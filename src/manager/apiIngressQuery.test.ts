import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import test from "node:test";
import { ManagerPluginRouteRegistry } from "./managerPluginRouteRegistry.js";
import { fixtureApiContract } from "./apiOperationContractFixtures.js";
import { markAuthenticatedConnectionRequest, markConsumedConnectionQueryParameters } from "./connectionRequestAccess.js";

test("only ingress-consumed credential fields leave the business URL; unknown query fields still fail validation", async t => {
  const registry = new ManagerPluginRouteRegistry(); let calls = 0;
  const registration = registry.registerOperations("example", [{ contract: fixtureApiContract({ method: "GET", request: {
    ...fixtureApiContract().request, body: { kind: "none" }
  } }), handler: input => {
    calls++; assert.equal(input.url.search, ""); assert.deepEqual(Object.keys(input.query), []);
    assert.ok(input.request.url!.includes("fixture-browser-value"), "Ingress must retain its original authentication URL.");
    return { status: 200, body: { ok: true, value: 1 } };
  } }]);
  const server = http.createServer((request, response) => {
    if (request.headers["x-fixture-ingress"] === "admitted") {
      markAuthenticatedConnectionRequest(request);
      markConsumedConnectionQueryParameters(request, ["webgui_token"]);
    }
    if (!registry.handle(request, new URL(request.url!, "http://localhost"), response)) { response.statusCode = 404; response.end(); }
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const address = server.address(); assert.ok(address && typeof address !== "string");
  t.after(async () => { await registration.dispose(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  const url = `http://127.0.0.1:${address.port}/api/example/records/one?webgui_token=fixture-browser-value`;
  const unclassified = await fetch(url); assert.equal(unclassified.status, 400); assert.equal(calls, 0);
  assert.equal((await unclassified.text()).includes("fixture-browser-value"), false);
  const admitted = await fetch(url, { headers: { "x-fixture-ingress": "admitted" } }); assert.equal(admitted.status, 200);
  assert.deepEqual(await admitted.json(), { ok: true, value: 1 }); assert.equal(calls, 1);
  const unknown = await fetch(url + "&unexpected=1", { headers: { "x-fixture-ingress": "admitted" } });
  assert.equal(unknown.status, 400); assert.equal(calls, 1);
  assert.equal(JSON.stringify(registry.catalogSnapshot()).includes("fixture-browser-value"), false);
});
