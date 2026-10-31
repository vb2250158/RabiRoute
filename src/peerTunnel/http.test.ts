import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import http from "node:http";
import { PassThrough } from "node:stream";
import test from "node:test";
import { configureTimeouts, readTimeoutOverrides } from "../shared/timeoutSettings.js";
import type { TunnelChannel } from "./channel.js";
import { proxyTunnel, serveTunnel, tunnelFetch, tunnelHeaders } from "./http.js";
import { TunnelSession, type TunnelStream } from "./session.js";
import { SpeechApiOwner, createSpeechApiOperations } from "../manager/speechApiOperations.js";
import type { SpeechApiContext } from "../manager/speechApiContext.js";
import { ManagerPluginRouteRegistry } from "../manager/managerPluginRouteRegistry.js";
import { issueInternalManagerHopHeaders, validateInternalManagerHop } from "../shared/internalManagerHop.js";
import { listenManagerEndpoint } from "../managerEndpointPolicy.js";

test('message history tunnel deadline includes the response body and cancels the upstream', { timeout: 2500 }, async t => {
  const { caller, receiver } = sessions(t);
  let calls = 0;
  const baseUrl = await server(t, (_req, res) => { calls++; res.writeHead(200); res.write('{'); });
  serveTunnel(receiver, () => ({ manager: { baseUrl } }));
  const start = performance.now();
  const response = await tunnelFetch(caller, 'manager', '/api/roles/fixture/message-endpoint-history?budgetMs=300');
  await assert.rejects(response.text(), /SEARCH_DEADLINE_EXCEEDED/);
  assert.equal(calls, 1); assert.ok(performance.now() - start < 1500);
});

test('history tunnel uses the configured default and permits an explicit budget above three seconds', { timeout: 10000 }, async t => {
  const previous = readTimeoutOverrides();
  t.after(() => configureTimeouts(previous));
  const { caller, receiver } = sessions(t);
  const baseUrl = await server(t, (_req, res) => {
    res.writeHead(200); res.write('{');
    const timer = setTimeout(() => res.end('}'), 3200);
    res.once('close', () => clearTimeout(timer));
  });
  serveTunnel(receiver, () => ({ manager: { baseUrl } }));
  configureTimeouts({ ...previous, 'history.transport': 6000 });
  const configured = await tunnelFetch(caller, 'manager', '/api/roles/fixture/message-endpoint-history');
  assert.equal(await configured.text(), '{}');
  configureTimeouts({ ...previous, 'history.transport': 20 });
  const explicit = await tunnelFetch(caller, 'manager', '/api/roles/fixture/message-endpoint-history?budgetMs=6000');
  assert.equal(await explicit.text(), '{}');
});

