import assert from "node:assert/strict";
import test from "node:test";
import { defaultPerformanceMonitoringConfig } from "../shared/performanceContract.js";
import { createNodePerformanceCollector } from "./nodePerformanceCollector.js";

test("node performance collector reports system and normalized HTTP metrics", async () => {
  const samples: unknown[] = [];
  const collector = createNodePerformanceCollector({
    sourceKind: "manager",
    sourceId: "manager",
    emit: sample => { samples.push(sample); }
  });
  const config = { ...defaultPerformanceMonitoringConfig(), enabled: true, sampleIntervalMs: 60_000 };
  collector.start(config);
  collector.recordHttpRequest("/api/roles/XinghaiBuilder/plans?limit=8", 200, 24, "req-1", 1200);
  collector.recordHttpRequest("/api/roles/XinghaiBuilder/plans/plan-a", 500, 2400, "req-2");
  collector.recordOperation({
    operation: "manager.plan_catalog.cold_load",
    durationMs: 42,
    error: false,
    time: new Date().toISOString()
  });
  await new Promise(resolve => setTimeout(resolve, 25));
  const sample = collector.sampleNow();
  collector.stop();

  assert.ok(sample?.system);
  assert.equal(sample?.source.kind, "manager");
  assert.equal(sample?.http?.count, 2);
  assert.equal(sample?.http?.errorCount, 1);
  assert.equal(sample?.http?.totalMs, 2424);
  assert.equal(sample?.http?.totalBytes, 1200);
  assert.deepEqual(
    sample?.http?.operations.map(item => item.operation).sort(),
    ["/api/roles/:roleId/plans", "/api/roles/:roleId/plans/:planId"]
  );
  assert.equal(sample?.operations?.[0].operation, "manager.plan_catalog.cold_load");
  assert.equal(sample?.operations?.[0].totalMs, 42);
  assert.equal(sample?.slowOperations?.[0].requestId, "req-2");
  assert.equal(samples.length, 1);
});

test("disabled node performance collector ignores requests and samples", () => {
  const collector = createNodePerformanceCollector({
    sourceKind: "gateway",
    sourceId: "route-a",
    emit: () => undefined
  });
  collector.start(defaultPerformanceMonitoringConfig());
  collector.recordHttpRequest("/meta", 200, 10);
  assert.equal(collector.sampleNow(), undefined);
  collector.stop();
});
