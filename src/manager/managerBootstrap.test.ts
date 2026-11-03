import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ManagerPluginRouteRegistry } from "./managerPluginRouteRegistry.js";
import { registerManagerBootstrap, splitManagerBootstrapPublicOperations } from "./managerBootstrap.js";
import { createCorePublicOperations, type CorePublicOperationsContext } from "./corePublicOperations.js";
import { createWebguiAccessOperations } from "./webguiAccessOperations.js";
import { createWebguiStaticOperations } from "./webguiStaticOperations.js";
import { NativeWebguiStaticOwner } from "./nativeWebguiStaticOwner.js";
import { ManagerEventHub, createManagerEventsOperation } from "./managerEvents.js";
import { createPluginCatalogOperations } from "./pluginCatalogOperations.js";
import { renderPluginCatalog } from "./pluginCatalogPresentation.js";
import { GenerationRuntime } from "../plugin-kernel/generationRuntime.js";
import { markAuthenticatedConnectionRequest } from "./connectionRequestAccess.js";
import { runPluginActivation } from "../plugin-kernel/pluginActivationContext.js";
import type { PluginIdentity } from "../plugin-kernel/types.js";
import type { NativeWebguiStaticOwner as StaticOwner } from "./nativeWebguiStaticOwner.js";

const identity = { applicationGenerationId: "bootstrap-app", managerInstanceId: "bootstrap-manager" };
function publicDefinitions() {
  return createCorePublicOperations({ identity: () => identity,
    metaPayload: () => ({ ...identity, health: { live: true, requiredReady: false, state: "degraded" } }),
    health: () => ({ protocolVersion: 1, ...identity, health: { live: true, requiredReady: false, state: "degraded" }, pluginReadiness: {}, routeLifecycle: {}, backgroundLifecycle: {} }),
    automaticUpdates: () => ({ state: "disabled" })
  } as CorePublicOperationsContext);
}

test("bootstrap partitions reuse original contracts and keep identity-reset and update operations in core", () => {
  const original = publicDefinitions(), split = splitManagerBootstrapPublicOperations(original);
  assert.deepEqual(split.bootstrap.map(item => item.contract.pathTemplate), ["/meta", "/health"]);
  assert.ok(split.business.some(item => item.contract.pathTemplate.startsWith("/api/rabi/identity/")));
  assert.ok(split.business.some(item => item.contract.pathTemplate === "/api/automatic-updates"));
  assert.equal(split.bootstrap.length + split.business.length, original.length);
  for (const definition of [...split.bootstrap, ...split.business]) assert.ok(original.includes(definition));
});

test("an empty published plugin set retains fresh WebGUI shell, identity, catalog, access and the original event stream", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "manager-bootstrap-"));
  const web = path.join(root, "web"); await fs.mkdir(path.join(web, "assets"), { recursive: true });
  await fs.writeFile(path.join(web, "index.html"), '<!doctype html><html><body>Bootstrap plugins<script src="/assets/app.js"></script></body></html>');
  await fs.writeFile(path.join(web, "assets", "app.js"), "export const bootstrap=true;");
  const published = new Set<string>(), key = {};
  const registry = new ManagerPluginRouteRegistry(() => published, { identity: () => ({ ...identity, pluginGenerationId: "plugins" }) }, { applicationOwnerKey: key });
  const runtime = new GenerationRuntime({ host: "manager", applicationIdentity: identity });
  const hub = new ManagerEventHub();
  const staticOwner = new NativeWebguiStaticOwner({ packageRoot: root, webuiDistPath: web,
    patches: { status: () => ({ active: undefined }) } as ConstructorParameters<typeof StaticOwner>[0]["patches"],
    isControlPath: value => value.startsWith("/api/") || ["/meta", "/health"].includes(value) });
  const controller = new AbortController();
  const bootstrap = await registerManagerBootstrap({ registry,
    applicationOwner: registry.createApplicationOwner(key, "host:manager-bootstrap"), publicOperations: publicDefinitions,
    catalogOperations: () => createPluginCatalogOperations({ runtime, root: () => root,
      renderCatalog: async (input, host) => ({ revision: 1, contract: {}, value: renderPluginCatalog(input, host) }) }),
    eventOperation: () => createManagerEventsOperation(hub), staticOperations: () => createWebguiStaticOperations(staticOwner),
    accessOperations: () => createWebguiAccessOperations({ canManage: () => true,
      readConfig: () => ({ enabled: false, accessToken: "" }), saveConfig: () => { throw new Error("Read-only fixture"); }, generateToken: () => "",
      readPayload: () => ({ code: 0, data: { enabled: false, tokenConfigured: false, token: "", canManage: true, managerHost: "127.0.0.1", managerPort: 0,
        listeningOnLan: false, restartRequired: false, hostManagedByEnvironment: false, urls: [] } }) })
  }, controller.signal);
  const server = http.createServer((request, response) => {
    markAuthenticatedConnectionRequest(request);
    if (!registry.handle(request, new URL(request.url!, "http://localhost"), response)) response.writeHead(404).end();
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { hub.closeAll(); await bootstrap.dispose(); await runtime.dispose(); server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve())); await fs.rm(root, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  for (const tail of ["/meta", "/health", "/api/plugins/catalog", "/api/webgui-access", "/plugins", "/assets/app.js"]) {
    const response = await fetch(base + tail); assert.equal(response.status, 200, tail); await response.text();
  }
  assert.equal((await (await fetch(base + "/meta")).json()).health.requiredReady, false);
  const events = await fetch(base + "/api/events"), reader = events.body!.getReader();
  await reader.read(); assert.equal(hub.activeSubscriberCount(), 1);
  const activation: PluginIdentity = { ...identity, activationId: "core-activation", instanceId: "manager:core", pluginId: "io.test.core", version: "1", revision: "test", host: "manager" };
  const business = runPluginActivation(activation, () => registry.registerOperations("manager:core", splitManagerBootstrapPublicOperations(publicDefinitions()).business));
  published.add(activation.activationId); registry.refreshPublication();
  assert.equal((await fetch(base + "/api/automatic-updates")).status, 200);
  published.clear(); registry.refreshPublication(); await business.dispose();
  assert.equal((await fetch(base + "/api/automatic-updates")).status, 404);
  assert.equal((await fetch(base + "/plugins")).status, 200);
  assert.equal(hub.activeSubscriberCount(), 1);
  hub.publish("plugin_catalog_changed", { generation: "without-core" });
  assert.equal((await reader.read()).done, false);
  await reader.cancel(); await bootstrap.dispose();
  assert.equal(hub.activeSubscriberCount(), 0);
  assert.equal((await fetch(base + "/meta")).status, 404);
});
