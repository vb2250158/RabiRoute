import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { PerformanceStore } from "./performanceStore.js";
import { defaultPerformanceMonitoringConfig, type PerformanceSample } from "../shared/performanceContract.js";

const config = { ...defaultPerformanceMonitoringConfig(), enabled: true, retentionHours: 720, maxDiskMb: 4096 };
function sample(id: string, time = Date.now()): PerformanceSample {
  return { schemaVersion: 1, kind: "performance_sample", sampleId: id, time: new Date(time).toISOString(), intervalMs: 5000,
    source: { kind: "manager", id: "synthetic", runtimeId: "synthetic" }, frontend: { page: "合成🌙", longTaskCount: 0, longTaskMaxMs: 0 } };
}
function shard(time: number): string { return `performance-${new Date(time).toISOString().slice(0, 13).replace("T", "-")}.jsonl`; }
function fixture(count = 50) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rabi-perf-disk-index-"));
  const store = new PerformanceStore(root, config), directory = store.logDirectory;
  fs.mkdirSync(directory, { recursive: true });
  for (let i = 0; i < count; i++) fs.writeFileSync(path.join(directory, shard(Date.now() - i * 3600000)), JSON.stringify(sample(`seed-${i}`, Date.now() - i * 3600000)) + "\n");
  return { root, store, directory, async close() { await store.stop(); fs.rmSync(root, { recursive: true, force: true }); } };
}
function actual(directory: string) {
  const files = fs.readdirSync(directory).filter(name => /^performance-.*\.jsonl$/.test(name));
  return { fileCount: files.length, diskBytes: files.reduce((n, name) => n + fs.statSync(path.join(directory, name)).size, 0) };
}
function assertDisk(f: ReturnType<typeof fixture>) {
  const expected = actual(f.directory), status = f.store.status();
  assert.equal(status.fileCount, expected.fileCount); assert.equal(status.diskBytes, expected.diskBytes);
}

test("scheduled 100ms batches update known shard bytes without rescanning unrelated files", async t => {
  const f = fixture();
  try {
    await f.store.start(); let stats = 0, reads = 0;
    const stat = fs.promises.stat, readdir = fs.promises.readdir;
    t.mock.method(fs.promises, "stat", async (...args: Parameters<typeof stat>) => { stats++; return Reflect.apply(stat, fs.promises, args); });
    t.mock.method(fs.promises, "readdir", async (...args: Parameters<typeof readdir>) => { reads++; return Reflect.apply(readdir, fs.promises, args); });
    for (let i = 0; i < 3; i++) {
      assert.equal(f.store.append(sample(`live-${i}`)), true);
      await delay(125); await f.store.flush(); assertDisk(f);
    }
    assert.equal(reads, 0); assert.equal(stats, 0);
    assert.ok(f.store.status().lastPersistedAt);
  } finally { await f.close(); }
});

test("new shard discovers an existing external prefix once then counts exact UTF8 bytes", async t => {
  const f = fixture(2);
  try {
    await f.store.start(); const time = Date.now() + 3600000, name = shard(time), prefix = "external-prefix\n";
    fs.writeFileSync(path.join(f.directory, name), prefix); let stats = 0;
    const stat = fs.promises.stat;
    t.mock.method(fs.promises, "stat", async (...args: Parameters<typeof stat>) => { stats++; return Reflect.apply(stat, fs.promises, args); });
    f.store.append(sample("new-hour", time)); await f.store.flush(); assertDisk(f);
    f.store.append(sample("same-hour", time + 1000)); await f.store.flush(); assertDisk(f);
    assert.equal(stats, 1); assert.ok(fs.readFileSync(path.join(f.directory, name), "utf8").startsWith(prefix));
  } finally { await f.close(); }
});

