import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Readable } from "node:stream";
import { defaultPerformanceMonitoringConfig, type PerformanceSample } from "../shared/performanceContract.js";
import { PerformanceStore } from "./performanceStore.js";

function seed(root: string, count: number): PerformanceSample {
  const time = new Date(Date.now() - 60_000).toISOString();
  const item: PerformanceSample = { schemaVersion: 1, kind: "performance_sample", sampleId: "fixture", time, intervalMs: 1_000,
    source: { kind: "manager", id: "synthetic", runtimeId: "restart-fixture" } };
  const directory = path.join(root, "data", ".runtime", "performance");
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, `performance-${time.slice(0, 13).replace("T", "-")}.jsonl`),
    Array.from({ length: count }, (_, index) => JSON.stringify({ ...item, sampleId: `synthetic-${index}` })).join("\n") + "\n");
  return item;
}

test("a hydrated store restart preserves aggregates beyond its dedupe window", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rabi-performance-restart-"));
  const store = new PerformanceStore(root, { ...defaultPerformanceMonitoringConfig(), enabled: true });
  try {
    const item = seed(root, 10_001);
    await store.start();
    assert.equal(store.status().loaded, true);
    assert.equal(store.memoryUsage().representedSamples, 10_001);
    await store.stop();
    await store.start();
    assert.equal(store.memoryUsage().representedSamples, 10_001);
    assert.equal(store.append({ ...item, sampleId: "new-after-reactivation", time: new Date().toISOString() }), true);
    assert.equal(store.memoryUsage().representedSamples, 10_002);
    await store.stop();
    await store.start();
    assert.equal(store.memoryUsage().representedSamples, 10_002);
  } finally {
    await store.stop();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("failed preparation does not mark hydration complete and a later start loads history", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rabi-performance-start-retry-"));
  const store = new PerformanceStore(root, { ...defaultPerformanceMonitoringConfig(), enabled: true });
  try {
    const blocker = path.join(root, "data");
    fs.writeFileSync(blocker, "synthetic-blocker");
    await assert.rejects(store.start());
    assert.equal(store.status().loaded, false);
    fs.unlinkSync(blocker);
    seed(root, 2);
    await store.start();
    assert.equal(store.status().loaded, true);
    assert.equal(store.memoryUsage().representedSamples, 2);
    await store.stop();
    await store.start();
    assert.equal(store.memoryUsage().representedSamples, 2);
  } finally {
    await store.stop();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a caught history read error can retry after the store reports loaded", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rabi-performance-history-retry-"));
  const store = new PerformanceStore(root, { ...defaultPerformanceMonitoringConfig(), enabled: true });
  const loadRecent = Reflect.get(store, "loadRecent");
  let injectReadError = true;
  Object.defineProperty(store, "loadRecent", { value: async () => {
    if (!injectReadError) return Reflect.apply(loadRecent, store, []);
    injectReadError = false;
    const readdir = fs.promises.readdir;
    fs.promises.readdir = async () => { throw new Error("synthetic history read failure"); };
    try { return await Reflect.apply(loadRecent, store, []); }
    finally { fs.promises.readdir = readdir; }
  } });
  try {
    seed(root, 2);
    await store.start();
    assert.equal(store.status().loaded, true);
    assert.equal(store.status().lastError, "synthetic history read failure");
    assert.equal(store.memoryUsage().representedSamples, 0);
    await store.stop();
    await store.start();
    assert.equal(store.status().lastError, undefined);
    assert.equal(store.memoryUsage().representedSamples, 2);
    await store.stop();
    await store.start();
    assert.equal(store.memoryUsage().representedSamples, 2);
  } finally {
    await store.stop();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

for (const partial of [false, true]) test(`a ${partial ? "partially read" : "unreadable"} history shard preserves good data and recovery rebuilds bounded aggregates without replay`, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rabi-performance-partial-history-"));
  const store = new PerformanceStore(root, { ...defaultPerformanceMonitoringConfig(), enabled: true });
  const sample = seed(root, 10_001);
  const directory = path.join(root, "data", ".runtime", "performance");
  const initial = fs.readdirSync(directory)[0];
  const shard = (offset: number) => `performance-${new Date(Date.now() + offset * 3600000).toISOString().slice(0, 13).replace("T", "-")}.jsonl`;
  const first = shard(-2), middle = shard(-1), last = shard(0);
  if (initial !== first) fs.renameSync(path.join(directory, initial), path.join(directory, first));
  const http = { operation: "all", count: 1, errorCount: 0, totalMs: 1, p50Ms: 1, p95Ms: 1, maxMs: 1, operations: [] };
  const middleBytes = `${JSON.stringify({ ...sample, sampleId: "recovered-middle", http })}\n`;
  fs.writeFileSync(path.join(directory, middle), middleBytes);
  fs.writeFileSync(path.join(directory, last), `${JSON.stringify({ ...sample, sampleId: "good-after-bad", http })}\n`);
  const originalStream = fs.createReadStream;
  let broken = true, reads = 0;
  t.mock.method(fs, "createReadStream", (filename: fs.PathLike, options?: Parameters<typeof fs.createReadStream>[1]) => {
    reads++;
    if (broken && path.basename(String(filename)) === middle) {
      if (!partial) throw new Error("synthetic unreadable history shard");
      return Readable.from((async function* () { yield middleBytes; throw new Error("synthetic unreadable history shard"); })()) as unknown as fs.ReadStream;
    }
    return originalStream(filename, options);
  });
  try {
    const empty = store.summary(3600000); assert.equal(empty.sources.length, 0);
    await store.start();
    assert.equal(store.memoryUsage().representedSamples, 10_002 + Number(partial), "a bad shard cannot hide the later good shard");
    assert.match(store.status().lastError ?? "", /synthetic unreadable history shard/);
    assert.equal(store.append({ ...sample, sampleId: "accepted-live", time: new Date().toISOString(), http }), true);
    assert.equal(store.memoryUsage().representedSamples, 10_003 + Number(partial));
    const beforeRecovery = store.summary(3600000);
    assert.equal(beforeRecovery.points.reduce((sum, point) => sum + point.requestCount, 0), 2 + Number(partial));
    await store.stop();
    assert.match(store.status().lastError ?? "", /synthetic unreadable history shard/, "a successful live flush cannot erase a history warning");
    assert.equal(fs.readFileSync(path.join(directory, middle), "utf8"), middleBytes);
    broken = false;
    await store.start();
    assert.equal(store.memoryUsage().representedSamples, 10_004, "recovery includes all persisted good data exactly once");
    const recovered = store.summary(3600000);
    assert.notEqual(recovered, beforeRecovery, "rebuild invalidates the prior summary object");
    assert.equal(recovered.points.reduce((sum, point) => sum + point.requestCount, 0), 3);
    assert.equal(store.status().lastError, undefined);
    await store.stop(); const readsBeforeWarmStart = reads;
    await store.start();
    assert.equal(store.memoryUsage().representedSamples, 10_004);
    assert.equal(reads, readsBeforeWarmStart, "a healthy warm restart does not replay history");
  } finally { await store.stop(); fs.rmSync(root, { recursive: true, force: true }); }
});

test("direct append cannot enter a history rebuild and admitted pending telemetry is flushed first", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rabi-performance-hydration-admission-"));
  const store = new PerformanceStore(root, { ...defaultPerformanceMonitoringConfig(), enabled: true });
  const item = seed(root, 1);
  assert.equal(store.append({ ...item, sampleId: "accepted-before-start" }), true);
  const load = Reflect.get(store, "loadRecent");
  let entered!: () => void, release!: () => void;
  const loading = new Promise<void>(resolve => { entered = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
  Object.defineProperty(store, "loadRecent", { value: async () => { entered(); await gate; return Reflect.apply(load, store, []); } });
  const starting = store.start();
  try {
    await loading;
    assert.equal(store.status().pendingRecords, 0);
    assert.equal(store.append({ ...item, sampleId: "not-admitted-during-hydration" }), false);
    release(); await starting;
    assert.equal(store.memoryUsage().representedSamples, 2);
    assert.equal(store.append({ ...item, sampleId: "accepted-after-hydration" }), true);
  } finally { release(); await starting; await store.stop(); fs.rmSync(root, { recursive: true, force: true }); }
});

test("a summary read during hydration cannot remain cached after the history finishes", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rabi-performance-history-cache-"));
  const store = new PerformanceStore(root, { ...defaultPerformanceMonitoringConfig(), enabled: true });
  const item = seed(root, 1), directory = path.join(root, "data", ".runtime", "performance");
  fs.appendFileSync(path.join(directory, fs.readdirSync(directory)[0]), `${JSON.stringify({ ...item, sampleId: "other-source", source: { ...item.source, id: "other" } })}\n`);
  const remember = Reflect.get(store, "remember");
  let partial: ReturnType<PerformanceStore["summary"]> | undefined;
  Object.defineProperty(store, "remember", { value: (...args: unknown[]) => {
    Reflect.apply(remember, store, args);
    partial ??= store.summary(3600000);
  } });
  try {
    await store.start();
    assert.equal(partial?.sources.length, 1);
    const complete = store.summary(3600000);
    assert.notEqual(complete, partial);
    assert.equal(complete.sources.length, 2);
  } finally { await store.stop(); fs.rmSync(root, { recursive: true, force: true }); }
});

for (const code of ["EACCES", "ENOENT"]) test(`one shard stat ${code} preserves readable history and partial disk statistics`, async t => {
  t.mock.method(Date, "now", () => Date.UTC(2026, 0, 1, 12, 0, 10));
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rabi-performance-shard-stat-"));
  const store = new PerformanceStore(root, { ...defaultPerformanceMonitoringConfig(), enabled: true });
  const item = seed(root, 1), directory = path.join(root, "data", ".runtime", "performance");
  const name = `performance-${new Date(Date.parse(item.time) - 3600000).toISOString().slice(0, 13).replace("T", "-")}.jsonl`;
  const badFile = path.join(directory, name), bytes = `${JSON.stringify({ ...item, sampleId: "metadata-unavailable" })}\n`;
  fs.writeFileSync(badFile, bytes);
  const stat = fs.promises.stat;
  t.mock.method(fs.promises, "stat", async (...args: Parameters<typeof stat>) => {
    if (path.basename(String(args[0])) === name) throw Object.assign(new Error(`synthetic shard ${code}`), { code });
    return Reflect.apply(stat, fs.promises, args);
  });
  try {
    await store.start();
    assert.equal(store.status().loaded, true);
    assert.equal(store.memoryUsage().representedSamples, 2);
    assert.equal(store.status().fileCount, 2);
    assert.ok(store.status().diskBytes > 0);
    assert.match(store.status().lastError ?? "", new RegExp(code));
    assert.equal(store.historyStatus().fatalError, undefined);
    assert.equal(fs.readFileSync(badFile, "utf8"), bytes);
  } finally { await store.stop(); fs.rmSync(root, { recursive: true, force: true }); }
});

test("best-effort write drops stay counted and write recovery cannot erase an independent history warning", async t => {
  t.mock.method(Date, "now", () => Date.UTC(2026, 0, 1, 12, 0, 10));
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rabi-performance-best-effort-"));
  const store = new PerformanceStore(root, { ...defaultPerformanceMonitoringConfig(), enabled: true });
  const item = seed(root, 1), directory = path.join(root, "data", ".runtime", "performance");
  const name = `performance-${new Date(Date.parse(item.time) - 3600000).toISOString().slice(0, 13).replace("T", "-")}.jsonl`;
  const filename = path.join(directory, name), bytes = `${JSON.stringify({ ...item, sampleId: "later-restored-history" })}\n`;
  fs.writeFileSync(filename, bytes);
  let historyBroken = true, writeBroken = true;
  const stream = fs.createReadStream, append = fs.promises.appendFile;
  t.mock.method(fs, "createReadStream", (file: fs.PathLike, options?: Parameters<typeof stream>[1]) => {
    if (historyBroken && path.basename(String(file)) === name) throw new Error("synthetic history warning");
    return stream(file, options);
  });
  t.mock.method(fs.promises, "appendFile", async (...args: Parameters<typeof append>) => {
    if (writeBroken) throw new Error("synthetic telemetry write failure");
    return Reflect.apply(append, fs.promises, args);
  });
  try {
    await store.start();
    assert.equal(store.append({ ...item, sampleId: "write-was-dropped" }), true);
    await store.flush();
    assert.equal(store.status().droppedRecords, 1);
    assert.equal(store.status().pendingRecords, 0);
    assert.match(store.status().lastError ?? "", /telemetry write failure/);
    assert.match(store.status().lastError ?? "", /history warning/);
    await store.stop();
    writeBroken = false;
    assert.equal(store.append({ ...item, sampleId: "persisted-after-write-recovery" }), true);
    await store.flush();
    assert.match(store.status().lastError ?? "", /history warning/);
    assert.doesNotMatch(store.status().lastError ?? "", /telemetry write failure/);
    assert.equal(fs.readFileSync(filename, "utf8"), bytes);
    historyBroken = false;
    await store.start();
    assert.equal(store.memoryUsage().representedSamples, 3);
    assert.equal(store.recent().some(sample => sample.sampleId === "write-was-dropped"), false);
    assert.equal(store.status().droppedRecords, 1, "rebuilding persisted history does not claim failed telemetry was durable");
  } finally { await store.stop(); fs.rmSync(root, { recursive: true, force: true }); }
});

for (const code of ["EACCES", "EBUSY"]) test(`a locked retention shard ${code} remains intact while other cleanup and collection proceed`, async t => {
  t.mock.method(Date, "now", () => Date.UTC(2026, 0, 1, 12, 0, 10));
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rabi-performance-locked-retention-"));
  const store = new PerformanceStore(root, { ...defaultPerformanceMonitoringConfig(), enabled: true });
  const item = seed(root, 1), directory = path.join(root, "data", ".runtime", "performance");
  const name = (offset: number) => `performance-${new Date(Date.parse(item.time) - offset * 3600000).toISOString().slice(0, 13).replace("T", "-")}.jsonl`;
  const locked = path.join(directory, name(1)), removable = path.join(directory, name(2));
  const bytes = `${JSON.stringify({ ...item, sampleId: "locked-original" })}\n`;
  fs.writeFileSync(locked, bytes); fs.writeFileSync(removable, `${JSON.stringify({ ...item, sampleId: "expired-removable" })}\n`);
  const expired = new Date(Date.now() - 72 * 3600000); fs.utimesSync(locked, expired, expired); fs.utimesSync(removable, expired, expired);
  const rm = fs.promises.rm; let attempts = 0;
  t.mock.method(fs.promises, "rm", async (...args: Parameters<typeof rm>) => {
    if (String(args[0]) === locked) { attempts++; throw Object.assign(new Error(`synthetic locked retention ${code}`), { code }); }
    return Reflect.apply(rm, fs.promises, args);
  });
  try {
    await store.start();
    assert.equal(attempts, 1);
    assert.equal(fs.readFileSync(locked, "utf8"), bytes);
    assert.equal(fs.existsSync(removable), false);
    assert.match(store.status().lastError ?? "", new RegExp(code));
    assert.equal(store.status().fileCount, 2);
    assert.ok(store.status().diskBytes >= Buffer.byteLength(bytes));
    assert.equal(store.historyStatus().fatalError, undefined);
    assert.equal(store.append({ ...item, sampleId: "live-after-locked-cleanup" }), true);
  } finally { await store.stop(); fs.rmSync(root, { recursive: true, force: true }); }
});
