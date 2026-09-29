import assert from "node:assert/strict";
import test from "node:test";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";
import { atomicRecordingJson } from "./allDayRecording.js";
import { ResourceCache } from "./resourceCache.js";
import { RecordingArchiveBindings } from "./recordingArchiveBindings.js";
import { RecordingArchiveStore } from "./recordingArchiveStore.js";
import { auditRecordingArchiveMutation } from "./recordingArchiveAudit.js";
import { installDataMutationAuditSink, type RecordedDataMutationAudit } from "../observability/dataMutationAudit.js";

test("archive publications audit successful writes, replay and failure without private values", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "archive-audit-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const records: RecordedDataMutationAudit[] = [];
  t.after(installDataMutationAuditSink(record => records.push(record)));
  const role = path.join(root, "private-role");
  await fs.mkdir(path.join(role, "all-day-recording"), { recursive: true });
  const bindings = new RecordingArchiveBindings(root, () => role);
  const namespace = "11111111-1111-4111-8111-111111111111";
  const target = await bindings.provisionNamespace("private-role", namespace);
  await bindings.configure("private-device", "private-role", namespace, 0);
  const store = new RecordingArchiveStore({ resolveOwner: async () => target, workerId: () => "worker" });
  const bytes = Buffer.from("private audio");
  const hash = createHash("sha256").update(bytes).digest("hex");
  await store.putObject("private-device", hash, bytes);
  await store.putObject("private-device", hash, bytes);
  assert.deepEqual(records.filter(record => record.owner === "recording-archive-store").map(record => record.outcome), ["started", "committed", "started", "no_change"]);
  assert.equal(records.filter(record => record.owner === "recording-archive-bindings" && record.outcome === "committed").length, 2);
  const failure = new Error("private transcript failure");
  await assert.rejects(auditRecordingArchiveMutation("fixture", role, async () => { throw failure; }), error => error === failure);
  assert.deepEqual(records.slice(-2).map(record => record.outcome), ["started", "failed"]);
  for (const value of [root, "private-role", "private-device", "private audio", failure.message]) {
    assert.equal(JSON.stringify(records).includes(value), false);
  }
});

test("recording writes audit committed and failed outcomes without private contents", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "recording-audit-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const records: RecordedDataMutationAudit[] = [];
  t.after(installDataMutationAuditSink(record => records.push(record)));
  const filename = path.join(root, "private.json");
  await atomicRecordingJson(filename, { text: "private transcript fixture" });
  assert.deepEqual(records.map(record => record.outcome), ["started", "committed"]);
  assert.equal(JSON.parse(await fs.readFile(filename, "utf8")).text, "private transcript fixture");
  await assert.rejects(atomicRecordingJson(path.join(filename, "blocked.json"), {}));
  assert.deepEqual(records.slice(-2).map(record => record.outcome), ["started", "failed"]);
  const bytes = Buffer.from("private audio fixture");
  const id = createHash("sha256").update(bytes).digest("hex");
  const cache = new ResourceCache(path.join(root, "cache"));
  await cache.put("private owner", id, bytes);
  assert.deepEqual(await cache.read("private owner", id), bytes);
  assert.equal(records.filter(record => record.owner === "resource-cache" && record.outcome === "committed").length, 2);
  const serialized = JSON.stringify(records);
  for (const privateValue of [root, "private transcript fixture", "private audio fixture", "private owner"]) {
    assert.equal(serialized.includes(privateValue), false);
  }
});
