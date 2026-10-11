import assert from "node:assert/strict";
import fs from "node:fs";
import { fork } from "node:child_process";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ManagerStorageMutationPool, ManagerStorageMutationError } from "./managerStorageMutationPool.js";
import { readDurableDeliveryReceipt, durableDeliveryReceiptPath } from "./durableDeliveryIdempotency.js";
import { RoleStorageApplication, roleStorageHttpError } from "./roleStorageApplication.js";
import { MANAGER_STORAGE_MUTATION_RECEIPT_NAMESPACE } from "./managerStorageMutationProtocol.js";
import { createPlan, readPlansFromStorageInWorker, updatePlan, listPlanHistory } from "../roleKnowledge.js";
import { loadDefaultPersonaPlanWorkflow, writePersonaPlanWorkflow, readPersonaPlanWorkflow } from "../personaPlanWorkflow.js";

test("real worker retains partial status migration as uncertain and never redelivers the same key", { timeout: 30_000 }, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "storage-batch-migration-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const roleDir = path.join(root, "FixtureRole");
  fs.mkdirSync(roleDir);
  const workflow = structuredClone(loadDefaultPersonaPlanWorkflow());
  const base = workflow.statuses.find(status => status.key === workflow.roles.analysis)!;
  const lastOrder = Math.max(...workflow.statuses.map(status => status.order));
  workflow.statuses.push({ ...base, key: "source", label: "Source", labelEn: "Source", legacyAliases: [], order: lastOrder + 1, currentStep: "optional" });
  workflow.statuses.push({ ...base, key: "replacement", label: "Replacement", labelEn: "Replacement", legacyAliases: [], order: lastOrder + 2, currentStep: "required" });
  const original = writePersonaPlanWorkflow(roleDir, workflow);
  const input = { title: "Batch migration fixture", focus: "Validate partial commit certainty", status: "source",
    activationStatus: "进行中" as const, steps: [{ id: "verify", title: "Verify" }], keywords: ["fixture"] };
  createPlan(roleDir, { ...input, id: "fixture-a", currentStepId: "verify" });
  createPlan(roleDir, { ...input, id: "fixture-b", currentStepId: "verify" });
  const ordered = readPlansFromStorageInWorker(roleDir);
  assert.equal(ordered.length, 2);
  const firstId = ordered[0]!.id;
  const secondId = ordered[1]!.id;
  updatePlan(roleDir, secondId, { currentStepId: undefined });
  const pool = new ManagerStorageMutationPool({ rolesRoot: root, applicationGenerationId: "generation", managerInstanceId: "manager" });
  t.after(() => pool.stop());
  const key = "partial-status-retirement";
  const retire = () => pool.deletePlanStatus("FixtureRole", "source", "replacement", {
    idempotencyKey: key, expectedRevision: original.revision, authorize: () => {}, timeoutMs: 20_000
  });
  const expectUncertain = () => assert.rejects(retire(), (error: unknown) => {
    assert.ok(error instanceof ManagerStorageMutationError);
    assert.equal(error.code, "indeterminate");
    return true;
  });
  await expectUncertain();
  const plans = readPlansFromStorageInWorker(roleDir);
  assert.equal(plans.find(plan => plan.id === firstId)?.status, "replacement");
  assert.equal(plans.find(plan => plan.id === secondId)?.status, "source");
  assert.equal(readPersonaPlanWorkflow(roleDir)?.revision, original.revision);
  const receipt = () => readDurableDeliveryReceipt(path.join(roleDir, "runtime"), MANAGER_STORAGE_MUTATION_RECEIPT_NAMESPACE, key);
  assert.equal(receipt()?.state, "uncertain");
  // Even after the original failure condition is fixed, this key must not
  // automatically finish the migration based on the unchanged workflow ETag.
  updatePlan(roleDir, secondId, { currentStepId: "verify" });
  const before = listPlanHistory(roleDir, secondId);
  await expectUncertain();
  assert.equal(receipt()?.state, "uncertain");
  assert.deepEqual(listPlanHistory(roleDir, secondId), before);
  assert.equal(readPlansFromStorageInWorker(roleDir).find(plan => plan.id === secondId)?.status, "source");
  assert.equal(readPersonaPlanWorkflow(roleDir)?.revision, original.revision);
});

type BatchFault = "workflow-cas" | "second-plan-conflict" | "empty-workflow-write" | "completed-receipt";

