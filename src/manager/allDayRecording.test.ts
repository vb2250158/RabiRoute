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

test("event pages cross empty months and equal timestamps in both directions without losing records", async t => {
  const store = await fixture(t);
  const first = Date.parse("2025-01-01"), last = Date.parse("2026-09-01");
  for (const row of [event("a",first),event("b",first),event("c",last)]) await store.append("one",row);
  const page = await store.page("one","older",{time:last+1,id:""},"all",2);
  assert.deepEqual(page.events.map(row=>row.id),["b","c"]); assert.equal(page.hasMore,true);
  const older = await store.page("one","older",page.cursor,"all",2);
  assert.deepEqual(older.events.map(row=>row.id),["a"]); assert.equal(older.hasMore,false);
  const newer = await store.page("one","newer",older.cursor,"window",2);
  assert.deepEqual(newer.events.map(row=>row.id),["b","c"]); assert.equal(newer.hasMore,false);
  assert.deepEqual((await store.page("one","older",{time:last+1,id:""},"microphone")).events,[]);
});

test("recent preview survives restart without reading a day index or scanning originals", async t => {
  const store = await fixture(t), time = Date.now();
  await store.append("one", event("first", time));
  await store.append("one", event("second", time + 1));
  await store.append("one", event("first", time));
  const restarted = new AllDayRecordingStore(store.roleDirectory, store.hostId, store.mobileRoot);
  const original = fs.readFile;
  t.mock.method(fs, "readFile", async (...args: Parameters<typeof fs.readFile>) => {
    assert.ok(!String(args[0]).includes("events-index"));
    assert.ok(!String(args[0]).includes(`${path.sep}events${path.sep}`));
    return original(...args);
  });
  t.mock.method(fs, "readdir", async () => { throw new Error("History scan must not block first paint"); });
  assert.deepEqual((await restarted.recent("one")).map(row => row.id), ["first", "second"]);
  assert.deepEqual(await restarted.recent("another"), []);
});

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
  await store.receiveMobile("phone-a", {...input, text:"", transcriptionState:"processing"});
  assert.equal((await store.timeline("one", startedAt - 1, startedAt + 2000)).length,0);
  await store.receiveMobile("phone-a", {...input, transcriptionState:"ready"});
  const completed = await store.timeline("one", startedAt - 1, startedAt + 2000);
  assert.equal(completed.length,1);
  assert.equal(completed[0].text,"transcript");
  assert.equal(completed[0].transcriptionState,"ready");
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
  await new Promise(resolve => setTimeout(resolve, 30));
  await service.stop("one");
  assert.equal(sampled, 1);
  assert.equal((await service.snapshot("one")).running, false);
  const restarted = new AllDayRecordingService(store, dependencies);
  assert.equal((await restarted.snapshot("one")).running, false);
});

test("unavailable microphone preserves enabled intent without blocking screen capture", async t => {
  const store = await fixture(t);
  await store.configure("one", { ...DEFAULT_ALL_DAY_SETTINGS, sources: { ...DEFAULT_ALL_DAY_SETTINGS.sources, microphone: true } });
  let captures = 0;
  const service = new AllDayRecordingService(store, { changed: () => {}, capture: async settings => { assert.equal(settings.sources.microphone,false); captures++; return []; }, startMicrophone: async () => { throw new Error("Microphone unavailable"); }, stopMicrophone: async () => {}, audio: async () => [], audioFile: async () => Buffer.alloc(0) });
  t.after(()=>service.dispose());
  await service.start("one");
  await new Promise(resolve=>setTimeout(resolve,50));
  assert.equal(captures,1);
  assert.equal((await service.snapshot("one")).enabled,true);
  assert.match((await service.snapshot("one")).sourceErrors!.microphone!,/unavailable/);
});

test("enable survives shutdown, runtime source changes persist, explicit disable survives restart", async t => {
  const store = await fixture(t);
  const deps = {changed:()=>{},capture:async()=>[],startMicrophone:async()=>"resident",stopMicrophone:async()=>{},audio:async()=>[],audioFile:async()=>Buffer.alloc(0)};
  await store.configure("one",{...DEFAULT_ALL_DAY_SETTINGS,sources:{...DEFAULT_ALL_DAY_SETTINGS.sources,screen:true}});
  const first = new AllDayRecordingService(store,deps);
  await first.start("one"); await first.dispose();
  const second = new AllDayRecordingService(store,deps);
  t.after(()=>second.dispose());
  await second.restore();
  assert.equal((await second.snapshot("one")).running,true);
  await second.configure("one",{...DEFAULT_ALL_DAY_SETTINGS,sources:{...DEFAULT_ALL_DAY_SETTINGS.sources,window:true}});
  assert.equal((await second.snapshot("one")).settings.sources.screen,false);
  assert.equal((await second.snapshot("one")).running,true);
  await second.stop("one");
  const third = new AllDayRecordingService(store,deps); await third.restore();
  assert.equal((await third.snapshot("one")).enabled,false);
  assert.equal((await third.snapshot("one")).running,false);
});

 test("shared microphone reads resident session only since enrollment", async t => {
  const store = await fixture(t);
  await store.configure("one", { ...DEFAULT_ALL_DAY_SETTINGS, sources: { ...DEFAULT_ALL_DAY_SETTINGS.sources, microphone: true } });
  const queries: { since: number; session: string }[] = [];
  let stopped = "";
  const service = new AllDayRecordingService(store, { changed: () => {}, capture: async () => [], startMicrophone: async () => "resident", stopMicrophone: async id => { stopped = id; }, audio: async (since, _until, session) => { queries.push({ since, session }); return []; }, audioFile: async () => Buffer.alloc(0) });
  const before = Date.now();
  await service.start("one");
  await new Promise(resolve=>setTimeout(resolve,30));
  await service.stop("one");
  assert.ok(queries.length > 0);
  assert.ok(queries.every(query => query.session === "resident" && query.since >= before));
  assert.notEqual(stopped, "resident");
});


test("review hides raw audio before pagination; ASR keeps capture identity, time and media", async t => {
  const store = await fixture(t), time = Date.now()-10000;
  const audio = {...event("recognized",time),kind:"audio" as const,source:"microphone" as const,text:"hello",transcriptionState:"ready" as const,media:"media/retained.wav"};
  await store.append("one",audio);
  for (const [i,state] of ["pending","processing","empty","error","ready"].entries())
    await store.append("one",{...audio,id:`hidden-${i}`,startedAt:time+i+1,text:"  ",transcriptionState:state as AllDayEvent["transcriptionState"]});
  await store.append("one",event("image-neighbor",time+10));
  assert.deepEqual((await store.recent("one")).map(x=>x.id),["recognized","image-neighbor"]);
  assert.deepEqual((await store.timeline("one",time-1,time+2000)).map(x=>x.id),["recognized","image-neighbor"]);
  const page = await store.page("one","older",{time:time+100,id:""},"all",1,"asr");
  assert.equal(page.hasMore,false); assert.deepEqual(page.events,[audio]);
  await store.append("one",{...audio,id:"hidden-0",startedAt:time+1,text:"late transcript"});
  const next = await store.page("one","newer",{time,id:"recognized"},"all",1,"asr");
  assert.equal(next.events[0].id,"hidden-0"); assert.equal(next.events[0].startedAt,time+1);
  assert.equal(next.events[0].media,audio.media);
});
