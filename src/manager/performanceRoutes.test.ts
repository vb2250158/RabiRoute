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

    await service.store.flush();
    let logs = { data: [] as PerformanceSample[] };
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const logsResponse = await fetch(`${baseUrl}/api/performance/logs?limit=10`);
      assert.equal(logsResponse.status, 200);
      logs = await logsResponse.json() as { data: PerformanceSample[] };
      if (logs.data.some(item => item.sampleId === sample.sampleId)) break;
      await new Promise(resolve => setTimeout(resolve, 25 * (attempt + 1)));
    }
    assert.equal(logs.data.filter(item => item.sampleId === sample.sampleId).length, 1);
    assert.equal(logs.data.some(item => item.sampleId === "forged-manager"), false);
    assert.equal(logs.data.find(item => item.sampleId === sample.sampleId)?.source.kind, "webgui");
    assert.equal(fs.readdirSync(path.join(root, "data", ".runtime", "performance")).length, 1);
  } finally {
    api.close();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await readWorkerPool.stop();
    await service.stop();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
