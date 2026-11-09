import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import { createHash } from "node:crypto";
import { nativeHttpTestFetch as fetchHttp } from "../../../../manager/nativeHttpTestClient.js";
import { ManagerPluginRouteRegistry } from "../../../../manager/managerPluginRouteRegistry.js";
import { apiCatalogOpenApi } from "../../../../manager/apiOperationCatalog.js";
import { markAuthenticatedConnectionRequest } from "../../../../manager/connectionRequestAccess.js";
import type { GatewayDefinition } from "../../../../shared/gatewayConfigModel.js";
import { createQqMessageOperations, handleQqMessageRoutes, type QqMessageRoutesContext } from "./qqMessageRoutes.js";
import { QQ_FORWARD_PATH_PATTERN } from "./qqReadContract.js";

const routeId = "forward-fixture", target = "456", messageId = "123";
const query = `?routeId=${routeId}&kind=group&target=${target}`;
const prefix = `/api/agent/qq/messages/${messageId}/forwards/`;
const segment = (id: string) => ({ type: "forward", data: { id } });
const node = (text: string, extra: object = {}) => ({ sender: { user_id: "789", nickname: "Forward sender" }, time: 100,
  message: [{ type: "text", data: { text } }], ...extra });
const root = () => ({ message_id: messageId, message_type: "group", group_id: target,
  message: [segment("provider-root"), segment("provider-root")] });
