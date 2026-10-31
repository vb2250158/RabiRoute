import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { once } from "node:events";
import { createManagerClient } from "../../apps/rabi-agent/lib/manager-client.mjs";
import { createDiagnosticsRoutes } from "../../plugins/builtin/io.rabiroute.manager.diagnostics/1.0.0/operations.mjs";
import * as corePublic from "./corePublicOperations.js";
import { createApiDiscoveryOperations } from "./apiDiscoveryRoutes.js";
import { ManagerPluginRouteRegistry } from "./managerPluginRouteRegistry.js";
import { LanAgentAuthority } from "./lanAgentAuthority.js";
import { assertTrustedLanAgentPrincipal, evaluateLanAgentRequest } from "./lanAgentRequestAccess.js";
import { markAuthenticatedConnectionRequest } from "./connectionRequestAccess.js";
import { memoryOnlyGatewayRuntimeStatus } from "./gatewayDiagnosticsSnapshot.js";
import type { GatewayRuntime } from "./runtimeRegistry.js";

test("executable diagnostics keep unready identity readable and the real connector can call meta and gateway operations", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "api-diagnostics-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const authority = new LanAgentAuthority({ statePath: path.join(root, "authority.json") });
  const credential = authority.enroll(authority.issueBootstrapTicket().ticket, "fixture-node");
  const metadata = { applicationGenerationId: "fixture-app", managerInstanceId: "fixture-manager", version: "fixture",
    health: { live: false, requiredReady: false, state: "starting", businessReady: false } };
  const gateway = memoryOnlyGatewayRuntimeStatus(root, {
    definition: { id: "fixture-route", enabled: true, name: "Fixture", messageAdapters: ["napcat"] }, readiness: "starting",
    process: null, endpoints: [], lastError: null, startedAt: null, stoppedAt: null, lastExit: null, log: []
  } as unknown as GatewayRuntime, { messageFiles: { napcat: { entries: [{ text: "fixture" }] } } });
  const registry = new ManagerPluginRouteRegistry(undefined, { identity: () => ({ applicationGenerationId: metadata.applicationGenerationId,
    managerInstanceId: metadata.managerInstanceId, pluginGenerationId: "fixture-plugins" }) });
  const buildMeta = corePublic.createManagerMetadataOperation;
  assert.equal(typeof buildMeta, "function", "Stable metadata must have a core owner");
  const coreRegistration = registry.registerOperations("core", [buildMeta(() => metadata)]);
  const routes = createDiagnosticsRoutes({ gatewayDiagnosticsPayload: () => [gateway] });
  assert.deepEqual(routes.operations.map(x => x.contract.operationId), ["manager.gateways.read"]);
  const registration = registry.registerOperations("diagnostics", routes.operations);
  const discovery = registry.registerOperations("discovery", createApiDiscoveryOperations(registry));
  const server = http.createServer((request, response) => {
    if (evaluateLanAgentRequest(request, authority, true).kind !== "agent") { response.writeHead(403).end(); return; }
    markAuthenticatedConnectionRequest(request, () => { assertTrustedLanAgentPrincipal(request); });
    if (!registry.handle(request, new URL(request.url!, "http://localhost"), response)) response.writeHead(404).end();
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  t.after(async () => { server.closeAllConnections(); await registration.dispose(); await coreRegistration.dispose(); await discovery.dispose(); await new Promise<void>(resolve => server.close(() => resolve())); });
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}`;
  const client = createManagerClient({ managerUrl: base, credential: credential.token, agentType: "dsh", sessionId: "original-source" });
  const unready = await client.request("GET", "/meta"); assert.equal(unready.statusCode, 200);
  assert.equal(JSON.parse(String(unready.body)).health.requiredReady, false);
  await assert.rejects(client.invokeOperation("manager.gateways.read"), /not ready/);
  metadata.health.live = true; metadata.health.requiredReady = true; metadata.health.state = "degraded";
  const currentMeta = await client.invokeOperation("agent:GET:/meta"); assert.equal(currentMeta.statusCode, 200);
  assert.equal(JSON.parse(String(currentMeta.body)).health.state, "degraded");
  const gateways = await client.invokeOperation("manager.gateways.read"); assert.equal(gateways.statusCode, 200);
  assert.deepEqual(JSON.parse(String(gateways.body)), JSON.parse(JSON.stringify([gateway])));
  const query = await client.request("GET", "/api/gateways?existingIgnoredQuery=1&existingIgnoredQuery=2"); assert.equal(query.statusCode, 200);
  assert.equal(query.headers!["cache-control"], "private, no-store");
  authority.revokeNode("fixture-node");
  assert.equal((await fetch(base + "/meta", { headers: { authorization: `Bearer ${credential.token}` } })).status, 403);
});

test("diagnostic retirement waits for awaited owner work after its HTTP client closes", { timeout: 5000 }, async t => {
  let started!: () => void;
  const reading = new Promise<void>(resolve => { started = resolve; });
  let finish!: () => void;
  const completed = new Promise<void>(resolve => { finish = resolve; });
  const routes = createDiagnosticsRoutes({ gatewayDiagnosticsPayload: async () => { started(); await completed; return []; } });
  const registry = new ManagerPluginRouteRegistry(); const registration = registry.registerOperations("diagnostics", routes.operations);
  const server = http.createServer((request, response) => registry.handle(request, new URL(request.url!, "http://localhost"), response));
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  t.after(async () => { finish(); server.closeAllConnections(); await registration.dispose(); await new Promise<void>(resolve => server.close(() => resolve())); });
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const controller = new AbortController();
  const request = fetch(`http://127.0.0.1:${address.port}/api/gateways`, { signal: controller.signal }).catch(() => undefined);
  await reading; controller.abort(); await request;
  let retired = false; const stopped = registration.dispose().then(() => { retired = true; });
  await new Promise<void>(resolve => setImmediate(resolve)); assert.equal(retired, false);
  finish(); await stopped; assert.equal(registration.activeOperationCount(), 0);
});
