import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { once } from "node:events";
import test from "node:test";
import { RoleStorageApplication, RoleStorageApplicationError, type RoleStorageApplicationOptions } from "./manager/roleStorageApplication.js";
import { ManagerStorageMutationPool, ManagerStorageMutationError } from "./manager/managerStorageMutationPool.js";
import { createPlan, getPlan, listPlanHistory, planUpdatePrimitives, updatePlanPrepared } from "./roleKnowledge.js";
import { readPlanStoragePackage } from "./planStorageRepository.js";
import { storageInventoryRevisionToken, storageMutationRevision } from "./shared/storageRevision.js";
import { durableDeliveryReceiptPath, durableDeliveryRequestDigest, readDurableDeliveryReceipt } from "./manager/durableDeliveryIdempotency.js";
import { MANAGER_STORAGE_MUTATION_RECEIPT_NAMESPACE } from "./manager/managerStorageMutationProtocol.js";
import type { PlanUpdateExecutorLease, PlanUpdateExecutorPin } from "./manager/planUpdateExecutor.js";

async function fixture(t: test.TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "plan-executor-ipc-"));
  const rolesRoot = path.join(root, "roles");
  const roleDir = path.join(rolesRoot, "Fixture");
  fs.mkdirSync(roleDir, { recursive: true });
  const plan = createPlan(roleDir, { id: "executor-plan", title: "Original", keywords: ["fixture"],
    steps: [{ id: "verify", title: "Verify" }], currentStepId: "verify" });
  const callsFile = path.join(root, "prepare-calls.txt");
  const modules = new Map<string, { pin: PlanUpdateExecutorPin; entryUrl: string }>();
  for (const version of ["A", "B"]) {
    const entry = path.join(root, "immutable-" + version + ".mjs");
    const source = `import fs from 'node:fs';
import {createPlanUpdatePreparation as base} from ${JSON.stringify(new URL("./plugins/io.rabiroute.manager.persona/worker/plan-update.mjs", import.meta.url).href)};
export function createPlanUpdatePreparation(ports) {
  const original = base(ports);
  return Object.freeze({...original,
    prepare(input) {
      fs.appendFileSync(${JSON.stringify(callsFile)}, ${JSON.stringify(version + "\n")});
      return original.prepare({...input, patch:{...input.patch,title:input.patch.title + ' [${version}]'}});
    },
    projectPlan(input) {
      if (input.plan.title.includes('[projection-error]')) {
        throw new Error('Fixture pure projection failed');
      }
      return {...input, plan: {...input.plan, title: input.plan.title + ' <${version}>'}};
    }
  });
}
`;
    fs.writeFileSync(entry, source);
    modules.set(version, { pin: { pluginId: "io.rabiroute.manager.persona", version: "0.0." + (version === "A" ? "1" : "2"),
      revision: createHash("sha256").update(source).digest("hex"), entryPath: "worker/plan-update.mjs" }, entryUrl: pathToFileURL(entry).href });
  }
  let selected = "A";
  let unavailable = false;
  let restoreUnavailable = false;
  let restoreCount = 0;
  let acquired = 0;
  let released = 0;
  const lease = (version: string): PlanUpdateExecutorLease => {
    acquired++;
    let closed = false;
    return { ...modules.get(version)!,
      async run<T>(operation: () => T | Promise<T>): Promise<T> { assert.equal(closed, false); return operation(); },
      release() { if (!closed) { closed = true; released++; } }
    };
  };
  const pool = new ManagerStorageMutationPool({ rolesRoot, applicationGenerationId: "fixture-app", managerInstanceId: "fixture-manager",
    timeoutMs: 10000,
    acquirePlanUpdateExecutor() {
      if (unavailable) throw new Error("Fixture current provider is retiring");
      return lease(selected);
    },
    async restorePlanUpdateExecutor(pin) {
      restoreCount++;
      if (restoreUnavailable) throw new Error("Fixture original package is missing");
      const version = [...modules].find(([, value]) => value.pin.revision === pin.revision)?.[0];
      assert.ok(version);
      return lease(version);
    }
  });
  t.after(async () => {
    await pool.stop();
    assert.equal(acquired, released, "all current and restored accepted-work leases close");
    fs.rmSync(root, { recursive: true, force: true });
  });
  const current = () => readPlanStoragePackage(roleDir, plan.id, "active");
  const receiptPath = (key: string) => durableDeliveryReceiptPath(path.join(roleDir, "runtime"), MANAGER_STORAGE_MUTATION_RECEIPT_NAMESPACE, key);
  const callList = () => fs.existsSync(callsFile) ? fs.readFileSync(callsFile, "utf8").trim().split("\n") : [];
  const seed = async (key: string, patch: Record<string, unknown>, originalVersion: string) => {
    const child = spawn(process.execPath, ["-e", "process.exit(0)"], { stdio: "ignore", windowsHide: true });
    const ownerPid = child.pid;
    await once(child, "close");
    const expectedRevision = storageInventoryRevisionToken(current().inventoryHash);
    const payload = { roleId: "Fixture", planId: plan.id, task: { type: "plan_update", patch } };
    const record = { version: 1, deliveryId: key, requestDigest: durableDeliveryRequestDigest(payload), state: "sending",
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), executionId: randomUUID(), ownerHost: os.hostname(), ownerPid,
      leaseExpiresAt: new Date(Date.now() - 1000).toISOString(), audit: { expectedRevision, planUpdateExecutor: modules.get(originalVersion)!.pin } };
    const file = receiptPath(key);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(record));
    return { expectedRevision, idempotencyKey: key };
  };
  return { root, roleDir, plan, pool, modules, current, receiptPath, callList, seed,
    select(version: string) { selected = version; },
    unavailable(value: boolean) { unavailable = value; },
    restoreUnavailable(value: boolean) { restoreUnavailable = value; },
    restores() { return restoreCount; }
  };
}

