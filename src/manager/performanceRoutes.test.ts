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
import { PerformanceApi, PERFORMANCE_EVENT_LIMITS } from "./performanceRoutes.js";
import { createPerformanceOperations } from "./performanceOperations.js";
import { ManagerPluginRouteRegistry } from "./managerPluginRouteRegistry.js";
import { LanAgentAuthority } from "./lanAgentAuthority.js";
import { evaluateLanAgentRequest, assertTrustedLanAgentPrincipal } from "./lanAgentRequestAccess.js";
import { markAuthenticatedConnectionRequest } from "./connectionRequestAccess.js";
import { registerLanAgentBodyGuard, assertLanAgentBodyAuthority } from "./lanAgentBodyAuthority.js";

function webguiSample(sampleId = "webgui-route-test"): PerformanceSample {
  return { schemaVersion: 1, kind: "performance_sample", sampleId, time: new Date().toISOString(), intervalMs: 5_000,
    source: { kind: "webgui", id: "webgui", runtimeId: "browser-test" }, frontend: { page: "/performance", longTaskCount: 1, longTaskMaxMs: 64 } };
}

async function fixture(t: test.TestContext, enabled = false) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-performance-operation-"));
  const globalConfig = new RabiGlobalConfigStore(root);
  if (enabled) globalConfig.patch({ performance: { ...globalConfig.read().performance, enabled: true } });
  const service = new PerformanceMonitoringService(root, globalConfig.read().performance);
  const api = new PerformanceApi({ service, globalConfig, gatewayExists: id => id === "existing-gateway" });
  const registry = new ManagerPluginRouteRegistry();
  const registration = registry.registerOperations("performance", createPerformanceOperations(api));
  const authority = new LanAgentAuthority({ statePath: path.join(root, "authority.json") });
  const credential = authority.enroll(authority.issueBootstrapTicket().ticket, "performance-node");
  const server = http.createServer((request, response) => {
    if (evaluateLanAgentRequest(request, authority, true).kind !== "agent") { response.writeHead(401).end(); return; }
    markAuthenticatedConnectionRequest(request, () => { assertTrustedLanAgentPrincipal(request); });
    registerLanAgentBodyGuard(request, body => assertLanAgentBodyAuthority(new URL(request.url!, "http://fixture").pathname, body, undefined));
    if (!registry.handle(request, new URL(request.url!, "http://fixture"), response)) response.writeHead(404).end();
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    const retired = registration.dispose(); api.close(); await retired;
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await service.stop();
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir())); fs.rmSync(root, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const headers = { authorization: `Bearer ${credential.token}`, "content-type": "text/plain" };
  const request = (url: string, method = "GET", body?: unknown) => new Promise<{ status: number; body: any }>((resolve, reject) => {
    const outgoing = http.request(base + url, { method, headers }, response => {
      const chunks: Buffer[] = []; response.on("data", chunk => chunks.push(Buffer.from(chunk))); response.on("error", reject);
      response.on("end", () => { const text = Buffer.concat(chunks).toString(); resolve({ status: response.statusCode!, body: text ? JSON.parse(text) : null }); });
    }); outgoing.on("error", reject); outgoing.setTimeout(10000, () => outgoing.destroy(new Error("Owned performance fixture timed out.")));
    outgoing.end(body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body));
  });
  return { root, api, service, globalConfig, registry, registration, authority, credential, base, headers, request };
}

test("an enrolled empty node saves native config, ingests samples, reads all snapshots and rejects forged manager data", async t => {
  const f = await fixture(t);
  const saved = await f.request("/api/performance/config?unknown=value", "PATCH", { enabled: true, sampleIntervalMs: "1001.8", ignored: true });
  assert.equal(saved.status, 200); assert.equal(saved.body.data.sampleIntervalMs, 1002);
  assert.deepEqual((await f.request("/api/performance/config")).body.data, f.globalConfig.read().performance);
  assert.equal(new RabiGlobalConfigStore(f.root).read().performance.enabled, true);
  const sample = webguiSample();
  assert.deepEqual((await f.request("/api/performance/batches", "POST", sample)).body, { code: 0, accepted: 1, rejected: 0 });
  const forged = await f.request("/api/performance/batches", "POST", { ...sample, sampleId: "forged-manager", source: { ...sample.source, kind: "manager" } });
  assert.equal(forged.status, 400); assert.equal(forged.body.rejected, 1);
  const logs = await f.request("/api/performance/logs?limit=10"); assert.equal(logs.status, 200);
  assert.equal(logs.body.data.filter((row: PerformanceSample) => row.sampleId === sample.sampleId).length, 1);
  assert.equal(logs.body.data.some((row: PerformanceSample) => row.sampleId === "forged-manager"), false);
  assert.equal((await f.request("/api/performance/status")).body.config.enabled, true);
  assert.equal((await f.request("/api/performance/summary?rangeMs=60000")).status, 200);
  assert.equal(f.registry.snapshot()[0]!.routeCount, 7);
});

