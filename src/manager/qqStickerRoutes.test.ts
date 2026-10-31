import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import { createQqStickerOperations, handleQqStickerRoutes } from "./qqStickerRoutes.js";
import { markAuthenticatedConnectionRequest } from "./connectionRequestAccess.js";
import type { GatewayDefinition } from "../shared/gatewayConfigModel.js";
import { ManagerPluginRouteRegistry } from "./managerPluginRouteRegistry.js";
import { apiCatalogOpenApi } from "./apiOperationCatalog.js";
import { QQ_STICKER_LIMITS } from "../napcatStickers.js";

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
    assert.equal(JSON.parse(body).data.items[0].name, "谢谢");
    const changedResponse = await fetch(`http://127.0.0.1:${address.port}/api/agent/qq/stickers?routeId=route-test&count=1`);
    assert.equal(changedResponse.status, 409);
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
});

test("executable favorite contracts serve each declared finite image type and withhold changed-account bytes", async t => {
  const id = "0123456789abcdef0123456789abcdef";
  const definition = { id: "route-test", enabled: true, messageAdapters: ["napcat"], napcatInstances: [
    { id: "account-test", enabled: true, httpUrl: "http://127.0.0.1:1234", accessToken: "test-secret" }
  ] } as GatewayDefinition;
  let type = "image/png";
  let disabled = false;
  let disableAfterImage = false;
  let declaredLength: string | undefined;
  let bodyBytes = Buffer.from("fixture image");
  let imageReads = 0;
  const registry = new ManagerPluginRouteRegistry();
  const registration = registry.registerOperations("qq-favorites", createQqStickerOperations({
    local: () => false, route: () => disabled ? { ...definition, enabled: false } : definition,
    json: () => { throw new Error("Executable owners return DTOs without writing HTTP."); },
    transport: (async (input, options) => {
      if (String(input).startsWith("http://127.0.0.1:1234/")) {
        assert.equal(new Headers(options?.headers).get("authorization"), "Bearer test-secret");
        return Response.json({ status: "ok", retcode: 0, data: [{ md5: id, url: `https://p.qpic.cn/${id}?rkey=private`, desc: "谢谢" }] });
      }
      imageReads++;
      assert.equal(new Headers(options?.headers).get("authorization"), null);
      if (disableAfterImage) disabled = true;
      return new Response(bodyBytes, { headers: { "content-type": type, ...(declaredLength ? { "content-length": declaredLength } : {}) } });
    }) as typeof fetch
  }));
  const server = http.createServer((request, response) => {
    markAuthenticatedConnectionRequest(request);
    if (!registry.handle(request, new URL(request.url!, "http://localhost"), response)) { response.statusCode = 404; response.end(); }
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { server.closeAllConnections(); await registration.dispose(); await new Promise<void>(resolve => server.close(() => resolve())); });
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const list = await fetch(`${base}/api/agent/qq/stickers?routeId=route-test`);
  assert.equal(list.status, 200);
  const wire = await list.text(); assert.ok(!wire.includes("test-secret") && !wire.includes("qpic.cn"));
  const preview = base + JSON.parse(wire).data.items[0].previewUrl;
  for (type of ["image/png", "image/jpeg", "image/gif", "image/webp", "image/avif", "image/bmp", "image/svg+xml"]) {
    bodyBytes = type === "image/svg+xml" ? Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>window.executed=true</script></svg>') : Buffer.from("fixture image");
    const response = await fetch(preview);
    assert.equal(response.status, 200); assert.equal(response.headers.get("content-type"), type);
    assert.equal(response.headers.get("content-security-policy"), "sandbox");
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), bodyBytes);
  }
  const spec = (await apiCatalogOpenApi(registry.catalogSnapshot())) as { paths: Record<string, { get: { responses: Record<string, Record<string, unknown>> } }> };
  const responseContract = spec.paths["/api/agent/qq/stickers/{stickerId}/preview"]!.get.responses["200"]!;
  assert.deepEqual(responseContract["x-rabiroute-binary"], { minBytes: 1, maxBytes: QQ_STICKER_LIMITS.previewBytes });
  assert.deepEqual(Object.keys(responseContract.content as object).sort(), ["*/*"]);
  type = "text/html"; const unsupported = await fetch(preview); assert.equal(unsupported.status, 503);
  assert.match((await unsupported.json()).message, /image MIME.*text\/html/);
  type = "image/png"; declaredLength = String(QQ_STICKER_LIMITS.previewBytes + 1);
  assert.equal((await fetch(preview)).status, 503);
  declaredLength = undefined;
  bodyBytes = Buffer.from("fixture image"); disableAfterImage = true;
  const changed = await fetch(preview); assert.equal(changed.status, 409);
  assert.equal((await changed.json()).errorCode, "QQ_STICKERS_INSTANCE_CHANGED");
  disabled = false; disableAfterImage = false;
  const readsBefore = imageReads;
  const badCount = await fetch(`${preview}&count=${QQ_STICKER_LIMITS.count + 1}`);
  assert.equal(badCount.status, 400); assert.match((await badCount.json()).message, /RABIROUTE_QQ_STICKER_COUNT=/);
  assert.equal((await fetch(`${preview}&url=https://example.invalid`)).status, 400);
  assert.equal((await fetch(`${preview}&count=1&count=2`)).status, 400);
  assert.equal(imageReads, readsBefore);
});