test("real child uses immutable A then B and completed replay needs neither restore nor a healthy current provider", async t => {
  const f = await fixture(t);
  const firstOptions = { idempotencyKey: "first-A", expectedRevision: storageInventoryRevisionToken(f.current().inventoryHash) };
  const patch = { title: "Changed" };
  const first = await f.pool.updatePlan("Fixture", f.plan.id, patch, firstOptions);
  assert.equal(first.title, "Changed [A]");
  const originalReceipt = fs.readFileSync(f.receiptPath(firstOptions.idempotencyKey));
  f.select("B");
  const second = await f.pool.updatePlan("Fixture", f.plan.id, { title: "Second" }, {
    idempotencyKey: "second-B", expectedRevision: storageInventoryRevisionToken(f.current().inventoryHash)
  });
  assert.equal(second.title, "Second [B]");
  f.unavailable(true);
  assert.deepEqual(await f.pool.updatePlan("Fixture", f.plan.id, patch, firstOptions), first);
  assert.deepEqual(fs.readFileSync(f.receiptPath(firstOptions.idempotencyKey)), originalReceipt);
  assert.deepEqual(f.callList(), ["A", "B"]);
  assert.equal(f.restores(), 0);
});

test("fresh provider admission failure creates no receipt and independent memory mutation continues", async t => {
  const f = await fixture(t);
  f.unavailable(true);
  await assert.rejects(f.pool.updatePlan("Fixture", f.plan.id, { title: "Not started" }, {
    idempotencyKey: "not-started", expectedRevision: storageInventoryRevisionToken(f.current().inventoryHash)
  }), error => error instanceof ManagerStorageMutationError && error.code === "busy" && error.commitState === "not_started");
  assert.equal(fs.existsSync(f.receiptPath("not-started")), false);
  const memory = await f.pool.createRecentMemory("Fixture", { title: "Healthy neighbor", content: "Preserved", keywords: ["fixture"] }, {
    idempotencyKey: "healthy-memory", expectedRevision: null
  });
  assert.equal(memory.title, "Healthy neighbor");
  assert.deepEqual(f.callList(), []);
});

