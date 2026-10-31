import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createXiaomiHomeManagerOperations } from "../integrations/xiaomiHome/managerOperations.js";
import { XiaomiHomeRuntimeController, XiaomiHomeSettingsStore } from "../integrations/xiaomiHome/settingsRuntime.js";
import { XiaomiHomeArtifactStore } from "../integrations/xiaomiHome/artifactStore.js";
import { XiaomiHomeCredentialStore } from "../integrations/xiaomiHome/credentials.js";
import { ManagerPluginRouteRegistry } from "./managerPluginRouteRegistry.js";
import { apiCatalogOpenApi } from "./apiOperationCatalog.js";
import { LanAgentAuthority } from "./lanAgentAuthority.js";
import { evaluateLanAgentRequest, assertTrustedLanAgentPrincipal } from "./lanAgentRequestAccess.js";
import { markAuthenticatedConnectionRequest } from "./connectionRequestAccess.js";

test("home directory search, pagination and details are discoverable through the same Agent catalog", { timeout: 15000 }, async t => {
  const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), "home-directory-catalog-")), cleanup: Array<() => Promise<unknown>> = [];
  t.after(async () => {
    const results = await Promise.allSettled(cleanup.map(dispose => dispose()));
    assert.equal(path.dirname(path.resolve(runtimeDir)), path.resolve(os.tmpdir()));
    fs.rmSync(runtimeDir, { recursive: true, force: true });
    assert.ok(results.every(result => result.status === "fulfilled"));
  });
  const baseUrl = "http://127.0.0.1", calls: string[] = [];
  const rows = [
    { entityId: "climate.ac", deviceId: "ac", displayName: "书房空调", areaName: "书房" },
    { entityId: "sensor.temperature", deviceId: "ac", displayName: "书房温度", areaName: "书房" },
    { entityId: "climate.ac2", deviceId: "ac2", displayName: "书房空调二", areaName: "书房" },
    { entityId: "climate.living", deviceId: "living", displayName: "客厅空调", areaName: "客厅" }
  ];
  const states = rows.map(row => ({ entity_id: row.entityId, state: "on", attributes: { friendly_name: row.displayName }, last_updated: "2026-10-22T00:00:00Z" }));
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = new URL(String(input)); assert.equal(url.origin, baseUrl); calls.push((init?.method || "GET") + " " + url.pathname);
    if (url.pathname === "/api/states") return new Response(JSON.stringify(states));
    if (url.pathname === "/api/template") {
      assert.equal(init?.method, "POST"); assert.equal(typeof JSON.parse(String(init.body)).template, "string");
      return new Response(JSON.stringify(rows.map(row => ({ ...row, model: "fixture", manufacturer: "fixture" }))));
    }
    const state = states.find(row => url.pathname === "/api/states/" + row.entity_id);
    assert.ok(state, "Only controlled registry/state reads are permitted."); assert.notEqual(init?.method, "POST"); return new Response(JSON.stringify(state));
  };
  const credentials = new XiaomiHomeCredentialStore(runtimeDir, { scheme: "test-protector-v1", protect: value => Buffer.from(value).toString("base64"), unprotect: value => Buffer.from(value, "base64").toString() });
  credentials.write("owned-directory-test-token", baseUrl, {});
  const runtime = new XiaomiHomeRuntimeController(new XiaomiHomeSettingsStore(runtimeDir, { baseUrl, eventMonitorEnabled: false }), new XiaomiHomeArtifactStore(runtimeDir), { env: {}, fetchImpl, deliverEvent: async () => { throw new Error("No external delivery is permitted."); } }, credentials);
  cleanup.push(() => runtime.stop());
  const registry = new ManagerPluginRouteRegistry();
  const definitions = createXiaomiHomeManagerOperations({ runtime, lifecycleFence: { applicationGenerationId: "directory-fixture-generation", managerInstanceId: "directory-fixture-manager" }, deliverEvent: async () => { throw new Error("No external delivery is permitted."); } });
  const operations = registry.registerOperations("home-directory-fixture", definitions.operations), proxies = registry.registerHttpProxies("home-directory-fixture", definitions.proxies);
  cleanup.push(() => operations.dispose(), () => proxies.dispose());
  const authority = new LanAgentAuthority({ statePath: path.join(runtimeDir, "authority.json") });
  const credential = authority.enroll(authority.issueBootstrapTicket().ticket, "empty-directory-node");
  const server = http.createServer((request, response) => {
    if (evaluateLanAgentRequest(request, authority, true).kind !== "agent") { response.writeHead(401).end(); return; }
    markAuthenticatedConnectionRequest(request, () => { assertTrustedLanAgentPrincipal(request); });
    if (!registry.handle(request, new URL(request.url!, "http://fixture"), response)) response.writeHead(404).end();
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  cleanup.push(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const request = (suffix: string) => fetch("http://127.0.0.1:" + address.port + "/api/agent/xiaomi-home" + suffix, { headers: { authorization: "Bearer " + credential.token } });
  const catalog = registry.catalogSnapshot(); assert.equal(catalog.operations.length, 53); assert.ok(catalog.operations.every(row => row.contract.exposure === "public"));
  assert.equal(catalog.coverage.scope, "registered-routes"); assert.equal(catalog.coverage.globalCoverage, "not-proven");
  const openapi = (await apiCatalogOpenApi(catalog)).paths as Record<string, unknown>;
  for (const suffix of ["/devices", "/resources", "/devices/{deviceId}", "/resources/{resourceId}", "/capabilities"]) assert.ok(openapi["/api/agent/xiaomi-home" + suffix]);
  const deviceContract = catalog.operations.find(row => row.contract.operationId === "manager.xiaomi-home.devices.list"); assert.ok(deviceContract); assert.equal(deviceContract.contract.request.query && typeof deviceContract.contract.request.query, "object"); assert.ok(deviceContract.contract.responses["200"].schema);
  // The live capability DTO owns query names/defaults; per-operation wire schemas
  // still defer these native query rules rather than claiming exact field coverage.
  const capabilities = await request("/capabilities"); assert.equal(capabilities.status, 200);
  const query = (await capabilities.json()).data.directoryQuery;
  assert.deepEqual(query.parameters, ["q", "kind", "available", "view", "offset", "limit"]); assert.deepEqual(query.resourceParameters, ["deviceId", "includeActions"]);
  assert.equal(query.defaultView, "summary"); assert.equal(query.defaultLimit, 20); assert.equal(query.maxLimit, 50);
  const first = await request("/devices?q=" + encodeURIComponent("书房") + "&kind=climate&available=1&view=summary&offset=0&limit=1"); assert.equal(first.status, 200);
  const page = (await first.json()).data; assert.equal(page.schemaVersion, 1); assert.equal(page.view, "summary"); assert.equal(page.total, 2); assert.equal(page.offset, 0); assert.equal(page.limit, 1); assert.equal(page.nextOffset, 1); assert.equal(page.items[0].deviceId, "ac"); assert.equal(typeof page.observedAt, "string"); assert.equal(page.items[0].resources, undefined);
  const second = await request("/devices?q=" + encodeURIComponent("书房") + "&kind=climate&available=1&view=summary&offset=1&limit=1"); assert.equal(second.status, 200);
  const next = (await second.json()).data; assert.equal(next.items[0].deviceId, "ac2"); assert.equal(next.nextOffset, null);
  const resources = await request("/resources?deviceId=ac&q=" + encodeURIComponent("温度") + "&limit=5"); assert.equal(resources.status, 200);
  const resourcePage = (await resources.json()).data; assert.equal(resourcePage.total, 1); assert.equal(resourcePage.items[0].resourceId, "home:ha:sensor.temperature"); assert.equal(resourcePage.nextOffset, null);
  const device = await request("/devices/ac"); assert.equal(device.status, 200); assert.equal((await device.json()).data.resourceCount, 2);
  const detail = await request("/resources/" + encodeURIComponent("home:ha:sensor.temperature")); assert.equal(detail.status, 200);
  const resource = (await detail.json()).data; assert.equal(resource.attributes.friendly_name, "书房温度"); assert.match(resource.stateVersion, /^ha:/);
  const before = calls.length;
  for (const suffix of ["/devices?limit=51", "/devices?limit=1&limit=2", "/resources?view=summary&includeActions=1"]) {
    const invalid = await request(suffix); assert.equal(invalid.status, 400); assert.equal((await invalid.json()).error.code, "xiaomi_home_query_invalid");
  }
  assert.equal(calls.length, before); assert.ok(!calls.some(call => call.includes("/api/services/")));
});
