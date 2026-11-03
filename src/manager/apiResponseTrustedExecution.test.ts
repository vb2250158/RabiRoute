import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import test from "node:test";
import { ManagerPluginRouteRegistry } from "./managerPluginRouteRegistry.js";
import { fixtureApiContract } from "./apiOperationContractFixtures.js";

test("a trusted response getter completes once without an unrelated VM cutoff", { timeout: 5000 }, async t => {
  let owners = 0, getters = 0, completed = false;
  const registry = new ManagerPluginRouteRegistry();
  const registration = registry.registerOperations("trusted-result", [{ contract: fixtureApiContract(), handler: () => {
    owners++;
    return { status: 200, body: { ok: true, value: 1 }, get stream() {
      getters++;
      const until = performance.now() + 180;
      while (performance.now() < until) { /* finite trusted calculation */ }
      completed = true;
      return undefined;
    } };
  } }]);
  const server = http.createServer((request, response) => registry.handle(request, new URL(request.url!, "http://localhost"), response));
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  t.after(async () => { server.closeAllConnections(); await registration.dispose(); await new Promise<void>(r => server.close(() => r())); });
  const address = server.address(); assert(address && typeof address !== "string");
  const response = await fetch(`http://127.0.0.1:${address.port}/api/example/records/one`, {
    method: "POST", headers: { "content-type": "application/json" }, body: '{"value":1}', signal: AbortSignal.timeout(3000)
  });
  assert.equal(response.status, 200); assert.deepEqual(await response.json(), { ok: true, value: 1 });
  assert.equal(owners, 1); assert.equal(getters, 1); assert.equal(completed, true);
});
