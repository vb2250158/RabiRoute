import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { updatePlan } from "./roleKnowledge.js";
import { commitPlanStoragePackage, readPlanStoragePackage } from "./planStorageRepository.js";
import { recoverStoredPlanPackages } from "./planStoragePackageRecovery.js";
import { createStorageStartupProcess } from "./manager/storageStartupProcess.js";
import { PlanStorageStartupLifecycle } from "./manager/planStorageStartupLifecycle.js";
import type { PlanStorageStartupGateSummary } from "./manager/planStorageStartupGate.js";

function fixture(t: test.TestContext, existingRoleDir?: string, planId = "pending-package") {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-package-recovery-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const roleDir = existingRoleDir ?? path.join(root, "roles", "Example");
  const plan = { id: planId, title: "Recovery", focus: "Preserve historical bytes", status: "执行中", keywords: ["recovery"],
    currentStepId: "inspect", steps: [{ id: "inspect", title: "Inspect" }] };
  const files = [
    ["plan.json", JSON.stringify(plan)],
    ["history.jsonl", `${JSON.stringify({ id: "created", planId, kind: "created", after: plan })}\n`],
    ["attachments/evidence.txt", "historical evidence\n"]
  ].map(([filePath, text]) => {
    const content = Buffer.from(text);
    return { path: filePath, content, size: content.length, sha256: createHash("sha256").update(content).digest("hex") };
  }).sort((left, right) => left.path.localeCompare(right.path));
  const inventoryHash = createHash("sha256").update(JSON.stringify(files.map(file => [file.path, file.size, file.sha256]))).digest("hex");
  const transactionId = `persona_sync_active_${inventoryHash}`;
  const result = commitPlanStoragePackage({ roleDir, planId, storageId: planId, bucket: "active", inventoryHash, files, transactionId });
  assert.ok(result.receiptPath);
  const target = path.join(roleDir, "plans", "active", planId);
  const transactionRoot = path.join(roleDir, "plans", "quarantine", "plan-storage-package-transactions", planId, transactionId);
  return { roleDir, planId, target, transactionRoot, receiptPath: result.receiptPath, inventoryHash,
    input: { roleDir, planId, storageId: planId, bucket: "active" as const, inventoryHash, files, transactionId } };
}

for (const staged of [false, true]) {
  test(`startup recovers historical package without a codec (${staged ? "staged" : "published"} payload)`, t => {
    const data = fixture(t);
    if (staged) fs.renameSync(data.target, path.join(data.transactionRoot, "payload"));
    fs.unlinkSync(data.receiptPath);
    const recovered = recoverStoredPlanPackages(data.roleDir);
    assert.deepEqual(recovered.errors, []);
    assert.equal(recovered.results.length, 1);
    assert.equal(recovered.results[0].status, staged ? "applied" : "unchanged");
    assert.equal(recovered.results[0].inventoryHash, data.inventoryHash);
    assert.equal(fs.readFileSync(path.join(data.target, "attachments", "evidence.txt"), "utf8"), "historical evidence\n");
    assert.ok(fs.existsSync(data.receiptPath));
    assert.deepEqual(recoverStoredPlanPackages(data.roleDir).errors, []);
  });
}

test("incomplete historical payload remains on disk and fails recovery closed", t => {
  const data = fixture(t);
  const payload = path.join(data.transactionRoot, "payload");
  fs.renameSync(data.target, payload);
  fs.unlinkSync(data.receiptPath);
  fs.writeFileSync(path.join(payload, "attachments", "evidence.txt"), "incomplete");
  const recovered = recoverStoredPlanPackages(data.roleDir);
  assert.equal(recovered.errors.length, 1);
  assert.equal(recovered.errors[0].planId, data.planId);
  assert.match(recovered.errors[0].message, /incomplete or changed/);
  assert.ok(fs.existsSync(path.join(data.transactionRoot, "manifest.json")));
  assert.equal(fs.readFileSync(path.join(payload, "attachments", "evidence.txt"), "utf8"), "incomplete");
  assert.equal(fs.existsSync(data.receiptPath), false);
});

