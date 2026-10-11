import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { AllDayRecordingStore } from "./allDayRecording.js";
import { DEFAULT_ALL_DAY_SETTINGS, type AllDayEvent } from "../shared/allDayRecording.js";

async function fixture(t: import("node:test").TestContext) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rabi-recording-readiness-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return new AllDayRecordingStore(role => path.join(root, role), "computer", path.join(root, "mobile"));
}
const row = (id: string, time: number): AllDayEvent => ({ id, startedAt: time, endedAt: time + 1,
  source: "window", deviceId: "computer", kind: "window", state: "saved", text: "Editor" });

test("catalog reads share their index body and owner writes invalidate the read cache", async t => {
  const store = await fixture(t), time = Date.now(), day = new Date(time).toISOString().slice(0,10);
  await store.append("one", row("first", time));
  await store.timeline("one", time - 1, time + 100);
  const original = fs.readFile; let reads = 0;
  t.mock.method(fs, "readFile", async (...args: Parameters<typeof fs.readFile>) => {
    if (String(args[0]).endsWith(`${day}.json`)) reads++;
    return original(...args);
  });
  const catalogs = await Promise.all([store.catalog("one",day), store.catalog("one",day)]);
  assert.deepEqual(catalogs.map(value => value.events.map(event => event.id)), [["first"],["first"]]);
  assert.ok(reads <= 1, "one NAS index body read at most");
  await store.append("one", row("second", time + 10));
  assert.deepEqual((await store.catalog("one",day)).events.map(event => event.id).sort(), ["first","second"]);
});

test("background index repair coalesces without blocking available history and retains originals", async t => {
  const store = await fixture(t), time = Date.now(), day = new Date(time).toISOString().slice(0,10);
  await store.append("one", row("first",time));
  const directory = path.join(store.directory("one"),"events",day);
  const before = await fs.readdir(directory), original = fs.readFile;
  let entered!: () => void, release!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const blocked = new Promise<void>(resolve => { release = resolve; });
  t.mock.method(fs,"readFile",async (...args: Parameters<typeof fs.readFile>) => {
    if (String(args[0]).startsWith(directory + path.sep)) { entered(); await blocked; }
    return original(...args);
  });
  let notifications = 0;
  const repair = store.repairIndex("one",day, () => notifications++);
  assert.equal(store.repairIndex("one",day, () => notifications++),repair);
  await started;
  const catalog = await store.catalog("one",day);
  assert.deepEqual(catalog.incompleteDays,[day]);
  release(); await repair;
  assert.equal(notifications,1);
  assert.deepEqual((await store.catalog("one",day)).events.map(event => event.id),["first"]);
  assert.deepEqual(await fs.readdir(directory),before);
});

test("status settings and intent survive slow storage after owner initialization and follow writes", async t => {
  const store = await fixture(t);
  await store.configure("one",DEFAULT_ALL_DAY_SETTINGS); await store.enableRole("one");
  await store.mobileDevices();
  t.mock.method(fs,"readFile",async () => { throw new Error("NAS read unavailable"); });
  assert.equal(await store.enabledRole(),"one");
  assert.deepEqual(await store.settings("one"),DEFAULT_ALL_DAY_SETTINGS);
  assert.deepEqual(await store.mobileDevices(),[]);
  await store.enableRole(null);
  assert.equal(await store.enabledRole(),null);
});
