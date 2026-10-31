import assert from "node:assert/strict";
import test from "node:test";
import http from "node:http";
import { once } from "node:events";
import { ManagerPluginRouteRegistry } from "./managerPluginRouteRegistry.js";
import { fixtureApiContract } from "./apiOperationContractFixtures.js";
import { compileApiContract, type ApiHttpProxyDefinition } from "./apiOperationContract.js";
import { apiCatalogOpenApi } from "./apiOperationCatalog.js";

const fallback = (): ApiHttpProxyDefinition["contract"] => fixtureApiContract({ operationId: "fixture.static", method: "*", pathTemplate: "/:suffix",
  httpProxy: { dispatch: "final-fallback", wire: { dataFrameBytes: 1024, streamWindowBytes: 4096, maxConcurrentStreams: 2 }, completion: "Original response finishes.", cancellation: "Close original response." },
  request: { pathRemainder: "suffix", path: { type: "object", properties: { suffix: { type: "string" } }, required: ["suffix"], additionalProperties: false }, query: true, headers: true, body: { kind: "passthrough" } },
  responses: { default: { mediaType: "*/*", passthrough: true } }
});

test("explicit final HTTP fallback runs after normal owners, legacy owners and known-path method rejection", async t => {
  const registry = new ManagerPluginRouteRegistry(); let fallbackCalls = 0;
  const final = registry.registerHttpProxies("static-owner", [{ contract: fallback(), async handler(input) {
    fallbackCalls++; input.request.resume(); input.prepareResponse(200, {}); input.response.end(`static:${input.request.method}:${input.path.suffix}`);
  } }]);
  const fixed = registry.registerOperations("business-owner", [{ contract: fixtureApiContract({ operationId: "fixture.known", method: "GET", pathTemplate: "/known",
    request: { path: { type: "object" }, query: { type: "object" }, headers: { type: "object" }, body: { kind: "none" } } }),
    handler: () => ({ status: 200, body: { ok: true, value: 1 } }) }]);
  const legacy = registry.register("legacy-owner", [{ routeId: "fixture.legacy", match: { kind: "exact", path: "/legacy", methods: ["GET"] },
    handler: (_request, _url, response) => { response.end("legacy"); return true; } }]);
  const upgrade = registry.registerUpgrades("upgrade-owner", [{ contract: fixtureApiContract({ operationId: "fixture.upgrade", method: "GET", pathTemplate: "/socket", transport: "websocket",
    request: { path: true, query: true, headers: true, body: { kind: "none" } }, responses: { "101": { mediaType: "application/octet-stream", schema: false } },
    websocket: { protocol: "native", framing: "bytes", maxMessageBytes: 4096, maxBufferedBytes: 8192, authentication: "Original owner.", completion: "Close.", cancellation: "Close." } }), handler() { throw new Error("not an upgrade test"); } }]);
  const server = http.createServer((request, response) => { if (!registry.handle(request, new URL(request.url!, "http://fixture"), response)) response.writeHead(404).end(); });
  server.listen(0, "127.0.0.1"); await once(server, "listening"); const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  t.after(async () => { legacy(); await Promise.all([final.dispose(), fixed.dispose(), upgrade.dispose()]); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  assert.deepEqual(await (await fetch(origin + "/known")).json(), { ok: true, value: 1 });
  assert.equal(await (await fetch(origin + "/legacy")).text(), "legacy");
  assert.equal((await fetch(origin + "/known", { method: "POST" })).status, 405);
  assert.equal((await fetch(origin + "/socket")).status, 426); assert.equal(fallbackCalls, 0);
  const root = await fetch(origin + "/"); assert.equal(await root.text(), "static:GET:"); assert.equal(root.headers.get("content-type"), null);
  assert.equal(await (await fetch(origin + "/unclaimed/deep/path")).text(), "static:GET:unclaimed/deep/path"); assert.equal(fallbackCalls, 2);
  const projection = (await apiCatalogOpenApi(registry.catalogSnapshot())) as any;
  assert.equal(projection.paths["/{suffix}"]["x-rabiroute-any-method"]["x-rabiroute-http-proxy"].dispatch, "final-fallback");
  assert.throws(() => registry.registerHttpProxies("other-static", [{ contract: { ...fallback(), operationId: "fixture.static.duplicate" }, handler: async () => {} }]), /Only one final/);
});

test("final fallback cannot be hidden in an ordinary prefix or fixed method", () => {
  const contract = fallback();
  assert.throws(() => compileApiContract({ contract: { ...contract, method: "GET" } }), /final HTTP fallback/);
  assert.throws(() => compileApiContract({ contract: { ...contract, pathTemplate: "/api/prefix:suffix" } }), /final HTTP fallback/);
});