test("original A receipt retry selects retained A over currently selected B through actual child IPC", async t => {
  const f = await fixture(t);
  const patch = { title: "Original A retry" };
  const options = await f.seed("retry-original-A", patch, "A");
  f.select("B");
  const value = await f.pool.updatePlan("Fixture", f.plan.id, patch, options);
  assert.equal(value.title, "Original A retry [A]");
  assert.deepEqual(f.callList(), ["A"]);
  assert.equal(f.restores(), 1);
  const receipt = readDurableDeliveryReceipt(path.join(f.roleDir, "runtime"), MANAGER_STORAGE_MUTATION_RECEIPT_NAMESPACE, options.idempotencyKey)!;
  assert.equal((receipt.audit as { planUpdateExecutor: PlanUpdateExecutorPin }).planUpdateExecutor.version, "0.0.1");
});

test("missing original executor keeps only its uncommitted operation unknown without invoking B", async t => {
  const f = await fixture(t);
  const patch = { title: "Unresolved A" };
  const options = await f.seed("missing-original-A", patch, "A");
  const before = f.current().inventoryHash;
  f.select("B");
  f.restoreUnavailable(true);
  await assert.rejects(f.pool.updatePlan("Fixture", f.plan.id, patch, options),
    error => error instanceof ManagerStorageMutationError && error.code === "indeterminate");
  assert.equal(f.current().inventoryHash, before);
  assert.deepEqual(f.callList(), []);
  assert.equal(readDurableDeliveryReceipt(path.join(f.roleDir, "runtime"), MANAGER_STORAGE_MUTATION_RECEIPT_NAMESPACE, options.idempotencyKey)!.state, "uncertain");
});