// Install faults only in a disposable real child. Production keeps its normal
// entry point, IPC admission, domain code, and durable receipt implementation.
function faultChildFactory(root: string, roleDir: string, key: string, fault: BatchFault) {
  const moduleUrl = (relative: string) => new URL(relative + (import.meta.url.endsWith(".ts") ? ".ts" : ".js"), import.meta.url).href;
  const wrapper = path.join(root, "fault-child.mjs");
  fs.writeFileSync(wrapper, `
    import fs from "node:fs";
    const repository = await import(${JSON.stringify(moduleUrl("../planStorageRepository"))});
    const workflow = await import(${JSON.stringify(moduleUrl("../personaPlanWorkflow"))});
    const roleDir = ${JSON.stringify(roleDir)};
    const fault = ${JSON.stringify(fault)};
    let seen = 0;
    if (fault === "workflow-cas") {
      repository.subscribePlanStorageCommits(event => {
        if (event.roleDir !== roleDir || ++seen !== 1) return;
        const current = workflow.readPersonaPlanWorkflow(roleDir);
        const changed = structuredClone(current.workflow);
        changed.statuses.find(status => status.key === "replacement").label = "Concurrent replacement";
        workflow.writePersonaPlanWorkflow(roleDir, changed, current.revision);
      });
    }
    if (fault === "second-plan-conflict") {
      let firstCommitted = false;
      repository.subscribePlanStorageCommits(event => {
        if (event.roleDir === roleDir) firstCommitted = true;
      });
      repository.subscribePlanStorageBeforeMutation(event => {
        if (event.roleDir === roleDir && firstCommitted) {
          throw new Error("STORAGE_MUTATION_REVISION_CONFLICT: injected after first plan commit.");
        }
      });
    }
    const rename = fs.renameSync;
    const configPath = ${JSON.stringify(path.join(roleDir, "personaConfig.json"))};
    const receiptPath = ${JSON.stringify(durableDeliveryReceiptPath(path.join(roleDir, "runtime"), MANAGER_STORAGE_MUTATION_RECEIPT_NAMESPACE, key))};
    fs.renameSync = (source, destination) => {
      if (fault === "empty-workflow-write" && destination === configPath) {
        throw new Error("Injected final workflow write failure.");
      }
      if (fault === "completed-receipt" && destination === receiptPath
        && JSON.parse(fs.readFileSync(source, "utf8")).state === "completed") {
        throw new Error("Injected terminal receipt publication failure.");
      }
      return rename(source, destination);
    };
    await import(${JSON.stringify(moduleUrl("./managerStorageMutationChild"))});
  `);
  return (identity: Parameters<NonNullable<ConstructorParameters<typeof ManagerStorageMutationPool>[0]["childFactory"]>>[0]) => fork(wrapper, [], {
    env: {
      ...process.env,
      RABIROUTE_APPLICATION_GENERATION_ID: identity.applicationGenerationId,
      RABIROUTE_MANAGER_INSTANCE_ID: identity.managerInstanceId,
      RABIROUTE_STORAGE_GENERATION_LEASE: identity.storageGenerationLease,
      RABIROUTE_STORAGE_ROLES_ROOT: identity.rolesRoot,
      RABIROUTE_MANAGER_STORAGE_MUTATION_PROCESS: "1"
    },
    execArgv: import.meta.url.endsWith(".ts") ? ["--import", "tsx"] : [],
    serialization: "json",
    stdio: ["ignore", "ignore", "ignore", "ipc"]
  });
}

