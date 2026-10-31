import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { Socket } from "node:net";
import test from "node:test";
import { defaultPerformanceMonitoringConfig, normalizePerformanceMonitoringConfig, performanceMonitoringConfigRules } from "../shared/performanceContract.js";
import { apiCatalogOpenApi } from "./apiOperationCatalog.js";
import { compileApiOperation, readApiRequestEnvelope, validateApiOperationResult, type ApiSchema } from "./apiOperationContract.js";
import { RabiGlobalConfigStore } from "./globalConfig.js";
import { ManagerPluginRouteRegistry } from "./managerPluginRouteRegistry.js";
import { PerformanceMonitoringService } from "./performanceMonitoring.js";
import { createPerformanceOperations } from "./performanceOperations.js";
import { PerformanceApi } from "./performanceRoutes.js";

function schema(value: ApiSchema | undefined): Readonly<Record<string, any>> {
  assert.ok(value && typeof value === "object"); return value;
}
function fields(value: ApiSchema): Readonly<Record<string, ApiSchema>> {
  const definition = schema(value);
  return definition.properties ?? definition.anyOf?.find((part: any) => part.type === "object")?.properties ?? {};
}
async function fixture(t: test.TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "performance-fields-"));
  const globalConfig = new RabiGlobalConfigStore(root);
  const service = new PerformanceMonitoringService(root, globalConfig.read().performance);
  // Config changes launch native cleanup without returning its Promise. Observe those jobs so
  // this fixture cannot delete its owned filesystem while native cleanup is still using it.
  const cleanupWork: Promise<void>[] = [];
  const nativeCleanup: () => Promise<void> = Reflect.get(service.store, "cleanup").bind(service.store);
  Reflect.set(service.store, "cleanup", () => {
    const work = nativeCleanup(); cleanupWork.push(work); void work.catch(() => {}); return work;
  });
  const api = new PerformanceApi({ service, globalConfig, gatewayExists: () => false });
  const definitions = createPerformanceOperations(api), operations = new Map(definitions.map(value => [value.contract.operationId.split("manager.performance.")[1]!, compileApiOperation(value)]));
  const registry = new ManagerPluginRouteRegistry();
  const registration = registry.registerOperations("performance", definitions);
  const request = new http.IncomingMessage(new Socket()), response = new http.ServerResponse(request);
  t.after(async () => {
    await Promise.all([registration.dispose(), api.close()]); await service.stop(); await Promise.all(cleanupWork); request.destroy(); response.destroy();
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir())); assert.ok(path.basename(root).startsWith("performance-fields-"));
    fs.rmSync(root, { recursive: true, force: true });
  });
  async function invoke(id: string, body?: unknown, search = "") {
    const operation = operations.get(id)!;
    assert.ok(operation);
    const url = new URL(operation.contract.pathTemplate + search, "http://fixture");
    const envelope = readApiRequestEnvelope(operation, request, url);
    if (operation.bodyValidator) assert.equal(operation.bodyValidator(body), true, JSON.stringify(operation.bodyValidator.errors));
    const result = await operationHandler(id)({ request, response, url, ...envelope, body, signal: new AbortController().signal });
    validateApiOperationResult(operation, result);
    return result;
  }
  function operationHandler(id: string) { return definitions.find(value => value.contract.operationId === `manager.performance.${id}`)!.handler; }
  return { root, api, service, operations, registry, invoke };
}

test("discovery exposes five native normalization fields, both batch shapes and known query names in OpenAPI", async t => {
  const f = await fixture(t), config = f.operations.get("config.save")!.contract.request.body;
  assert.equal(config.kind, "json"); if (config.kind !== "json") return;
  assert.deepEqual(Object.keys(fields(config.schema)).sort(), Object.keys(performanceMonitoringConfigRules).sort());
  for (const [key, rule] of Object.entries(performanceMonitoringConfigRules)) {
    const field = schema(fields(config.schema)[key]); assert.deepEqual(field.examples, [rule.default]);
    if ("minimum" in rule) assert.ok(field.description.includes(`${rule.minimum}..${rule.maximum}`));
    assert.equal(field.type, undefined); assert.equal(field.required, undefined);
  }
  const batch = f.operations.get("batches.append")!.contract.request.body;
  assert.equal(batch.kind, "json"); if (batch.kind !== "json") return;
  const batchFields = fields(batch.schema);
  for (const key of ["sampleId", "time", "intervalMs", "source", "system", "http", "operations", "frontend", "slowOperations", "samples"]) assert.ok(key in batchFields);
  const items = schema(batchFields.samples).anyOf.find((part: any) => part.type === "array").items;
  assert.ok("sampleId" in fields(items)); assert.ok("cpuPercent" in fields(fields(items).system));
  assert.ok("totalBytes" in fields(fields(items).http)); assert.ok("jsHeapLimitBytes" in fields(fields(items).frontend));
  const snapshot = f.registry.catalogSnapshot(), openapi = (await apiCatalogOpenApi(snapshot)) as any;
  for (const [suffix, name] of [["summary", "rangeMs"], ["logs", "limit"]]) {
    const parameter = openapi.paths[`/api/performance/${suffix}`].get.parameters.find((entry: any) => entry.name === name);
    assert.ok(parameter); assert.equal(parameter.required, false); assert.equal(parameter.schema.type, undefined);
  }
  assert.equal(snapshot.operations.length, 7); assert.equal(snapshot.coverage.globalCoverage, "not-proven");
});

