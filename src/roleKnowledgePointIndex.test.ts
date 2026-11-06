import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { getPlanAsync as getPlanFreshAsync, readPlanPointCandidateHint, validatePlanPointCandidateHint, readPlanPageCatalogInWorker, planPageReadDiagnostics, clearPlanCatalogAfterStartupMigration, publishRolePlanCatalog } from "./roleKnowledge.js";
import { planJsonFile } from "./planStorageLayout.js";
import { planReadFence, invalidatePlanReads } from "./planReadInvalidation.js";

// Same two-stage protocol as the parent: hint is copied, real getter reads files, then owner validates.
async function getPlanAsync(roleDir: string, planId: string, options: { catalogFence?: ReturnType<typeof planReadFence> } = {}) {
  if (!options.catalogFence) return getPlanFreshAsync(roleDir, planId);
  await new Promise<void>(resolve => setImmediate(resolve));
  const hint = readPlanPointCandidateHint(roleDir, planId, options.catalogFence);
  if (!hint) return getPlanFreshAsync(roleDir, planId);
  let accepted = true;
  const plan = await getPlanFreshAsync(roleDir, planId, {
    candidateFiles: structuredClone(hint.paths), onHintRejected: () => { accepted = false; }
  });
  if (!accepted) return plan;
  await new Promise<void>(resolve => setImmediate(resolve));
  return validatePlanPointCandidateHint(roleDir, planId, options.catalogFence, hint.token)
    ? plan : getPlanFreshAsync(roleDir, planId);
}

