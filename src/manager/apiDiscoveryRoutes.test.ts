import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import { once } from "node:events";
import { ManagerPluginRouteRegistry } from "./managerPluginRouteRegistry.js";
import { createApiDiscoveryOperations } from "./apiDiscoveryRoutes.js";
import { fixtureApiContract } from "./apiOperationContractFixtures.js";

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
  assert.equal(body.data.schemaVersion, "2"); assert.equal(body.data.operations.length, 4);
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