// Exercise the actual session framing and Duplex flow without identity files or live peers.
function sessions(t: test.TestContext) {
  const a = new EventEmitter() as TunnelChannel, b = new EventEmitter() as TunnelChannel;
  let closed = false;
  a.send = async bytes => { setImmediate(() => { if (!closed) b.emit("data", bytes); }); };
  b.send = async bytes => { setImmediate(() => { if (!closed) a.emit("data", bytes); }); };
  a.close = b.close = () => { if (!closed) { closed = true; a.emit("close"); b.emit("close"); } };
  const cipher = { encode: (value: unknown) => Buffer.from(JSON.stringify(value)), decode: (bytes: Buffer) => JSON.parse(bytes.toString()) };
  const hello = { deviceId: "test-peer", generation: "test-generation", publicKey: "test-only", ephemeral: "test-only", nonce: "test-only", target: "test-caller", signature: "test-only" };
  const grant = { deviceId: hello.deviceId, publicKey: hello.publicKey, services: ["manager"] };
  const caller = new TunnelSession(hello, grant, a, cipher, true);
  const receiver = new TunnelSession(hello, grant, b, cipher, false);
  t.after(() => { caller.close(); receiver.close(); });
  return { caller, receiver };
}
async function server(t: test.TestContext, handler: http.RequestListener) {
  const value = http.createServer(handler);
  const endpoint = await listenManagerEndpoint({ server: value, host: "127.0.0.1", policy: { mode: "auto" } });
  t.after(() => { value.closeAllConnections(); value.close(); });
  return endpoint.baseUrl;
}
test("generic Manager and owned resource tunnels sign each actual HTTP path after stripping forged headers", { timeout: 3000 }, async t => {
  const { caller, receiver } = sessions(t);
  const expected = { generation: "fixture-generation", scope: "a".repeat(64) };
  const seen: string[] = [];
  const baseUrl = await server(t, (req, res) => {
    const claims = validateInternalManagerHop(req, expected);
    assert.equal(claims?.deviceId, "actual-eye"); assert.equal(claims?.target, req.url);
    assert.equal(validateInternalManagerHop(req, expected), claims);
    assert.equal(req.headers["x-future-contract"], "preserved");
    assert.equal(req.headers["x-token-count"], "23");
    assert.equal(req.headers["x-secret-version"], "v-next");
    for (const name of ["x-rabiroute-host-token", "x-rabiroute-webgui-token", "x-remote-agent-token"]) assert.equal(req.headers[name], undefined);
    assert.equal(req.headers["x-rabilink-resource-key"], req.url!.startsWith("/api/resource-cache/data/") ? "owned-fixture-key" : undefined);
    seen.push(claims!.nonce); res.setHeader("x-rabilink-internal-hop", req.headers["x-rabilink-internal-hop"]!);
    res.setHeader("x-token-count", req.headers["x-token-count"]!);
    res.setHeader("x-secret-version", req.headers["x-secret-version"]!);
    res.end("signed " + req.url);
  });
  const internalHeaders = (method: string, target: string) => issueInternalManagerHopHeaders({ kind: "peer" as const, ...expected, deviceId: "actual-eye", method, target });
  serveTunnel(receiver, () => ({ manager: { baseUrl, internalHeaders }, resources: {
    baseUrl, pathPrefix: "/api/resource-cache/data", internalHeaders, headers: { "x-rabilink-resource-key": "owned-fixture-key" }
  } }), service => ["manager", "resources"].includes(service));
  for (const [service, path, wire] of [
    ["manager", "/api/unknown-new-api?flag", "/api/unknown-new-api?flag"],
    ["manager", "/api/unknown-new-api?flag=next", "/api/unknown-new-api?flag=next"],
    ["resources", "/image%20one?variant=small", "/api/resource-cache/data/image%20one?variant=small"]
  ]) {
    const result = await tunnelFetch(caller, service, path, { headers: {
      "x-rabilink-tunnel-local": "forged-generation", "x-rabilink-tunnel-device-id": "forged-eye",
      "x-rabilink-internal-hop": "forged", "x-rabiroute-relay-proxy": "1", "x-future-contract": "preserved", "x-rabilink-resource-key": "forged-key",
      "x-token-count": "23", "x-secret-version": "v-next", "x-rabiroute-host-token": "forged-host", "x-rabiroute-webgui-token": "forged-webgui", "x-remote-agent-token": "forged-agent"
    } });
    assert.equal(result.status, 200); assert.equal(await result.text(), "signed " + wire);
    assert.equal(result.headers.get("x-rabilink-internal-hop"), null);
    assert.equal(result.headers.get("x-token-count"), "23");
    assert.equal(result.headers.get("x-secret-version"), "v-next");
  }
  assert.equal(seen.length, 3); assert.equal(new Set(seen).size, 3);
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
function guardedFront(t: test.TestContext, caller: TunnelSession, guard: () => void) {
  const settled = deferred<unknown>();
  const url = server(t, (request, response) => {
    void proxyTunnel(caller, "manager", "/test", request, response, guard).then(() => settled.resolve(undefined), error => {
      // The outer API boundary owns sanitization; the proxy must return the denial.
      if (!response.headersSent && !response.destroyed) { response.writeHead(403); response.end("denied"); }
      settled.resolve(error);
    });
  });
  return { url, settled: settled.promise };
}

test("tunnel rejects before dispatch and preserves the original authority denial", { timeout: 3000 }, async t => {
  const { caller } = sessions(t); const denial = new Error("test-only authority denial");
  const front = guardedFront(t, caller, () => { throw denial; });
  const response = await fetch(await front.url);
  assert.equal(response.status, 403); assert.equal(await response.text(), "denied");
  assert.equal(await front.settled, denial); assert.equal(caller.streams.size, 0);
});

test("tunnel rechecks late headers on upstream success and failure", { timeout: 3000 }, async t => {
  for (const failure of [false, true]) {
    const { caller, receiver } = sessions(t); const denial = new Error("test-only revoked"); let revoked = false;
    receiver.once("request", (stream: TunnelStream) => {
      stream.resume(); revoked = true;
      if (failure) stream.destroy(new Error("test-only private upstream error"));
      else void stream.reply({ status: 200, headers: { "x-private-result": "hidden" } }).then(() => stream.end("private body"));
    });
    const front = guardedFront(t, caller, () => { if (revoked) throw denial; });
    const response = await fetch(await front.url);
    assert.equal(response.status, 403); assert.equal(response.headers.get("x-private-result"), null);
    assert.equal(await response.text(), "denied"); assert.equal(await front.settled, denial);
    assert.equal(caller.streams.size, 0);
  }
});

test("tunnel input chunk denial settles a pending header wait without forwarding the body", { timeout: 3000 }, async t => {
  const { caller, receiver } = sessions(t); const denial = new Error("test-only upload revoked"); let checks = 0; let body = "";
  receiver.once("request", (stream: TunnelStream) => { stream.on("data", chunk => { body += chunk; }); });
  const front = guardedFront(t, caller, () => { if (++checks >= 3) throw denial; });
  const response = await fetch(await front.url, { method: "POST", body: "forbidden mutation" });
  assert.equal(response.status, 403); assert.equal(await response.text(), "denied");
  assert.equal(await front.settled, denial); assert.equal(body, ""); assert.equal(caller.streams.size, 0);
});

test("tunnel input final denial does not dispatch the completion frame", { timeout: 3000 }, async t => {
  const { caller, receiver } = sessions(t); const denial = new Error("test-only final revoked"); let revoked = false; let ended = false;
  const request = new PassThrough() as unknown as http.IncomingMessage; request.method = "GET"; request.headers = {};
  const response = new http.ServerResponse(request);
  const remoteClosed = deferred<void>();
  receiver.once("request", (stream: TunnelStream) => {
    stream.resume(); stream.on("end", () => { ended = true; }); stream.once("close", () => remoteClosed.resolve());
    revoked = true; request.push(null);
  });
  await assert.rejects(proxyTunnel(caller, "manager", "/test", request, response, () => { if (revoked) throw denial; }), error => error === denial);
  await remoteClosed.promise; assert.equal(ended, false);
});

test("tunnel output chunk and final denial stop disclosure and reject the proxy promise", { timeout: 3000 }, async t => {
  for (const final of [false, true]) {
    const { caller, receiver } = sessions(t); const remote = deferred<TunnelStream>();
    const denial = new Error("test-only download revoked"); let revoked = false;
    receiver.once("request", (stream: TunnelStream) => {
      stream.resume(); remote.resolve(stream);
      void stream.reply({ status: 200, headers: {} }).then(() => stream.write("allowed"));
    });
    const front = guardedFront(t, caller, () => { if (revoked) throw denial; });
    const response = await fetch(await front.url); const reader = response.body!.getReader();
    assert.equal(new TextDecoder().decode((await reader.read()).value), "allowed");
    revoked = true;
    if (final) (await remote.promise).end(); else (await remote.promise).write("private-after-revocation");
    await assert.rejects(reader.read()); assert.equal(await front.settled, denial);
    assert.equal(caller.streams.size, 0);
  }
});

test("tunnel request source errors terminate the pending proxy and release the stream", { timeout: 3000 }, async t => {
  const { caller } = sessions(t);
  const request = new PassThrough() as unknown as http.IncomingMessage;
  request.method = "POST"; request.headers = {};
  const response = new http.ServerResponse(request);
  const operation = proxyTunnel(caller, "manager", "/test", request, response);
  // A source error is not automatically propagated by pipe(). The proxy must
  // own it, settle the header wait, and remove its listeners after termination.
  assert.equal(request.listenerCount("error"), 1);
  request.destroy(new Error("test-only source failed"));
  await operation;
  assert.equal(caller.streams.size, 0); assert.equal(response.statusCode, 502);
  assert.equal(request.listenerCount("error"), 0);
  assert.equal(request.listenerCount("aborted"), 0);
  assert.equal(response.listenerCount("close"), 0);
});

test("tunnel client disconnect terminates the proxy and remote stream", { timeout: 3000 }, async t => {
  const { caller, receiver } = sessions(t); const remoteClosed = deferred<void>();
  receiver.once("request", (stream: TunnelStream) => {
    stream.resume(); stream.once("close", () => remoteClosed.resolve());
    void stream.reply({ status: 200, headers: {} }).then(() => stream.write("allowed"));
  });
  const front = guardedFront(t, caller, () => {});
  const controller = new AbortController();
  const response = await fetch(await front.url, { signal: controller.signal });
  const reader = response.body!.getReader(); await reader.read(); controller.abort();
  await front.settled; await remoteClosed.promise; assert.equal(caller.streams.size, 0);
});

test("tunnel connection errors before headers are sanitized without exposing upstream details", { timeout: 3000 }, async t => {
  const { caller, receiver } = sessions(t);
  receiver.once("request", (stream: TunnelStream) => stream.destroy(new Error("test-only private failure")));
  const front = guardedFront(t, caller, () => {});
  const response = await fetch(await front.url);
  assert.equal(response.status, 502); assert.doesNotMatch(await response.text(), /private/);
  assert.equal(await front.settled, undefined); assert.equal(caller.streams.size, 0);
});

test("raw SSE upstream read failure terminates the downstream without an unhandled sink error", { timeout: 3000 }, async t => {
  const source = deferred<ReadableStreamDefaultController<Uint8Array>>();
  const aborted = deferred<void>();
  const owner = new SpeechApiOwner({
    speechControl: { eventStream: async (signal: AbortSignal) => new Response(new ReadableStream<Uint8Array>({ start(controller) {
      source.resolve(controller); controller.enqueue(new TextEncoder().encode("data: allowed\n\n"));
      signal.addEventListener("abort", () => aborted.resolve(), { once: true });
    } }), { headers: { "content-type": "text/event-stream" } }) },
    capture: () => ({ guard: () => {}, run: <T>(action: () => T) => action(), targetLocal: false })
  } as unknown as SpeechApiContext);
  const registry = new ManagerPluginRouteRegistry(), registration = registry.registerOperations("speech-stream-fixture", createSpeechApiOperations(owner).operations.filter(value => value.contract.operationId === "manager.speech.events"));
  t.after(async () => { await Promise.all([registration.dispose(), owner.events.stop()]); });
  const url = await server(t, (request, response) => { if (!registry.handle(request, new URL(request.url!, "http://fixture"), response)) response.writeHead(404).end(); });
  const response = await fetch(url + "/api/speech/events"); const reader = response.body!.getReader();
  assert.match(new TextDecoder().decode((await reader.read()).value), /allowed/);
  (await source.promise).error(new Error("test-only private upstream failure"));
  await assert.rejects(reader.read()); await aborted.promise;
});


test("transport write failure rejects the original stream without another send", async t => {
  const channel = new EventEmitter() as TunnelChannel;
  let writes = 0;
  channel.send = async () => { writes++; throw new Error("fixture channel failed"); };
  channel.close = () => { channel.emit("close"); };
  const hello = { deviceId: "fixture", generation: "generation", publicKey: "fixture", ephemeral: "fixture", nonce: "fixture", target: "caller", signature: "fixture" };
  const session = new TunnelSession(hello, { deviceId: "fixture", publicKey: "fixture", services: ["manager"] }, channel,
    { encode: value => Buffer.from(JSON.stringify(value)), decode: bytes => JSON.parse(bytes.toString()) }, true);
  t.after(() => session.close());
  const stream = session.open({ service: "manager", method: "POST", path: "/new-write", headers: {} });
  await assert.rejects(new Promise<void>((resolve, reject) => stream.write("write-once", error => error ? reject(error) : resolve())));
  await assert.rejects(stream.response); assert.equal(writes, 1); assert.equal(session.streams.size, 0);
});

test("service revocation suppresses later SSE bytes and closes the upstream", { timeout: 3000 }, async t => {
  const { caller, receiver } = sessions(t); let allowed = true;
  const upstream = deferred<http.ServerResponse>(); const closed = deferred<void>();
  const url = await server(t, (_request, response) => {
    response.writeHead(200, { "content-type": "text/event-stream" }); response.write("data: allowed\n\n");
    response.once("close", () => closed.resolve()); upstream.resolve(response);
  });
  serveTunnel(receiver, () => ({ manager: { baseUrl: url } }), () => allowed);
  const response = await tunnelFetch(caller, "manager", "/new-events"); const reader = response.body!.getReader();
  assert.match(new TextDecoder().decode((await reader.read()).value), /allowed/);
  allowed = false; (await upstream.promise).write("data: private-after-revocation\n\n");
  await assert.rejects(reader.read()); await closed.promise; assert.equal(caller.streams.size, 0);
});

test("service revocation stops upload bytes before they reach the owner", { timeout: 3000 }, async t => {
  const { caller, receiver } = sessions(t); let allowed = true, received = "";
  const first = deferred<void>(); const closed = deferred<void>();
  const url = await server(t, (request, _response) => {
    request.on("data", bytes => { received += bytes.toString(); first.resolve(); });
    request.once("close", () => closed.resolve());
  });
  serveTunnel(receiver, () => ({ manager: { baseUrl: url } }), () => allowed);
  const stream = caller.open({ service: "manager", method: "POST", path: "/new-upload", headers: {} });
  stream.write("allowed"); await first.promise; allowed = false; stream.write("private-after-revocation");
  await assert.rejects(stream.response); await closed.promise; assert.equal(received, "allowed");
});

test("lifecycle fences and mutation controls survive while caller identity headers are stripped", () => {
  assert.deepEqual(tunnelHeaders({ "x-rabiroute-expected-application-generation-id": "generation", "x-rabiroute-expected-manager-instance-id": "instance",
    "idempotency-key": "original", "if-match": "strong", "x-rabilink-tunnel-local": "forged", "x-rabilink-tunnel-device-id": "forged", "x-rabiroute-peer-proxy": "forged", authorization: "forged" }), {
    "x-rabiroute-expected-application-generation-id": "generation", "x-rabiroute-expected-manager-instance-id": "instance", "idempotency-key": "original", "if-match": "strong"
  });
});