for (const fault of ["workflow-cas", "second-plan-conflict", "empty-workflow-write", "completed-receipt"] as const) {
  test(`real worker ${fault} remains HTTP 503/unknown and cannot replay domain writes`, { timeout: 30_000 }, async t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "storage-batch-fault-"));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const roleDir = path.join(root, "FixtureRole");
    fs.mkdirSync(roleDir);
    const workflow = structuredClone(loadDefaultPersonaPlanWorkflow());
    const base = workflow.statuses.find(status => status.key === workflow.roles.analysis)!;
    const lastOrder = Math.max(...workflow.statuses.map(status => status.order));
    workflow.statuses.push({ ...base, key: "source", label: "Source", labelEn: "Source", legacyAliases: [], order: lastOrder + 1, currentStep: "optional" });
    workflow.statuses.push({ ...base, key: "replacement", label: "Replacement", labelEn: "Replacement", legacyAliases: [], order: lastOrder + 2, currentStep: "optional" });
    const original = writePersonaPlanWorkflow(roleDir, workflow);
    if (fault !== "empty-workflow-write") {
      for (const id of ["fixture-a", "fixture-b"]) createPlan(roleDir, {
        id, title: "Batch fault fixture", focus: "Validate commit uncertainty", status: "source",
        activationStatus: "进行中", keywords: ["fixture"], steps: [{ id: "verify", title: "Verify" }], currentStepId: "verify"
      });
    }
    const key = `batch-${fault}`;
    const identity = { applicationGenerationId: "generation", managerInstanceId: "manager" };
    const pool = new ManagerStorageMutationPool({ rolesRoot: root, ...identity, childFactory: faultChildFactory(root, roleDir, key, fault) });
    const application = new RoleStorageApplication({ rolesRoot: root, ...identity, mutationPool: pool });
    t.after(() => application.stop());
    await assert.rejects(application.commands.deletePlanStatus("FixtureRole", "source", "replacement", {
      idempotencyKey: key, expectedRevision: original.revision, authorize: () => {}
    }), (error: unknown) => {
      const response = roleStorageHttpError(error);
      assert.equal(response.statusCode, 503);
      assert.equal(response.body.state, "indeterminate");
      assert.equal(response.body.commitState, "unknown");
      return true;
    });
    const receipt = () => readDurableDeliveryReceipt(path.join(roleDir, "runtime"), MANAGER_STORAGE_MUTATION_RECEIPT_NAMESPACE, key);
    assert.equal(receipt()?.state, "uncertain");
    const plans = readPlansFromStorageInWorker(roleDir);
    const migratedCount = fault === "empty-workflow-write" ? 0 : fault === "second-plan-conflict" ? 1 : 2;
    assert.equal(plans.filter(plan => plan.status === "replacement").length, migratedCount);
    const afterWorkflow = readPersonaPlanWorkflow(roleDir)!;
    if (fault === "workflow-cas") {
      assert.notEqual(afterWorkflow.revision, original.revision);
      assert.equal(afterWorkflow.workflow.statuses.find(status => status.key === "source")?.state, "enabled");
    } else if (fault === "completed-receipt") {
      assert.notEqual(afterWorkflow.revision, original.revision);
      assert.equal(afterWorkflow.workflow.statuses.find(status => status.key === "source")?.state, "retired");
    } else assert.equal(afterWorkflow.revision, original.revision);
    const histories = plans.map(plan => listPlanHistory(roleDir, plan.id));
    await assert.rejects(pool.deletePlanStatus("FixtureRole", "source", "replacement", {
      idempotencyKey: key, expectedRevision: original.revision, authorize: () => {}
    }), (error: unknown) => error instanceof ManagerStorageMutationError && error.code === "indeterminate");
    assert.equal(receipt()?.state, "uncertain");
    assert.deepEqual(plans.map(plan => listPlanHistory(roleDir, plan.id)), histories);
    assert.deepEqual(readPersonaPlanWorkflow(roleDir), afterWorkflow);
  });
}

test("real worker replays a completed batch receipt without additional domain writes", { timeout: 30_000 }, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "storage-batch-completed-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const roleDir = path.join(root, "FixtureRole");
  fs.mkdirSync(roleDir);
  const workflow = structuredClone(loadDefaultPersonaPlanWorkflow());
  const base = workflow.statuses.find(status => status.key === workflow.roles.analysis)!;
  workflow.statuses.push({ ...base, key: "source", label: "Source", labelEn: "Source", legacyAliases: [],
    order: Math.max(...workflow.statuses.map(status => status.order)) + 1 });
  const original = writePersonaPlanWorkflow(roleDir, workflow);
  createPlan(roleDir, { id: "fixture", title: "Completed batch fixture", focus: "Verify receipt replay", status: "source",
    activationStatus: "进行中", keywords: ["fixture"], steps: [{ id: "verify", title: "Verify" }], currentStepId: "verify" });
  const pool = new ManagerStorageMutationPool({ rolesRoot: root, applicationGenerationId: "generation", managerInstanceId: "manager" });
  t.after(() => pool.stop());
  const retire = () => pool.deletePlanStatus("FixtureRole", "source", workflow.roles.analysis, {
    idempotencyKey: "completed-batch", expectedRevision: original.revision, authorize: () => {}
  });
  const committed = await retire();
  const history = listPlanHistory(roleDir, "fixture");
  const afterWorkflow = readPersonaPlanWorkflow(roleDir);
  assert.equal(readDurableDeliveryReceipt(path.join(roleDir, "runtime"), MANAGER_STORAGE_MUTATION_RECEIPT_NAMESPACE, "completed-batch")?.state, "completed");
  assert.deepEqual(await retire(), committed);
  assert.deepEqual(listPlanHistory(roleDir, "fixture"), history);
  assert.deepEqual(readPersonaPlanWorkflow(roleDir), afterWorkflow);
});
