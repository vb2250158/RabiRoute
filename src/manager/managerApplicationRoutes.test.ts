import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import test from "node:test";
import type { ApiOperationDefinition } from "./apiOperationContract.js";
import { ManagerPluginRouteRegistry } from "./managerPluginRouteRegistry.js";
import { nativeHttpTestFetch } from "./nativeHttpTestClient.js";
import { runPluginActivation } from "../plugin-kernel/pluginActivationContext.js";

function operation(id: string, route: string): ApiOperationDefinition {
  return { contract: {
    operationId: id, contractVersion: "1.0.0", method: "GET", pathTemplate: route, exposure: "public", transport: "http", description: "Fixture read.",
    request: { path: { type: "object" }, query: { type: "object" }, headers: { type: "object" }, body: { kind: "none" } },
    responses: { "200": { mediaType: "application/json; charset=utf-8", schema: { type: "object", required: ["value"], properties: { value: { const: id } } } } },
    effects: { mode: "read", description: "Read fixture." }, recovery: { strategy: "repeatable-read", description: "Read again." }, validators: []
  }, handler: () => ({ status: 200, body: { value: id } }) };
}

test("application routes survive an empty published plugin set without exposing an impersonation path", async t => {
  const key = {}, published = new Set<string>();
  const registry = new ManagerPluginRouteRegistry(() => published, undefined, { applicationOwnerKey: key });
  assert.throws(() => registry.createApplicationOwner({}, "host:bootstrap"), /unavailable/);
  const owner = registry.createApplicationOwner(key, "host:bootstrap");
  assert.throws(() => registry.registerOperations(owner.instanceId, [operation("test.unowned", "/unowned")]), /owned by the Host/);
  const app = await owner.run(async () => registry.registerOperationsAsync(owner.instanceId, [operation("test.bootstrap", "/bootstrap")], new AbortController().signal));
  const identity = { applicationGenerationId: "app", managerInstanceId: "manager", instanceId: "plugin:one", pluginId: "io.test.one", version: "1.0.0", revision: "fixture", host: "manager" as const, activationId: "activation-one" };
  assert.throws(() => runPluginActivation(identity, () => owner.run(() => {})), /Plugin activation/);
  assert.throws(() => runPluginActivation(identity, () => registry.registerOperations(owner.instanceId, [operation("test.forged", "/forged")])), /owned by the Host/);
  const plugin = runPluginActivation(identity, () => registry.registerOperations(identity.instanceId, [operation("test.plugin", "/plugin")]));
  const server = http.createServer((request, response) => {
    if (!registry.handle(request, new URL(request.url!, "http://localhost"), response)) response.writeHead(404).end();
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const base = `http://127.0.0.1:${(server.address() as import("node:net").AddressInfo).port}`;
  t.after(async () => { await app.dispose(); await plugin.dispose(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  assert.equal((await nativeHttpTestFetch(base + "/bootstrap")).status, 200);
  assert.equal((await nativeHttpTestFetch(base + "/plugin")).status, 404);
  published.add(identity.activationId);
  assert.equal((await nativeHttpTestFetch(base + "/plugin")).status, 200);
  published.clear();
  assert.equal((await nativeHttpTestFetch(base + "/bootstrap")).status, 200);
  assert.equal((await nativeHttpTestFetch(base + "/plugin")).status, 404);
  await app.dispose();
  assert.equal((await nativeHttpTestFetch(base + "/bootstrap")).status, 404);
});