function fixture(t: { after(action: () => void): void }, count = 64) {
  const roleDir = fs.mkdtempSync(path.join(os.tmpdir(), "rabi-point-membership-"));
  t.after(() => { clearPlanCatalogAfterStartupMigration(roleDir); fs.rmSync(roleDir, { recursive: true, force: true }); });
  const raw = (id: string, title = id) => ({ id, title, status: "待处理", archiveStatus: "未归档", keywords: ["fixture"],
    steps: [{ id: "one", title: "Nested", description: "Only synthetic data" }],
    taskBinding: { agentType: "codex", sessionId: "synthetic-task", sessionTitle: "Original title", workspace: roleDir },
    createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z" });
  const write = (id: string, value = raw(id), file = planJsonFile(roleDir, id, "active")) => {
    fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(value)); return file;
  };
  for (let i = 0; i < count; i++) write(`synthetic-${i}`);
  const warm = async () => { const fence = planReadFence(roleDir); await readPlanPageCatalogInWorker(roleDir, fence); return fence; };
  const dirty = async (previous = 0) => { const deadline = Date.now() + 2500; while ((planPageReadDiagnostics(roleDir).watchEvents?.length ?? 0) <= previous) {
    assert.ok(Date.now() < deadline, "native watcher must report the owned fixture change"); await delay(5);
  } };
  return { roleDir, raw, write, warm, dirty };
}
function counters(t: { mock: typeof import("node:test").mock }, root: string) {
  const original = { stat: fs.promises.stat, readFile: fs.promises.readFile, readdir: fs.promises.readdir };
  const calls = { stat: 0, read: 0, readdir: 0 };
  t.mock.method(fs.promises, "stat", async (...args: Parameters<typeof original.stat>) => { if (String(args[0]).startsWith(root)) calls.stat++; return Reflect.apply(original.stat, fs.promises, args); });
  t.mock.method(fs.promises, "readFile", async (...args: Parameters<typeof original.readFile>) => { if (String(args[0]).startsWith(root)) calls.read++; return Reflect.apply(original.readFile, fs.promises, args); });
  t.mock.method(fs.promises, "readdir", async (...args: Parameters<typeof original.readdir>) => { if (String(args[0]).startsWith(root)) calls.readdir++; return Reflect.apply(original.readdir, fs.promises, args); });
  const reset = () => { calls.stat = calls.read = calls.readdir = 0; };
  return { calls, reset };
}

test("warm complete same-fence membership avoids unrelated metadata for missing and existing IDs", async t => {
  const f = fixture(t), fence = await f.warm(), c = counters(t, f.roleDir);
  for (let i = 0; i < 3; i++) { assert.equal(await getPlanAsync(f.roleDir, "absent", { catalogFence: fence }), null); }
  assert.deepEqual(c.calls, { stat: 0, read: 0, readdir: 3 }, "only original target recovery directory is rechecked");
  c.reset(); const actual = await getPlanAsync(f.roleDir, "synthetic-2", { catalogFence: fence });
  assert.equal(actual?.taskBinding?.sessionId, "synthetic-task"); assert.ok(actual?.steps.length);
  assert.deepEqual(c.calls, { stat: 0, read: 1, readdir: 1 });
  actual!.title = "Caller mutation"; actual!.steps[0]!.title = "Caller nested mutation";
  const next = await getPlanAsync(f.roleDir, "synthetic-2", { catalogFence: fence });
  assert.equal(next?.title, "synthetic-2"); assert.notEqual(next?.steps[0]?.title, "Caller nested mutation");
});

test("cold, no-fence and changed-fence queries retain the original fresh getter", async t => {
  const f = fixture(t, 8), c = counters(t, f.roleDir), fence = planReadFence(f.roleDir);
  assert.equal(await getPlanAsync(f.roleDir, "absent", { catalogFence: fence }), null); assert.ok(c.calls.stat >= 8);
  await f.warm(); c.reset(); assert.equal(await getPlanAsync(f.roleDir, "absent"), null); assert.equal(c.calls.stat, 8);
  invalidatePlanReads(f.roleDir, "absent"); c.reset();
  assert.equal(await getPlanAsync(f.roleDir, "absent", { catalogFence: planReadFence(f.roleDir) }), null); assert.equal(c.calls.stat, 8);
});

test("published items without a complete physical inventory do not prove absence", async t => {
  const f = fixture(t, 3), fence = planReadFence(f.roleDir);
  publishRolePlanCatalog(f.roleDir, []); const c = counters(t, f.roleDir);
  assert.equal((await getPlanAsync(f.roleDir, "synthetic-1", { catalogFence: fence }))?.id, "synthetic-1");
  assert.ok(c.calls.stat >= 2);
});

test("native external creation, raw-ID replacement and truncation never become cached absence", async t => {
  const f = fixture(t, 3); let fence = await f.warm();
  assert.equal(await getPlanAsync(f.roleDir, "new-one", { catalogFence: fence }), null);
  f.write("new-one"); await f.dirty();
  assert.equal((await getPlanAsync(f.roleDir, "new-one", { catalogFence: fence }))?.id, "new-one");
  fence = await f.warm(); const previous = planPageReadDiagnostics(f.roleDir).watchEvents?.length ?? 0;
  const physical = planJsonFile(f.roleDir, "synthetic-1", "active"); f.write("renamed-id", f.raw("renamed-id"), physical); await f.dirty(previous);
  assert.equal(await getPlanAsync(f.roleDir, "synthetic-1", { catalogFence: fence }), null);
  assert.equal((await getPlanAsync(f.roleDir, "renamed-id", { catalogFence: fence }))?.id, "renamed-id");
  fs.truncateSync(physical, 0);
  assert.equal(await getPlanAsync(f.roleDir, "renamed-id", { catalogFence: fence }), null);
});

test("a target disappearing across the recovery await falls back to the original fresh scan", async t => {
  const f = fixture(t, 3), fence = await f.warm(), target = planJsonFile(f.roleDir, "synthetic-1", "active");
  const readdir = fs.promises.readdir; let changed = false;
  t.mock.method(fs.promises, "readdir", async (...args: Parameters<typeof readdir>) => {
    try { return await Reflect.apply(readdir, fs.promises, args); }
    finally {
      if (!changed && String(args[0]).includes("plan-storage-package-transactions")) { changed = true; fs.unlinkSync(target); }
    }
  });
  assert.equal(await getPlanAsync(f.roleDir, "synthetic-1", { catalogFence: fence }), null); assert.equal(changed, true);
});

test("unrelated duplicate and malformed rows do not turn fresh point access into a role gate", async t => {
  const f = fixture(t, 3), fence = await f.warm();
  f.write("other-alias", f.raw("synthetic-2"));
  fs.writeFileSync(f.write("broken"), "{broken"); await f.dirty();
  assert.equal((await getPlanAsync(f.roleDir, "synthetic-1", { catalogFence: fence }))?.id, "synthetic-1");
  await assert.rejects(getPlanAsync(f.roleDir, "synthetic-2", { catalogFence: fence }), /stable plan id exists in more than one/);
});


test("archive moves and a new page revision replace physical membership without losing full binding", async t => {
  const f = fixture(t, 3); let fence = await f.warm();
  const source = planJsonFile(f.roleDir, "synthetic-1", "active"), target = planJsonFile(f.roleDir, "synthetic-1", "archive");
  const archived = { ...f.raw("synthetic-1"), status: "已归档", activationStatus: "已归档", archiveStatus: "已归档" };
  fs.writeFileSync(source, JSON.stringify(archived)); fs.mkdirSync(path.dirname(path.dirname(target)), { recursive: true });
  fs.renameSync(path.dirname(source), path.dirname(target)); await f.dirty();
  const actual = await getPlanAsync(f.roleDir, "synthetic-1", { catalogFence: fence });
  assert.equal(actual?.archiveStatus, "已归档"); assert.equal(actual?.taskBinding?.sessionId, "synthetic-task");
  fence = await f.warm(); const c = counters(t, f.roleDir);
  assert.equal((await getPlanAsync(f.roleDir, "synthetic-1", { catalogFence: fence }))?.archiveStatus, "已归档");
  assert.deepEqual(c.calls, { stat: 0, read: 1, readdir: 1 });
});

test("noncanonical paths without a raw ID never become addressable through a synthesized page ID", async t => {
  const f = fixture(t, 0);
  t.mock.method(Date, "now", () => 1794000000000);
  const physical = path.join(f.roleDir, "plans", "active", "legacy-opaque", "plan.json");
  const raw = { title: "Only a title", status: "待处理", archiveStatus: "未归档" };
  fs.mkdirSync(path.dirname(physical), { recursive: true }); fs.writeFileSync(physical, JSON.stringify(raw));
  const fence = await f.warm();
  const catalog = await readPlanPageCatalogInWorker(f.roleDir, fence);
  const id = catalog[0]!.id;
  assert.equal(await getPlanFreshAsync(f.roleDir, id), null);
  assert.equal(await getPlanAsync(f.roleDir, id, { catalogFence: fence }), null);
  assert.deepEqual(JSON.parse(fs.readFileSync(physical, "utf8")), raw);
});

test("hint tokens bind the complete catalog object, not a published item or prior dirty revision", async t => {
  const f = fixture(t, 2), fence = await f.warm();
  const hint = readPlanPointCandidateHint(f.roleDir, "absent", fence)!;
  assert.deepEqual(hint.paths, []);
  const positive = readPlanPointCandidateHint(f.roleDir, "synthetic-1", fence)!;
  positive.paths.length = 0;
  assert.equal(readPlanPointCandidateHint(f.roleDir, "synthetic-1", fence)!.paths.length, 1);
  assert.equal(validatePlanPointCandidateHint(f.roleDir, "absent", fence, hint.token), true);
  const previous = planPageReadDiagnostics(f.roleDir).watchEvents?.length ?? 0;
  f.write("new-one"); await f.dirty(previous);
  assert.equal(validatePlanPointCandidateHint(f.roleDir, "absent", fence, hint.token), false);
  await f.warm();
  assert.notEqual(readPlanPointCandidateHint(f.roleDir, "absent", fence)!.token, hint.token);
});
