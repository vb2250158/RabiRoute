import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  createPlan, updatePlan, getPlan, getPlanAsync, getPublishedPlan, listPlans, readPlansFromStorageInWorker,
  readPlanPageCatalogInWorker, readPlanCatalogDiagnostics, readPlanPointCandidateHint,
  clearPlanCatalogAfterStartupMigration, publishRolePlanCatalog, publishedRolePlans
} from "./roleKnowledge.js";
import { planDirectory, planJsonFile } from "./planStorageLayout.js";
import { planReadFence } from "./planReadInvalidation.js";
import { ManagerReadWorkerPool, type RolePlanCatalogRead } from "./manager/managerReadWorkerPool.js";

function fixture(t: test.TestContext) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "plan-availability-"));
  t.after(() => { clearPlanCatalogAfterStartupMigration(dir); assert.equal(path.dirname(dir), path.resolve(os.tmpdir())); fs.rmSync(dir, { recursive: true, force: true }); });
  const plans = ["damaged", "healthy-a", "healthy-b"].map(id => createPlan(dir, {
    id, title: id, status: "分析中", currentStepId: "one", steps: [{ id: "one", title: "One", status: "进行中" }], keywords: ["fixture"]
  }));
  return { dir, plans, read: () => readPlanPageCatalogInWorker(dir, planReadFence(dir), true) };
}

test("plan availability: duplicate groups are local while strict snapshots and point identity remain strict", async t => {
  const f = fixture(t), original = fs.readFileSync(planJsonFile(f.dir, "damaged", "active"));
  fs.cpSync(planDirectory(f.dir, "damaged", "active"), planDirectory(f.dir, "damaged", "archive"), { recursive: true });
  const third = path.join(f.dir, "plans/active/extra-physical"); fs.mkdirSync(third); fs.writeFileSync(path.join(third, "plan.json"), original);
  const result = await f.read(); assert.deepEqual(result.map(plan => plan.id), ["healthy-a", "healthy-b"]);
  const diagnostics = readPlanCatalogDiagnostics(f.dir); assert.equal(diagnostics.length, 1);
  assert.equal(diagnostics[0]?.code, "duplicate_plan_identity"); assert.equal(diagnostics[0]?.files?.length, 3);
  assert.equal(readPlanPointCandidateHint(f.dir, "damaged", planReadFence(f.dir)), undefined);
  assert.equal((await getPlanAsync(f.dir, "healthy-a"))?.id, "healthy-a");
  await assert.rejects(getPlanAsync(f.dir, "damaged"), /storage conflict/);
  assert.throws(() => readPlansFromStorageInWorker(f.dir), /storage conflict/);
  assert.throws(() => publishRolePlanCatalog(f.dir, [f.plans[0], f.plans[0]]), /duplicate|storage conflict/i);
  assert.ok(fs.readFileSync(planJsonFile(f.dir, "damaged", "active")).equals(original));
  fs.rmSync(planDirectory(f.dir, "damaged", "archive"), { recursive: true }); fs.rmSync(third, { recursive: true });
  const restored = await f.read(); assert.equal(restored.length, 3); assert.deepEqual(readPlanCatalogDiagnostics(f.dir), []);
});

test("plan availability: one unreadable row does not erase healthy cache or hide a healthy update", async t => {
  const f = fixture(t); assert.equal((await f.read()).length, 3);
  const file = planJsonFile(f.dir, "damaged", "active"), original = fs.readFileSync(file);
  const healthyFile = planJsonFile(f.dir, "healthy-a", "active"), healthy = JSON.parse(fs.readFileSync(healthyFile, "utf8"));
  healthy.title = "Current healthy update"; fs.writeFileSync(healthyFile, JSON.stringify(healthy));
  const read = fs.promises.readFile;
  const stub = t.mock.method(fs.promises, "readFile", (...args: Parameters<typeof read>) => {
    if (path.resolve(String(args[0])) === path.resolve(file)) return Promise.reject(Object.assign(new Error("Fixture EACCES"), { code: "EACCES" }));
    return read(...args);
  });
  const result = await f.read(); assert.equal(result.length, 2); assert.equal(result.find(plan => plan.id === "healthy-a")?.title, healthy.title);
  assert.equal(listPlans(f.dir).length, 2); assert.equal(readPlanCatalogDiagnostics(f.dir)[0]?.errorCode, "EACCES");
  assert.equal(readPlanPointCandidateHint(f.dir, "missing", planReadFence(f.dir)), undefined);
  assert.equal(getPublishedPlan(f.dir, "damaged"), undefined); assert.ok(fs.readFileSync(file).equals(original));
  stub.mock.restore(); assert.equal((await f.read()).length, 3); assert.deepEqual(readPlanCatalogDiagnostics(f.dir), []);
});

