import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import test from "node:test";
import { compileApiOperation, validateApiOperationResult, type ApiOperationContract, type ApiOperationDefinition } from "./apiOperationContract.js";
import { apiCatalogOpenApi } from "./apiOperationCatalog.js";
import { fixtureApiContract } from "./apiOperationContractFixtures.js";
import { ManagerPluginRouteRegistry } from "./managerPluginRouteRegistry.js";

function contract(maxBytes: number, minBytes = 0): ApiOperationContract {
  return fixtureApiContract({ operationId: "example.binary", method: "GET", pathTemplate: "/api/example/binary/:recordId",
    request: { ...fixtureApiContract().request, body: { kind: "none" } },
    responses: { "200": { mediaType: "application/octet-stream", binary: { minBytes, maxBytes },
      headers: { type: "object", required: ["content-length"], properties: { "content-length": { type: "string", pattern: "^[0-9]+$" } }, additionalProperties: true } } },
    effects: { mode: "read", description: "Reads one finite in-memory fixture, without a delivery." },
    recovery: { strategy: "repeatable-read", description: "Repeat the read under the current contract." } });
}

test("JSON release files declared as finite bytes retain exact formatting and never serialize Buffer metadata", async t => {
  const bytes = Buffer.from('{\n  "fixture": true\n}\n');
  const definition = { ...contract(bytes.length), responses: { "200": { mediaType: "application/json; charset=utf-8", binary: { maxBytes: bytes.length } } } };
  const compiled = compileApiOperation({ contract: definition, handler: () => ({ status: 200, body: bytes }) });
  assert.throws(() => validateApiOperationResult(compiled, { status: 200, body: { fixture: true } }), { code: "API_RESPONSE_SCHEMA_INVALID" });
  const registry = new ManagerPluginRouteRegistry();
  const registration = registry.registerOperations("json-file", [{ contract: definition, handler: () => ({ status: 200, body: bytes, headers: { "content-length": String(bytes.length) } }) }]);
  const server = http.createServer((request, response) => { registry.handle(request, new URL(request.url!, "http://localhost"), response); });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  t.after(async () => { server.closeAllConnections(); await registration.dispose(); await new Promise<void>(resolve => server.close(() => resolve())); });
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const response = await fetch(`http://127.0.0.1:${address.port}/api/example/binary/one`);
  assert.equal(response.status, 200); assert.equal(response.headers.get("content-type"), "application/json; charset=utf-8");
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes);
});

test("the same finite byte limit controls actual HTTP output and OpenAPI without encoding bytes as JSON", async t => {
  const registry = new ManagerPluginRouteRegistry();
  const definition = (maxBytes: number): ApiOperationDefinition => ({ contract: contract(maxBytes), handler: () => ({ status: 200,
    body: Buffer.from("data"), headers: { "content-length": "4" } }) });
  let registration = registry.registerOperations("binary", [definition(4)]);
  const server = http.createServer((request, response) => {
    if (!registry.handle(request, new URL(request.url!, "http://localhost"), response)) { response.statusCode = 404; response.end(); }
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const address = server.address(); assert.ok(address && typeof address !== "string");
  t.after(async () => { await registration.dispose(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  const url = `http://127.0.0.1:${address.port}/api/example/binary/one`;
  const response = await fetch(url); assert.equal(response.status, 200); assert.equal(response.headers.get("content-type"), "application/octet-stream");
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), Buffer.from("data"));
  await registration.dispose(); registration = registry.registerOperations("binary", [definition(3)]);
  const rejected = await fetch(url); assert.equal(rejected.status, 500);
  assert.equal((await rejected.json()).errorCode, "API_RESPONSE_SCHEMA_INVALID");
  const openapi = (await apiCatalogOpenApi(registry.catalogSnapshot())) as { paths: Record<string, { get: { responses: Record<string, Record<string, unknown>> } }> };
  const declared = openapi.paths["/api/example/binary/{recordId}"]!.get.responses["200"]!;
  assert.deepEqual(declared["x-rabiroute-binary"], { minBytes: 0, maxBytes: 3 });
});

test("finite binary contracts enforce type, empty-body bounds, length and HEAD metadata", () => {
  const operation = compileApiOperation({ contract: contract(8), handler: () => ({ status: 200 }) });
  assert.doesNotThrow(() => validateApiOperationResult(operation, { status: 200, body: Buffer.alloc(0), headers: { "content-length": "0" } }));
  for (const body of ["data", [1, 2], undefined, Buffer.alloc(9)]) {
    assert.throws(() => validateApiOperationResult(operation, { status: 200, body, headers: { "content-length": "4" } }), { code: "API_RESPONSE_SCHEMA_INVALID" });
  }
  const nonempty = compileApiOperation({ contract: contract(8, 1), handler: () => ({ status: 200 }) });
  assert.throws(() => validateApiOperationResult(nonempty, { status: 200, body: Buffer.alloc(0), headers: { "content-length": "0" } }));
  assert.throws(() => validateApiOperationResult(operation, { status: 200, body: Buffer.alloc(4), headers: { "content-length": "5" } }));
  const head = compileApiOperation({ contract: { ...contract(8), method: "HEAD" }, handler: () => ({ status: 200 }) });
  assert.doesNotThrow(() => validateApiOperationResult(head, { status: 200, headers: { "content-length": "4" } }));
  assert.throws(() => validateApiOperationResult(head, { status: 200, headers: { "content-length": "9" } }));
  assert.throws(() => compileApiOperation({ contract: contract(0), handler: () => ({ status: 200 }) }), /finite binary/);
});
