import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { ManagerReadWorkerPool } from "./managerReadWorkerPool.js";
import type { RecentMemoryCatalogRead } from "../roleKnowledge.js";
import { readCompanionContext } from "./companionContextReader.js";
import type { CompanionSession } from "../shared/companionActivity.js";

const session: CompanionSession = {
  id: "fixture-session", roleId: "fixture", gatewayId: "route", presetId: "watch", title: "", status: "active",
  revision: 1, startedAt: 1, lastObservationAt: null, positionSeconds: null, subtitle: "", autoReview: true,
  voice: false, saveSummary: false, notes: [], review: null, error: "", observationOwner: "desktop",
  window: null, activityKind: "watch", version: 1
};

async function writePersona(root: string) {
  await fs.mkdir(path.join(root, "prompts"), { recursive: true });
  await fs.writeFile(path.join(root, "persona.md"), "A fixture persona.");
  await fs.writeFile(path.join(root, "prompts", "companionship.md"), "Accompany the user.");
}

test("companion memory worker reads valid memories despite unavailable plans and isolates malformed records", { timeout: 30_000 }, async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "companion-memory-isolation-"));
  const pool = new ManagerReadWorkerPool({ maxConcurrency: 1, timeoutMs: 20_000 });
  t.after(async () => { await pool.stop(); await fs.rm(root, { recursive: true, force: true }); });
  const recent = path.join(root, "memory", "recent");
  await fs.mkdir(recent, { recursive: true });
  // These dependencies are deliberately unusable: a complete knowledge read must not be attempted.
  await fs.writeFile(path.join(root, "plans"), "unavailable plan storage");
  await fs.writeFile(path.join(root, "memory", "consolidated"), "unavailable consolidated storage");
  const valid = { id: "valid", title: "Remembered preference", focus: "Preference", content: "Keep the response brief.",
    createdAt: "2026-10-30T00:00:00.000Z", updatedAt: "2026-10-30T00:00:00.000Z", keywords: ["preference"] };
  await writePersona(root);
  await fs.writeFile(path.join(recent, "a-valid.json"), JSON.stringify(valid));
  await fs.writeFile(path.join(recent, "b-broken.json"), "{broken");
  await fs.writeFile(path.join(recent, "c-valid.json"), JSON.stringify({ ...valid, id: "valid-c", title: "Another preference" }));
  await fs.writeFile(path.join(recent, "d-structure.json"), JSON.stringify({ title: "Missing required content" }));
  const read = () => pool.run<RecentMemoryCatalogRead>({ type: "role_recent_memory_catalog", roleDir: root });
  const first = await read();
  assert.deepEqual(first.memories.map(item => item.id), ["valid", "valid-c"]);
  assert.deepEqual(first.issues.map(item => item.file).sort(), ["b-broken.json", "d-structure.json"]);
  assert.deepEqual(first.issues.map(item => item.message).sort(), ["invalid_json", "invalid_record"]);
  assert.equal("content" in first.memories[0], false);
  const issues: RecentMemoryCatalogRead["issues"] = [];
  const context = await readCompanionContext({ roleDirectory: root, session }, { pool, onIssues: value => issues.push(...value) });
  assert.match(context, /Remembered preference/);
  assert.match(context, /Another preference/);
  assert.equal(issues.length, 2);
  await readCompanionContext({ roleDirectory: root, session }, { pool, onIssues: value => issues.push(...value) });
  assert.equal(issues.length, 2, "unchanged bad files must not repeat diagnostics every review");
  // The resident worker must see edits, not permanently serve its parsed-body cache.
  await fs.writeFile(path.join(recent, "a-valid.json"), JSON.stringify({ ...valid, focus: "An updated longer preference." }));
  assert.equal((await read()).memories[0].focus, "An updated longer preference.");
  for (let index = 0; index < 5; index++) await fs.writeFile(path.join(recent, `extra-${index}.json`), JSON.stringify({
    ...valid, id: `extra-${index}`, updatedAt: "2026-10-29T00:00:00.000Z", content: "private body".repeat(1000)
  }));
  const bounded = await read();
  assert.equal(bounded.memories.length, 3);
  assert.ok(JSON.stringify(bounded).length < 2000, "the worker must not transfer unused memory bodies");
});

test("companion memory worker reports a directory failure instead of publishing empty memories", { timeout: 30_000 }, async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "companion-memory-failure-"));
  const pool = new ManagerReadWorkerPool({ maxConcurrency: 1, timeoutMs: 20_000 });
  t.after(async () => { await pool.stop(); await fs.rm(root, { recursive: true, force: true }); });
  await fs.mkdir(path.join(root, "memory"));
  await fs.writeFile(path.join(root, "memory", "recent"), "not a directory");
  await writePersona(root);
  const read = () => readCompanionContext({ roleDirectory: root, session }, { pool });
  await assert.rejects(read(), { code: "COMPANION_CONTEXT_FAILED" });
  await fs.unlink(path.join(root, "memory", "recent"));
  await fs.mkdir(path.join(root, "memory", "recent"));
  await fs.writeFile(path.join(root, "memory", "recent", "recovered.json"), JSON.stringify({
    id: "recovered", title: "Recovered memory", content: "Readable again", focus: "Restored preference"
  }));
  assert.match(await read(), /Recovered memory/);
});
