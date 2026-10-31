import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import http from "node:http";
import test from "node:test";
import os from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";
import { createQqMessageOperations, handleQqMessageRoutes, type QqMessageRoutesContext } from "./qqMessageRoutes.js";
import { ManagerPluginRouteRegistry } from "./managerPluginRouteRegistry.js";
import { apiCatalogOpenApi } from "./apiOperationCatalog.js";
import { qqMessageMedia, readQqMedia, QQ_MEDIA_MAX_BYTES, qqRead } from "./qqMessageMedia.js";
import type { GatewayDefinition } from "../shared/gatewayConfigModel.js";
import { LanAgentAuthority } from "./lanAgentAuthority.js";
import { evaluateLanAgentRequest } from "./lanAgentRequestAccess.js";
import { markAuthenticatedConnectionRequest } from "./connectionRequestAccess.js";

const definition = { id: "test-route", enabled: true, messageAdapters: ["napcat"],
  napcatInstances: [{ id: "test-instance", enabled: true, httpUrl: "http://127.0.0.1:12345", accessToken: "test-secret" }] } as GatewayDefinition;
const row = { message_id: 123, message_type: "group", group_id: "456", time: 100, user_id: "789",
  message: [{ type: "text", data: { text: "hello" } }, { type: "video", data: { file: "abc.mp4", url: "https://media.qq.com/private-key", thumb: "cover.png" } }] };
