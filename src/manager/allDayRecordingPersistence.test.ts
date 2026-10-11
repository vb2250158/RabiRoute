import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { AllDayRecordingStore, atomicRecordingJson } from "./allDayRecording.js";
import type { AllDayEvent } from "../shared/allDayRecording.js";

test("recording retries a contended preview replacement without losing or duplicating events", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rabi-recording-rename-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = new AllDayRecordingStore(role => path.join(root, role), "computer", path.join(root, "mobile"));
  const time = Date.now() - 1000;
  const row: AllDayEvent = { id: "original", startedAt: time, endedAt: time + 1, source: "window", deviceId: "computer", kind: "window", state: "saved", text: "Editor" };
  await store.append("one", row);
  const target = path.join(store.directory("one"), "recent-preview.json");
  const rename = fs.rename.bind(fs);
  let attempts = 0;
  t.mock.method(fs, "rename", async (source: string, destination: string) => {
    if (destination === target && ++attempts <= 2) {
      assert.deepEqual(JSON.parse(await fs.readFile(target, "utf8")).events.map((event: AllDayEvent) => event.id), ["original"]);
      throw Object.assign(new Error("EPERM: operation not permitted, rename preview"), { code: "EPERM", syscall: "rename" });
    }
    await rename(source, destination);
  });
  const next = { ...row, id: "next", startedAt: time + 10, endedAt: time + 11 };
  await store.append("one", next);
  await store.append("one", next);
  assert.equal(attempts, 4);
  assert.deepEqual((await store.recent("one")).map(event => event.id), ["original", "next"]);
  assert.deepEqual((await store.timeline("one", time - 1, time + 100)).map(event => event.id), ["original", "next"]);
  assert.equal((await fs.readdir(store.directory("one"))).some(name => name.endsWith(".partial")), false);
});

test("failed recording serialization leaves the old JSON intact and cleans its temporary file", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rabi-recording-write-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const target = path.join(root, "recent-preview.json");
  await fs.writeFile(target, '{"events":[]}');
  const value: Record<string, unknown> = {}; value.self = value;
  await assert.rejects(atomicRecordingJson(target, value), /circular/i);
  assert.equal(await fs.readFile(target, "utf8"), '{"events":[]}');
  assert.deepEqual(await fs.readdir(root), ["recent-preview.json"]);
});

test("a permanent recording replacement failure preserves the prior preview and reports its original error", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rabi-recording-failure-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const target = path.join(root, "recent-preview.json");
  await fs.writeFile(target, '{"events":[]}');
  const failure = Object.assign(new Error("ENOSPC: no space left on device, rename preview"), { code: "ENOSPC", syscall: "rename" });
  let attempts = 0;
  t.mock.method(fs, "rename", async () => { attempts++; throw failure; });
  await assert.rejects(atomicRecordingJson(target, { events: ["next"] }), error => error === failure);
  assert.equal(attempts, 1);
  assert.equal(await fs.readFile(target, "utf8"), '{"events":[]}');
  assert.deepEqual(await fs.readdir(root), ["recent-preview.json"]);
});
