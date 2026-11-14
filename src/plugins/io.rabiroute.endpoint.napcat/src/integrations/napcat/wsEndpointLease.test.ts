import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { once } from "node:events";
import test from "node:test";
import { WebSocket, WebSocketServer } from "ws";
import type { GatewayListenerDescriptor } from "@rabiroute/plugin-sdk";
import { createNapcatWsEndpointAccess } from "./wsEndpointLease.js";
import { configureNapcatOneBot, launchNapcatInstance, type NapcatManagerContext } from "../../messageEndpoints/napcatManager.js";
import { createNapcatManagerOwner, type NapcatManagerHostPorts } from "./managerOwner.js";
import { startNapCatWsOwner } from "../../adapters/napcatWsOwner.js";
import { ManagerPluginRouteRegistry } from "@rabiroute/host-api/manager/managerPluginRouteRegistry";
import { GenerationRuntime } from "@rabiroute/host-api/plugin-kernel/generationRuntime";
import type { PluginCandidate } from "@rabiroute/host-api/plugin-kernel/types";

const request = { gatewayId: "route", instanceId: "bot" };

test("a Host with only endpoint @2 cannot activate the new @3 consumer", async () => {
  let activated = 0;
  const candidate: PluginCandidate = { instanceId: "napcat", revision: "fixture-v3", config: {},
    entry: { execution: "in_process", path: "fixture-v3.mjs" },
    manifest: { schemaVersion: 2, id: "io.test.napcat-v3", version: "1.0.0", entries: { gateway: { execution: "in_process", module: "fixture-v3.mjs" } },
      provides: [], requires: ["host.message-endpoints@3"], optional: [], permissions: [] } };
  const runtime = new GenerationRuntime({ host: "gateway", hostServices: [{ capability: "host.message-endpoints@2", value: {} }],
    executor: { async prepare() { return { activate() { activated++; } }; } } });
  try {
    const result = await runtime.switch([candidate]);
    assert.notEqual(result.generation.records[0]?.status, "active"); assert.equal(activated, 0);
  } finally { await runtime.dispose(); }
});
function descriptor(assertCurrent: () => void): GatewayListenerDescriptor {
  return { gatewayId: "route", gatewayGenerationId: "original", pid: 123,
    listenerId: "fixture-listener", leaseId: "fixture-lease", protocol: "onebot-v11-reverse-websocket",
    address: { protocol: "http", hostname: "127.0.0.1", port: 12345 }, assertCurrent };
}

for (const cause of ["no current descriptor", "generation changed"] as const) {
  test(`${cause} rejects real NapCat configuration and launch before any file mutation or spawn`, async t => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "napcat-ws-admission-"));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const filename = path.join(directory, "onebot11.json"); fs.writeFileSync(filename, '{"original":true}');
    let probes = 0, spawns = 0;
    const access = createNapcatWsEndpointAccess({ signal: new AbortController().signal, timeoutMs: 100,
      assertBound() {}, listeners: { readListener() { return undefined; }, async waitForListener() {
        if (cause === "no current descriptor") throw new Error(cause);
        return descriptor(() => { throw new Error(cause); });
      } } });
    const instance = { id: "bot", gatewayPort: 0, httpUrl: "http://127.0.0.1:1", webuiUrl: "http://127.0.0.1:1/webui" };
    const context: NapcatManagerContext = { rootDir: directory,
      getRuntimes: () => [{ definition: { id: "route", gatewayPort: 0, napcatInstances: [instance] } }],
      normalizeNapCatInstances: () => [instance], appendLog() {},
      async checkHttpEndpoint() { probes++; return false; },
      runBindingOperation: (binding, operation) => access.run(binding, operation),
      assertWsEndpointCurrent: access.assertCurrent,
      launchNapcatProcess() { spawns++; }
    };
    await assert.rejects(configureNapcatOneBot(context, { ...request, ...instance }), new RegExp(cause));
    await assert.rejects(launchNapcatInstance(context, request), new RegExp(cause));
    assert.equal(fs.readFileSync(filename, "utf8"), '{"original":true}');
    assert.deepEqual(fs.readdirSync(directory), ["onebot11.json"]);
    assert.equal(probes, 0); assert.equal(spawns, 0);
  });
}

test("a retired descriptor cannot be replaced inside the original binding operation", async () => {
  let current = true, acquisitions = 0, writes = 0;
  let release!: () => void, entered!: () => void;
  const ready = new Promise<void>(resolve => { entered = resolve; });
  const wait = new Promise<void>(resolve => { release = resolve; });
  const lease = descriptor(() => { if (!current) throw new Error("original generation retired"); });
  const access = createNapcatWsEndpointAccess({ signal: new AbortController().signal, timeoutMs: 100,
    assertBound() {}, listeners: { readListener() { return lease; }, async waitForListener() { acquisitions++; return lease; } } });
  const operation = assert.rejects(access.run(request, async () => {
    entered(); await wait;
    await access.run(request, async () => { access.assertCurrent(); writes++; });
  }), /original generation retired/);
  await ready; current = false; release(); await operation;
  assert.equal(acquisitions, 1); assert.equal(writes, 0);
});

