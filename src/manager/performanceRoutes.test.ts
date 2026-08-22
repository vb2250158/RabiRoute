import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { AddressInfo } from "node:net";
import type { PerformanceSample } from "../shared/performanceContract.js";
import { RabiGlobalConfigStore } from "./globalConfig.js";
import { PerformanceMonitoringService } from "./performanceMonitoring.js";
import { PerformanceApi } from "./performanceRoutes.js";
import { ManagerReadWorkerPool } from "./managerReadWorkerPool.js";

function webguiSample(): PerformanceSample {
  return {
    schemaVersion: 1,
    kind: "performance_sample",
    sampleId: "webgui-route-test",
    time: new Date().toISOString(),
    intervalMs: 5_000,
    source: { kind: "webgui", id: "webgui", runtimeId: "browser-test" },
    frontend: { page: "/performance", longTaskCount: 1, longTaskMaxMs: 64 }
  };
}

test("performance API enables recording, ingests WebGUI JSON, and rejects forged manager samples", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-performance-api-"));
  const globalConfig = new RabiGlobalConfigStore(root);
  const service = new PerformanceMonitoringService(root, globalConfig.read().performance);
  const readWorkerPool = new ManagerReadWorkerPool({ maxConcurrency: 1, maxQueue: 1, timeoutMs: 30_000 });
  const api = new PerformanceApi({
    service,
    globalConfig,
    gatewayExists: () => false,
    readWorkerPool
  });
  const server = http.createServer((request, response) => {
    const requestUrl = new URL(request.url ?? "/", "http://127.0.0.1");
    if (!api.handle(request, requestUrl, response)) {
      response.writeHead(404).end();
    }
  });

  try {
    await service.start();
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const port = (server.address() as AddressInfo).port;
    const baseUrl = `http://127.0.0.1:${port}`;

    const enabledResponse = await fetch(`${baseUrl}/api/performance/config`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ enabled: true, sampleIntervalMs: 1_000 })
    });
    assert.equal(enabledResponse.status, 200);
    assert.equal((await enabledResponse.json() as { data: { enabled: boolean } }).data.enabled, true);

    const sample = webguiSample();
    const acceptedResponse = await fetch(`${baseUrl}/api/performance/batches`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(sample)
    });
    assert.equal(acceptedResponse.status, 202);

    const forgedResponse = await fetch(`${baseUrl}/api/performance/batches`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...sample, sampleId: "forged-manager", source: { ...sample.source, kind: "manager" } })
    });
    assert.equal(forgedResponse.status, 400);

    const logsResponse = await fetch(`${baseUrl}/api/performance/logs?limit=10`);
    assert.equal(logsResponse.status, 200);
    const logs = await logsResponse.json() as { data: PerformanceSample[] };
    assert.equal(logs.data.filter(item => item.sampleId === sample.sampleId).length, 1);
    assert.equal(logs.data.some(item => item.sampleId === "forged-manager"), false);
    assert.equal(logs.data.find(item => item.sampleId === sample.sampleId)?.source.kind, "webgui");
  } finally {
    api.close();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await readWorkerPool.stop();
    await service.stop();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("performance summary and logs expose pending samples without flush or read workers", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-performance-memory-api-"));
  const globalConfig = new RabiGlobalConfigStore(root);
  globalConfig.patch({ performance: { ...globalConfig.read().performance, enabled: true } });
  const service = new PerformanceMonitoringService(root, globalConfig.read().performance);
  const readWorkerPool = new ManagerReadWorkerPool({ maxConcurrency: 1, maxQueue: 1, timeoutMs: 30_000 });
  let flushCalls = 0;
  let readWorkerCalls = 0;
  const originalFlush = service.store.flush.bind(service.store);
  service.store.flush = async () => {
    flushCalls += 1;
    throw new Error("performance route must not flush");
  };
  readWorkerPool.queryPerformanceSummaryJson = async () => {
    readWorkerCalls += 1;
    throw new Error("performance route must not use summary read worker");
  };
  readWorkerPool.queryPerformanceLogsJson = async () => {
    readWorkerCalls += 1;
    throw new Error("performance route must not use logs read worker");
  };
  const api = new PerformanceApi({
    service,
    globalConfig,
    gatewayExists: () => false,
    readWorkerPool
  });

  const get = (pathname: string): { statusCode: number; body: unknown } => {
    let statusCode = 0;
    let responseBody = "";
    const request = { method: "GET" } as http.IncomingMessage;
    const response = {
      writeHead(code: number) {
        statusCode = code;
        return response;
      },
      end(body?: string) {
        responseBody = body ?? "";
        return response;
      }
    } as unknown as http.ServerResponse;
    assert.equal(api.handle(request, new URL(pathname, "http://127.0.0.1"), response), true);
    return { statusCode, body: JSON.parse(responseBody) as unknown };
  };

  try {
    const sample = { ...webguiSample(), sampleId: "pending-webgui-route-test" };
    assert.equal(service.ingest(sample), true);
    assert.equal(service.store.status().pendingRecords, 1);

    const summaryResponse = get("/api/performance/summary?rangeMs=60000");
    assert.equal(summaryResponse.statusCode, 200);
    const summary = summaryResponse.body as {
      code: number;
      data: { sources: Array<{ source: PerformanceSample["source"] }>; status: { pendingRecords: number } };
    };
    assert.equal(summary.code, 0);
    assert.equal(summary.data.sources.some(item => item.source.runtimeId === sample.source.runtimeId), true);
    assert.equal(summary.data.status.pendingRecords, 1);

    const invalidLimitResponse = get("/api/performance/logs?limit=invalid");
    assert.equal(invalidLimitResponse.statusCode, 200);
    const invalidLimitLogs = invalidLimitResponse.body as { data: PerformanceSample[] };
    assert.equal(invalidLimitLogs.data.length, 1);

    const logsResponse = get("/api/performance/logs?limit=10");
    assert.equal(logsResponse.statusCode, 200);
    const logs = logsResponse.body as {
      code: number;
      data: PerformanceSample[];
      status: { pendingRecords: number };
    };
    assert.equal(logs.code, 0);
    assert.equal(logs.data.some(item => item.sampleId === sample.sampleId), true);
    assert.equal(logs.status.pendingRecords, 1);
    assert.equal(flushCalls, 0);
    assert.equal(readWorkerCalls, 0);
  } finally {
    service.store.flush = originalFlush;
    api.close();
    await readWorkerPool.stop();
    await service.stop();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
