import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import { once } from "node:events";
import { fillApiPathTemplate, parseApiPathTemplate } from "../../apps/rabi-agent/lib/api-path-template.mjs";
import { createManagerClient } from "../../apps/rabi-agent/lib/manager-client.mjs";
import { compileApiOperation } from "./apiOperationContract.js";
import { fixtureApiContract } from "./apiOperationContractFixtures.js";
import { ManagerPluginRouteRegistry } from "./managerPluginRouteRegistry.js";
import { apiCatalogOpenApi } from "./apiOperationCatalog.js";
import { createApiDiscoveryOperations } from "./apiDiscoveryRoutes.js";

const template = "/api/files/:version/:assetPath";
const tails = ["assetPath"];
const fileContract = () => fixtureApiContract({ operationId: "fixture.files.read", method: "GET", pathTemplate: template,
  request: { pathTails: tails, path: { type: "object", required: ["version", "assetPath"], properties: { version: { type: "string" }, assetPath: { type: "string" } }, additionalProperties: false },
    query: { type: "object", additionalProperties: false }, headers: { type: "object" }, body: { kind: "none" } },
  responses: { "200": { mediaType: "application/json", schema: { type: "object", required: ["assetPath"], properties: { assetPath: { type: "string" } }, additionalProperties: false } } } });

test("one shared path grammar preserves nested segments and rejects invalid tail values and declarations", () => {
  const parsed = parseApiPathTemplate(template, tails);
  assert.deepEqual(parsed.names, ["version", "assetPath"]); assert.deepEqual(parsed.tails, ["assetPath"]);
  assert.equal(parsed.openApiTemplate, "/api/files/{version}/{assetPath}");
  assert.equal(fillApiPathTemplate(template, { version: "1 / 2", assetPath: "lib/汉字 #.mjs" }, tails), "/api/files/1%20%2F%202/lib/%E6%B1%89%E5%AD%97%20%23.mjs");
  for (const value of ["", "/file", "dir/", "dir//file", "dir/../file", "dir/./file", "dir\\file", "dir/\u0000file"]) {
    assert.throws(() => fillApiPathTemplate(template, { version: 1, assetPath: value }, tails));
  }
  for (const path of ["/api/:path+/more", "/api/:id/:id+", "/api/:path*", "/api/:path++"]) {
    assert.throws(() => parseApiPathTemplate(path));
    assert.throws(() => compileApiOperation({ contract: { ...fileContract(), pathTemplate: path }, handler: () => ({ status: 200, body: {} }) }));
  }
  for (const pathTails of [["version"], ["absent"], ["assetPath", "assetPath"], "assetPath", [1]]) {
    assert.throws(() => compileApiOperation({ contract: { ...fileContract(), request: { ...fileContract().request, pathTails: pathTails as string[] } }, handler: () => ({ status: 200, body: {} }) }));
  }
});

test("tail capture rejects overlapping fixed and parameter routes before changing the active snapshot", async () => {
  const registry = new ManagerPluginRouteRegistry();
  const first = registry.registerOperations("files", [{ contract: fileContract(), handler: () => ({ status: 200, body: { assetPath: "" } }) }]);
  const snapshot = registry.catalogSnapshot();
  for (const pathTemplate of ["/api/files/one/lib/file.mjs", "/api/files/:tag/:name", "/api/files/:tag/lib/:rest"]) {
    assert.throws(() => registry.registerOperations("other", [{ contract: { ...fileContract(), operationId: "fixture.other", pathTemplate, request: { ...fileContract().request, pathTails: [] } }, handler: () => ({ status: 200, body: {} }) }]), /routes overlap/);
    assert.equal(registry.catalogSnapshot(), snapshot);
  }
  const separate = registry.registerOperations("separate", [{ contract: { ...fileContract(), operationId: "fixture.manifest", pathTemplate: "/api/files/manifest", request: { ...fileContract().request, pathTails: [] } }, handler: () => ({ status: 200, body: { assetPath: "manifest" } }) }]);
  await separate.dispose(); await first.dispose();
});

test("real HTTP discovery, OpenAPI and the generic connector use identical nested path capture", async t => {
  const identity = { applicationGenerationId: "path-fixture-app", managerInstanceId: "path-fixture-manager", pluginGenerationId: "path-fixture-plugins" };
  const registry = new ManagerPluginRouteRegistry(undefined, { identity: () => identity }); let calls = 0;
  const registration = registry.registerOperations("fixture", [{ contract: fileContract(), handler: input => { calls++; return { status: 200, body: { assetPath: input.path.assetPath } }; } }]);
  const discovery = registry.registerOperations("discovery", createApiDiscoveryOperations(registry));
  const server = http.createServer((request, response) => {
    if (request.url === "/meta") { response.setHeader("content-type", "application/json"); response.end(JSON.stringify({ ...identity, health: { live: true, requiredReady: true, state: "healthy" } })); return; }
    if (!registry.handle(request, new URL(request.url!, "http://localhost"), response)) response.writeHead(404).end();
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  t.after(async () => { server.closeAllConnections(); await Promise.all([registration.dispose(), discovery.dispose()]); await new Promise<void>(resolve => server.close(() => resolve())); });
  const address = server.address(); assert.ok(address && typeof address !== "string"); const base = `http://127.0.0.1:${address.port}`;
  const client = createManagerClient({ managerUrl: base, localHost: true, endpointSession: { async ensure() { return { managerUrl: base, meta: { ...identity, health: { live: true, requiredReady: true, state: "healthy" } } }; } } });
  const response = await client.invokeOperation("fixture.files.read", { path: { version: "1", assetPath: "lib/汉字 #.mjs" } });
  assert.equal(response.statusCode, 200); assert.equal(JSON.parse(String(response.body)).assetPath, "lib/汉字 #.mjs"); assert.equal(calls, 1);
  for (const tail of ["lib%2f..%2fsecret", "lib%2f%2fsecret", "lib/%00secret"]) {
    const rejected = await fetch(`${base}/api/files/1/${tail}`); assert.equal(rejected.status, 400); assert.equal(calls, 1);
  }
  // Previous generic connectors encode the whole path value; the same contract accepts that wire form.
  const legacyPath = template.replace(/:([A-Za-z][A-Za-z0-9_]*)/g, (_all, name) => encodeURIComponent(name === "version" ? "1" : "lib/汉字 #.mjs"));
  const legacy = await fetch(base + legacyPath); assert.equal(legacy.status, 200); assert.equal((await legacy.json()).assetPath, "lib/汉字 #.mjs");
  const spec = (await apiCatalogOpenApi(registry.catalogSnapshot())) as any;
  assert.deepEqual(spec.paths["/api/files/{version}/{assetPath}"].get["x-rabiroute-path-tails"], ["assetPath"]);
  assert.equal(spec.paths["/api/files/{version}/{assetPath}"].get.parameters.find((parameter: any) => parameter.name === "assetPath").required, true);
});
