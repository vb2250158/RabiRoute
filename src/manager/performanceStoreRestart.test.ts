import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
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