test("the original Manager binding writes the actual owned WS address to OneBot and keeps saved zero", { timeout: 15000 }, async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "napcat-ws-real-config-"));
  const configDir = path.join(directory, "config"); fs.mkdirSync(configDir);
  let applied: string | undefined;
  const server = http.createServer(async (request, response) => {
    let bytes = ""; for await (const chunk of request) bytes += String(chunk);
    response.setHeader("content-type", "application/json");
    if (request.url === "/api/auth/login") response.end(JSON.stringify({ code: 0, data: { Credential: "test-only-session" } }));
    else if (request.url === "/api/QQLogin/GetQQLoginInfo") response.end(JSON.stringify({ code: 0, data: { uin: "10000", online: true } }));
    else if (request.url === "/api/OB11Config/SetConfig") {
      assert.equal(request.headers.authorization, "Bearer test-only-session");
      applied = String(JSON.parse(bytes).config); response.end(JSON.stringify({ code: 0 }));
    } else if (request.url === "/get_login_info") response.end(JSON.stringify({ retcode: 0, data: { user_id: 10000 } }));
    else { response.statusCode = 404; response.end(JSON.stringify({ code: -1 })); }
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const address = server.address(); if (!address || typeof address === "string") throw new Error("No fixture WebUI address.");
  fs.writeFileSync(path.join(configDir, "webui.json"), JSON.stringify({ port: address.port, token: "test-only-token" }));
  const registry = new ManagerPluginRouteRegistry();
  const native = await startNapCatWsOwner({ instanceId: "bot", port: 0, server: new WebSocketServer({ noServer: true }),
    operations: registry, connected: () => async () => {}, reportError(error) { throw error; } });
  const binding = native.binding.binding;
  const proof: GatewayListenerDescriptor = { gatewayId: "route", gatewayGenerationId: "fixture-original", pid: process.pid,
    listenerId: binding.listenerId, leaseId: binding.leaseId, protocol: binding.protocol, address: binding.address,
    assertCurrent() { if (!native.listener.listening || !native.binding.publication().active) throw new Error("original listener retired"); } };
  const saved = { id: "route", enabled: true, messageAdapters: ["napcat"] as const, gatewayPort: 0,
    napcatInstances: [{ id: "bot", botUserId: "10000", enabled: true, gatewayPort: 0, workingDir: directory,
      httpUrl: `http://127.0.0.1:${address.port}`, webuiUrl: `http://127.0.0.1:${address.port}/webui`, webuiToken: "test-only-token" }] };
  const host: NapcatManagerHostPorts = {
    rootDir: directory, managerPort: 0, readOnly: false,
    readListener() { proof.assertCurrent(); return proof; }, async waitForListener() { proof.assertCurrent(); return proof; },
    readRuntimes: () => [{ definition: { ...saved, messageAdapters: [...saved.messageAdapters] }, running: true, status: {} }],
    readRoutes: () => [{ ...saved, messageAdapters: [...saved.messageAdapters] }], normalizeDefinition: value => value,
    appendRouteLog() {}, async checkHttpEndpoint() { return true; }, async writeRoutes() { throw new Error("saved config must not change"); },
    async saveRoute() { throw new Error("saved config must not change"); }, routeVersion: () => "fixture", syncRoutes() {}, gatewayPayload() {}, log() {}
  };
  const manager = createNapcatManagerOwner(host);
  t.after(async () => { await manager.stopResources(); await native.close(); server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve())); fs.rmSync(directory, { recursive: true, force: true }); });
  await manager.reconcileRoutes([{ ...saved, messageAdapters: [...saved.messageAdapters] }]);
  const result = await configureNapcatOneBot(manager.context(), { ...request, gatewayPort: 65500,
    httpUrl: saved.napcatInstances[0].httpUrl, webuiUrl: saved.napcatInstances[0].webuiUrl });
  assert.equal(result.ok, true);
  const actual = `ws://127.0.0.1:${native.port}`;
  const persisted = JSON.parse(fs.readFileSync(path.join(configDir, "onebot11_10000.json"), "utf8"));
  assert.equal(persisted.network.websocketClients[0].url, actual);
  assert.equal(JSON.parse(applied!).network.websocketClients[0].url, actual);
  assert.equal(saved.gatewayPort, 0); assert.equal(saved.napcatInstances[0].gatewayPort, 0);
  const socket = new WebSocket(persisted.network.websocketClients[0].url); await once(socket, "open");
  const closed = once(socket, "close"); socket.close(); await closed;
});
