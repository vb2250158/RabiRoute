import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import { handleQqStickerRoutes } from "./qqStickerRoutes.js";
import { markAuthenticatedConnectionRequest } from "./connectionRequestAccess.js";
import type { GatewayDefinition } from "../shared/gatewayConfigModel.js";

test("authenticated remote connections read favorites, hide native credentials and pin account", async () => {
  const id = "0123456789abcdef0123456789abcdef";
  const definition = { id: "route-test", enabled: true, messageAdapters: ["napcat"], napcatInstances: [
    { id: "account-test", enabled: true, httpUrl: "http://127.0.0.1:1234", accessToken: "test-secret" }
  ] } as GatewayDefinition;
  let changed = false;
  const server = http.createServer((request, response) => {
    markAuthenticatedConnectionRequest(request);
    handleQqStickerRoutes(request, new URL(request.url!, "http://localhost"), response, {
      local: () => false, route: () => changed ? { ...definition, enabled: false } : definition,
      json: (response, status, value) => { response.writeHead(status, { "content-type": "application/json" }); response.end(JSON.stringify(value)); },
      transport: (async (_input: unknown, options: RequestInit) => {
        assert.equal(new Headers(options.headers).get("authorization"), "Bearer test-secret");
        if (request.url!.includes("count=1")) changed = true;
        return Response.json({ status: "ok", retcode: 0, data: [{ md5: id, url: `https://p.qpic.cn/${id}?rkey=private`, desc: "谢谢" }] });
      }) as typeof fetch
    }, operation => operation);
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as { port: number };
  try {
    const response = await fetch(`http://127.0.0.1:${address.port}/api/agent/qq/stickers?routeId=route-test`);
    assert.equal(response.status, 200);
    const body = await response.text();
    assert.ok(!body.includes("private") && !body.includes("test-secret") && !body.includes("qpic.cn"));
    assert.equal(JSON.parse(body).data.items[0].description, "谢谢");
    const changedResponse = await fetch(`http://127.0.0.1:${address.port}/api/agent/qq/stickers?routeId=route-test&count=1`);
    assert.equal(changedResponse.status, 409);
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
});
