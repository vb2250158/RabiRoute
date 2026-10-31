import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import { once } from "node:events";
import { WebSocket, WebSocketServer } from "ws";
import { createManagerClient } from "../lib/manager-client.mjs";

const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const schema = { type: "object", required: ["type"], properties: { type: { type: "string" } }, additionalProperties: true };
async function fixture(t, framing = "json") {
  const meta = { applicationGenerationId: "app", managerInstanceId: "manager", health: { live: true, requiredReady: true, state: "healthy" } };
  const contract = { operationId: "future.channel", aliases: ["old:GET:/channel"], contractVersion: "1.0.0", method: "GET", transport: "websocket",
    pathTemplate: "/future/:channel", request: { body: { kind: "none" } }, websocket: { protocol: "future.native", framing,
      maxMessageBytes: 1024, maxBufferedBytes: 2048, closeGraceMs: 100,
      ...(framing === "json" ? { incomingSchema: schema, outgoingSchema: schema } : {}) } };
  const state = { contract, meta, received: [], upgrades: [], catalogReads: 0, rejectUpgrade: false };
  const catalog = () => ({ schemaVersion: "2", ...meta, pluginGenerationId: "plugins", catalogRevision: 1,
    catalogDigest: "sha256:" + "a".repeat(64), nextCursor: "", operations: [{ id: contract.operationId, contractDigest: "sha256:" + "b".repeat(64), contract }] });
  const server = http.createServer((request, response) => {
    response.setHeader("content-type", "application/json");
    if (request.url === "/meta") { response.end(JSON.stringify(state.metadata?.() ?? meta)); return; }
    if (request.url === "/api/agent/help") { state.catalogReads++; response.end(JSON.stringify({ code: 0, data: catalog() })); return; }
    response.writeHead(404).end("{}");
  });
  const ws = new WebSocketServer({ noServer: true });
  server.on("upgrade", (request, socket, head) => {
    state.upgrades.push({ path: request.url, headers: request.headers });
    if (state.rejectUpgrade) { socket.end("HTTP/1.1 409 Conflict\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"); return; }
    ws.handleUpgrade(request, socket, head, channel => ws.emit("connection", channel, request));
  });
  ws.on("connection", channel => {
    state.serverSocket = channel; state.onConnect?.(channel);
    channel.on("message", (raw, binary) => {
      const value = framing === "json" ? JSON.parse(raw.toString()) : Buffer.from(raw); state.received.push(value);
      state.onReceive?.(value); if (state.echo !== false) channel.send(framing === "json" ? JSON.stringify(value) : value, { binary });
    });
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const client = createManagerClient({ managerUrl: `http://127.0.0.1:${server.address().port}`, credential: "fixture-private-credential" });
  const channels = [];
  state.open = async (options = {}, id = "future.channel") => {
    const channel = await client.openOperation(id, { path: { channel: "one" }, ...options }); channels.push(channel); return channel;
  };
  t.after(async () => {
    for (const channel of channels) channel.close();
    for (const channel of ws.clients) channel.terminate();
    await Promise.all(channels.map(channel => channel.closed));
    await new Promise(resolve => ws.close(resolve)); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  });
  return Object.assign(state, { client });
}

test("accepted send callbacks provide producer backpressure and remain owned after the socket closes", { timeout: 10000 }, async t => {
  const accepted = deferred(), release = deferred();
  t.after(() => release.resolve());
  const f = await fixture(t); f.echo = false;
  const original = WebSocket.prototype.send;
  t.mock.method(WebSocket.prototype, "send", function(data, options, callback) {
    const done = typeof options === "function" ? options : callback;
    if (!this._isServer && typeof done === "function") {
      return original.call(this, data, typeof options === "function" ? {} : options, error => {
        accepted.resolve(); void release.promise.then(() => done(error));
      });
    }
    return original.call(this, data, options, callback);
  });
  const channel = await f.open({ onMessage: () => {} });
  let sent = false, closed = false;
  const writing = channel.sendJsonAsync({ type: "owned-write" }).then(() => { sent = true; });
  await accepted.promise; channel.close(); const closing = channel.closed.then(() => { closed = true; });
  try { await new Promise(resolve => setImmediate(resolve)); assert.equal(sent, false); assert.equal(closed, false); }
  finally { release.resolve(); }
  await writing; await closing; assert.equal(sent, true); assert.equal(closed, true);
});

test("generic WebSocket resolves a future contract/alias, preserves native frames and follows a changed path without mappings", { timeout: 10000 }, async t => {
  const f = await fixture(t), message = deferred(); const values = [];
  const first = await f.open({ path: { channel: "one / two" }, query: { tag: ["a", "b"] },
    headers: { "x-future-resource": "resource" }, onMessage: value => { values.push(value); message.resolve(); }, onOpen: channel => channel.sendJson({ type: "native-auth", value: "opaque" }) }, "old:GET:/channel");
  await message.promise;
  assert.deepEqual(values, [{ type: "native-auth", value: "opaque" }]);
  assert.equal(f.upgrades[0].path, "/future/one%20%2F%20two?tag=a&tag=b");
  assert.equal(f.upgrades[0].headers["x-rabiroute-api-contract"], "sha256:" + "b".repeat(64));
  assert.equal(f.upgrades[0].headers["x-future-resource"], "resource");
  assert.equal(f.upgrades[0].headers["x-rabiroute-expected-manager-instance-id"], "manager");
  first.close(); await first.closed;
  f.contract.pathTemplate = "/changed/:channel"; f.client.catalog.handleEvent({ type: "api.catalog.changed" });
  const second = await f.open({ onMessage: () => {} }); assert.equal(f.upgrades[1].path, "/changed/one"); second.close(); await second.closed;
  assert.equal(f.received.length, 1, "Discovery and reconnection never replay the authentication or commands.");
});

test("Socket closure retains consumer and close-owner cleanup before settling closed", { timeout: 10000 }, async t => {
  const entered = deferred(), release = deferred(), closeEntered = deferred(), closeRelease = deferred();
  t.after(() => { release.resolve(); closeRelease.resolve(); });
  const f = await fixture(t);
  const channel = await f.open({ onMessage: async (_value, { signal }) => { entered.resolve(signal); await release.promise; },
    onClose: async () => { closeEntered.resolve(); await closeRelease.promise; } });
  channel.sendJson({ type: "work" }); const signal = await entered.promise;
  let closed = false; const finished = channel.closed.then(() => { closed = true; }); channel.close();
  await new Promise(resolve => setImmediate(resolve)); assert.equal(signal.aborted, true); assert.equal(closed, false);
  release.resolve(); await closeEntered.promise; assert.equal(closed, false); closeRelease.resolve(); await finished;
});

test("identity change after upgrade discloses no queued frames and starts no native login", { timeout: 10000 }, async t => {
  const f = await fixture(t); let messages = 0, opened = 0;
  f.onConnect = socket => { f.metadata = () => ({ ...f.meta, managerInstanceId: "replacement" }); socket.send('{"type":"early"}'); };
  await assert.rejects(f.open({ onMessage: () => { messages++; }, onOpen: () => { opened++; } }), /IDENTITY_OR_OPEN_FAILED/);
  assert.equal(f.upgrades.length, 1); assert.equal(messages, 0); assert.equal(opened, 0); assert.equal(f.received.length, 0);
});

test("contract conflicts do not replay an upgrade, and later explicit opens refresh discovery", { timeout: 10000 }, async t => {
  const f = await fixture(t); f.rejectUpgrade = true;
  await assert.rejects(f.open({ onMessage: () => {} }), error => error.code === "API_CONTRACT_CHANGED" && error.statusCode === 409);
  assert.equal(f.upgrades.length, 1); assert.equal(f.catalogReads, 1);
  f.rejectUpgrade = false; const next = await f.open({ onMessage: () => {} }); assert.equal(f.catalogReads, 2); next.close(); await next.closed;
});

test("frame schemas and byte capacities reject invalid data before native delivery", { timeout: 10000 }, async t => {
  const f = await fixture(t); let received = 0;
  const channel = await f.open({ onMessage: () => { received++; } });
  assert.throws(() => channel.sendJson({ wrong: true }), /INVALID_OUTGOING_FRAME/);
  assert.throws(() => channel.sendJson({ type: "large", value: "x".repeat(1024) }), /CAPACITY_EXCEEDED/); await channel.closed;
  assert.equal(f.received.length, 0);
  const second = await f.open({ onMessage: () => { received++; } }); f.serverSocket.send('{"wrong":true}');
  assert.equal((await second.closed).errorCode, "INVALID_INCOMING_FRAME"); assert.equal(received, 0);
});

test("binary framing preserves original bytes and rejects JSON send helpers", { timeout: 10000 }, async t => {
  const f = await fixture(t, "bytes"), received = deferred(); const bytes = Buffer.from([0, 255, 1, 13, 10]);
  const channel = await f.open({ onMessage: value => received.resolve(value) });
  channel.send(bytes); assert.deepEqual(await received.promise, bytes); assert.throws(() => channel.sendJson({}), /JSON_NOT_SUPPORTED/);
  channel.close(); await channel.closed;
});

test("unsupported schemas, missing consumers and credential overrides never establish a Socket", { timeout: 10000 }, async t => {
  const f = await fixture(t);
  await assert.rejects(f.open(), /explicit onMessage/);
  await assert.rejects(f.open({ onMessage: () => {}, headers: { authorization: "private-value" } }), /transport-owned/);
  f.contract.websocket.incomingSchema = { type: "object", unrecognizedKeyword: true };
  await assert.rejects(f.open({ onMessage: () => {} }), /UNSUPPORTED_SCHEMA/); assert.equal(f.upgrades.length, 0);
});

test("caller cancellation closes the original channel without another connection or error credential disclosure", { timeout: 10000 }, async t => {
  const f = await fixture(t), controller = new AbortController();
  const channel = await f.open({ onMessage: () => {}, signal: controller.signal }); controller.abort();
  assert.equal((await channel.closed).errorCode, "CANCELLED"); assert.equal(f.upgrades.length, 1);
  assert.throws(() => channel.sendJson({ type: "late" }), error => !error.message.includes("fixture-private-credential") && error.code === "CLOSED");
});

test("slow consumers are serialized and cancellation waits for the accepted consumer rather than delivering queued frames", { timeout: 10000 }, async t => {
  const entered = deferred(), release = deferred(); let consumers = 0, concurrent = 0;
  t.after(() => release.resolve());
  const f = await fixture(t);
  const channel = await f.open({ onMessage: async () => { consumers++; concurrent++; assert.equal(concurrent, 1); entered.resolve(); await release.promise; concurrent--; } });
  f.serverSocket.send('{"type":"first"}'); await entered.promise;
  f.serverSocket.send('{"type":"queued"}'); channel.close();
  let settled = false; channel.closed.then(() => { settled = true; });
  await new Promise(resolve => setImmediate(resolve)); assert.equal(settled, false); assert.equal(consumers, 1);
  release.resolve(); await channel.closed; assert.equal(consumers, 1); assert.equal(concurrent, 0);
});

test("opening cancellation waits for the original onOpen cleanup without publishing a usable session", { timeout: 10000 }, async t => {
  const entered = deferred(), release = deferred(), controller = new AbortController();
  t.after(() => release.resolve());
  const f = await fixture(t);
  const opening = f.open({ signal: controller.signal, onMessage: () => {}, onOpen: async (_channel, { signal }) => { entered.resolve(signal); await release.promise; } });
  const outcome = assert.rejects(opening, error => error.code === "CANCELLED");
  const signal = await entered.promise; controller.abort(); assert.equal(signal.aborted, true);
  let finished = false; outcome.then(() => { finished = true; }); await new Promise(resolve => setImmediate(resolve)); assert.equal(finished, false);
  release.resolve(); await outcome; assert.equal(f.upgrades.length, 1); assert.equal(f.received.length, 0);
});

test("different server incoming and outgoing schemas validate the correct client directions", { timeout: 10000 }, async t => {
  const f = await fixture(t), response = deferred(); f.echo = false;
  f.contract.websocket.incomingSchema = { type: "object", required: ["request"], properties: { request: { const: "client" } }, additionalProperties: false };
  f.contract.websocket.outgoingSchema = { type: "object", required: ["response"], properties: { response: { const: "server" } }, additionalProperties: false };
  f.onReceive = value => { assert.deepEqual(value, { request: "client" }); f.serverSocket.send('{"response":"server"}'); };
  const channel = await f.open({ onMessage: value => response.resolve(value) });
  assert.throws(() => channel.sendJson({ response: "server" }), /INVALID_OUTGOING_FRAME/);
  channel.sendJson({ request: "client" }); assert.deepEqual(await response.promise, { response: "server" });
  channel.close(); await channel.closed; assert.equal(f.received.length, 1);
});