const envelope = (data: unknown) => Response.json({ status: "ok", retcode: 0, data });
async function serve(transport: typeof fetch, options: { local?: boolean; route?: () => GatewayDefinition | undefined; authority?: LanAgentAuthority;
  connection?: (request: http.IncomingMessage) => (() => void) | undefined; typed?: boolean } = {}) {
  const context: QqMessageRoutesContext = { local: () => options.local !== false, route: options.route ?? (() => definition), transport,
    json: (reply, status, body) => { reply.writeHead(status, { "content-type": "application/json" }); reply.end(JSON.stringify(body)); } };
  const registry = options.typed ? new ManagerPluginRouteRegistry() : undefined;
  const registration = registry?.registerOperations("qq-read-test", createQqMessageOperations(context));
  const server = http.createServer((request, response) => {
    const url = new URL(request.url!, "http://127.0.0.1");
    if (options.authority) evaluateLanAgentRequest(request, options.authority, true);
    const connectionAuthority = options.connection?.(request);
    if (connectionAuthority) markAuthenticatedConnectionRequest(request, connectionAuthority);
    if (!(registry ? registry.handle(request, url, response) : handleQqMessageRoutes(request, url, response, context, operation => operation))) response.writeHead(404).end();
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  return { base: `http://127.0.0.1:${(server.address() as { port: number }).port}`, registry,
    close: async () => { server.closeAllConnections(); await registration?.dispose(); await new Promise<void>(resolve => server.close(() => resolve())); } };
}
const query = "?routeId=test-route&kind=group&target=456";

test("history carries cursor, masks upstream URLs and returns usable attachment links", async () => {
  const app = await serve(async (_url, init) => {
    const body = JSON.parse(String(init?.body));
    assert.equal(body.message_seq, "124"); assert.equal(body.count, 20); assert.equal(body.disable_get_url, true);
    assert.equal(init?.redirect, "error");
    return envelope({ messages: [row] });
  });
  try {
    const result = await fetch(app.base + "/api/agent/qq/history" + query + "&cursor=124&limit=20");
    assert.equal(result.status, 200);
    const text = await result.text(); assert.ok(!text.includes("private-key")); assert.ok(!text.includes("test-secret"));
    const data = JSON.parse(text).data;
    assert.equal(data.nextCursor, "123"); assert.equal(data.completenessUnknown, true);
    assert.equal(data.entries[0].attachments[0].contentUrl, "/api/agent/qq/messages/123/attachments/0" + query);
    assert.equal(data.entries[0].text, "hello");
  } finally { await app.close(); }
});

test("executable QQ history/message/download share projection schemas and returned attachment indices remain callable past 99", async () => {
  const bytes = Buffer.from("image-content");
  const many = { ...row, message: Array.from({ length: 101 }, (_value, index) => ({ type: "image", data: { file: `item-${index}` } })) };
  const app = await serve(async (url, init) => {
    if (String(url).endsWith("get_group_msg_history")) return envelope({ messages: [many] });
    if (String(url).endsWith("get_msg")) return envelope(many);
    if (String(url).endsWith("get_file")) { assert.equal(JSON.parse(String(init?.body)).file_id, "item-100");
      return envelope({ url: "https://media.qq.com/fixture-image.png", file_size: bytes.length }); }
    return new Response(bytes);
  }, { typed: true });
  try {
    const history = await fetch(app.base + "/api/agent/qq/history" + query); assert.equal(history.status, 200);
    const historyData = (await history.json()).data; assert.equal(historyData.entries[0].attachments.length, 101);
    const message = await fetch(app.base + "/api/agent/qq/messages/123" + query); assert.equal(message.status, 200);
    const data = (await message.json()).data;
    const link = data.attachments[100].contentUrl; assert.match(link, /\/attachments\/100\?/);
    const media = await fetch(app.base + link); assert.equal(media.status, 200);
    assert.deepEqual(Buffer.from(await media.arrayBuffer()), bytes);
    assert.equal(media.headers.get("x-rabiroute-content-sha256"), createHash("sha256").update(bytes).digest("hex"));
    const spec = (await apiCatalogOpenApi(app.registry!.catalogSnapshot())) as { paths: Record<string, any> };
    assert.deepEqual(spec.paths["/api/agent/qq/messages/{messageId}/attachments/{attachmentIndex}"].get.responses["200"]["x-rabiroute-binary"], { minBytes: 1, maxBytes: QQ_MEDIA_MAX_BYTES });
    assert.equal(JSON.stringify(app.registry!.catalogSnapshot()).includes("test-secret"), false);
    assert.equal((await fetch(app.base + "/api/agent/qq/history" + query + "&kind=private")).status, 400);
  } finally { await app.close(); }
});

test("expired get_msg falls back to a bounded page anchored on the same message", async () => {
  const actions: string[] = [];
  const app = await serve(async (url, init) => {
    actions.push(String(url));
    if (String(url).endsWith("get_msg")) return Response.json({ status: "failed", retcode: 1, message: "test-secret" });
    assert.equal(JSON.parse(String(init?.body)).message_seq, "123");
    return envelope({ messages: [row] });
  });
  try {
    const result = await fetch(app.base + "/api/agent/qq/messages/123" + query);
    assert.equal(result.status, 200); assert.equal((await result.json()).data.messageId, "123");
    assert.equal(actions.length, 2);
  } finally { await app.close(); }
});

test("download reads actual video bytes returned by get_file, never its thumbnail", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "qq-media-test-"));
  const file = path.join(dir, "video.mp4");
  const bytes = Buffer.from("actual-video-content"); await fs.writeFile(file, bytes);
  const app = await serve(async (url, init) => {
    if (String(url).endsWith("get_msg")) return envelope(row);
    assert.ok(String(url).endsWith("get_file")); assert.deepEqual(JSON.parse(String(init?.body)), { file_id: "abc.mp4" });
    return envelope({ file, file_size: String(bytes.length) });
  });
  try {
    const result = await fetch(app.base + "/api/agent/qq/messages/123/attachments/0" + query);
    assert.equal(result.status, 200); assert.deepEqual(Buffer.from(await result.arrayBuffer()), bytes);
    assert.equal(result.headers.get("x-rabiroute-content-sha256"), createHash("sha256").update(bytes).digest("hex"));
    assert.match(result.headers.get("content-disposition")!, /video-1.mp4/);
  } finally { await app.close(); await fs.rm(dir, { recursive: true, force: true }); }
});

test("foreign conversation or message IDs fail closed without downloading", async () => {
  for (const foreign of [{ ...row, group_id: "999" }, { ...row, message_id: 999 }]) {
    let calls = 0;
    const app = await serve(async () => { calls++; return envelope(foreign); });
    try {
      const result = await fetch(app.base + "/api/agent/qq/messages/123/attachments/0" + query);
      assert.equal(result.status, 409); assert.equal(calls, 1);
    } finally { await app.close(); }
  }
});

test("remote, relay, duplicate and arbitrary-url requests never reach OneBot", async () => {
  let calls = 0;
  const transport: typeof fetch = async () => { calls++; return envelope(row); };
  const remote = await serve(transport, { local: false });
  const local = await serve(transport);
  try {
    assert.equal((await fetch(remote.base + "/api/agent/qq/messages/123" + query)).status, 403);
    assert.equal((await fetch(local.base + "/api/agent/qq/messages/123" + query, { headers: { "x-rabilink-tunnel-local": "1" } })).status, 403);
    assert.equal((await fetch(local.base + "/api/agent/qq/messages/123" + query, { headers: { "x-rabiroute-peer-proxy": "1" } })).status, 403);
    for (const extra of ["&routeId=other", "&url=http://127.0.0.1/private", "&file=/private", "&limit=101"]) {
      assert.equal((await fetch(local.base + "/api/agent/qq/history" + query + extra)).status, 400);
    }
    assert.equal(calls, 0);
  } finally { await remote.close(); await local.close(); }
});

