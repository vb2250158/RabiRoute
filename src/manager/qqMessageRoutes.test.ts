import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import http from "node:http";
import test from "node:test";
import os from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";
import { handleQqMessageRoutes } from "./qqMessageRoutes.js";
import { qqMessageMedia, readQqMedia, QQ_MEDIA_MAX_BYTES, qqRead } from "./qqMessageMedia.js";
import type { GatewayDefinition } from "../shared/gatewayConfigModel.js";
import { authorizeAgentApiOperation } from "./agentApiPolicy.js";

const definition = { id: "test-route", enabled: true, messageAdapters: ["napcat"],
  napcatInstances: [{ id: "test-instance", enabled: true, httpUrl: "http://127.0.0.1:12345", accessToken: "test-secret" }] } as GatewayDefinition;
const row = { message_id: 123, message_type: "group", group_id: "456", time: 100, user_id: "789",
  message: [{ type: "text", data: { text: "hello" } }, { type: "video", data: { file: "abc.mp4", url: "https://media.qq.com/private-key", thumb: "cover.png" } }] };
const envelope = (data: unknown) => Response.json({ status: "ok", retcode: 0, data });
async function serve(transport: typeof fetch, options: { local?: boolean; route?: () => GatewayDefinition | undefined } = {}) {
  const server = http.createServer((request, response) => {
    const url = new URL(request.url!, "http://127.0.0.1");
    if (!handleQqMessageRoutes(request, url, response, { local: () => options.local !== false,
      route: options.route ?? (() => definition), transport,
      json: (reply, status, body) => { reply.writeHead(status, { "content-type": "application/json" }); reply.end(JSON.stringify(body)); }
    }, operation => operation)) response.writeHead(404).end();
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  return { base: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
    close: () => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }) };
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
  await assert.rejects(qqRead({ httpUrl: "http://other.invalid", accessToken: "" }, "get_msg", {}, signal), /QQ_ENDPOINT_UNSAFE/);
  assert.equal(qqMessageMedia("[CQ:video,file=abc.mp4,url=https://media.qq.com/a&#44;b]")[0].url, "https://media.qq.com/a,b");
});

test("catalog recognizes all public query and download contracts", () => {
  for (const url of ["/api/agent/qq/history" + query + "&cursor=1&limit=50", "/api/agent/qq/messages/123" + query,
    "/api/agent/qq/messages/123/attachments/0" + query]) assert.equal(authorizeAgentApiOperation("GET", url).allowed, true);
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
      assert.equal(init?.headers, undefined); assert.equal(init?.redirect, "error");
      return new Response(bytes);
    });
  assert.deepEqual(result, bytes); assert.equal(calls, 2);
});

test("declared oversize and hostile media hosts fail before download", async () => {
  for (const data of [{ file: "", url: "http://127.0.0.1/private" }, { file: "", url: "https://media.qq.com@attacker.invalid/video" }]) {
    let calls = 0;
    await assert.rejects(readQqMedia({ httpUrl: "http://127.0.0.1:12345", accessToken: "test-secret" },
      { kind: "video", name: "video.mp4", file: "abc.mp4" }, AbortSignal.timeout(1000),
      async () => { calls++; return envelope(data); }), /QQ_MEDIA_URL_UNSUPPORTED/);
    assert.equal(calls, 1);
  }
  await assert.rejects(qqRead({ httpUrl: "http://127.0.0.1:12345", accessToken: "test-secret" }, "get_msg", {}, AbortSignal.timeout(1000),
    async () => new Response("small", { headers: { "content-length": String(2 * 1024 * 1024) } })), /QQ_RESPONSE_TOO_LARGE/);
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
