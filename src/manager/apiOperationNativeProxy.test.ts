import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import test from "node:test";
import { once } from "node:events";
import { compileApiContract, apiPathParameters, type ApiHttpProxyDefinition } from "./apiOperationContract.js";
import { fixtureApiContract } from "./apiOperationContractFixtures.js";
import { ManagerPluginRouteRegistry } from "./managerPluginRouteRegistry.js";
import { apiCatalogOpenApi } from "./apiOperationCatalog.js";
import { createApiDiscoveryOperations } from "./apiDiscoveryRoutes.js";
import { markAuthenticatedConnectionRequest } from "./connectionRequestAccess.js";
import { LanAgentAuthority } from "./lanAgentAuthority.js";
import { evaluateLanAgentRequest, assertTrustedLanAgentPrincipal } from "./lanAgentRequestAccess.js";
import { validateAgentApiRequestTarget } from "./agentApiPolicy.js";
import { createManagerClient } from "../../apps/rabi-agent/lib/manager-client.mjs";
import { fillApiPathTemplate, apiTailPathsOverlap } from "../../apps/rabi-agent/lib/api-path-template.mjs";

const template = "/api/native/models:suffix";
const proxyContract = () => fixtureApiContract({ operationId: "fixture.native.models", method: "*", pathTemplate: template,
  httpProxy: { wire: { dataFrameBytes: 1024, streamWindowBytes: 4096, maxConcurrentStreams: 4 }, completion: "Original exchange closes.", cancellation: "Wait for the original producer to close." },
  request: { pathRemainder: "suffix", path: { type: "object", required: ["suffix"], additionalProperties: false, properties: { suffix: { type: "string" } } },
    query: { type: "object" }, headers: { type: "object" }, body: { kind: "passthrough" } },
  responses: { default: { mediaType: "*/*", passthrough: true } } });
const fixedContract = () => fixtureApiContract({ operationId: "fixture.native.fixed", method: "GET", pathTemplate: "/api/native/models",
  request: { path: { type: "object" }, query: { type: "object" }, headers: { type: "object" }, body: { kind: "none" } },
  responses: { "200": { mediaType: "application/json", schema: { type: "object", required: ["fixed"], properties: { fixed: { const: true } } } } } });

test("raw native prefix retains empty, partial-segment, encoded and nested suffixes", () => {
  const operation = compileApiContract({ contract: proxyContract() });
  for (const suffix of ["", "XYZ", "/a/b", "/%E6%B1%89%2Fbytes", "%broken"]) {
    assert.deepEqual({ ...apiPathParameters(operation, "/api/native/models" + suffix) }, { suffix });
    assert.equal(fillApiPathTemplate(template, { suffix }, [], "suffix"), "/api/native/models" + suffix);
  }
  assert.equal(apiPathParameters(operation, "/api/native/model"), undefined);
  assert.equal(apiTailPathsOverlap(template, "/api/native/models/settings", [], [], "suffix"), true);
  assert.equal(apiTailPathsOverlap(template, "/api/native/elsewhere", [], [], "suffix"), false);
  assert.equal(apiTailPathsOverlap(template, "/api/native/MODELS/settings", [], [], "suffix", "", [], ["MODELS"]), true);
  assert.throws(() => compileApiContract({ contract: { ...fixedContract(), method: "*" } }), /wildcard/);
  assert.throws(() => fillApiPathTemplate(template, { suffix: "?leak=1" }, [], "suffix"));
});

test("native fallback overlap is allowed only with the same owner and a fixed method", async () => {
  const registry = new ManagerPluginRouteRegistry();
  const definition: ApiHttpProxyDefinition = { contract: proxyContract(), async handler() {} };
  const proxy = registry.registerHttpProxies("native", [definition]);
  const fixed = registry.registerOperations("native", [{ contract: fixedContract(), handler: () => ({ status: 200, body: { fixed: true } }) }]);
  try {
    const snapshot = registry.catalogSnapshot();
    assert.throws(() => registry.registerOperations("other", [{ contract: { ...fixedContract(), operationId: "fixture.other" }, handler: () => ({ status: 200 }) }]), /overlap/);
    assert.throws(() => registry.registerHttpProxies("native", [{ ...definition, contract: { ...proxyContract(), operationId: "fixture.ambiguous" } }]), /overlap/);
    assert.equal(registry.catalogSnapshot(), snapshot);
    const spec = (await apiCatalogOpenApi(snapshot)) as { paths: Record<string, Record<string, Record<string, unknown>>> };
    const projected = spec.paths["/api/native/models{suffix}"];
    assert.equal(projected["*"], undefined);
    assert.equal(projected["x-rabiroute-any-method"].operationId, "fixture.native.models");
    assert.equal(projected["x-rabiroute-any-method"]["x-rabiroute-path-remainder"], "suffix");
  } finally { await fixed.dispose(); await proxy.dispose(); }
});

