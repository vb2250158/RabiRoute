import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import { once } from "node:events";
import { ManagerPluginRouteRegistry } from "../../../../manager/managerPluginRouteRegistry.js";
import { createApiDiscoveryOperations } from "./apiDiscoveryRoutes.js";
import { fixtureApiContract } from "../../../../manager/apiOperationContractFixtures.js";
import type { ApiOperationDefinition } from "../../../../manager/apiOperationContract.js";

test("discovery, OpenAPI, conditional reads and revision-bound pagination use the active registered snapshot", async t => {
  const registry = new ManagerPluginRouteRegistry();
  const discovery = registry.registerOperations("discovery", createApiDiscoveryOperations(registry));
  const alias = "example:POST:/api/example/records/:recordId";
  const operation = registry.registerOperations("example", [{ contract: fixtureApiContract({ aliases: [alias] }), handler: () => ({ status: 200, body: { ok: true, value: 1 } }) }]);
  // A broad former handler cannot hide an exact registered discovery operation.
  registry.register("broad", [{ routeId: "broad", match: { kind: "prefix", pathPrefix: "/api/" }, handler: (_req, _url, res) => { res.statusCode = 418; res.end(); return true; } }]);
  const server = http.createServer((request, response) => {
    if (!registry.handle(request, new URL(request.url!, "http://localhost"), response)) { response.statusCode = 404; response.end(); }
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const root = `http://127.0.0.1:${address.port}`;
  t.after(async () => { await operation.dispose(); await discovery.dispose(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  const help = await fetch(root + "/api/agent/help");
  assert.equal(help.status, 200);
  const body = await help.json() as { data: { schemaVersion: string; operations: { id: string }[]; coverage: { complete: boolean } } };
  assert.equal(body.data.schemaVersion, "2"); assert.equal(body.data.operations.length, 7);
  assert.ok(body.data.operations.some(value => value.id === "example.record.write"));
  assert.equal(body.data.coverage.complete, false);
  const aliasHelp = await (await fetch(root + "/api/agent/help?operationId=" + encodeURIComponent(alias))).json();
  assert.equal(aliasHelp.data.count, 1); assert.equal(aliasHelp.data.operations[0].id, "example.record.write");
  assert.deepEqual(aliasHelp.data.operations[0].contract.aliases, [alias]);
  assert.equal((await fetch(root + "/api/agent/help", { headers: { "if-none-match": help.headers.get("etag")! } })).status, 304);
  assert.equal((await fetch(root + "/api/agent/help?operationId=example.record.write", { headers: { "if-none-match": help.headers.get("etag")! } })).status, 200);
  const filtered = await fetch(root + "/api/agent/help?method=%20pOsT%20&path=%20%2Fapi%2Fexample%2Frecords%2F%3ArecordId%20");
  assert.equal(filtered.status, 200);
  assert.deepEqual((await filtered.json()).data.operations.map((value: { id: string }) => value.id), ["example.record.write"]);
  for (const query of ["path=%20", "operationId=%20", "method=GET&method=POST", "unrecognized=value"]) {
    const invalid = await fetch(root + "/api/agent/help?" + query); assert.equal(invalid.status, 400);
    assert.equal((await invalid.json()).errorCode, "API_REQUEST_SCHEMA_INVALID");
  }
  const page = await (await fetch(root + "/api/agent/help?limit=1")).json() as { data: { nextCursor: string; count: number } };
  for (const value of [null, false, 12, [], "invalid"]) {
    const cursor = Buffer.from(JSON.stringify(value)).toString("base64url");
    const rejected = await fetch(root + "/api/agent/help?cursor=" + cursor);
    assert.equal(rejected.status, 400);
    assert.equal((await rejected.json()).errorCode, "API_CATALOG_CURSOR_INVALID");
  }
  assert.equal(page.data.count, 1); assert.ok(page.data.nextCursor);
  const next = await fetch(root + "/api/agent/help?limit=1&cursor=" + encodeURIComponent(page.data.nextCursor)); assert.equal(next.status, 200);
  await operation.dispose();
  assert.equal((await fetch(root + "/api/agent/help?limit=1&cursor=" + encodeURIComponent(page.data.nextCursor))).status, 409);
  const spec = await (await fetch(root + "/api/agent/openapi")).json() as { openapi: string; paths: Record<string, unknown> };
  assert.equal(spec.openapi, "3.1.0"); assert.ok(spec.paths["/api/agent/help"]);
  assert.equal((await fetch(root + "/api/lan-agent/capabilities")).status, 200);
});


test("lightweight discovery HTTP routes expose categories, search and exact descriptions through the active registry", async t => {
  const registry = new ManagerPluginRouteRegistry();
  const discovery = registry.registerOperations("discovery", createApiDiscoveryOperations(registry));
  const declaration = { title: "读取群聊历史", summary: "Read selected group history", category: { id: "messages.qq", title: "QQ", parentId: "messages" },
    tags: ["QQ"], keywords: ["群消息"], provider: "napcat", inputSources: [{ field: "query.routeId", operationId: "fixture.routes", resultPath: "/data/items", valuePath: "/id" }] };
  const operation = registry.registerOperations("example", [{ contract: fixtureApiContract({ operationId: "fixture.group.history", aliases: ["legacy:group:history"] }), discovery: declaration,
    handler: () => ({ status: 200, body: { ok: true, value: 1 } }) }]);
  declaration.title = "Caller mutation must not leak";
  const server = http.createServer((request, response) => {
    if (!registry.handle(request, new URL(request.url!, "http://localhost"), response)) { response.statusCode = 404; response.end(); }
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const root = `http://127.0.0.1:${address.port}`;
  t.after(async () => { await operation.dispose(); await discovery.dispose(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  const categories = await (await fetch(root + "/api/agent/categories")).json();
  assert.equal(categories.code, 0); assert.equal(categories.data.resultScope, "api-categories"); assert.match(categories.data.usageHint, /not a business resource list/); assert.equal(categories.data.categories.find((row: { id: string }) => row.id === "messages").count, 1);
  assert.equal(categories.data.categories.find((row: { id: string }) => row.id === "messages.qq").parentId, "messages");
  const response = await fetch(root + "/api/agent/operations?category=messages&query=" + encodeURIComponent("QQ 群消息") + "&provider=napcat&method=post&owner=example&pathPrefix=%2Fapi%2Fexample");
  assert.equal(response.status, 200);
  const page = await response.json(); assert.equal(page.data.resultScope, "api-operations"); assert.match(page.data.usageHint, /Totals count matching APIs/); assert.equal(page.data.count, 1); assert.equal(page.data.items[0].operationId, "fixture.group.history");
  assert.equal(page.data.items[0].title, "读取群聊历史"); assert.equal(Object.hasOwn(page.data.items[0], "contract"), false);
  assert.equal((await fetch(response.url, { headers: { "if-none-match": response.headers.get("etag")! } })).status, 304);
  const detail = await (await fetch(root + page.data.items[0].describe.path)).json();
  assert.equal(detail.data.resultScope, "api-operation-description"); assert.equal(detail.data.operation.id, "fixture.group.history"); assert.ok(detail.data.operation.contract.request); assert.equal(Object.hasOwn(detail.data.operation, "help"), false);
  assert.equal(detail.data.operation.discovery.inputSources[0].valuePath, "/id");
  const input = await (await fetch(root + page.data.items[0].describe.path + "?view=input")).json();
  assert.ok(input.data.operation.request); assert.equal(Object.hasOwn(input.data.operation, "contract"), false);
  const result = await (await fetch(root + page.data.items[0].describe.path + "?view=result")).json();
  assert.ok(result.data.operation.responses); assert.equal(Object.hasOwn(result.data.operation, "request"), false);
  assert.equal((await fetch(root + "/api/agent/operations/" + encodeURIComponent("legacy:group:history"))).status, 200);
  assert.equal((await fetch(root + "/api/agent/operations/unknown")).status, 404);
  for (const query of ["limit=0", "unknown=value", "method=GET&method=POST", "match=invalid"]) assert.equal((await fetch(root + "/api/agent/operations?" + query)).status, 400);
  assert.equal((await fetch(root + page.data.items[0].describe.path + "?view=unsupported")).status, 400);
  const initial = await (await fetch(root + "/api/agent/operations?limit=1")).json();
  assert.equal(initial.data.total, 7); assert.ok(initial.data.nextCursor);
  await operation.dispose();
  assert.equal((await fetch(root + "/api/agent/operations?limit=1&cursor=" + encodeURIComponent(initial.data.nextCursor))).status, 409);
});

test("a new plugin declaration reaches search, describe, Help and capabilities and disappears on unload", async t => {
  const registry = new ManagerPluginRouteRegistry();
  const discovery = registry.registerOperations("discovery", createApiDiscoveryOperations(registry));
  const contract = fixtureApiContract({ operationId: "io.example.coral.inventory.read", method: "GET", pathTemplate: "/api/example/coral/inventory",
    request: { path: { type: "object" }, query: { type: "object" }, headers: { type: "object" }, body: { kind: "none" } },
    effects: { mode: "read", description: "Reads the plugin inventory." } });
  const declared: ApiOperationDefinition = { contract,
    discovery: { title: "查询珊瑚库存", summary: "Read coral inventory quantities.", keywords: ["珊瑚库存", "coral inventory"],
      category: { id: "io.example.coral", title: "珊瑚仓库" } },
    handler: () => ({ status: 200, body: { ok: true, value: 3 } }) };
  const registration = registry.registerOperations("io.example.coral", [declared]);
  const server = http.createServer((request, response) => {
    if (!registry.handle(request, new URL(request.url!, "http://localhost"), response)) { response.statusCode = 404; response.end(); }
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const root = `http://127.0.0.1:${address.port}`;
  t.after(async () => { await registration.dispose(); await discovery.dispose(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  for (const query of ["珊瑚库存", "coral inventory"]) {
    const page = await (await fetch(root + "/api/agent/operations?query=" + encodeURIComponent(query) + "&match=all")).json();
    assert.deepEqual(page.data.items.map((row: { operationId: string }) => row.operationId), [contract.operationId]);
    assert.equal(Object.hasOwn(page.data.items[0], "discoveryQuality"), false);
  }
  const detail = await (await fetch(root + "/api/agent/operations/" + contract.operationId)).json();
  assert.equal(detail.data.operation.discovery.title, "查询珊瑚库存");
  assert.equal(detail.data.operation.discoveryQuality.state, "complete");
  const help = await (await fetch(root + "/api/agent/help?operationId=" + contract.operationId)).json();
  assert.equal(help.data.operations[0].discovery.title, detail.data.operation.discovery.title);
  assert.deepEqual(help.data.operations[0].discovery.keywords, detail.data.operation.discovery.keywords);
  assert.equal(help.data.operations[0].discovery.category.id, detail.data.operation.discovery.category.id);
  assert.equal(help.data.operations[0].discoveryQuality.state, "complete");
  const capabilities = await (await fetch(root + "/api/lan-agent/capabilities")).json();
  assert.equal(capabilities.operations.find((row: { id: string }) => row.id === contract.operationId).discovery.title, "查询珊瑚库存");
  assert.deepEqual(await (await fetch(root + contract.pathTemplate)).json(), { ok: true, value: 3 });
  await registration.dispose();
  const unloaded = await (await fetch(root + "/api/agent/operations?query=" + encodeURIComponent("珊瑚库存"))).json();
  assert.equal(unloaded.data.total, 0);
  assert.equal((await fetch(root + "/api/agent/operations/" + contract.operationId)).status, 404);
  assert.equal((await fetch(root + "/api/agent/help?operationId=" + contract.operationId)).status, 404);
});

test("missing discovery metadata remains visible as a quality issue while the handler stays usable", async t => {
  const registry = new ManagerPluginRouteRegistry();
  const discovery = registry.registerOperations("discovery", createApiDiscoveryOperations(registry));
  const contract = fixtureApiContract({ operationId: "io.example.opaque.read", method: "GET", pathTemplate: "/api/example/opaque",
    request: { path: { type: "object" }, query: { type: "object" }, headers: { type: "object" }, body: { kind: "none" } },
    effects: { mode: "read", description: "Reads one value." } });
  const registration = registry.registerOperations("io.example.opaque", [{ contract, handler: () => ({ status: 200, body: { ok: true, value: 1 } }) }]);
  const server = http.createServer((request, response) => {
    if (!registry.handle(request, new URL(request.url!, "http://localhost"), response)) { response.statusCode = 404; response.end(); }
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const root = `http://127.0.0.1:${address.port}`;
  t.after(async () => { await registration.dispose(); await discovery.dispose(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  const detail = await (await fetch(root + "/api/agent/operations/" + contract.operationId)).json();
  const quality = detail.data.operation.discoveryQuality;
  assert.equal(quality.state, "needs_attention"); assert.ok(quality.issues.length > 0);
  const help = await (await fetch(root + "/api/agent/help?operationId=" + contract.operationId)).json();
  assert.deepEqual(help.data.operations[0].discoveryQuality, quality);
  assert.deepEqual(await (await fetch(root + contract.pathTemplate)).json(), { ok: true, value: 1 });
});