test("partial failed append reconciles actual bytes and preserves original best-effort failure", async t => {
  const f = fixture(2);
  try {
    await f.store.start(); const file = path.join(f.directory, shard(Date.now())), before = fs.readFileSync(file);
    const append = fs.promises.appendFile; let fail = true;
    t.mock.method(fs.promises, "appendFile", async (...args: Parameters<typeof append>) => {
      if (fail) { fail = false; await append(args[0], "partial🌙", "utf8"); throw new Error("synthetic partial append"); }
      return Reflect.apply(append, fs.promises, args);
    });
    f.store.append(sample("failed")); await f.store.flush(); assertDisk(f);
    assert.equal(f.store.status().droppedRecords, 1); assert.match(f.store.status().lastError ?? "", /partial append/);
    assert.ok(fs.readFileSync(file).subarray(0, before.length).equals(before));
    f.store.append(sample("recovered")); await f.store.flush(); assertDisk(f);
    assert.equal(f.store.status().droppedRecords, 1); assert.equal(f.store.status().lastError, undefined);
  } finally { await f.close(); }
});

test("unreadable new shard stays partial until that shard metadata is readable", async t => {
  const f = fixture(1);
  try {
    await f.store.start(); const time = Date.now() + 3600000, name = shard(time), file = path.join(f.directory, name);
    fs.writeFileSync(file, "unreadable prefix\n"); const stat = fs.promises.stat; let denied = true;
    t.mock.method(fs.promises, "stat", async (...args: Parameters<typeof stat>) => {
      if (denied && path.basename(String(args[0])) === name) throw Object.assign(new Error("synthetic metadata EACCES"), { code: "EACCES" });
      return Reflect.apply(stat, fs.promises, args);
    });
    f.store.append(sample("unknown", time)); await f.store.flush();
    assert.equal(f.store.status().fileCount, 2); assert.equal(f.store.status().diskBytes, actual(f.directory).diskBytes - fs.statSync(file).size);
    assert.match(f.store.status().lastError ?? "", /metadata EACCES/);
    denied = false; f.store.append(sample("metadata-restored", time + 1000)); await f.store.flush(); assertDisk(f);
    assert.match(f.store.status().lastError ?? "", /metadata EACCES/, "successful writes do not erase independent history warnings");
  } finally { await f.close(); }
});

test("restart and original config cleanup discover external changes while locked deletion stays local", async t => {
  const f = fixture(3);
  try {
    await f.store.start(); await f.store.stop();
    const names = fs.readdirSync(f.directory).sort(), locked = path.join(f.directory, names[0]), removable = path.join(f.directory, names[1]);
    fs.appendFileSync(locked, "external repair\n"); const old = new Date(Date.now() - 800 * 3600000);
    fs.utimesSync(locked, old, old); fs.utimesSync(removable, old, old);
    const rm = fs.promises.rm;
    t.mock.method(fs.promises, "rm", async (...args: Parameters<typeof rm>) => {
      if (String(args[0]) === locked) throw Object.assign(new Error("synthetic retention EBUSY"), { code: "EBUSY" });
      return Reflect.apply(rm, fs.promises, args);
    });
    await f.store.start(); assertDisk(f); assert.ok(fs.existsSync(locked)); assert.equal(fs.existsSync(removable), false);
    assert.match(f.store.status().lastError ?? "", /retention EBUSY/);
    const extra = path.join(f.directory, "performance-external.jsonl"); fs.writeFileSync(extra, "external new file\n");
    f.store.applyConfig(config); await f.store.stop(); assertDisk(f);
  } finally { await f.close(); }
});

test("cleanup snapshot cannot overwrite a concurrent append delta and stop joins owned disk work", async t => {
  const f = fixture(2);
  try {
    await f.store.start(); const stat = fs.promises.stat; let enter!: () => void, release!: () => void;
    const entered = new Promise<void>(resolve => { enter = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
    let held = false;
    t.mock.method(fs.promises, "stat", async (...args: Parameters<typeof stat>) => {
      const value = await Reflect.apply(stat, fs.promises, args);
      if (!held) { held = true; enter(); await gate; }
      return value;
    });
    f.store.applyConfig(config); await entered;
    f.store.append(sample("concurrent")); const flush = f.store.flush(); let stopped = false;
    const stop = f.store.stop().then(() => { stopped = true; }); await delay(10); assert.equal(stopped, false);
    release(); await Promise.all([flush, stop]); assertDisk(f); assert.equal(stopped, true);
  } finally { await f.close(); }
});
