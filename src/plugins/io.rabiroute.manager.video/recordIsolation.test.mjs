import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { VideoService } from "./service.mjs";
import { VideoProjects } from "./projects.mjs";
const catalog = JSON.parse(await fs.readFile(new URL("./catalog.json", import.meta.url), "utf8"));
const command = { model: catalog.models[0].id, prompt: "A test paper boat.", width: 512, height: 512, frames: 22, seed: 1 };
async function fixture(t) {
  const stateRoot = await fs.mkdtemp(path.join(os.tmpdir(), "rabi-video-record-isolation-"));
  const runtime = { stateRoot, alive: () => true, stop: async () => {} };
  t.after(async () => { assert.equal(path.dirname(stateRoot), path.resolve(os.tmpdir())); await fs.rm(stateRoot, { recursive: true, force: true }); });
  const owner = () => { const result = new VideoService(runtime, catalog, () => {}); result.online = true; result.pump = () => {}; return result; };
  const service = owner(); await service.initialize();
  const seed = async (key, compute = false) => {
    const publicJob = await service.submit(command, key, undefined, { computeOnly: compute });
    const job = service.jobs.get(publicJob.id); job.status = "succeeded"; await service.save(job);
    return { job, file: path.join(stateRoot, ...(compute ? ["compute"] : []), "jobs", `${job.id}.json`) };
  };
  return { runtime, service, owner, seed };
}

test("known damaged task keys stay reserved while valid receipts and new independent jobs work", async t => {
  const f = await fixture(t), good = await f.seed("good-original-key"), bad = await f.seed("bad-original-key");
  const invalid = JSON.stringify({ ...bad.job, createdAt: null }); await fs.writeFile(bad.file, invalid);
  const restored = f.owner(); await restored.initialize();
  assert.equal(restored.snapshot().jobs.length, 1);
  assert.deepEqual(restored.snapshot().recordIssues, [{ id: bad.job.id, scope: "jobs", code: "invalid_record" }]);
  assert.equal((await restored.submit(command, "good-original-key")).id, good.job.id);
  await assert.rejects(restored.submit(command, "bad-original-key"), error => error.status === 409);
  assert.equal((await restored.submit(command, "independent-new-key")).status, "queued");
  assert.equal(await fs.readFile(bad.file, "utf8"), invalid);
  await fs.writeFile(bad.file, JSON.stringify(bad.job)); await restored.initialize();
  assert.equal((await restored.submit(command, "bad-original-key")).id, bad.job.id);
});

test("unreadable task evidence preserves its file and only prevents unmatched submissions in that receipt domain", async t => {
  const f = await fixture(t), good = await f.seed("good-readable-key");
  const file = path.join(f.runtime.stateRoot, "jobs", `${randomUUID()}.json`); await fs.writeFile(file, "{");
  const restored = f.owner(); await restored.initialize();
  assert.equal(restored.snapshot().jobs[0].id, good.job.id);
  assert.equal((await restored.submit(command, "good-readable-key")).id, good.job.id);
  await assert.rejects(restored.submit(command, "unknown-new-key"), error => error.status === 409);
  assert.equal((await restored.submit(command, "independent-compute-key", undefined, { computeOnly: true })).status, "queued");
  assert.equal(await fs.readFile(file, "utf8"), "{");
});

test("duplicate task IDs across directories and duplicate keys retain all original files", async t => {
  for (const duplicateId of [false, true]) {
    const f = await fixture(t), first = await f.seed("duplicate-original-key"), good = await f.seed("unrelated-valid-key");
    const duplicate = { ...first.job, id: duplicateId ? first.job.id : randomUUID(), ...(duplicateId ? { computeOnly: true } : {}) };
    const file = path.join(f.runtime.stateRoot, ...(duplicateId ? ["compute"] : []), "jobs", `${duplicate.id}.json`);
    const before = await fs.readFile(first.file); await fs.writeFile(file, JSON.stringify(duplicate));
    const duplicateBefore = await fs.readFile(file);
    const restored = f.owner(); await restored.initialize();
    assert.deepEqual(restored.snapshot().jobs.map(job => job.id), [good.job.id]);
    assert.equal(restored.recordIssues.length, 2);
    await assert.rejects(restored.submit(command, "duplicate-original-key"), error => error.status === 409);
    assert.deepEqual(await fs.readFile(first.file), before); assert.deepEqual(await fs.readFile(file), duplicateBefore);
  }
});

test("one recovery write failure leaves other jobs readable and keeps the failed receipt reserved", async t => {
  const f = await fixture(t), bad = await f.seed("recovery-failed-key"), good = await f.seed("recovery-valid-key");
  const raw = JSON.stringify({ ...bad.job, status: "running" }); await fs.writeFile(bad.file, raw);
  const restored = f.owner(), original = restored.save.bind(restored);
  restored.save = async job => { if (job.id === bad.job.id) throw new Error("controlled file write failure"); return original(job); };
  await restored.initialize();
  assert.equal(restored.recordIssues[0].code, "recovery_failed");
  assert.equal((await restored.submit(command, "recovery-valid-key")).id, good.job.id);
  await assert.rejects(restored.submit(command, "recovery-failed-key"), error => error.status === 409);
  assert.equal(await fs.readFile(bad.file, "utf8"), raw);
});

test("project listing isolates damaged identities and dates without overwriting originals or bypassing access", async t => {
  const f = await fixture(t), projects = new VideoProjects(f.runtime), id = randomUUID(), bad = randomUUID();
  await projects.create({ id });
  const file = projects.file(bad), raw = JSON.stringify({ id: bad, revision: 0, title: "Bad", updatedAt: null }); await fs.writeFile(file, raw);
  assert.deepEqual((await projects.list()).map(row => row.id), [id]); assert.equal(projects.recordIssues[0].id, bad);
  await assert.rejects(projects.create({ id: bad })); assert.equal(await fs.readFile(file, "utf8"), raw);
  const denied = new Error("access withdrawn"); await assert.rejects(projects.list({ assert() { throw denied; } }), error => error === denied);
  // Retain the original project's documented ID String coercion.
  const coerced = [randomUUID()]; await projects.create({ id: coerced }); assert.deepEqual((await projects.read(String(coerced))).id, coerced);
});
