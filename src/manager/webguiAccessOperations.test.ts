import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import test from "node:test";
import { createManagerClient } from "../../apps/rabi-agent/lib/manager-client.mjs";
import { createWebguiAccessOperations, WEBGUI_ACCESS_BODY_LIMIT } from "./webguiAccessOperations.js";
import { RabiGlobalConfigStore } from "./globalConfig.js";
import { LanAgentAuthority } from "./lanAgentAuthority.js";
import { assertTrustedLanAgentPrincipal, evaluateLanAgentRequest } from "./lanAgentRequestAccess.js";
import { hasAuthenticatedConnectionRequest, markAuthenticatedConnectionRequest } from "./connectionRequestAccess.js";
import { assertLanAgentBodyAuthority, registerLanAgentBodyGuard } from "./lanAgentBodyAuthority.js";
import { ManagerPluginRouteRegistry } from "./managerPluginRouteRegistry.js";
import { createApiDiscoveryOperations } from "./apiDiscoveryRoutes.js";
import { createManagerMetadataOperation } from "./corePublicOperations.js";

test("authenticated node calls WebGUI settings through discovery and original config persistence without a persona grant", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "api-webgui-access-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const config = new RabiGlobalConfigStore(root);
  config.patch({ webguiLan: { enabled: true, accessToken: "fixture-original-shared" /* Public test-only fixture; not a real credential. */ } });
  const authority = new LanAgentAuthority({ statePath: path.join(root, "authority.json") });
  const credential = authority.enroll(authority.issueBootstrapTicket().ticket, "fixture-node");
  let writes = 0; let rotations = 0;
  const registry = new ManagerPluginRouteRegistry(undefined, { identity: () => ({ applicationGenerationId: "fixture-app", managerInstanceId: "fixture-manager", pluginGenerationId: "fixture-plugins" }) });
  const owner = { readConfig: () => config.read().webguiLan,
    saveConfig(value: { enabled: boolean; accessToken: string }) { writes++; config.patch({ webguiLan: value }); },
    generateToken: () => `fixture-rotated-${++rotations}`,
    canManage: hasAuthenticatedConnectionRequest,
    readPayload: () => { const current = config.read().webguiLan; return { code: 0, data: {
      enabled: current.enabled, tokenConfigured: Boolean(current.accessToken), token: current.accessToken, canManage: true,
      managerHost: "127.0.0.1", managerPort: 0, listeningOnLan: false, restartRequired: true, hostManagedByEnvironment: false,
      urls: [{ name: "fixture", address: "192.0.2.1", url: "http://fixture.invalid/" }]
    } }; } };
  const registration = registry.registerOperations("core", createWebguiAccessOperations(owner));
  const discovery = registry.registerOperations("discovery", createApiDiscoveryOperations(registry));
  const diagnostics = registry.registerOperations("metadata", [createManagerMetadataOperation(() => ({
    applicationGenerationId: "fixture-app", managerInstanceId: "fixture-manager", health: { live: true, requiredReady: true, state: "healthy" }
  }))]);
  const server = http.createServer((request, response) => {
    if (evaluateLanAgentRequest(request, authority, config.read().webguiLan.enabled).kind !== "agent") { response.writeHead(403).end(); return; }
    markAuthenticatedConnectionRequest(request, () => { assertTrustedLanAgentPrincipal(request); });
    const url = new URL(request.url!, "http://localhost");
    registerLanAgentBodyGuard(request, body => assertLanAgentBodyAuthority(url.pathname, body, assertTrustedLanAgentPrincipal(request)?.source));
    if (!registry.handle(request, url, response)) response.writeHead(404).end();
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  t.after(async () => { server.closeAllConnections(); await registration.dispose(); await discovery.dispose(); await diagnostics.dispose(); await new Promise<void>(resolve => server.close(() => resolve())); });
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}`;
  const client = createManagerClient({ managerUrl: base, credential: credential.token, agentType: "codex", sessionId: "fixture-original-full-session" });
  const before = await client.invokeOperation("manager.webgui-access.read"); assert.equal(before.statusCode, 200);
  const result = await client.invokeOperation("manager.webgui-access.update", { body: { regenerateToken: true } });
  assert.equal(result.statusCode, 200, JSON.parse(String(result.body)).errorCode ?? JSON.parse(String(result.body)).message); assert.equal(rotations, 1);
  assert.equal(JSON.parse(String(result.body)).data.token, "fixture-rotated-1");
  assert.equal(new RabiGlobalConfigStore(root).read().webguiLan.accessToken, "fixture-rotated-1");
  const auth = { authorization: `Bearer ${credential.token}` };
  const empty = await fetch(base + "/api/webgui-access", { method: "POST", headers: auth }); assert.equal(empty.status, 200); await empty.body?.cancel();
  const ignored = await fetch(base + "/api/webgui-access", { method: "PATCH", headers: auth, body: Buffer.from('{"enabled":"ignored","regenerateToken":1,"extra":true}') });
  assert.equal(ignored.status, 200); await ignored.body?.cancel(); assert.equal(rotations, 1);
  const textJson = await fetch(base + "/api/webgui-access", { method: "POST", headers: { ...auth, "content-type": "text/plain" }, body: "42" });
  assert.equal(textJson.status, 200); await textJson.body?.cancel(); assert.equal(rotations, 1);
  const count = writes;
  for (const body of ["null", " ", JSON.stringify({ extra: "x".repeat(WEBGUI_ACCESS_BODY_LIMIT) })]) {
    const invalid = await fetch(base + "/api/webgui-access", { method: "PATCH", headers: { ...auth, "content-type": "application/json" }, body });
    assert.ok([400, 413].includes(invalid.status)); await invalid.body?.cancel();
  }
  assert.equal(writes, count);
  for (const method of ["DELETE", "HEAD"]) {
    const invalid = await fetch(base + "/api/webgui-access", { method, headers: auth });
    assert.equal(invalid.status, 405); assert.equal(invalid.headers.get("allow"), "GET, PATCH, POST");
    if (method === "HEAD") assert.equal(await invalid.text(), ""); else await invalid.body?.cancel();
  }
  assert.equal(writes, count);
  const openapi = await (await fetch(base + "/api/agent/openapi", { headers: auth })).json() as any;
  assert.equal(openapi.paths["/api/webgui-access"].patch.requestBody.required, false);
  const catalogText = JSON.stringify(registry.catalogSnapshot());
  assert.equal(catalogText.includes("fixture-rotated-1"), false); assert.equal(catalogText.includes(credential.token), false);
  authority.revokeNode("fixture-node");
  assert.equal((await fetch(base + "/api/webgui-access", { headers: auth })).status, 403);
});

test("WebGUI configuration writes retain the original connection/local-machine predicate", () => {
  let writes = 0;
  const operations = createWebguiAccessOperations({ canManage: () => false, readConfig: () => ({ enabled: false, accessToken: "" }),
    saveConfig: () => { writes++; }, generateToken: () => "fixture", readPayload: () => ({}) });
  const write = operations.find(operation => operation.contract.method === "PATCH")!;
  const result = write.handler({ request: {} as http.IncomingMessage, response: {} as http.ServerResponse,
    url: new URL("http://localhost/api/webgui-access"), path: {}, query: {}, body: { enabled: true } });
  assert.equal((result as { status: number }).status, 403); assert.equal(writes, 0);
});
