import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { defaultPerformanceMonitoringConfig, type PerformanceSample } from "../shared/performanceContract.js";
import { PerformanceStore } from "./performanceStore.js";

function sample(time: string): PerformanceSample {
  return {
    schemaVersion: 1,
    kind: "performance_sample",
    sampleId: `sample-${time}`,
    time,
    intervalMs: 5000,
    source: { kind: "manager", id: "manager", runtimeId: "runtime-1", pid: 123 },
    system: {
      cpuPercent: 12.5,
      rssBytes: 1000,
      heapUsedBytes: 500,
      heapTotalBytes: 800,
      externalBytes: 50,
      eventLoopP50Ms: 2,
      eventLoopP95Ms: 8,
      eventLoopMaxMs: 12,
      eventLoopUtilization: 0.2
    },
    http: {
      operation: "all",
      count: 3,
      errorCount: 1,
      totalMs: 210,
      p50Ms: 20,
      p95Ms: 120,
      maxMs: 180,
      totalBytes: 3000,
      maxBytes: 1500,
      operations: [{
        operation: "/gateways",
        count: 3,
        errorCount: 1,
        totalMs: 210,
        p50Ms: 20,
        p95Ms: 120,
        maxMs: 180,
        totalBytes: 3000,
        maxBytes: 1500
      }]
    },
    operations: [{
      operation: "manager.gateways.build_diagnostics",
      count: 1,
      errorCount: 0,
      totalMs: 72,
      p50Ms: 72,
      p95Ms: 72,
      maxMs: 72
    }]
  };
}

test("performance store writes independent hourly JSONL and builds recent summaries", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-performance-store-"));
  const config = { ...defaultPerformanceMonitoringConfig(), enabled: true };
  const store = new PerformanceStore(root, config);
  try {
    await store.start();
    const now = new Date();
    now.setMinutes(5, 0, 0);
    assert.equal(store.append(sample(now.toISOString())), true);
    assert.equal(store.append(sample(now.toISOString())), false);
    await store.flush();

    const files = fs.readdirSync(path.join(root, "data", ".runtime", "performance"));
    assert.equal(files.length, 1);
    assert.match(files[0], /^performance-\d{4}-\d{2}-\d{2}-\d{2}\.jsonl$/);
    const persisted = fs.readFileSync(path.join(root, "data", ".runtime", "performance", files[0]), "utf8");
    assert.equal(persisted.trim().split(/\r?\n/).length, 1);
    assert.equal(JSON.parse(persisted.trim()).sampleId, `sample-${now.toISOString()}`);

    const summary = store.summary(60 * 60 * 1000);
    assert.equal(summary.sources.length, 1);
    assert.equal(summary.points[0].requestCount, 3);
    assert.equal(summary.points[0].errorCount, 1);
    assert.equal(summary.httpOperations[0].operation, "/gateways");
    assert.equal(summary.httpOperations[0].totalBytes, 3000);
    assert.equal(summary.hotOperations[0].operation, "manager.gateways.build_diagnostics");
    assert.equal(summary.hotOperations[0].totalMs, 72);
    assert.equal(summary.status.logDirectory, "data/.runtime/performance");
  } finally {
    await store.stop();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("performance store rejects malformed source kinds", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-performance-invalid-"));
  const store = new PerformanceStore(root, { ...defaultPerformanceMonitoringConfig(), enabled: true });
  try {
    await store.start();
    const invalid = sample(new Date().toISOString()) as unknown as {
      source: { kind: string; id: string; runtimeId: string };
    };
    invalid.source.kind = "external";
    assert.equal(store.append(invalid as PerformanceSample), false);
  } finally {
    await store.stop();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("disabled performance store keeps existing history but rejects new records", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-performance-disabled-"));
  const store = new PerformanceStore(root, defaultPerformanceMonitoringConfig());
  try {
    await store.start();
    assert.equal(store.append(sample(new Date().toISOString())), false);
    assert.equal(store.recent().length, 0);
  } finally {
    await store.stop();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("performance store keeps 3000 ordered appends below the monitoring overhead budget", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-performance-budget-"));
  const store = new PerformanceStore(root, {
    ...defaultPerformanceMonitoringConfig(),
    enabled: true,
    retentionHours: 720
  });
  try {
    await store.start();
    const startedAt = performance.now();
    const baseTime = Date.now() - 3_000 * 5_000;
    for (let index = 0; index < 3_000; index += 1) {
      assert.equal(store.append(sample(new Date(baseTime + index * 5_000).toISOString())), true);
    }
    const durationMs = performance.now() - startedAt;
    assert.ok(durationMs < 1_500, `3000 appends took ${durationMs.toFixed(1)} ms`);
  } finally {
    await store.stop();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