test("enabled authenticated Agent reads public QQ without a Route owner grant and revocation withholds awaited data", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "qq-agent-authority-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const authority = new LanAgentAuthority({ statePath: path.join(root, "authority.json") });
  const credential = authority.enroll(authority.issueBootstrapTicket().ticket, "fixture-node");
  const headers = { authorization: `Bearer ${credential.token}`, "x-rabiroute-agent-id": "fixture-agent" };
  let revoke = false;
  let calls = 0;
  const app = await serve(async () => {
    calls++;
    if (revoke) authority.revokeNode("fixture-node");
    return envelope(row);
  }, { local: false, authority });
  try {
    assert.equal((await fetch(app.base + "/api/agent/qq/messages/123" + query, { headers })).status, 200);
    assert.equal((await fetch(app.base + "/api/agent/qq/messages/123" + query, { headers: { "x-rabiroute-agent-id": "fixture-agent" } })).status, 403);
    assert.equal(calls, 1);
    revoke = true;
    const result = await fetch(app.base + "/api/agent/qq/messages/123" + query, { headers });
    assert.equal(result.status, 403);
    assert.equal((await result.json()).errorCode, "QQ_READ_AUTHORIZATION_REVOKED");
    assert.equal(calls, 2);
  } finally { await app.close(); }
});

test("verified Relay and Peer connections read the same QQ API; spoofed headers and revoked leases withhold results", async () => {
  for (const proxyHeader of ["x-rabiroute-relay-proxy", "x-rabiroute-peer-proxy"]) {
    let enabled = true;
    let revokeDuringRead = false;
    let calls = 0;
    const app = await serve(async () => {
      calls++;
      if (revokeDuringRead) enabled = false;
      return envelope(row);
    }, { local: false, connection: request => request.headers.authorization === "Bearer fixture-verified-connection"
      ? () => { if (!enabled) throw new Error("Connection revoked."); } : undefined });
    const headers = { authorization: "Bearer fixture-verified-connection", "x-rabilink-tunnel-local": "fixture-generation", [proxyHeader]: "1" };
    try {
      assert.equal((await fetch(app.base + "/api/agent/qq/messages/123" + query, { headers: { "x-rabilink-tunnel-local": "fixture-generation", [proxyHeader]: "1" } })).status, 403);
      assert.equal(calls, 0);
      assert.equal((await fetch(app.base + "/api/agent/qq/messages/123" + query, { headers })).status, 200);
      revokeDuringRead = true;
      const result = await fetch(app.base + "/api/agent/qq/messages/123" + query, { headers });
      assert.equal(result.status, 403);
      assert.equal((await result.json()).errorCode, "QQ_READ_AUTHORIZATION_REVOKED");
      assert.equal(calls, 2);
    } finally { await app.close(); }
  }
});

test("route changes while reading withhold the result", async () => {
  let current: GatewayDefinition | undefined = definition;
  const app = await serve(async () => { current = undefined; return envelope(row); }, { route: () => current });
  try { assert.equal((await fetch(app.base + "/api/agent/qq/messages/123" + query)).status, 409); }
  finally { await app.close(); }
});

test("empty file path, oversize and arbitrary references yield explicit failures", async () => {
  const endpoint = { httpUrl: "http://127.0.0.1:12345", accessToken: "" };
  const signal = AbortSignal.timeout(1000);
  await assert.rejects(readQqMedia(endpoint, { kind: "video", name: "test", file: "abc" }, signal,
    async () => envelope({ file: "", url: "" })), /QQ_MEDIA_REFERENCE_UNAVAILABLE/);
  await assert.rejects(readQqMedia(endpoint, { kind: "video", name: "test", file: "abc" }, signal,
    async () => envelope({ file_size: QQ_MEDIA_MAX_BYTES + 1 })), /QQ_MEDIA_TOO_LARGE/);
  await assert.rejects(readQqMedia(endpoint, { kind: "video", name: "test", file: "C:\\private" }, signal), /QQ_MEDIA_REFERENCE_UNAVAILABLE/);
  await assert.rejects(qqRead({ httpUrl: "file:///unsupported", accessToken: "" }, "get_msg", {}, signal), /QQ_ENDPOINT_UNSAFE/);
  assert.equal(qqMessageMedia("[CQ:video,file=abc.mp4,url=https://media.qq.com/a&#44;b]")[0].url, "https://media.qq.com/a,b");
});

