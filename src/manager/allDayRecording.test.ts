import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { AllDayRecordingStore, AllDayRecordingService } from "./allDayRecording.js";
import { DEFAULT_ALL_DAY_SETTINGS, type AllDayEvent } from "../shared/allDayRecording.js";

async function fixture(t: import("node:test").TestContext) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rabi-all-day-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return new AllDayRecordingStore(role => path.join(root, role), "computer-a", path.join(root, "mobile"));
}
const event = (id: string, time: number): AllDayEvent => ({ id, startedAt: time, endedAt: time + 1000, source: "window", deviceId: "computer-a", kind: "window", state: "saved", text: "Editor" });

test("concurrent timeline reads share a day scan and append invalidates its cached result", async t => {
  const store = await fixture(t), time = Date.now();
  await store.append("one", event("first", time));
  const original = fs.readFile; let eventReads = 0;
  t.mock.method(fs, "readFile", async (...args: Parameters<typeof fs.readFile>) => {
    if (String(args[0]).includes(`${path.sep}events${path.sep}`)) eventReads++;
    return original(...args);
  });
  await Promise.all([store.timeline("one",time-1,time+2000), store.timeline("one",time-1,time+2000)]);
  assert.equal(eventReads,1);
  await store.timeline("one",time-1,time+2000);
  assert.equal(eventReads,1);
  await store.append("one",event("second",time+1));
  assert.deepEqual((await store.timeline("one",time-1,time+2000)).map(row => row.id),["first","second"]);
  assert.equal(eventReads,1,"append updates the compact index without rescanning event files");
});

test("a damaged day index rebuilds from originals and concurrent writes retain every event", async t => {
  const store = await fixture(t), time = Date.now();
  await store.append("one",event("first",time));
  await store.timeline("one",time-1,time+2000);
  const day = new Date(time).toISOString().slice(0,10);
  await fs.writeFile(path.join(store.directory("one"),"events-index",`${day}.json`),"{broken");
  await Promise.all(Array.from({length:20},(_,i) => store.append("one",event(`event-${i}`,time+i+1))));
  const rows = await store.timeline("one",time-1,time+2000);
  assert.equal(rows.length,21);
  assert.equal(new Set(rows.map(row => row.id)).size,21);
  const snapshot = JSON.parse(await fs.readFile(path.join(store.directory("one"),"events-index",`${day}.json`),"utf8"));
  assert.equal(snapshot.events.length,21);
  await Promise.all(Array.from({length:10},(_,i) => store.append("one",event(`next-${i}`,time+i+50))));
  assert.equal((await store.timeline("one",time-1,time+2000)).length,31);
});

test("index survives directory timestamp drift and recovers an interrupted original write", async t => {
  const store = await fixture(t), time = Date.now();
  await store.append("one",event("first",time));
  await store.timeline("one",time-1,time+2000);
  const day = new Date(time).toISOString().slice(0,10);
  const directory = path.join(store.directory("one"),"events",day);
  await fs.utimes(directory,new Date(time+10000),new Date(time+10000));
  let now = time + 60000;
  t.mock.method(Date,"now",() => now);
  const original = fs.readdir; let scans = 0;
  t.mock.method(fs,"readdir",async (...args: Parameters<typeof fs.readdir>) => { scans++; return original(...args); });
  assert.equal((await store.timeline("one",time-1,time+2000)).length,1);
  assert.equal(scans,0,"valid index never enumerates the source directory");
  await fs.writeFile(path.join(store.directory("one"),"events-index",`${day}.dirty.json`),"{}");
  await fs.writeFile(path.join(directory,`${createHash("sha256").update("interrupted").digest("hex")}.json`),JSON.stringify(event("interrupted",time+1)));
  now += 60000;
  assert.equal((await store.timeline("one",time-1,time+2000)).length,2);
  assert.equal(scans,1);
  await assert.rejects(fs.access(path.join(store.directory("one"),"events-index",`${day}.dirty.json`)));
});