test("performance summary and logs expose pending samples without flushing or read workers", async t => {
  const f = await fixture(t, true);
  const original = f.service.store.flush.bind(f.service.store); let flushes = 0;
  f.service.store.flush = async () => { flushes++; throw new Error("Read must not flush"); };
  t.after(() => { f.service.store.flush = original; });
  const sample = webguiSample("pending"); assert.equal(f.service.ingest(sample), true);
  const summary = await f.request("/api/performance/summary?rangeMs=60000"); assert.equal(summary.status, 200);
  assert.equal(summary.body.data.sources.some((item: any) => item.source.runtimeId === sample.source.runtimeId), true);
  assert.equal(summary.body.data.status.pendingRecords, 1);
  const logs = await f.request("/api/performance/logs?limit=invalid"); assert.equal(logs.status, 200);
  assert.equal(logs.body.data[0].sampleId, sample.sampleId); assert.equal(flushes, 0);
  f.service.store.flush = original;
});

test("native batch admission preserves source provenance, deduplication, invalid-item counts and byte limits", async t => {
  const f = await fixture(t, true), sample = webguiSample("batch");
  const mixed = await f.request("/api/performance/batches", "POST", { samples: [sample, null, {}, sample] });
  assert.equal(mixed.status, 202); assert.deepEqual(mixed.body, { code: 0, accepted: 1, rejected: 3 });
  const gateway = { ...sample, sampleId: "gateway", source: { kind: "gateway", id: "existing-gateway", runtimeId: "gateway-runtime" } };
  assert.equal(f.api.ingest(gateway, { socket: { remoteAddress: "203.0.113.1" } } as http.IncomingMessage).accepted, 0);
  assert.equal((await f.request("/api/performance/batches", "POST", gateway)).status, 202);
  assert.equal((await f.request("/api/performance/batches", "POST", { ...gateway, sampleId: "unknown", source: { ...gateway.source, id: "missing" } })).status, 400);
  assert.equal((await f.request("/api/performance/config", "PATCH", "{")).status, 400);
  assert.equal((await f.request("/api/performance/config", "PATCH", JSON.stringify({ padding: "x".repeat(16 * 1024) }))).status, 413);
  assert.equal((await f.request("/api/performance/batches", "POST", "null")).status, 400);
});

test("native SSE emits ready and sample frames, and owner retirement joins the original subscription", { timeout: 10000 }, async t => {
  const f = await fixture(t, true);
  let connected!: () => void, sampled!: () => void;
  const ready = new Promise<void>(resolve => { connected = resolve; });
  const sampleSeen = new Promise<void>(resolve => { sampled = resolve; });
  let text = "", retirementStarted = false;
  const done = new Promise<void>((resolve, reject) => {
    const outgoing = http.get(f.base + "/api/performance/events", { headers: f.headers }, response => {
      assert.equal(response.headers["content-type"], "text/event-stream");
      response.on("data", chunk => { text += chunk.toString(); if (text.includes("event: ready")) connected(); if (text.includes('"runtimeId":"browser-test"')) sampled(); });
      response.on("end", resolve); response.on("error", error => retirementStarted && (error as NodeJS.ErrnoException).code === "ECONNRESET" ? resolve() : reject(error));
    }); outgoing.on("error", reject); t.after(() => outgoing.destroy());
  });
  await ready; assert.equal(f.service.ingest(webguiSample("sse")), true); await sampleSeen;
  retirementStarted = true; const retiring = f.registration.dispose(); f.api.close(); await retiring; await done;
  assert.ok(text.includes("retry: 3000")); assert.ok(text.includes("event: sample"));
  assert.equal((await f.request("/api/performance/status")).status, 404);
});

test("a never-started performance stream and a pending next both reach EOF on close or cancellation", async t => {
  const f = await fixture(t, true), unstarted = f.api.events(); unstarted.cancel("not written");
  assert.equal((await unstarted.frames[Symbol.asyncIterator]().next()).done, true);
  const source = f.api.events(), iterator = source.frames[Symbol.asyncIterator]();
  assert.equal((await iterator.next()).done, false); const pending = iterator.next();
  source.cancel("disconnect"); assert.equal((await pending).done, true);
  const final = f.api.events(), finalIterator = final.frames[Symbol.asyncIterator](); await finalIterator.next();
  const waiting = finalIterator.next(); f.api.close(); assert.equal((await waiting).done, true);
  assert.throws(() => f.api.saveConfig({ enabled: false }), /retired/);
});

test("slow notification consumers are bounded and must refresh state after overflow", async t => {
  const f = await fixture(t, true), stream = f.api.events();
  for (let index = 0; index <= PERFORMANCE_EVENT_LIMITS.queuedFrames; index++) f.service.ingest(webguiSample(`overflow-${index}`));
  assert.equal(stream.signal!.aborted, true);
  assert.equal((await stream.frames[Symbol.asyncIterator]().next()).done, true);
  assert.ok(f.api.logs("1").data.length > 0);
});