test("a fresh QQ URL can recover an empty local path without forwarding OneBot credentials", async () => {
  let calls = 0;
  const bytes = Buffer.from("video-url-content");
  const result = await readQqMedia({ httpUrl: "http://127.0.0.1:12345", accessToken: "test-secret" },
    { kind: "video", name: "video.mp4", file: "abc.mp4", url: "https://media.qq.com/video" }, AbortSignal.timeout(1000),
    async (url, init) => {
      calls++;
      if (calls === 1) return envelope({ file: "", url: "" });
      assert.equal(String(url), "https://media.qq.com/video");
      assert.equal(init?.headers, undefined); assert.equal(init?.redirect, "follow");
      return new Response(bytes);
    });
  assert.deepEqual(result, bytes); assert.equal(calls, 2);
});

test("unsupported URL forms and oversized upstream bodies fail before download", async () => {
  for (const data of [{ file: "", url: "file:///unsupported" }, { file: "", url: "https://user:password@media.example/video" }]) {
    let calls = 0;
    await assert.rejects(readQqMedia({ httpUrl: "http://127.0.0.1:12345", accessToken: "test-secret" },
      { kind: "video", name: "video.mp4", file: "abc.mp4" }, AbortSignal.timeout(1000),
      async () => { calls++; return envelope(data); }), /QQ_MEDIA_URL_UNSUPPORTED/);
    assert.equal(calls, 1);
  }
  await assert.rejects(qqRead({ httpUrl: "http://127.0.0.1:12345", accessToken: "test-secret" }, "get_msg", {}, AbortSignal.timeout(1000),
    async () => new Response("small", { headers: { "content-length": String(Number.MAX_SAFE_INTEGER + 1) } })), /QQ_RESPONSE_TOO_LARGE/);
});

test("attachment download follows a real HTTP resource redirect without OneBot credentials", async t => {
  const bytes = Buffer.from("redirected-video");
  const mediaServer = http.createServer((request, response) => {
    assert.equal(request.headers.authorization, undefined);
    if (request.url === "/redirect") { response.writeHead(302, { location: "/video" }); response.end(); }
    else { response.writeHead(200); response.end(bytes); }
  });
  await new Promise<void>(resolve => mediaServer.listen(0, "127.0.0.1", resolve));
  const mediaUrl = `http://127.0.0.1:${(mediaServer.address() as { port: number }).port}/redirect`;
  const napcat = http.createServer((request, response) => {
    assert.equal(request.url, "/get_file"); assert.equal(request.headers.authorization, "Bearer fixture");
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ status: "ok", retcode: 0, data: { url: mediaUrl } }));
  });
  await new Promise<void>(resolve => napcat.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    for (const server of [napcat, mediaServer]) { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
  });
  const result = await readQqMedia({ httpUrl: `http://127.0.0.1:${(napcat.address() as { port: number }).port}`, accessToken: "fixture" },
    { kind: "video", name: "video.mp4", file: "video-id" }, AbortSignal.timeout(3000));
  assert.deepEqual(result, bytes);
});

test("configured remote NapCat and returned CDN domains or ports need no additional grant", async () => {
  for (const mediaUrl of ["https://multimedia.nt.qq.com.cn/video", "https://cdn.example:8443/video", "http://127.0.0.1:43210/video"]) {
    let calls = 0;
    const bytes = Buffer.from("video bytes");
    const result = await readQqMedia({ httpUrl: "https://napcat.example:8443", accessToken: "fixture" },
      { kind: "video", name: "video.mp4", file: "video-id" }, AbortSignal.timeout(1000), async (url, options) => {
        if (++calls === 1) { assert.equal(String(url), "https://napcat.example:8443/get_file"); return envelope({ url: mediaUrl }); }
        assert.equal(String(url), mediaUrl); assert.equal(options?.redirect, "follow");
        assert.equal(new Headers(options?.headers).get("authorization"), null);
        return new Response(bytes);
      });
    assert.deepEqual(result, bytes); assert.equal(calls, 2);
  }
});

test("private conversation reads use its exact peer without silently selecting a group", async () => {
  const app = await serve(async (url, init) => {
    assert.ok(String(url).endsWith("get_friend_msg_history"));
    assert.equal(JSON.parse(String(init?.body)).user_id, "456");
    return envelope({ messages: [{ ...row, message_type: "private", group_id: undefined, user_id: "456" }] });
  });
  try { assert.equal((await fetch(app.base + "/api/agent/qq/history" + query.replace("kind=group", "kind=private"))).status, 200); }
  finally { await app.close(); }
});