test("local-day timeline spans UTC shards, remains persona-scoped, and deduplicates retries", async t => {
  const store = await fixture(t);
  const since = Date.parse("2026-09-18T16:00:00Z"), until = since + 86400_000;
  const first = event("one", since + 1000), second = event("two", since + 12 * 3600_000);
  await store.append("one", first); await store.append("one", first); await store.append("one", second);
  await store.append("two", event("private", since + 2000));
  assert.deepEqual((await store.timeline("one", since, until)).map(row => row.id), ["one", "two"]);
  assert.equal((await store.timeline("two", since, until)).length, 1);
  await assert.rejects(store.timeline("one", since, since + 48 * 3600_000));
  await assert.rejects(store.media("one", "../../", "bad"));
});

test("mobile events require explicit device selection and retry with a stable identity", async t => {
  const store = await fixture(t), startedAt = Date.now();
  const input = { id: "event-1", startedAt, endedAt: startedAt + 1000, text: "transcript", chunks: ["a".repeat(64)] };
  await store.receiveMobile("phone-a", input); await store.receiveMobile("phone-a", input);
  assert.equal((await store.timeline("one", startedAt - 1, startedAt + 2000)).length, 0);
  const deviceId = createHash("sha256").update("phone-a").digest("hex");
  await store.configure("one", { ...DEFAULT_ALL_DAY_SETTINGS, mobileDeviceIds: [deviceId] });
  assert.equal((await store.timeline("one", startedAt - 1, startedAt + 2000)).length, 1);
  assert.equal((await store.timeline("two", startedAt - 1, startedAt + 2000)).length, 0);
  await assert.rejects(store.receiveMobile("phone-a", { ...input, chunks: ["../../secret"] }));
});

test("settings do not start capture; one host owner and explicit stop serialize capture", async t => {
  const store = await fixture(t);
  let sampled = 0;
  const dependencies = { changed: () => {}, capture: async () => { sampled++; return [{ source: "window" as const, text: "Editor" }]; }, startMicrophone: async () => {}, stopMicrophone: async () => {}, audio: async () => [], audioFile: async () => Buffer.alloc(0) };
  const service = new AllDayRecordingService(store, dependencies);
  t.after(() => service.dispose());
  await service.configure("one", { ...DEFAULT_ALL_DAY_SETTINGS, sources: { ...DEFAULT_ALL_DAY_SETTINGS.sources, window: true } });
  assert.equal((await service.snapshot("one")).running, false);
  assert.equal(sampled, 0);
  await service.start("one");
  await assert.rejects(service.start("two"), /Another persona/);
  await assert.rejects(service.configure("one", DEFAULT_ALL_DAY_SETTINGS), /Pause/);
  await new Promise(resolve => setTimeout(resolve, 30));
  await service.stop("one");
  assert.equal(sampled, 1);
  assert.equal((await service.snapshot("one")).running, false);
  const restarted = new AllDayRecordingService(store, dependencies);
  assert.equal((await restarted.snapshot("one")).running, false);
});

test("microphone failure never leaves a falsely running session", async t => {
  const store = await fixture(t);
  await store.configure("one", { ...DEFAULT_ALL_DAY_SETTINGS, sources: { ...DEFAULT_ALL_DAY_SETTINGS.sources, microphone: true } });
  const service = new AllDayRecordingService(store, { changed: () => {}, capture: async () => [], startMicrophone: async () => { throw new Error("Microphone in use"); }, stopMicrophone: async () => {}, audio: async () => [], audioFile: async () => Buffer.alloc(0) });
  await assert.rejects(service.start("one"), /in use/);
  assert.equal((await service.snapshot("one")).running, false);
});

 test("shared microphone reads resident session only since enrollment", async t => {
  const store = await fixture(t);
  await store.configure("one", { ...DEFAULT_ALL_DAY_SETTINGS, sources: { ...DEFAULT_ALL_DAY_SETTINGS.sources, microphone: true } });
  const queries: { since: number; session: string }[] = [];
  let stopped = "";
  const service = new AllDayRecordingService(store, { changed: () => {}, capture: async () => [], startMicrophone: async () => "resident", stopMicrophone: async id => { stopped = id; }, audio: async (since, _until, session) => { queries.push({ since, session }); return []; }, audioFile: async () => Buffer.alloc(0) });
  const before = Date.now();
  await service.start("one");
  await service.stop("one");
  assert.ok(queries.length > 0);
  assert.ok(queries.every(query => query.session === "resident" && query.since >= before));
  assert.notEqual(stopped, "resident");
});