test("input metadata admits arbitrary JSON and malformed per-item values without substituting structural errors", async t => {
  const f = await fixture(t);
  const corpus = [null, false, true, 1, 0, "value", [], [null, 3], {}, { unknown: true },
    { enabled: [], sampleIntervalMs: ["1001.8"], retentionHours: null, maxDiskMb: {}, slowOperationMs: false },
    { samples: null }, { samples: "not-an-array" }, { samples: [null, 3, [], {}, { source: false, system: 3, http: { operations: "opaque" } }] }];
  for (const operation of [f.operations.get("config.save")!, f.operations.get("batches.append")!]) {
    for (const value of corpus) assert.equal(operation.bodyValidator!(value), true, JSON.stringify(operation.bodyValidator!.errors));
  }
  const result = await f.invoke("batches.append", { samples: [null, {}, { source: { kind: "webgui" } }] });
  assert.equal(result.status, 400); assert.deepEqual(result.body, { code: -1, accepted: 0, rejected: 3 });
});

test("native config merge retains scalar/empty/unknown behavior and Number round clamp conversions", async t => {
  const f = await fixture(t);
  let expected = defaultPerformanceMonitoringConfig();
  for (const body of [null, false, 1, "unchanged", [], { unknown: { nested: true } }, {}]) {
    const result = await f.invoke("config.save", body); assert.deepEqual((result.body as any).data, expected);
  }
  let result = await f.invoke("config.save", { enabled: "true", sampleIntervalMs: "1001.8", retentionHours: null, maxDiskMb: [17.6], slowOperationMs: false });
  expected = { enabled: false, sampleIntervalMs: 1002, retentionHours: 1, maxDiskMb: 18, slowOperationMs: 100 };
  assert.deepEqual((result.body as any).data, expected);
  result = await f.invoke("config.save", { enabled: true, sampleIntervalMs: {}, retentionHours: "NaN", maxDiskMb: "Infinity", slowOperationMs: "1e309" });
  assert.deepEqual((result.body as any).data, { ...defaultPerformanceMonitoringConfig(), enabled: true });
  assert.deepEqual(normalizePerformanceMonitoringConfig({ sampleIntervalMs: ["60001"], retentionHours: true, maxDiskMb: "4097", slowOperationMs: "100.5" }),
    { enabled: false, sampleIntervalMs: 60000, retentionHours: 1, maxDiskMb: 4096, slowOperationMs: 101 });
});

test("optional metric shapes and pid remain opaque through native admission, logs and response validation", async t => {
  const f = await fixture(t); await f.invoke("config.save", { enabled: true });
  const sample = { schemaVersion: 1, kind: "performance_sample", sampleId: "opaque-metrics", time: new Date().toISOString(), intervalMs: 5000,
    source: { kind: "webgui", id: "webgui", runtimeId: "fixture", pid: { provider: "opaque" } },
    system: { cpuPercent: "opaque-number", gcCount: 0 }, frontend: false, extraProviderValue: { open: true } };
  const admitted = await f.invoke("batches.append", sample); assert.equal(admitted.status, 202);
  const logs = await f.invoke("logs.read", undefined, "?limit=1"); assert.deepEqual((logs.body as any).data[0], sample);
  const responseSchema = schema(f.operations.get("logs.read")!.contract.responses["200"].schema);
  const sampleFields = fields(responseSchema.properties.data.items);
  assert.ok("system" in sampleFields); assert.ok("http" in sampleFields); assert.ok("frontend" in sampleFields);
  const source = fields(sampleFields.source); assert.equal(schema(source.pid).type, undefined);
});

test("rangeMs and limit retain first-value conversion, empty defaults, clamping and native invalid-number outcomes", async t => {
  const f = await fixture(t);
  for (const search of ["", "?rangeMs=", "?rangeMs=60001&rangeMs=2", "?rangeMs=1", "?rangeMs=Infinity", "?rangeMs=200000000&unknown=ok"]) {
    const result = await f.invoke("summary.read", undefined, search);
    const raw = new URL("http://fixture/" + search).searchParams.get("rangeMs");
    assert.equal((result.body as any).data.rangeMs, f.api.summary(raw).rangeMs);
  }
  const invalid = f.operations.get("summary.read")!;
  assert.equal(invalid.queryValidator({ rangeMs: "not-a-number" }), true);
  const url = new URL("http://fixture/api/performance/summary?rangeMs=not-a-number");
  const native = f.api.summary(url.searchParams.get("rangeMs"));
  const invalidResult = await f.invoke("summary.read", undefined, "?rangeMs=not-a-number");
  assert.equal((invalidResult.body as any).data.rangeMs, native.rangeMs);
  for (const query of [{ limit: "" }, { limit: "NaN" }, { limit: ["1.9", "100"] }, { limit: "Infinity", unknown: ["a", "b"] }]) {
    assert.equal(f.operations.get("logs.read")!.queryValidator(query), true);
  }
  for (const search of ["", "?limit=", "?limit=NaN", "?limit=1.9&limit=2", "?limit=Infinity", "?limit=-1"]) {
    const result = await f.invoke("logs.read", undefined, search); assert.equal(result.status, 200);
  }
});