test("package recovery continues past a corrupt middle transaction without altering its evidence", t => {
  const first = fixture(t, undefined, "a-valid");
  const broken = fixture(t, first.roleDir, "b-broken");
  const last = fixture(t, first.roleDir, "c-valid");
  for (const item of [first, broken, last]) {
    fs.renameSync(item.target, path.join(item.transactionRoot, "payload"));
    fs.unlinkSync(item.receiptPath);
  }
  const brokenFile = path.join(broken.transactionRoot, "payload", "attachments", "evidence.txt");
  fs.writeFileSync(brokenFile, "incomplete");
  const manifest = fs.readFileSync(path.join(broken.transactionRoot, "manifest.json"));
  const recovered = recoverStoredPlanPackages(first.roleDir);
  assert.deepEqual(recovered.results.map(result => [result.planId, result.status]), [[first.planId, "applied"], [last.planId, "applied"]]);
  assert.equal(recovered.errors.length, 1);
  assert.equal(recovered.errors[0].planId, broken.planId);
  assert.match(recovered.errors[0].message, /incomplete or changed/);
  for (const item of [first, last]) {
    assert.equal(readPlanStoragePackage(item.roleDir, item.planId, "active").inventoryHash, item.inventoryHash);
    assert.ok(fs.existsSync(item.receiptPath));
  }
  assert.equal(fs.existsSync(broken.receiptPath), false);
  assert.equal(fs.existsSync(broken.target), false);
  assert.equal(fs.readFileSync(brokenFile, "utf8"), "incomplete");
  assert.deepEqual(fs.readFileSync(path.join(broken.transactionRoot, "manifest.json")), manifest);
  assert.throws(() => readPlanStoragePackage(broken.roleDir, broken.planId, "active"), /pending recovery/);
  assert.throws(() => updatePlan(broken.roleDir, broken.planId, { title: "must stay blocked" }), /pending recovery|Plan not found/);
  assert.equal(updatePlan(first.roleDir, first.planId, { title: "Normal item remains writable" }).title, "Normal item remains writable");
  fs.writeFileSync(brokenFile, "historical evidence\n");
  assert.deepEqual(recoverStoredPlanPackages(first.roleDir).errors, []);
  assert.equal(readPlanStoragePackage(broken.roleDir, broken.planId, "active").inventoryHash, broken.inventoryHash);
});

test("an unverified package manifest never attributes a failure to another plan", t => {
  const data = fixture(t);
  const manifestPath = path.join(data.transactionRoot, "manifest.json");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  manifest.planId = "another-plan";
  manifest.storageId = "another-plan";
  fs.writeFileSync(manifestPath, JSON.stringify(manifest));
  const recovered = recoverStoredPlanPackages(data.roleDir);
  assert.equal(recovered.errors.length, 1);
  assert.equal(recovered.errors[0].planId, undefined);
  assert.match(recovered.errors[0].message, /scope mismatch/);
});

test("unknown package identity blocks a different plan write without changing its bytes", t => {
  const first = fixture(t, undefined, "good-plan");
  const other = fixture(t, first.roleDir, "unknown-plan");
  const file = path.join(first.target, "plan.json");
  const before = fs.readFileSync(file);
  fs.writeFileSync(path.join(other.transactionRoot, "manifest.json"), "{");
  assert.throws(() => updatePlan(first.roleDir, first.planId, { title: "blocked by unknown ownership" }), /JSON|property|Unexpected/);
  assert.deepEqual(fs.readFileSync(file), before);
});

test("exact prepared package retry remains idempotent while a new transaction stays fenced", t => {
  const data = fixture(t);
  fs.renameSync(data.target, path.join(data.transactionRoot, "payload"));
  fs.unlinkSync(data.receiptPath);
  assert.throws(() => commitPlanStoragePackage({ ...data.input, transactionId: "different-transaction" }), /pending recovery/);
  assert.equal(commitPlanStoragePackage(data.input).status, "applied");
  assert.equal(commitPlanStoragePackage(data.input).status, "unchanged");
  assert.equal(readPlanStoragePackage(data.roleDir, data.planId, "active").inventoryHash, data.inventoryHash);
});

