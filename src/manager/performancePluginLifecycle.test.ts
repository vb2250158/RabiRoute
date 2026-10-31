import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { GenerationRuntime } from "../plugin-kernel/generationRuntime.js";
import type { PluginCandidate, PluginManifest, PluginModule } from "../plugin-kernel/types.js";
import { recordPerformanceOperation } from "../performance/performanceInstrumentation.js";
import { normalizePerformanceMonitoringConfig } from "../shared/performanceContract.js";
import { RabiGlobalConfigStore } from "./globalConfig.js";
import { ManagerPluginRouteRegistry } from "./managerPluginRouteRegistry.js";
import { PerformanceMonitoringService } from "./performanceMonitoring.js";
import { PerformanceApi } from "./performanceRoutes.js";
import { createPerformanceOperations } from "./performanceOperations.js";
import { markAuthenticatedConnectionRequest } from "./connectionRequestAccess.js";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

async function fixture(t: test.TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "performance-lifecycle-"));
  const entry = path.resolve("plugins/builtin/io.rabiroute.manager.performance/1.0.0/manager.mjs");
  const plugin: PluginModule = await import(pathToFileURL(entry).href);
  const manifest: PluginManifest = JSON.parse(fs.readFileSync(path.join(path.dirname(entry), "rabi.plugin.json"), "utf8"));
  const counts = { starts: 0, stops: 0, requests: 0, operations: 0, storeStarts: 0, storeStops: 0 };
  const releaseControlledWork: Array<() => void> = [];
  const service = new PerformanceMonitoringService(root, normalizePerformanceMonitoringConfig({ enabled: true }), () => ({
    start() { counts.starts++; }, stop() { counts.stops++; }, update() {}, sampleNow() { return undefined; },
    recordHttpRequest() { counts.requests++; }, recordOperation() { counts.operations++; }
  }));
  service.store.start = async () => { counts.storeStarts++; };
  service.store.stop = async () => { counts.storeStops++; };
  let generation!: GenerationRuntime;
  const routes = new ManagerPluginRouteRegistry(() => new Set(generation.current().records.filter(record => record.status === "active").map(record => record.identity.activationId)));
  const apis: PerformanceApi[] = [];
  class TrackedApi extends PerformanceApi {
    constructor(context: ConstructorParameters<typeof PerformanceApi>[0]) { super(context); apis.push(this); }
  }
  const hooks: Array<(...args: Parameters<PerformanceMonitoringService["recordHttpRequest"]>) => void> = [];
  let hook = (..._args: Parameters<PerformanceMonitoringService["recordHttpRequest"]>) => {};
  const host = {
    performanceMonitoring: service, managerReadOnly: false, managerPluginRoutes: routes,
    PerformanceApi: TrackedApi, createPerformanceOperations,
    rabiGlobalConfig: new RabiGlobalConfigStore(root), runtimes: new Map(),
    get recordManagerHttpRequest() { return hook; },
    set recordManagerHttpRequest(value: typeof hook) { hook = value; hooks.push(value); }
  };
  let nextEffect: (() => Promise<() => void>) | undefined;
  let publicationFailure = false;
  generation = new GenerationRuntime({ host: "manager",
    hostServices: [{ capability: "host.manager.performance@1", value: host }, { capability: "manager.core@1", value: {} }],
    executor: { async prepare() {
      const effect = nextEffect; nextEffect = undefined;
      const failPublication = publicationFailure; publicationFailure = false;
      return { async activate(context) {
        await plugin.activate(context);
        if (effect) context.effects.add(effect, "controlled candidate");
        if (failPublication) context.publication.add({ publish() { throw new Error("controlled publication failure"); }, rollback() {} });
      } };
    } }
  });
  const candidate = (revision: string, shutdownTimeoutMs = 1000): PluginCandidate => ({
    instanceId: "manager:performance", revision, config: {}, manifest, entry: { execution: "in_process", path: entry },
    policy: { resources: { shutdownTimeoutMs, maxChildProcesses: 0 }, restart: { mode: "never", maxAttempts: 0, windowMs: 1000, initialBackoffMs: 1, maximumBackoffMs: 1 } }
  });
  t.after(async () => {
    for (const release of releaseControlledWork) release();
    await generation.shutdown(); await service.stop();
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith("performance-lifecycle-"));
    fs.rmSync(root, { force: true, recursive: true });
  });
  return { service, counts, generation, routes, apis, hooks, host, candidate, releaseControlledWork,
    effect(value: () => Promise<() => void>) { nextEffect = value; },
    failPublication() { publicationFailure = true; } };
}

