import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { defaultPerformanceMonitoringConfig, type PerformanceSample } from "../shared/performanceContract.js";
import { PERFORMANCE_STORE_MEMORY_LIMITS } from "./performanceAggregateIndex.js";
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



test("performance summaries remove persistent event streams from current and historical samples", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-performance-stream-filter-"));
  const store = new PerformanceStore(root, { ...defaultPerformanceMonitoringConfig(), enabled: true });
  try {
    await store.start();
    const current = sample(new Date().toISOString());
    current.http = {
      operation: "all",
      count: 2,
      errorCount: 0,
      totalMs: 493_788,
      p50Ms: 12,
      p95Ms: 493_776,
      maxMs: 493_776,
      operations: [
        { operation: "/api/events", count: 1, errorCount: 0, totalMs: 493_776, p50Ms: 493_776, p95Ms: 493_776, maxMs: 493_776 },
        { operation: "/meta", count: 1, errorCount: 0, totalMs: 12, p50Ms: 12, p95Ms: 12, maxMs: 12 }
      ]
    };
    current.slowOperations = [{
      time: current.time,
      operation: "/api/events",
      durationMs: 493_776,
      kind: "http",
      statusCode: 200
    }];
    assert.equal(store.append(current), true);

    const summary = store.summary(60 * 60 * 1000);
    assert.equal(summary.sources[0].latest?.requestP95Ms, 12);
    assert.deepEqual(summary.httpOperations.map(item => item.operation), ["/meta"]);
    assert.equal(summary.slowOperations.some(item => item.operation === "/api/events"), false);
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
    const oversizedId = sample(new Date(Date.now() + 1).toISOString());
    oversizedId.sampleId = "x".repeat(513);
    assert.equal(store.append(oversizedId), false);
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


function aggregateSample(
  time: string,
  index: number,
  options: { count?: number; errorCount?: number; p50Ms?: number; p95Ms?: number; maxMs?: number; cpuPercent?: number } = {}
): PerformanceSample {
  const count = options.count ?? 1;
  const errorCount = options.errorCount ?? 0;
  const p50Ms = options.p50Ms ?? 10;
  const p95Ms = options.p95Ms ?? p50Ms;
  const maxMs = options.maxMs ?? p95Ms;
  const totalMs = p50Ms * count;
  return {
    schemaVersion: 1,
    kind: "performance_sample",
    sampleId: `aggregate-${index}-${time}`,
    time,
    intervalMs: 1_000,
    source: { kind: "manager", id: "manager", runtimeId: "runtime-history", pid: 456 },
    system: {
      cpuPercent: options.cpuPercent ?? 20,
      rssBytes: 2_000,
      heapUsedBytes: 1_000,
      heapTotalBytes: 1_500,
      externalBytes: 100,
      eventLoopP50Ms: 1,
      eventLoopP95Ms: p95Ms,
      eventLoopMaxMs: maxMs,
      eventLoopUtilization: 0.1,
      gcCount: 1,
      gcDurationMs: 2,
      gcMaxMs: 2
    },
    http: {
      operation: "all",
      count,
      errorCount,
      totalMs,
      p50Ms,
      p95Ms,
      maxMs,
      totalBytes: count * 100,
      maxBytes: 100,
      operations: [{
        operation: "/history",
        count,
        errorCount,
        totalMs,
        p50Ms,
        p95Ms,
        maxMs,
        totalBytes: count * 100,
        maxBytes: 100
      }]
    },
    operations: [{
      operation: "manager.history.aggregate",
      count,
      errorCount,
      totalMs,
      p50Ms,
      p95Ms,
      maxMs
    }]
  };
}

function writePerformanceSamples(root: string, samples: PerformanceSample[]): void {
  const directory = path.join(root, "data", ".runtime", "performance");
  fs.mkdirSync(directory, { recursive: true });
  const shards = new Map<string, string[]>();
  for (const item of samples) {
    const filename = `performance-${item.time.slice(0, 13).replace("T", "-")}.jsonl`;
    const lines = shards.get(filename) ?? [];
    lines.push(`${JSON.stringify(item)}\n`);
    shards.set(filename, lines);
  }
  for (const [filename, lines] of shards) {
    fs.writeFileSync(path.join(directory, filename), lines.join(""), "utf8");
  }
}

test("performance summaries preserve 1h, 6h, and 48h aggregation semantics", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-performance-tiers-"));
  const store = new PerformanceStore(root, {
    ...defaultPerformanceMonitoringConfig(),
    enabled: true,
    retentionHours: 720,
    sampleIntervalMs: 1_000
  });
  try {
    await store.start();
    const now = Date.now();
    const recent = aggregateSample(new Date(now - 30 * 60_000).toISOString(), 1, {
      count: 2,
      errorCount: 1,
      p50Ms: 10,
      p95Ms: 20,
      maxMs: 30,
      cpuPercent: 10
    });
    const medium = aggregateSample(new Date(now - 3 * 60 * 60_000).toISOString(), 2, {
      count: 6,
      errorCount: 2,
      p50Ms: 30,
      p95Ms: 40,
      maxMs: 50,
      cpuPercent: 30
    });
    const old = aggregateSample(new Date(now - 24 * 60 * 60_000).toISOString(), 3, {
      count: 2,
      errorCount: 3,
      p50Ms: 50,
      p95Ms: 60,
      maxMs: 70,
      cpuPercent: 50
    });
    assert.equal(store.append(old), true);
    assert.equal(store.append(medium), true);
    assert.equal(store.append(recent), true);

    const oneHour = store.summary(60 * 60_000);
    assert.equal(oneHour.bucketMs, 10_000);
    assert.equal(oneHour.httpOperations[0].count, 2);
    assert.equal(oneHour.httpOperations[0].errorCount, 1);
    assert.equal(oneHour.httpOperations[0].p50Ms, 10);
    assert.equal(oneHour.points[0].cpuPercent, 10);

    const sixHours = store.summary(6 * 60 * 60_000);
    assert.equal(sixHours.bucketMs, 60_000);
    assert.equal(sixHours.httpOperations[0].count, 8);
    assert.equal(sixHours.httpOperations[0].errorCount, 3);
    assert.equal(sixHours.httpOperations[0].p50Ms, 25);
    assert.equal(sixHours.httpOperations[0].p95Ms, 40);
    assert.equal(sixHours.hotOperations[0].totalMs, 200);

    const fortyEightHours = store.summary(48 * 60 * 60_000);
    assert.equal(fortyEightHours.bucketMs, 5 * 60_000);
    assert.equal(fortyEightHours.httpOperations[0].count, 10);
    assert.equal(fortyEightHours.httpOperations[0].errorCount, 6);
    assert.equal(fortyEightHours.httpOperations[0].p50Ms, 30);
    assert.equal(fortyEightHours.httpOperations[0].p95Ms, 60);
    assert.equal(fortyEightHours.httpOperations[0].maxMs, 70);
    assert.equal(fortyEightHours.httpOperations[0].totalBytes, 1_000);
    assert.equal(fortyEightHours.hotOperations[0].totalMs, 300);
  } finally {
    await store.stop();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("720h retention with 1s sampling keeps raw memory bounded beyond 100000 samples", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-performance-extreme-"));
  const store = new PerformanceStore(root, {
    ...defaultPerformanceMonitoringConfig(),
    enabled: true,
    retentionHours: 720,
    sampleIntervalMs: 1_000
  });
  try {
    await store.start();
    const count = 100_100;
    const now = Date.now();
    const baseTime = now - 47 * 60 * 60_000;
    const stepMs = Math.floor((47 * 60 * 60_000 - 60_000) / (count - 1));
    for (let index = 0; index < count; index += 1) {
      assert.equal(store.append(aggregateSample(new Date(baseTime + index * stepMs).toISOString(), index)), true);
    }

    const usage = store.memoryUsage();
    assert.ok(usage.recentSamples <= PERFORMANCE_STORE_MEMORY_LIMITS.recentSamples);
    assert.ok(usage.recentSampleBytes <= PERFORMANCE_STORE_MEMORY_LIMITS.recentSampleBytes);
    assert.ok(usage.dedupeSampleIds <= PERFORMANCE_STORE_MEMORY_LIMITS.dedupeSampleIds);
    assert.ok(usage.aggregateBuckets <= PERFORMANCE_STORE_MEMORY_LIMITS.aggregateBucketsPerTier * 3);
    assert.ok(usage.aggregateOperationEntries <= PERFORMANCE_STORE_MEMORY_LIMITS.aggregateOperationEntriesPerTier * 3);
    assert.equal(usage.representedSamples, count);
    assert.equal(store.recent(10_000).length, PERFORMANCE_STORE_MEMORY_LIMITS.recentSamples);

    const summaryStartedAt = performance.now();
    const summary = store.summary(48 * 60 * 60_000);
    const summaryDurationMs = performance.now() - summaryStartedAt;
    assert.equal(summary.httpOperations[0].count, count);
    assert.equal(summary.httpOperations[0].errorCount, 0);
    assert.equal(summary.hotOperations[0].count, count);
    assert.ok(summary.points[0].time <= new Date(baseTime + 5 * 60_000).toISOString());
    assert.ok(summary.points.at(-1)!.time >= new Date(now - 10 * 60_000).toISOString());
    assert.ok(summaryDurationMs < 500, `48h summary took ${summaryDurationMs.toFixed(1)} ms`);
  } finally {
    await store.stop();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("startup streams historical JSONL into aggregates and retains only bounded raw records", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-performance-recovery-"));
  const count = 20_000;
  const now = Date.now();
  const baseTime = now - 12 * 60 * 60_000;
  const samples = Array.from({ length: count }, (_, index) =>
    aggregateSample(new Date(baseTime + index * 2_000).toISOString(), index, {
      errorCount: index % 5_000 === 0 ? 1 : 0
    }));
  const tooOld = aggregateSample(new Date(now - 100 * 60 * 60_000).toISOString(), count + 1, {
    count: 999,
    errorCount: 999
  });
  writePerformanceSamples(root, [...samples, tooOld]);

  const store = new PerformanceStore(root, {
    ...defaultPerformanceMonitoringConfig(),
    enabled: true,
    retentionHours: 720,
    sampleIntervalMs: 1_000
  });
  try {
    await store.start();
    const usage = store.memoryUsage();
    assert.equal(usage.representedSamples, count);
    assert.equal(usage.recentSamples, PERFORMANCE_STORE_MEMORY_LIMITS.recentSamples);
    assert.ok(usage.aggregateBuckets < count);
    assert.ok(usage.aggregateOperationEntries < count);

    const summary = store.summary(48 * 60 * 60_000);
    assert.equal(summary.httpOperations[0].count, count);
    assert.equal(summary.httpOperations[0].errorCount, 4);
    assert.equal(summary.hotOperations[0].count, count);
    assert.equal(summary.sources[0].source.runtimeId, "runtime-history");
    assert.equal(store.recent().at(-1)?.sampleId, samples.at(-1)?.sampleId);
  } finally {
    await store.stop();
    fs.rmSync(root, { recursive: true, force: true });
  }
});


test("operation cardinality is bounded inside each aggregate bucket", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-performance-cardinality-"));
  const store = new PerformanceStore(root, { ...defaultPerformanceMonitoringConfig(), enabled: true });
  try {
    await store.start();
    const item = aggregateSample(new Date().toISOString(), 1);
    const operations = Array.from({ length: 100 }, (_, index) => ({
      operation: `/cardinality/${index}`,
      count: 1,
      errorCount: 0,
      totalMs: index + 1,
      p50Ms: index + 1,
      p95Ms: index + 1,
      maxMs: index + 1
    }));
    item.http = {
      operation: "all",
      count: operations.length,
      errorCount: 0,
      totalMs: operations.reduce((sum, operation) => sum + operation.totalMs, 0),
      p50Ms: 50,
      p95Ms: 100,
      maxMs: 100,
      operations
    };
    item.operations = operations.map(operation => ({ ...operation, operation: `internal.${operation.operation}` }));
    assert.equal(store.append(item), true);

    const usage = store.memoryUsage();
    assert.ok(usage.aggregateOperationEntries <= (PERFORMANCE_STORE_MEMORY_LIMITS.operationsPerBucket + 1) * 2 * 3);
    const summary = store.summary(60 * 60_000);
    assert.equal(summary.httpOperations.reduce((sum, operation) => sum + operation.count, 0), 100);
    assert.equal(summary.hotOperations.reduce((sum, operation) => sum + operation.count, 0), 100);
    assert.equal(summary.httpOperations.some(operation => operation.operation === "__other__"), true);
    assert.equal(summary.hotOperations.some(operation => operation.operation === "__other__"), true);
  } finally {
    await store.stop();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