test("real startup child isolates a corrupt package and lifecycle reports partial readiness", async t => {
  const first = fixture(t, undefined, "a-valid");
  const broken = fixture(t, first.roleDir, "b-broken");
  const last = fixture(t, first.roleDir, "c-valid");
  const payload = path.join(broken.transactionRoot, "payload");
  fs.renameSync(broken.target, payload);
  fs.unlinkSync(broken.receiptPath);
  fs.writeFileSync(path.join(payload, "attachments", "evidence.txt"), "incomplete");
  const lifecycle = new PlanStorageStartupLifecycle({
    rolesRoot: path.dirname(first.roleDir), readOnly: false, attemptTimeoutMs: 60000,
    attemptFactory: () => createStorageStartupProcess<PlanStorageStartupGateSummary>({ kind: "plan", rolesRoot: path.dirname(first.roleDir), roleId: path.basename(first.roleDir) }, 5000)
  });
  t.after(() => lifecycle.stop());
  const summary = await new Promise<PlanStorageStartupGateSummary>((resolve, reject) => {
    const deadline = setTimeout(() => reject(new Error("partial startup fixture did not finish")), 60000);
    lifecycle.onReady(value => { clearTimeout(deadline); resolve(value); });
    lifecycle.start();
  });
  assert.equal(lifecycle.snapshot().state, "partial");
  assert.deepEqual(summary.failures, []);
  assert.equal(summary.packageConflicts?.length, 1);
  assert.equal(summary.packageConflicts?.[0].planId, broken.planId);
  for (const item of [first, last]) assert.ok(readPlanStoragePackage(item.roleDir, item.planId, "active").files.length);
  assert.equal(fs.readFileSync(path.join(payload, "attachments", "evidence.txt"), "utf8"), "incomplete");
  assert.equal(fs.existsSync(broken.receiptPath), false);
});


test("completed package recovery preserves a later normal plan update after payload consumption", t => {
  const data = fixture(t);
  assert.equal(fs.existsSync(path.join(data.transactionRoot, "payload")), false);
  const originalReceipt = fs.readFileSync(data.receiptPath);
  const updated = updatePlan(data.roleDir, data.planId, { title: "Later normal write", status: "分析中", keywords: ["recovery"],
    currentStepId: "inspect", steps: [{ id: "inspect", title: "Inspect" }] });
  assert.equal(updated.title, "Later normal write");
  const latest = readPlanStoragePackage(data.roleDir, data.planId, "active");
  assert.notEqual(latest.inventoryHash, data.inventoryHash);
  for (let attempt = 0; attempt < 2; attempt++) {
    const recovered = recoverStoredPlanPackages(data.roleDir);
    assert.deepEqual(recovered.errors, []);
    assert.equal(recovered.results.length, 1);
    assert.equal(recovered.results[0].status, "unchanged");
    assert.equal(readPlanStoragePackage(data.roleDir, data.planId, "active").inventoryHash, latest.inventoryHash);
    assert.deepEqual(fs.readFileSync(data.receiptPath), originalReceipt);
    assert.equal(fs.existsSync(path.join(data.transactionRoot, "payload")), false);
  }
});

for (const field of ["planId", "storageId", "transactionId", "bucket", "inventoryHash", "specHash", "status", "kind"]) {
  test("completed package recovery rejects a tampered receipt " + field, t => {
    const data = fixture(t);
    const originalPlanBytes = fs.readFileSync(path.join(data.target, "plan.json"));
    const receipt = JSON.parse(fs.readFileSync(data.receiptPath, "utf8"));
    receipt[field] = field === "inventoryHash" || field === "specHash" ? "0".repeat(64) : "invalid-owner";
    fs.writeFileSync(data.receiptPath, JSON.stringify(receipt));
    const tamperedBytes = fs.readFileSync(data.receiptPath);
    const recovered = recoverStoredPlanPackages(data.roleDir);
    assert.equal(recovered.errors.length, 1);
    assert.match(recovered.errors[0].message, /receipt identity mismatch/);
    assert.throws(() => readPlanStoragePackage(data.roleDir, data.planId, "active"), /receipt identity mismatch/);
    assert.throws(() => updatePlan(data.roleDir, data.planId, { title: "must stay blocked" }), /receipt identity mismatch/);
    assert.deepEqual(fs.readFileSync(path.join(data.target, "plan.json")), originalPlanBytes);
    assert.deepEqual(fs.readFileSync(data.receiptPath), tamperedBytes);
  });
}