test("candidate preparation and failed effect preserve the published collector, sink and HTTP hook", async t => {
  const f = await fixture(t);
  await f.generation.switch([f.candidate("one")]); await f.service.start();
  assert.equal(f.generation.current().records[0]?.status, "active", JSON.stringify(f.generation.current().records[0]?.error));
  const original = f.host.recordManagerHttpRequest;
  const staged = deferred(), fail = deferred();
  f.effect(async () => { staged.resolve(); await fail.promise; throw new Error("controlled candidate failure"); });
  const switching = f.generation.switch([f.candidate("bad")]); await staged.promise;
  try {
    assert.equal(f.host.recordManagerHttpRequest, original);
    assert.equal(f.counts.starts, 1); assert.equal(f.counts.stops, 0);
  } finally { fail.resolve(); await switching; }
  assert.equal(f.host.recordManagerHttpRequest, original);
  assert.match(f.generation.current().records[0]!.error!.message, /controlled candidate failure/);
  original("/api/roles", 200, 1); recordPerformanceOperation("controlled", 1);
  assert.equal(f.counts.requests, 1); assert.equal(f.counts.operations, 1);
  assert.equal(f.counts.stops, 0); assert.equal(f.hooks.length, 1);
  assert.equal(f.routes.snapshot()[0]!.routeCount, 7);
});

test("required-capability rollback after effect commit never takes collector ownership", async t => {
  const f = await fixture(t);
  await f.generation.switch([f.candidate("one")]); await f.service.start();
  const original = f.host.recordManagerHttpRequest;
  await assert.rejects(f.generation.switch([f.candidate("rollback")], { readyRequires: ["missing@1"] }), /required plugin capabilities/i);
  assert.equal(f.host.recordManagerHttpRequest, original);
  assert.equal(f.counts.starts, 1); assert.equal(f.counts.stops, 0); assert.equal(f.hooks.length, 1);
  assert.equal(f.routes.snapshot()[0]!.routeCount, 7);
});

test("a later synchronous publication failure restores the previous hook and collector lease", async t => {
  const f = await fixture(t);
  await f.generation.switch([f.candidate("one")]); await f.service.start();
  const hook = f.host.recordManagerHttpRequest;
  f.failPublication();
  await assert.rejects(f.generation.switch([f.candidate("bad-publication")]), /controlled publication failure/);
  assert.equal(f.host.recordManagerHttpRequest, hook);
  assert.equal(f.counts.starts, 1); assert.equal(f.counts.stops, 0);
  recordPerformanceOperation("retained-sink", 1); assert.equal(f.counts.operations, 1);
  assert.equal(f.routes.snapshot()[0]!.routeCount, 7);
});

test("successful publication and revision rollback hand off once without restarting the shared collector", async t => {
  const f = await fixture(t);
  await f.generation.switch([f.candidate("one")]); await f.service.start();
  const firstHook = f.host.recordManagerHttpRequest;
  await f.generation.switch([f.candidate("two")]); await f.service.start();
  assert.notEqual(f.host.recordManagerHttpRequest, firstHook);
  assert.equal(f.hooks.length, 2);
  assert.equal(f.counts.starts, 1); assert.equal(f.counts.stops, 0);
  await f.generation.switch([f.candidate("one")]); await f.service.start();
  assert.equal(f.hooks.length, 3); assert.equal(f.counts.starts, 1); assert.equal(f.counts.stops, 0);
  await f.generation.switch([]);
  assert.equal(f.counts.stops, 1); assert.equal(f.counts.storeStops, 1);
});

test("retirement timeout retains the real operation producer and cannot later clear the new hook", async t => {
  const f = await fixture(t), producer = deferred(), started = deferred();
  const register = f.routes.registerOperationsAsync.bind(f.routes);
  let registration = 0;
  f.routes.registerOperationsAsync = async (instance, definitions, signal) => {
    const operations = await register(instance, definitions, signal);
    if (registration++ !== 0) return operations;
    return { ...operations, async dispose() { started.resolve(); await operations.dispose(); await producer.promise; } };
  };
  await f.generation.switch([f.candidate("one", 5)]); await f.service.start();
  const stream = f.apis[0]!.events(), iterator = stream.frames[Symbol.asyncIterator]();
  await iterator.next(); const pending = iterator.next();
  const switched = f.generation.switch([f.candidate("two")]); await started.promise;
  const result = await switched;
  assert.ok(result.generation.cleanupDiagnostics.some(item => item.message.includes("timed out")));
  assert.equal((await pending).done, true);
  const hook = f.host.recordManagerHttpRequest;
  assert.equal(f.counts.stops, 0); assert.equal(f.counts.starts, 1);
  producer.resolve(); await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(f.host.recordManagerHttpRequest, hook); assert.equal(f.counts.stops, 0);
  await f.generation.switch([]); assert.equal(f.counts.stops, 1);
});

test("removal cannot stop the collector until the retired producer has actually joined", async t => {
  const f = await fixture(t), producer = deferred();
  const register = f.routes.registerOperationsAsync.bind(f.routes);
  f.routes.registerOperationsAsync = async (instance, definitions, signal) => {
    const operations = await register(instance, definitions, signal);
    return { ...operations, async dispose() { await operations.dispose(); await producer.promise; } };
  };
  await f.generation.switch([f.candidate("one", 5)]); await f.service.start();
  const removed = await f.generation.switch([]);
  assert.ok(removed.generation.cleanupDiagnostics.length);
  assert.equal(f.counts.stops, 0);
  producer.resolve(); await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(f.counts.stops, 1);
});

