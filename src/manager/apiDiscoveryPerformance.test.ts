import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import test from "node:test";
import { createApiDiscoveryOperations, projectApiHelp } from "./apiDiscoveryRoutes.js";
import { apiCatalogOpenApi, createApiCatalogSnapshot } from "./apiOperationCatalog.js";
import { fixtureApiContract } from "./apiOperationContractFixtures.js";
import { ManagerPluginRouteRegistry } from "./managerPluginRouteRegistry.js";

for (const endpoint of ["/api/agent/help", "/api/lan-agent/capabilities", "/api/agent/openapi"]) test(`large discovery ${endpoint} retains every contract and responsive health through the original registry guards`, { timeout: 20_000 }, async t => {
  const properties = Object.fromEntries(Array.from({ length: 24 }, (_, index) => [`field${index}`, {
    type: "array", items: { type: "object", additionalProperties: false, properties: { id: { type: "string" }, enabled: { type: "boolean" } } }
  }]));
  const operations = Array.from({ length: 1600 }, (_, index) => ({
    contract: fixtureApiContract({ operationId: `fixture.operation.${index}`, method: "GET", pathTemplate: `/api/fixture/${index}`,
      responses: { "200": { mediaType: "application/json", schema: { type: "object", additionalProperties: false, properties } } } }),
    contractDigest: `sha256:${"a".repeat(64)}`, owner: { instanceId: "fixture" }
  }));
  const snapshot = createApiCatalogSnapshot({ applicationGenerationId: "fixture-app", managerInstanceId: "fixture-manager", pluginGenerationId: "fixture-plugins" }, 1, operations, []);
  const registry = new ManagerPluginRouteRegistry();
  t.mock.method(registry, "catalogSnapshot", () => snapshot);
  const registration = registry.registerOperations("discovery-performance", createApiDiscoveryOperations(registry));
  const server = http.createServer((request, response) => {
    if (request.url === "/health") { response.end("healthy"); return; }
    if (!registry.handle(request, new URL(request.url!, "http://localhost"), response)) { response.statusCode = 404; response.end(); }
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const address = server.address(); assert.ok(address && typeof address === "object");
  const base = `http://127.0.0.1:${address.port}`;
  let polling = true;
  const samples: number[] = [];
  const health = (async () => {
    while (polling) {
      const start = performance.now();
      const response = await fetch(base + "/health", { signal: AbortSignal.timeout(1500) });
      assert.equal(await response.text(), "healthy");
      samples.push(performance.now() - start);
      await new Promise(resolve => setTimeout(resolve, 20));
    }
  })();
  // Observe failures immediately while cleanup still joins this exact polling work.
  void health.catch(() => {});
  t.after(async () => {
    polling = false;
    try { await health; }
    finally { await registration.dispose(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
  });
  const response = await fetch(base + endpoint, { signal: AbortSignal.timeout(15_000) });
  assert.equal(response.status, 200);
  const text = await response.text();
  polling = false; await health;
  assert.ok(Buffer.byteLength(text) > (endpoint.endsWith("openapi") ? 14_000_000 : 15_000_000));
  assert.ok(samples.length >= 3, `Only ${samples.length} independent health reads completed during help generation.`);
  assert.ok(Math.max(...samples) < 500, `Independent health was delayed ${Math.max(...samples)}ms.`);
  const result = JSON.parse(text);
  if (endpoint.endsWith("openapi")) {
    assert.deepEqual(result, JSON.parse(JSON.stringify((await apiCatalogOpenApi(snapshot)))));
    assert.equal(Object.keys(result.paths).length, operations.length);
  } else {
    const data = endpoint.endsWith("help") ? result.data : result;
    assert.equal(data.operations.length, operations.length);
    assert.deepEqual(data.operations, JSON.parse(JSON.stringify(snapshot.operations.map(projectApiHelp))));
    assert.equal(data.catalogDigest, snapshot.catalogDigest);
  }
  assert.equal((await fetch(base + endpoint, { headers: { "if-none-match": response.headers.get("etag")! } })).status, 304);
  if (endpoint.endsWith("help")) {
    const selected = await (await fetch(base + "/api/agent/help?operationId=fixture.operation.1200")).json();
    assert.equal(selected.data.operations.length, 1);
    assert.equal(selected.data.operations[0].id, "fixture.operation.1200");
  }
  t.diagnostic(JSON.stringify({ endpoint, bytes: Buffer.byteLength(text), operations: operations.length, healthReads: samples.length, maximumHealthMs: Math.max(...samples) }));
});

test("OpenAPI asynchronous projection observes cancellation before publishing a document", async () => {
  const snapshot = createApiCatalogSnapshot({ applicationGenerationId: "fixture", managerInstanceId: "fixture", pluginGenerationId: "fixture" }, 1,
    [{ contract: fixtureApiContract(), contractDigest: `sha256:${"a".repeat(64)}`, owner: { instanceId: "fixture" } }], []);
  const controller = new AbortController(), cause = new Error("cancel OpenAPI projection");
  const operation = apiCatalogOpenApi(snapshot, controller.signal);
  controller.abort(cause);
  await assert.rejects(operation, error => error === cause || error instanceof Error && error.cause === cause);
});
