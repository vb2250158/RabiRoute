import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import { once } from "node:events";
import { ManagerPluginRouteRegistry } from "../../../../manager/managerPluginRouteRegistry.js";
import { createApiDiscoveryOperations } from "./apiDiscoveryRoutes.js";
import { fixtureApiContract } from "../../../../manager/apiOperationContractFixtures.js";

/** GET /api/agent/categories is the entry point of every Agent's discovery loop.
 * This covers the published category shape: builtin groups, plugin-declared
 * children, synthesised missing parents and the rolled-up operation counts. */
test("categories keep the builtin business groups, plugin children and rolled-up counts in one closed structure", async t => {
  const registry = new ManagerPluginRouteRegistry();
  const discovery = registry.registerOperations("discovery", createApiDiscoveryOperations(registry));
  const declaration = (operationId: string, pathTemplate: string,
    category: { id: string; title: string; description?: string; parentId?: string }) => ({
    contract: fixtureApiContract({ operationId, method: "GET", pathTemplate,
      request: { path: { type: "object" }, query: { type: "object" }, headers: { type: "object" }, body: { kind: "none" } } }),
    discovery: { title: operationId, summary: operationId, category },
    handler: () => ({ status: 200, body: { ok: true } })
  });
  const registration = registry.registerOperations("example", [
    declaration("fixture.qq.history", "/api/example/qq/history", { id: "messages.qq", title: "QQ 消息", parentId: "messages" }),
    declaration("fixture.qq.send", "/api/example/qq/send", { id: "messages.qq", title: "QQ 消息", parentId: "messages" }),
    // The parent is declared by no operation: the endpoint must synthesise it
    // instead of publishing a child whose parentId resolves to nothing.
    declaration("fixture.custom.tool", "/api/example/custom/tool", { id: "custom.tools", title: "自定义工具", parentId: "custom.root" }),
  ]);
  const server = http.createServer((request, response) => {
    if (!registry.handle(request, new URL(request.url!, "http://localhost"), response)) { response.statusCode = 404; response.end(); }
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const root = `http://127.0.0.1:${address.port}`;
  t.after(async () => { await registration.dispose(); await discovery.dispose(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });

  const response = await fetch(root + "/api/agent/categories");
  assert.equal(response.status, 200);
  const body = await response.json() as { code: number; data: {
    schemaVersion: string; applicationGenerationId: string; managerInstanceId: string; pluginGenerationId: string;
    catalogRevision: number; catalogDigest: string; resultScope: string; usageHint: string;
    categories: { id: string; title: string; description: string; parentId?: string; count: number; ownerPluginId?: string }[] } };
  assert.equal(body.code, 0);
  assert.equal(body.data.schemaVersion, "2");
  assert.equal(body.data.resultScope, "api-categories");
  assert.match(body.data.usageHint, /not a business resource list/);
  assert.ok(body.data.applicationGenerationId && body.data.managerInstanceId && body.data.pluginGenerationId);
  assert.ok(Number.isInteger(body.data.catalogRevision) && body.data.catalogRevision >= 1);
  assert.match(body.data.catalogDigest, /^sha256:[a-f0-9]{64}$/);

  const categories = body.data.categories;
  const byId = new Map(categories.map(category => [category.id, category]));
  // Every builtin business group is published even without a matching operation.
  for (const id of ["messages", "agents", "knowledge", "devices", "settings", "automation", "runtime"]) {
    const builtin = byId.get(id);
    assert.ok(builtin, `missing builtin category ${id}`);
    assert.ok(builtin.title.trim(), `builtin category ${id} has no title`);
    assert.ok(builtin.description.trim(), `builtin category ${id} has no description`);
    assert.ok(Number.isInteger(builtin.count) && builtin.count >= 0, `builtin category ${id} has no count`);
    assert.equal(builtin.parentId, undefined);
  }
  // Plugin children keep their declared parent and roll up into it. ownerPluginId
  // only exists when the registration carries a plugin activation, so this
  // registry-only fixture publishes the category without one.
  assert.deepEqual(
    { id: byId.get("messages.qq")?.parentId, count: byId.get("messages.qq")?.count, owner: byId.get("messages.qq")?.ownerPluginId },
    { id: "messages", count: 2, owner: undefined });
  assert.equal(byId.get("messages")?.count, 2);
  // A parent nobody declared is synthesised so no child points at a missing row.
  assert.deepEqual({ id: byId.get("custom.root")?.id, title: byId.get("custom.root")?.title, count: byId.get("custom.root")?.count, parent: byId.get("custom.root")?.parentId },
    { id: "custom.root", title: "custom.root", count: 1, parent: undefined });
  assert.deepEqual({ parent: byId.get("custom.tools")?.parentId, count: byId.get("custom.tools")?.count },
    { parent: "custom.root", count: 1 });
  for (const category of categories) {
    if (category.parentId === undefined) continue;
    assert.ok(byId.has(category.parentId), `category ${category.id} points at missing parent ${category.parentId}`);
  }
  assert.equal(new Set(categories.map(category => category.id)).size, categories.length);

  // The same read stays conditional on the published catalog revision.
  const etag = response.headers.get("etag");
  assert.ok(etag);
  const conditional = await fetch(root + "/api/agent/categories", { headers: { "if-none-match": etag } });
  assert.equal(conditional.status, 304);
});