test("startup and stop serialize around a pending store load and repeated start installs one sink", async t => {
  const f = await fixture(t), loading = deferred(), entered = deferred();
  f.service.store.start = async () => { f.counts.storeStarts++; entered.resolve(); await loading.promise; };
  const start = f.service.start(); await entered.promise;
  const secondStart = f.service.start(), stopping = f.service.stop();
  try { assert.equal(f.counts.starts, 0); assert.equal(f.counts.stops, 0); }
  finally { loading.resolve(); await Promise.all([start, secondStart, stopping]); }
  assert.equal(f.counts.starts, 1); assert.equal(f.counts.stops, 1); assert.equal(f.counts.storeStarts, 1);
  recordPerformanceOperation("after-stop", 1); assert.equal(f.counts.operations, 0);
});

test("a completed timeout HTTP response does not release its still-running native producer", { timeout: 10000 }, async t => {
  const f = await fixture(t), producer = deferred(), entered = deferred();
  f.releaseControlledWork.push(producer.resolve);
  const register = f.routes.registerOperationsAsync.bind(f.routes);
  let originalOperations: Awaited<ReturnType<typeof register>> | undefined;
  f.routes.registerOperationsAsync = async (instance, definitions, signal) => {
    originalOperations = await register(instance, definitions.map(definition => definition.contract.operationId !== "manager.performance.status.read" ? definition : {
      ...definition, prepare: undefined, async handler(input) {
        input.response.writeHead(408, { "content-type": "application/json" }).end(JSON.stringify({ code: -1, message: "controlled timeout" }));
        entered.resolve(); await producer.promise;
        return { status: 200, body: {} };
      }
    }), signal);
    return originalOperations;
  };
  await f.generation.switch([f.candidate("one", 5)]); await f.service.start();
  const server = http.createServer((request, response) => {
    markAuthenticatedConnectionRequest(request, () => {});
    if (!f.routes.handle(request, new URL(request.url!, "http://fixture"), response)) response.writeHead(404).end();
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { producer.resolve(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const response = await fetch(`http://127.0.0.1:${address.port}/api/performance/status`); await response.text(); await entered.promise;
  assert.equal(response.status, 408); assert.equal(originalOperations!.activeOperationCount(), 1);
  const removed = await f.generation.switch([]); assert.ok(removed.generation.cleanupDiagnostics.length);
  assert.equal(f.counts.stops, 0); assert.equal(originalOperations!.activeOperationCount(), 1);
  producer.resolve(); await f.generation.shutdown();
  assert.equal(originalOperations!.activeOperationCount(), 0); assert.equal(f.counts.stops, 1);
});

test("startup failure releases partial resources and permits a later successful start", async t => {
  const f = await fixture(t);
  f.service.store.start = async () => { throw new Error("controlled load failure"); };
  await assert.rejects(f.service.start(), /controlled load failure/);
  assert.equal(f.counts.starts, 0); assert.equal(f.counts.stops, 1); assert.equal(f.counts.storeStops, 1);
  recordPerformanceOperation("failed-start", 1); assert.equal(f.counts.operations, 0);
  f.service.store.start = async () => { f.counts.storeStarts++; };
  await f.service.start(); recordPerformanceOperation("recovered", 1);
  assert.equal(f.counts.starts, 1); assert.equal(f.counts.operations, 1);
});

test("post-publication startup failure retires that owner rather than restoring an unpublished candidate", async t => {
  const f = await fixture(t);
  f.service.store.start = async () => { throw new Error("controlled published startup failure"); };
  await f.generation.switch([f.candidate("startup-fails")]);
  const record = f.generation.current().records.find(item => item.identity.instanceId === "manager:performance")!;
  assert.equal(record.status, "failed"); assert.match(record.error!.message, /controlled published startup failure/);
  assert.equal(f.routes.snapshot().length, 0); assert.equal(f.counts.starts, 0);
  recordPerformanceOperation("retired-failed-start", 1); assert.equal(f.counts.operations, 0);
  const before = f.counts.requests;
  f.host.recordManagerHttpRequest("/api/roles", 200, 1); assert.equal(f.counts.requests, before);
});

test("read-only publication keeps its collector stopped and stream close joins all original subscriptions", async t => {
  const f = await fixture(t);
  f.host.managerReadOnly = true;
  await f.generation.switch([f.candidate("readonly")]);
  assert.equal(f.counts.starts, 0); assert.equal(f.counts.storeStarts, 0);
  const subscribe = f.service.store.subscribe.bind(f.service.store);
  let subscriptions = 0;
  f.service.store.subscribe = listener => {
    subscriptions++; const unsubscribe = subscribe(listener);
    return () => { subscriptions--; unsubscribe(); };
  };
  const api = f.apis[0]!, unstarted = api.events(), started = api.events();
  const iterator = started.frames[Symbol.asyncIterator](); await iterator.next(); const pending = iterator.next();
  assert.equal(subscriptions, 2);
  const closing = api.close(); assert.equal(api.close(), closing); await closing;
  assert.equal(subscriptions, 0); assert.equal((await pending).done, true);
  assert.equal((await unstarted.frames[Symbol.asyncIterator]().next()).done, true);
});
