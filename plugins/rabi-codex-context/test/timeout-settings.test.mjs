import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { requestManager } from "../scripts/lib/rabi-manager-client.mjs";
import { getTimeoutMs, configureTimeouts } from "../scripts/lib/timeout-settings.mjs";

test("verified Manager metadata configures Hook request deadline including response body", async t => {
  const requests = [];
  const server = createServer((request, response) => {
    requests.push(request.url);
    if (request.url === "/meta") response.end(JSON.stringify({ applicationGenerationId:"test-generation", managerInstanceId:"test-manager", health:{live:true,requiredReady:true,state:"healthy"},timeoutOverrides:{"hooks.manager.request":100} }));
    else { response.writeHead(200,{"content-type":"application/json"}); response.flushHeaders(); response.write('{"code":'); }
  });
  await new Promise(resolve => server.listen(0,"127.0.0.1",resolve));
  t.after(async () => { configureTimeouts({}); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const env = {RABIROUTE_MANAGER_URL:"http://127.0.0.1:"+server.address().port};
  await assert.rejects(requestManager("/api/test",{}, {env}),/100 ms|abort/i);
  assert.deepEqual(requests,["/meta","/api/test"]);
});
test("cold discovery uses explicit startup snapshot and absent values retain defaults", () => {
  configureTimeouts({});
  assert.equal(getTimeoutMs("hooks.manager.discovery",8000,{RABIROUTE_TIMEOUT_OVERRIDES:'{"hooks.manager.discovery":2300}'}),2300);
  assert.equal(getTimeoutMs("other",55,{}),55);
});