test("real HTTP generic invocation preserves extension method/body/query and fixed-method precedence", async t => {
  const identity = { applicationGenerationId: "proxy-app", managerInstanceId: "proxy-manager", pluginGenerationId: "proxy-plugin" };
  const registry = new ManagerPluginRouteRegistry(undefined, { identity: () => identity });
  let calls = 0;
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "api-native-proxy-"));
  const authority = new LanAgentAuthority({ statePath: path.join(root, "authority.json") });
  const credential = authority.enroll(authority.issueBootstrapTicket().ticket, "empty-native-proxy-node");
  t.after(async () => { assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir())); assert.ok(path.basename(root).startsWith("api-native-proxy-")); await fs.rm(root, { recursive: true, force: true }); });
  // Register fallback first: order must not shadow the fixed public contract.
  const proxy = registry.registerHttpProxies("native", [{ contract: proxyContract(), async handler(input) {
    calls++;
    const chunks: Buffer[] = [];
    for await (const bytes of input.request) chunks.push(Buffer.from(bytes));
    input.assertCurrent();
    const body = JSON.stringify({ method: input.request.method, suffix: input.path.suffix, query: input.url.search, body: Buffer.concat(chunks).toString() });
    input.prepareResponse(207, { "content-type": "application/json" });
    input.response.writeHead(207, { "content-type": "application/json" }).end(body);
  } }]);
  const fixed = registry.registerOperations("native", [{ contract: fixedContract(), handler: () => ({ status: 200, body: { fixed: true } }) }]);
  const discovery = registry.registerOperations("discovery", createApiDiscoveryOperations(registry));
  const server = http.createServer((request, response) => {
    if (request.url === "/meta") { response.setHeader("content-type", "application/json"); response.end(JSON.stringify({ ...identity, health: { live: true, requiredReady: true, state: "healthy" } })); return; }
    if (evaluateLanAgentRequest(request, authority, true).kind !== "agent") { response.writeHead(403).end(); return; }
    if (!validateAgentApiRequestTarget(request.method!, request.url!).allowed) { response.writeHead(400).end(); return; }
    markAuthenticatedConnectionRequest(request, () => { assertTrustedLanAgentPrincipal(request); });
    if (!registry.handle(request, new URL(request.url!, "http://fixture"), response)) response.writeHead(404).end();
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  t.after(async () => { server.closeAllConnections(); await Promise.all([proxy.dispose(), fixed.dispose(), discovery.dispose()]); await new Promise<void>(resolve => server.close(() => resolve())); });
  const address = server.address(); assert.ok(address && typeof address !== "string"); const base = `http://127.0.0.1:${address.port}`;
  const client = createManagerClient({ managerUrl: base, credential: credential.token, endpointSession: { async ensure() { return { managerUrl: base, meta: { ...identity, health: { live: true, requiredReady: true, state: "healthy" } } }; } } });
  const invoked = await client.invokeOperation("fixture.native.models", { method: "PROPFIND", path: { suffix: "XYZ/a%20b" }, query: { tag: ["first", "second"] }, bodyText: "original-body" });
  assert.equal(invoked.statusCode, 207);
  assert.ok(invoked.body !== undefined);
  assert.deepEqual(JSON.parse(invoked.body), { method: "PROPFIND", suffix: "XYZ/a%20b", query: "?tag=first&tag=second", body: "original-body" });
  assert.equal(calls, 1);
  const fixedReply = await client.invokeOperation("fixture.native.fixed"); assert.equal(fixedReply.statusCode, 200); assert.ok(fixedReply.body !== undefined); assert.deepEqual(JSON.parse(fixedReply.body), { fixed: true }); assert.equal(calls, 1);
  const extensionAtFixed = await client.invokeOperation("fixture.native.models", { method: "PROPFIND", path: { suffix: "" } }); assert.equal(extensionAtFixed.statusCode, 207); assert.equal(calls, 2);
  const filtered = await client.request("GET", "/api/agent/help?method=PROPFIND");
  assert.ok(filtered.body !== undefined);
  assert.deepEqual(JSON.parse(filtered.body).data.operations.map((value: { id: string }) => value.id), ["fixture.native.models"]);
  await assert.rejects(client.invokeOperation("fixture.native.models", { path: { suffix: "XYZ" } }), /explicit valid HTTP method/);
  await assert.rejects(client.invokeOperation("fixture.native.fixed", { method: "DELETE" }), /fixed operation methods/);
  assert.equal(calls, 2);
  authority.setNodeEnabled(credential.nodeId, false, true);
  const denied = await fetch(base + "/api/native/modelsXYZ", { method: "PROPFIND", headers: { authorization: "Bearer " + credential.token } }); assert.equal(denied.status, 403); assert.equal(calls, 2);
});