test("plan availability: whole namespace failure keeps its original error and prior valid catalog", async t => {
  const f = fixture(t); const original = await f.read(), readdir = fs.promises.readdir;
  const active = path.resolve(f.dir, "plans/active");
  const stub = t.mock.method(fs.promises, "readdir", (...args: Parameters<typeof readdir>) => {
    if (path.resolve(String(args[0])) === active) return Promise.reject(Object.assign(new Error("Fixture namespace EACCES"), { code: "EACCES" }));
    return readdir(...args);
  });
  await assert.rejects(f.read(), { code: "EACCES" }); assert.deepEqual(listPlans(f.dir), original);
  assert.equal(readPlanPointCandidateHint(f.dir, "healthy-a", planReadFence(f.dir)), undefined);
  stub.mock.restore(); assert.equal((await f.read()).length, 3);
});

test("plan availability: unknown package metadata is visible partial evidence without blocking unrelated collection", async t => {
  const f = fixture(t), transaction = path.join(f.dir, "plans/quarantine/plan-storage-package-transactions/unattributed/fixture");
  fs.mkdirSync(transaction, { recursive: true }); const file = path.join(transaction, "manifest.json"); fs.writeFileSync(file, "{broken");
  const result = await f.read(); assert.equal(result.length, 3);
  const diagnostics = readPlanCatalogDiagnostics(f.dir); assert.equal(diagnostics[0]?.code, "package_recovery_unknown"); assert.equal(diagnostics[0]?.planId, undefined);
  assert.equal(readPlanPointCandidateHint(f.dir, "healthy-a", planReadFence(f.dir)), undefined);
  assert.equal((await getPlanAsync(f.dir, "healthy-a"))?.id, "healthy-a"); assert.equal(fs.readFileSync(file, "utf8"), "{broken");
});

test("plan availability: partial worker result never becomes a complete published snapshot or cached executable bad ID", async t => {
  const f = fixture(t); publishRolePlanCatalog(f.dir, f.plans);
  fs.cpSync(planDirectory(f.dir, "damaged", "active"), planDirectory(f.dir, "damaged", "archive"), { recursive: true });
  const pool = new ManagerReadWorkerPool(); t.after(() => pool.stop());
  const partial: RolePlanCatalogRead = { plans: [f.plans[1]!], approvalByPlanId: {}, partial: true,
    diagnostics: [{ code: "duplicate_plan_identity", planId: "damaged", message: "Fixture duplicated ID" }] };
  t.mock.method(pool, "run", async () => partial);
  const result = await pool.queryRolePlanCatalog(f.dir); assert.equal(result.partial, true); assert.equal(result.plans.length, 1);
  assert.deepEqual(publishedRolePlans(f.dir)?.map(plan => plan.id), ["healthy-a", "healthy-b"]);
  assert.equal(getPublishedPlan(f.dir, "damaged"), undefined); assert.throws(() => getPlan(f.dir, "damaged"), /storage bucket|storage conflict/i);
  assert.equal(getPlan(f.dir, "healthy-b")?.id, "healthy-b");
});

test("plan availability: unrelated duplicate group cannot turn healthy create or update into post-write failure", async t => {
  const f = fixture(t);
  fs.cpSync(planDirectory(f.dir, "damaged", "active"), planDirectory(f.dir, "damaged", "archive"), { recursive: true });
  assert.equal((await f.read()).length, 2);
  const created = createPlan(f.dir, { id: "new-healthy", title: "New healthy", status: "分析中", currentStepId: "one", steps: [{ id: "one", title: "One", status: "进行中" }], keywords: ["fixture"] });
  assert.equal(created.id, "new-healthy");
  const updated = updatePlan(f.dir, "healthy-a", { title: "Managed healthy update" }); assert.equal(updated?.title, "Managed healthy update");
  const result = await f.read(); assert.equal(result.length, 3); assert.equal(result.find(plan => plan.id === "healthy-a")?.title, "Managed healthy update");
  assert.ok(readPlanCatalogDiagnostics(f.dir).some(issue => issue.code === "duplicate_plan_identity"));
  await assert.rejects(getPlanAsync(f.dir, "damaged"), /storage conflict/i);
});

test("plan availability: strict storage reads recheck an unavailable cached physical row instead of treating old contents as current", async t => {
  const f = fixture(t); await f.read(); const file = path.resolve(planJsonFile(f.dir, "damaged", "active"));
  const asyncRead = fs.promises.readFile;
  const asynchronous = t.mock.method(fs.promises, "readFile", (...args: Parameters<typeof asyncRead>) => {
    if (path.resolve(String(args[0])) === file) return Promise.reject(Object.assign(new Error("Fixture async EACCES"), { code: "EACCES" }));
    return asyncRead(...args);
  });
  assert.equal((await f.read()).length, 2);
  const syncRead = fs.readFileSync; let checked = 0;
  const synchronous = t.mock.method(fs, "readFileSync", (...args: Parameters<typeof syncRead>) => {
    if (path.resolve(String(args[0])) === file) { checked++; throw Object.assign(new Error("Fixture sync EACCES"), { code: "EACCES" }); }
    return syncRead(...args);
  });
  assert.equal(readPlansFromStorageInWorker(f.dir).some(plan => plan.id === "damaged"), false);
  assert.ok(checked > 0); synchronous.mock.restore(); asynchronous.mock.restore();
  assert.equal((await f.read()).length, 3);
});