test("frozen prepared A WAL completes generically even when its package is missing, with zero preparation calls", async t => {
  const f = await fixture(t);
  const patch = { title: "Frozen original A" };
  const options = await f.seed("prepared-A", patch, "A");
  const original = f.current();
  const module = await import(f.modules.get("A")!.entryUrl);
  const preparation = module.createPlanUpdatePreparation(planUpdatePrimitives);
  const rename = fs.renameSync;
  const spy = t.mock.method(fs, "renameSync", ((source: fs.PathLike, target: fs.PathLike) => {
    if (String(source) === path.join(f.roleDir, "plans", "active", f.plan.id) && path.basename(String(target)) === "previous") {
      throw Object.assign(new Error("Fixture prepared publication interrupted"), { code: "EIO" });
    }
    return rename(source, target);
  }) as typeof fs.renameSync);
  assert.throws(() => updatePlanPrepared(f.roleDir, f.plan.id, patch, preparation, options.expectedRevision, {
    requestId: options.idempotencyKey, revision: storageMutationRevision(options.idempotencyKey)
  }), /publication interrupted/);
  spy.mock.restore();
  assert.equal(f.current().inventoryHash, original.inventoryHash);
  const preparationsBeforeRecovery = f.callList();
  f.select("B");
  f.restoreUnavailable(true);
  const value = await f.pool.updatePlan("Fixture", f.plan.id, patch, options);
  assert.equal(value.title, patch.title + " [A]");
  assert.equal(value.storageMutationRequestId, options.idempotencyKey);
  assert.deepEqual(f.callList(), preparationsBeforeRecovery);
  assert.equal(f.restores(), 0);
  const history = listPlanHistory(f.roleDir, f.plan.id).filter(item => item.after.storageMutationRequestId === options.idempotencyKey);
  assert.equal(history.length, 1);
  assert.equal(history[0].after.title, patch.title + " [A]");
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

function application(f: Awaited<ReturnType<typeof fixture>>, beforeRead: () => Promise<void> = async () => {}) {
  const readPool: NonNullable<RoleStorageApplicationOptions["readPool"]> = {
    async run<T>() {
      await beforeRead();
      const current = f.current();
      return { plan: getPlan(f.roleDir, f.plan.id), approval: { count: 0 }, revision: storageInventoryRevisionToken(current.inventoryHash) } as T;
    },
    async queryRoleKnowledgeCatalogSnapshot() { throw new Error("Unexpected full catalog read"); }
  };
  return new RoleStorageApplication({
    rolesRoot: path.join(f.root, "roles"), applicationGenerationId: "fixture-app", managerInstanceId: "fixture-manager",
    mutationPool: f.pool, readPool,
    async restorePlanUpdateExecutor(pin) {
      const descriptor = [...f.modules.values()].find(item => item.pin.revision === pin.revision);
      assert.ok(descriptor);
      return { ...descriptor, async run<T>(operation: () => T | Promise<T>) { return operation(); }, release() {} };
    }
  });
}

test("slow command projection releases the mutation queue and preserves exact A after selection changes", async t => {
  const f = await fixture(t);
  const entered = deferred<void>();
  const resume = deferred<void>();
  const app = application(f, async () => { entered.resolve(); await resume.promise; });
  t.after(() => resume.resolve());
  const updating = app.commands.updatePlan("Fixture", f.plan.id, { title: "Projected" }, {
    idempotencyKey: "projection-does-not-own-queue", expectedRevision: storageInventoryRevisionToken(f.current().inventoryHash)
  });
  await entered.promise;
  assert.equal(f.pool.status().active, 0);
  f.select("B");
  const neighbor = await f.pool.createRecentMemory("Fixture", { title: "Independent while projection waits", content: "Healthy", keywords: ["fixture"] }, {
    idempotencyKey: "neighbor-during-projection", expectedRevision: null
  });
  assert.equal(neighbor.title, "Independent while projection waits");
  resume.resolve();
  const result = await updating;
  assert.equal(result.commit.title, "Projected [A]");
  assert.equal(result.projection.plan.title, "Projected [A] <A>");
});

test("pure projection failure reports committed and leaves receipt and independent writes usable", async t => {
  const f = await fixture(t);
  const app = application(f);
  await assert.rejects(app.commands.updatePlan("Fixture", f.plan.id, { title: "[projection-error]" }, {
    idempotencyKey: "projection-fails-after-commit", expectedRevision: storageInventoryRevisionToken(f.current().inventoryHash)
  }), error => error instanceof RoleStorageApplicationError && error.commitState === "committed");
  assert.equal(getPlan(f.roleDir, f.plan.id)!.title, "[projection-error] [A]");
  assert.equal(readDurableDeliveryReceipt(path.join(f.roleDir, "runtime"), MANAGER_STORAGE_MUTATION_RECEIPT_NAMESPACE, "projection-fails-after-commit")!.state, "completed");
  const memory = await f.pool.createRecentMemory("Fixture", { title: "After projection failure", content: "Healthy", keywords: ["fixture"] }, {
    idempotencyKey: "neighbor-after-projection-error", expectedRevision: null
  });
  assert.equal(memory.title, "After projection failure");
});

test("completed original A command restores A for projection when current B cannot admit work", async t => {
  const f = await fixture(t);
  const app = application(f);
  const options = { idempotencyKey: "completed-A-projection", expectedRevision: storageInventoryRevisionToken(f.current().inventoryHash) };
  const patch = { title: "Original A" };
  const original = await app.commands.updatePlan("Fixture", f.plan.id, patch, options);
  const before = fs.readFileSync(f.receiptPath(options.idempotencyKey));
  f.select("B");
  f.unavailable(true);
  const repeated = await app.commands.updatePlan("Fixture", f.plan.id, patch, options);
  assert.deepEqual(repeated, original);
  assert.deepEqual(fs.readFileSync(f.receiptPath(options.idempotencyKey)), before);
  assert.deepEqual(f.callList(), ["A"]);
});