type FixtureOptions = {
  local?: boolean; typed?: boolean; transport?: typeof fetch;
  connection?: (request: http.IncomingMessage) => void;
  upstream?: (action: string, payload: Record<string, unknown>) => unknown | Promise<unknown>;
};
async function fixture(options: FixtureOptions = {}) {
  let selectedRoot: unknown = root();
  let bundles: Record<string, unknown> = { "provider-root": { messages: [node("first"), node("second")] } };
  let routeEnabled = true;
  const calls: Array<{ action: string; payload: Record<string, unknown> }> = [];
  const bytes = Buffer.from("forward image fixture bytes");
  const provider = http.createServer(async (request, response) => {
    try {
      if (request.url === "/image") { assert.equal(request.headers.authorization, undefined); response.writeHead(200).end(bytes); return; }
      assert.equal(request.headers.authorization, "Bearer fixture-private-token");
      const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const payload = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      const action = request.url!.slice(1); calls.push({ action, payload });
      const data = options.upstream ? await options.upstream(action, payload) : action === "get_msg" ? selectedRoot
        : action === "get_forward_msg" ? bundles[String(payload.message_id)] : action === "get_file" ? { url: providerBase + "/image" } : {};
      response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ status: "ok", retcode: 0, data }));
    } catch { response.writeHead(500).end(); }
  });
  await new Promise<void>(resolve => provider.listen(0, "127.0.0.1", resolve));
  const providerBase = `http://127.0.0.1:${(provider.address() as { port: number }).port}`;
  const definition = { id: routeId, enabled: true, messageAdapters: ["napcat"],
    napcatInstances: [{ id: "forward-instance", enabled: true, httpUrl: providerBase, accessToken: "fixture-private-token" }] } as GatewayDefinition;
  const context: QqMessageRoutesContext = { local: () => options.local !== false, route: () => routeEnabled ? definition : undefined,
    transport: options.transport, json: (response, status, body) => { response.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body)); } };
  const registry = options.typed === false ? undefined : new ManagerPluginRouteRegistry();
  const registration = registry?.registerOperations("qq-forward-fixture", createQqMessageOperations(context));
  const manager = http.createServer((request, response) => {
    options.connection?.(request);
    const url = new URL(request.url!, "http://127.0.0.1");
    if (!(registry ? registry.handle(request, url, response) : handleQqMessageRoutes(request, url, response, context, operation => operation))) response.writeHead(404).end();
  });
  await new Promise<void>(resolve => manager.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(manager.address() as { port: number }).port}`;
  return { base, calls, bytes, definition, registry, setRoot: (value: unknown) => { selectedRoot = value; },
    setBundles: (value: Record<string, unknown>) => { bundles = value; }, disable: () => { routeEnabled = false; },
    close: async () => { manager.closeAllConnections(); provider.closeAllConnections(); await registration?.dispose();
      await Promise.all([manager, provider].map(server => new Promise<void>(resolve => server.close(() => resolve())))); } };
}

test("merged forwards use real HTTP provider resolution and original root-scoped media links", async t => {
  const f = await fixture(); t.after(f.close);
  f.setBundles({ "provider-root": { messages: [node("native content", { message_id: "provider-node-id", message: [
    { type: "text", data: { text: "native content" } }, { type: "image", data: { file: "node-resource", url: "https://private.provider/image" } }, segment("private-nested-id")
  ] }), node("missing id", { sender: {} })] } });
  const response = await fetchHttp(f.base + prefix + "0" + query); assert.equal(response.status, 200);
  const raw = await response.text(), data = JSON.parse(raw).data;
  assert.doesNotMatch(raw, /provider-root|private-nested-id|private\.provider|node-resource|fixture-private-token/);
  assert.equal(data.total, 2); assert.equal(data.truncated, false); assert.equal(data.messageId, messageId);
  assert.deepEqual(data.entries.map((entry: any) => entry.nodeIndex), [0, 1]);
  assert.equal(data.entries[0].messageId, "provider-node-id"); assert.equal(data.entries[1].messageId, ""); assert.equal(data.entries[1].sender, "");
  const link = data.entries[0].attachments[0].contentUrl;
  assert.equal(link, prefix + "0/nodes/0/attachments/0" + query);
  const media = await fetchHttp(f.base + link); assert.equal(media.status, 200); assert.deepEqual(Buffer.from(await media.arrayBuffer()), f.bytes);
  assert.equal(media.headers.get("x-rabiroute-content-sha256"), createHash("sha256").update(f.bytes).digest("hex"));
  const detail = await fetchHttp(f.base + prefix + "0/nodes/0" + query); assert.equal(detail.status, 200);
  assert.equal((await detail.json()).data.messageId, "provider-node-id");
  assert.deepEqual(f.calls.map(call => call.action), ["get_msg", "get_forward_msg", "get_msg", "get_forward_msg", "get_file", "get_msg", "get_forward_msg"]);
});

test("nested occurrence paths retain duplicate forwards and original node indices", async t => {
  const f = await fixture(); t.after(f.close);
  f.setBundles({ "provider-root": { messages: [null, node("nested", { message: [segment("unused"), segment("child")] })] },
    child: { messages: [node("third", { message: [segment("leaf")] })] }, leaf: { messages: [node("leaf content")] } });
  const response = await fetchHttp(f.base + prefix + "1.1.1.0.0" + query); const detail = await response.json(); assert.equal(response.status, 200, JSON.stringify(detail));
  assert.equal(detail.data.entries[0].text, "leaf content");
  assert.deepEqual(f.calls.map(call => call.payload.message_id), [messageId, "provider-root", "child", "leaf"]);
  for (const invalid of ["0.0", "00", "9007199254740992", "0.9007199254740992.0", "0.-1.0", "a", "0%2F1"]) {
    const count = f.calls.length; const bad = await fetchHttp(f.base + prefix + invalid + query);
    assert.ok([400, 404].includes(bad.status), invalid); assert.equal(f.calls.length, count);
  }
  for (const value of ["0", "1000", "0.100.999", "999.99.999.99.999", "0.0.0.0.0.0.0"]) assert.equal(QQ_FORWARD_PATH_PATTERN.test(value), true);
});

test("one malformed node is isolated without renumbering; empty or invalid bundles fail explicitly", async t => {
  const f = await fixture(); t.after(f.close);
  f.setBundles({ "provider-root": { messages: [null, node("healthy"), true, { sender: { user_id: "1" } }, { type: "node", data: { name: "OneBot node", uin: 22, content: "inline text" } }] } });
  const response = await fetchHttp(f.base + prefix + "0" + query); assert.equal(response.status, 200); const data = (await response.json()).data;
  assert.equal(data.total, 5); assert.equal(data.truncated, true); assert.deepEqual(data.entries.map((entry: any) => entry.nodeIndex), [1, 4]);
  assert.equal(data.entries[1].sender, "22"); assert.equal(data.entries[1].senderName, "OneBot node");
  assert.equal((await fetchHttp(f.base + prefix + "0/nodes/0" + query)).status, 404);
  for (const [messages, status, code] of [[[], 404, "QQ_FORWARD_EMPTY"], ["bad", 503, "QQ_FORWARD_INVALID_RESPONSE"]] as const) {
    f.setBundles({ "provider-root": { messages } }); const bad = await fetchHttp(f.base + prefix + "0" + query);
    assert.equal(bad.status, status); assert.equal((await bad.json()).errorCode, code);
  }
  f.setBundles({ "provider-root": { messages: Array.from({ length: 102 }, (_, i) => node(String(i))) } });
  const limited = (await (await fetchHttp(f.base + prefix + "0" + query)).json()).data;
  assert.equal(limited.total, 102); assert.equal(limited.entries.length, 100); assert.equal(limited.truncated, false); assert.equal(limited.offset, 0); assert.equal(limited.nextOffset, 100);
});

test("each request reauthorizes the root conversation; caller forward IDs/URLs cannot select provider resources", async t => {
  const f = await fixture(); t.after(f.close);
  for (const suffix of ["&forwardId=secret", "&url=http://example.invalid", "&routeId=other", "&limit=101", "&offset=9007199254740992", "&offset=-1", "&offset=01"]) {
    const response = await fetchHttp(f.base + prefix + "0" + query + suffix); assert.equal(response.status, 400); assert.equal(f.calls.length, 0);
  }
  for (const badRoot of [{ ...root(), group_id: "999" }, { ...root(), message_id: "999" }, { ...root(), message_type: "private" }]) {
    f.setRoot(badRoot); const before = f.calls.length;
    const response = await fetchHttp(f.base + prefix + "0/nodes/0/attachments/0" + query); assert.equal(response.status, 409);
    assert.equal((await response.json()).errorCode, "QQ_MESSAGE_TARGET_MISMATCH"); assert.equal(f.calls.length, before + 1);
  }
});

test("local, revoked connection and spoofed proxy authority follow the existing QQ owner", async t => {
  const denied = await fixture({ local: false }); t.after(denied.close);
  assert.equal((await fetchHttp(denied.base + prefix + "0" + query)).status, 403); assert.equal(denied.calls.length, 0);
  const spoofed = await fixture(); t.after(spoofed.close);
  assert.equal((await fetchHttp(spoofed.base + prefix + "0" + query, { headers: { "x-rabilink-tunnel-local": "1" } })).status, 403);
  let valid = true;
  const connection = await fixture({ local: false, connection: request => markAuthenticatedConnectionRequest(request, () => { if (!valid) throw new Error("revoked"); }),
    upstream: action => { if (action === "get_forward_msg") { valid = false; return { messages: [node("never return revoked data")] }; } return root(); } }); t.after(connection.close);
  const revoked = await fetchHttp(connection.base + prefix + "0" + query); assert.equal(revoked.status, 403);
  assert.equal((await revoked.json()).errorCode, "API_REQUEST_AUTHORITY_REVOKED");
});

test("current route changes during any forward await reject subsequent content and media", async t => {
  let change = () => {};
  const f = await fixture({ upstream: action => { if (action === "get_forward_msg") { change(); return { messages: [node("stale")] }; } return root(); } }); t.after(f.close);
  change = f.disable;
  const response = await fetchHttp(f.base + prefix + "0" + query); assert.equal(response.status, 409);
  assert.equal((await response.json()).errorCode, "QQ_READ_ROUTE_CHANGED");
});

test("client cancellation aborts the same upstream lease and releases concurrency capacity", async t => {
  let begin!: () => void, abort!: () => void;
  const started = new Promise<void>(resolve => { begin = resolve; }); const aborted = new Promise<void>(resolve => { abort = resolve; });
  let pending = true;
  const f = await fixture({ transport: async (url, init) => {
    if (String(url).endsWith("get_forward_msg") && pending) { begin(); return new Promise<Response>((_resolve, reject) => {
      init!.signal!.addEventListener("abort", () => { abort(); reject(new Error("cancelled")); }, { once: true });
    }); }
    return fetchHttp(String(url), init);
  } }); t.after(f.close);
  const request = http.get(f.base + prefix + "0" + query); request.on("error", () => {});
  await started; request.destroy(); await aborted; pending = false;
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal((await fetchHttp(f.base + prefix + "0" + query)).status, 200);
});

test("CQ forward occurrence order and aliases stay server-owned in typed and transitional adapters", async t => {
  for (const typed of [true, false]) {
    const f = await fixture({ typed }); t.after(f.close);
    f.setRoot({ ...root(), message: "[CQ:forward,id=provider-root][CQ:forward,resid=provider-root]" });
    const response = await fetchHttp(f.base + prefix + "1" + query); assert.equal(response.status, 200);
    if (!f.registry) continue;
    const spec = await apiCatalogOpenApi(f.registry.catalogSnapshot()) as any;
    for (const suffix of ["", "/nodes/{nodeIndex}", "/nodes/{nodeIndex}/attachments/{attachmentIndex}"]) {
      const operation = spec.paths["/api/agent/qq/messages/{messageId}/forwards/{forwardPath}" + suffix].get;
      assert.ok(operation.responses["200"]); assert.equal(operation["x-rabiroute-contract-version"], "1.0.0");
    }
    assert.doesNotMatch(JSON.stringify(f.registry.catalogSnapshot()), /fixture-private-token|provider-root/);
  }
});

test("forward reads share configured concurrency, timeout and cancellation with existing QQ reads", async t => {
  const previous = process.env.RABIROUTE_QQ_READ_CONCURRENCY;
  process.env.RABIROUTE_QQ_READ_CONCURRENCY = "1";
  t.after(() => { if (previous === undefined) delete process.env.RABIROUTE_QQ_READ_CONCURRENCY; else process.env.RABIROUTE_QQ_READ_CONCURRENCY = previous; });
  let begin!: () => void, release!: () => void;
  const started = new Promise<void>(resolve => { begin = resolve; }); const gate = new Promise<void>(resolve => { release = resolve; });
  const f = await fixture({ upstream: async action => { if (action === "get_forward_msg") { begin(); await gate; return { messages: [node("done")] }; } return root(); } }); t.after(f.close);
  const pending = fetchHttp(f.base + prefix + "0" + query); await started;
  assert.equal((await fetchHttp(f.base + "/api/agent/qq/messages/123" + query)).status, 429);
  assert.equal((await fetchHttp(f.base + prefix + "0" + query)).status, 429);
  release(); assert.equal((await pending).status, 200);
  assert.equal((await fetchHttp(f.base + "/api/agent/qq/messages/123" + query)).status, 200);
  const previousTimeout = process.env.RABIROUTE_QQ_READ_TIMEOUT_MS; process.env.RABIROUTE_QQ_READ_TIMEOUT_MS = "30";
  t.after(() => { if (previousTimeout === undefined) delete process.env.RABIROUTE_QQ_READ_TIMEOUT_MS; else process.env.RABIROUTE_QQ_READ_TIMEOUT_MS = previousTimeout; });
  const timed = await fixture({ transport: async (url, init) => String(url).endsWith("get_msg") ? Response.json({ status: "ok", retcode: 0, data: root() })
    : new Promise<Response>((_resolve, reject) => { const signal = init!.signal!; if (signal.aborted) { reject(signal.reason); return; }
      signal.addEventListener("abort", () => reject(signal.reason), { once: true }); }) }); t.after(timed.close);
  const result = await fetchHttp(timed.base + prefix + "0" + query); assert.equal(result.status, 503); assert.equal((await result.json()).errorCode, "QQ_READ_TIMEOUT");
});

test("forward media uses the existing byte quota and withholds route changes before CDN reads", async t => {
  const previous = process.env.RABIROUTE_QQ_MEDIA_MAX_BYTES; process.env.RABIROUTE_QQ_MEDIA_MAX_BYTES = "2";
  t.after(() => { if (previous === undefined) delete process.env.RABIROUTE_QQ_MEDIA_MAX_BYTES; else process.env.RABIROUTE_QQ_MEDIA_MAX_BYTES = previous; });
  const f = await fixture(); t.after(f.close);
  f.setBundles({ "provider-root": { messages: [node("image", { message: [{ type: "image", data: { file: "root-node-image" } }] })] } });
  const result = await fetchHttp(f.base + prefix + "0/nodes/0/attachments/0" + query); assert.equal(result.status, 413); assert.equal((await result.json()).errorCode, "QQ_RESPONSE_TOO_LARGE");
  let change = () => {}, downloads = 0;
  const changed = await fixture({ transport: async (url, init) => {
    const action = new URL(String(url)).pathname;
    if (action === "/get_msg") return Response.json({ status: "ok", retcode: 0, data: root() });
    if (action === "/get_forward_msg") return Response.json({ status: "ok", retcode: 0, data: { messages: [node("image", { message: [{ type: "image", data: { file: "node-image" } }] })] } });
    if (action === "/get_file") { change(); return Response.json({ status: "ok", retcode: 0, data: { url: "http://localhost/image" } }); }
    downloads++; return new Response("forbidden bytes");
  } }); t.after(changed.close); change = changed.disable;
  const rejected = await fetchHttp(changed.base + prefix + "0/nodes/0/attachments/0" + query);
  assert.equal(rejected.status, 409); assert.equal(downloads, 0);
});

test("self-sent private forward roots still require selected-peer history proof", async t => {
  let seenHistory = false;
  const outgoing = { ...root(), message_type: "private", self_id: "789", user_id: "789", post_type: "message_sent", sender: { user_id: "789" } };
  const f = await fixture({ upstream: (action, payload) => {
    if (action === "get_msg") return outgoing;
    if (action === "get_friend_msg_history") { seenHistory = true; assert.equal(payload.user_id, "456"); return { messages: [outgoing] }; }
    assert.equal(seenHistory, true); return { messages: [node("private forward")] };
  } }); t.after(f.close);
  const response = await fetchHttp(f.base + prefix + "0?routeId=" + routeId + "&kind=private&target=456"); assert.equal(response.status, 200);
  assert.equal((await response.json()).data.entries[0].kind, "private");
  assert.deepEqual(f.calls.map(call => call.action), ["get_msg", "get_friend_msg_history", "get_forward_msg"]);
});

test("forward pages expose every raw node with stable offsets and usable last-page media", async t => {
  const f = await fixture(); t.after(f.close);
  const messages = Array.from({ length: 205 }, (_, index) => node(`node-${index}`));
  messages[204] = node("last image", { message: [{ type: "image", data: { file: "last-node-image" } }] });
  f.setBundles({ "provider-root": { messages } });
  for (const [offset, expectedLength, nextOffset] of [[0, 100, 100], [100, 100, 200], [200, 5, null]] as const) {
    const response = await fetchHttp(f.base + prefix + "0" + query + "&offset=" + offset); assert.equal(response.status, 200);
    const page = (await response.json()).data;
    assert.equal(page.offset, offset); assert.equal(page.nextOffset, nextOffset); assert.equal(page.total, 205); assert.equal(page.truncated, false);
    assert.deepEqual(page.entries.map((row: any) => row.nodeIndex), Array.from({ length: expectedLength }, (_, index) => offset + index));
  }
  const limited = (await (await fetchHttp(f.base + prefix + "0" + query + "&offset=203&limit=1")).json()).data;
  assert.equal(limited.entries[0].nodeIndex, 203); assert.equal(limited.nextOffset, 204);
  const detail = await fetchHttp(f.base + prefix + "0/nodes/204" + query); assert.equal(detail.status, 200);
  const link = (await detail.json()).data.attachments[0].contentUrl;
  assert.equal(link, prefix + "0/nodes/204/attachments/0" + query);
  const media = await fetchHttp(f.base + link); assert.equal(media.status, 200); assert.deepEqual(Buffer.from(await media.arrayBuffer()), f.bytes);
  for (const suffix of ["&offset=1", "&limit=1"]) assert.equal((await fetchHttp(f.base + prefix + "0/nodes/204" + query + suffix)).status, 400);
  const beyond = (await (await fetchHttp(f.base + prefix + "0" + query + "&offset=9007199254740991")).json()).data;
  assert.deepEqual(beyond.entries, []); assert.equal(beyond.nextOffset, null); assert.equal(beyond.total, 205);
});

test("an all-malformed page retains continuation to later healthy nodes without renumbering", async t => {
  const f = await fixture(); t.after(f.close);
  f.setBundles({ "provider-root": { messages: [...Array(100).fill(null), node("healthy after bad page"), false, node("healthy last")] } });
  const first = await fetchHttp(f.base + prefix + "0" + query); assert.equal(first.status, 200);
  const page = (await first.json()).data;
  assert.deepEqual(page.entries, []); assert.equal(page.skippedCount, 100); assert.equal(page.truncated, true); assert.equal(page.total, 103); assert.equal(page.nextOffset, 100);
  const next = (await (await fetchHttp(f.base + prefix + "0" + query + "&offset=" + page.nextOffset)).json()).data;
  assert.deepEqual(next.entries.map((row: any) => row.nodeIndex), [100, 102]); assert.equal(next.skippedCount, 1); assert.equal(next.nextOffset, null);
});

test("four-level forwards and node/forward indices above previous display bounds remain readable", async t => {
  const f = await fixture(); t.after(f.close);
  f.setRoot({ ...root(), message: Array.from({ length: 1001 }, () => segment("provider-root")) });
  f.setBundles({ "provider-root": { messages: [...Array(100).fill(null), node("at 100", { message: [segment("second")] })] },
    second: { messages: [node("at second", { message: [segment("third")] })] },
    third: { messages: [node("at third", { message: [segment("fourth")] })] }, fourth: { messages: [node("four levels work")] } });
  const response = await fetchHttp(f.base + prefix + "1000.100.0.0.0.0.0" + query); assert.equal(response.status, 200);
  assert.equal((await response.json()).data.entries[0].text, "four levels work");
  assert.deepEqual(f.calls.map(call => call.payload.message_id), [messageId, "provider-root", "second", "third", "fourth"]);
  const before = f.calls.length;
  for (const suffix of ["0/nodes/9007199254740992", "9007199254740992"]) {
    assert.equal((await fetchHttp(f.base + prefix + suffix + query)).status, 400); assert.equal(f.calls.length, before);
  }
  assert.equal((await fetchHttp(f.base + prefix + "1001" + query)).status, 404);
  assert.equal((await fetchHttp(f.base + prefix + "1000.101.0" + query)).status, 404);
});

test("cancelling a later nested page aborts its pending owner and never resolves later bundles", async t => {
  let begin!: () => void, finish!: () => void;
  const started = new Promise<void>(resolve => { begin = resolve; }), aborted = new Promise<void>(resolve => { finish = resolve; });
  const calls: string[] = [];
  const f = await fixture({ transport: async (url, init) => {
    const action = new URL(String(url)).pathname, id = JSON.parse(String(init?.body)).message_id;
    calls.push(action + ":" + id);
    if (action === "/get_msg") return Response.json({ status: "ok", retcode: 0, data: root() });
    if (id === "provider-root") return Response.json({ status: "ok", retcode: 0, data: { messages: [...Array(100).fill(null), node("next", { message: [segment("pending-nested")] })] } });
    begin(); return new Promise<Response>((_resolve, reject) => { init!.signal!.addEventListener("abort", () => { finish(); reject(new Error("cancelled nested read")); }, { once: true }); });
  } }); t.after(f.close);
  const request = http.get(f.base + prefix + "0.100.0" + query + "&offset=100"); request.on("error", () => {});
  await started; request.destroy(); await aborted;
  assert.deepEqual(calls, ["/get_msg:123", "/get_forward_msg:provider-root", "/get_forward_msg:pending-nested"]);
});

test("provider-owned forward references remain readable without an extra identifier-length quota", async t => {
  const f = await fixture(); t.after(f.close);
  const providerId = "provider-reference-" + "x".repeat(5000);
  f.setRoot({ ...root(), message: [segment(providerId)] }); f.setBundles({ [providerId]: { messages: [node("provider reference resolved")] } });
  const response = await fetchHttp(f.base + prefix + "0" + query); assert.equal(response.status, 200);
  const text = await response.text(); assert.equal(JSON.parse(text).data.entries[0].text, "provider reference resolved"); assert.equal(text.includes(providerId), false);
});
