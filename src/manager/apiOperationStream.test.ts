import assert from "node:assert/strict";
import http from "node:http";
import { EventEmitter, once } from "node:events";
import test, { type TestContext } from "node:test";
import { compileApiOperation, type ApiOperationContract, type ApiOperationDefinition, type ApiOperationStream } from "./apiOperationContract.js";
import { cancelApiOperationStream, writeApiOperationStream } from "./apiOperationStream.js";
import { ManagerPluginRouteRegistry } from "./managerPluginRouteRegistry.js";
import { fixtureApiContract } from "./apiOperationContractFixtures.js";

const empty = { type: "object", properties: {}, additionalProperties: false } as const;
function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }

test("an unstarted stream drains yielding cleanup while cancellation awaits that same EOF", { timeout: 10000 }, async t => {
  const entered = deferred(), release = deferred(), cleaned = deferred(); let stopped = false, cancellations = 0;
  t.after(release.resolve);
  const source: ApiOperationStream = {
    frames: (async function* () { try { if (!stopped) yield { event: "data", data: { revision: 1 } }; }
      finally { entered.resolve(); yield { comment: "cleanup" }; await release.promise; cleaned.resolve(); } })(),
    cancel: () => { cancellations++; stopped = true; return cleaned.promise; }
  };
  let finished = false; const retiring = cancelApiOperationStream(source, new Error("Never written")).then(() => { finished = true; });
  await entered.promise; await new Promise(resolve => setImmediate(resolve)); assert.equal(finished, false);
  release.resolve(); await retiring; assert.equal(cancellations, 1); assert.equal(finished, true);
});

test("disconnect before a delayed stream result retains its lease until unstarted owner cleanup completes", { timeout: 10000 }, async t => {
  const started = deferred(), handlerRelease = deferred(), cleanupStarted = deferred(), cleanupRelease = deferred(), cleaned = deferred();
  let sourceStopped = false;
  t.after(() => { handlerRelease.resolve(); cleanupRelease.resolve(); });
  const owner = await serve(t, { contract: contract(), handler: async input => {
    assert.ok(input.signal); started.resolve(); await handlerRelease.promise;
    return { status: 200, stream: {
      frames: (async function* () { try { if (!sourceStopped) yield { event: "data", data: { revision: 1 } }; }
        finally { cleanupStarted.resolve(); yield { comment: "cleanup" }; await cleanupRelease.promise; cleaned.resolve(); } })(),
      cancel: () => { sourceStopped = true; return cleaned.promise; }
    } };
  } });
  const outgoing = http.get(owner.url); outgoing.on("error", () => {}); t.after(() => outgoing.destroy());
  await started.promise; outgoing.destroy(); await new Promise(resolve => setImmediate(resolve)); handlerRelease.resolve();
  await cleanupStarted.promise;
  let disposed = false; const retiring = owner.registration.dispose().then(() => { disposed = true; });
  await new Promise(resolve => setImmediate(resolve)); assert.equal(disposed, false);
  cleanupRelease.resolve(); await retiring; assert.equal(disposed, true); assert.equal(sourceStopped, true);
});
function contract(overrides: Partial<ApiOperationContract> = {}): ApiOperationContract {
  return fixtureApiContract({ operationId: "example.stream", method: "GET", pathTemplate: "/api/example/stream", transport: "sse",
    request: { path: empty, query: empty, headers: { type: "object" }, body: { kind: "none" } },
    responses: { "200": { mediaType: "text/event-stream", stream: { framing: "sse-json", maxFrameBytes: 1024,
      frameSchema: { type: "object", required: ["event", "data"], additionalProperties: false, properties: {
        event: { type: "string" }, data: { type: "object", required: ["revision"], additionalProperties: false, properties: { revision: { type: "integer" } } }
      } }, completion: "EOF or client disconnect.", cancellation: "Stop the producer and drain cleanup to EOF." } } }, ...overrides });
}
async function serve(t: TestContext, definition: ApiOperationDefinition) {
  const registry = new ManagerPluginRouteRegistry();
  const registration = registry.registerOperations("stream-owner", [definition]);
  const server = http.createServer((request, response) => {
    if (!registry.handle(request, new URL(request.url!, "http://localhost"), response)) { response.statusCode = 404; response.end(); }
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const address = server.address(); assert.ok(address && typeof address !== "string");
  t.after(async () => { await registration.dispose(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  return { registry, registration, url: `http://127.0.0.1:${address.port}/api/example/stream` };
}

test("real SSE streams validate and frame each event without buffering the complete response", async t => {
  let cleaned = false; let cancellations = 0;
  const owner = await serve(t, { contract: contract(), handler: () => ({ status: 200, stream: {
    frames: (async function* () { try { for (const revision of [1, 2, 3]) yield { event: "changed", data: { revision } }; } finally { cleaned = true; } })(),
    cancel: () => { cancellations++; }
  } }) });
  const response = await fetch(owner.url); assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "text/event-stream");
  assert.equal(await response.text(), [1, 2, 3].map(revision => `event: changed\ndata: {"revision":${revision}}\n\n`).join(""));
  assert.equal(cleaned, true); assert.equal(cancellations, 0);
});

test("raw SSE retains comments, multiline non-JSON data and split UTF-8 bytes exactly", async t => {
  const packet = Buffer.from(": heartbeat\r\nid: 42\r\nretry: 1500\r\nevent: source\r\ndata: not-json\r\ndata: 二行\r\n\r\n");
  const raw = contract({ responses: { "200": { mediaType: "text/event-stream; charset=utf-8", stream: {
    framing: "bytes", maxFrameBytes: 4096, completion: "Native EOF.", cancellation: "Cancel and join the original SSE producer."
  } } } });
  const owner = await serve(t, { contract: raw, handler: () => ({ status: 200, stream: {
    frames: (async function* () { for (let offset = 0; offset < packet.length; offset++) yield packet.subarray(offset, offset + 1); })(), cancel: () => undefined
  } }) });
  const response = await fetch(owner.url); assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "text/event-stream; charset=utf-8");
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), packet);
  assert.throws(() => compileApiOperation({ contract: contract({ responses: { "200": { mediaType: "application/octet-stream", stream: {
    framing: "bytes", maxFrameBytes: 64, completion: "EOF.", cancellation: "Join producer."
  } } } }), handler: () => ({ status: 200 }) }), /Raw SSE byte streams/);
});

test("raw SSE disconnect and retirement wait for the original producer cleanup", async t => {
  const stop = deferred(), cleanupStarted = deferred(), cleanupRelease = deferred(), cleaned = deferred();
  t.after(() => { stop.resolve(); cleanupRelease.resolve(); });
  const owner = await serve(t, { contract: contract({ responses: { "200": { mediaType: "text/event-stream", stream: {
    framing: "bytes", maxFrameBytes: 64, completion: "Native EOF or disconnect.", cancellation: "Join original cleanup."
  } } } }), handler: () => ({ status: 200, stream: {
    frames: (async function* () { try { yield Buffer.from(": ready\n\n"); await stop.promise; }
      finally { cleanupStarted.resolve(); await cleanupRelease.promise; cleaned.resolve(); } })(),
    cancel: () => { stop.resolve(); return cleaned.promise; }
  } }) });
  const response = await fetch(owner.url), reader = response.body!.getReader(); await reader.read(); await reader.cancel();
  await cleanupStarted.promise;
  let retired = false; const retiring = owner.registration.dispose().then(() => { retired = true; });
  await new Promise(resolve => setImmediate(resolve)); assert.equal(retired, false);
  cleanupRelease.resolve(); await retiring; assert.equal(retired, true);
});

test("invalid first frames return the declared failure and discard original binary headers after cancelling the owner", async t => {
  let cancelled = 0; let cleaned = false;
  const owner = await serve(t, { contract: contract(), handler: () => ({ status: 200, headers: { "content-length": "99", "content-encoding": "gzip" }, stream: {
    frames: (async function* () { try { yield { event: "changed", data: { revision: "invalid" } }; } finally { cleaned = true; } })(), cancel: () => { cancelled++; }
  } }) });
  const response = await fetch(owner.url); assert.equal(response.status, 500);
  assert.notEqual(response.headers.get("content-length"), "99"); assert.equal(response.headers.get("content-encoding"), null);
  assert.equal((await response.json()).errorCode, "API_STREAM_FRAME_SCHEMA_INVALID");
  assert.equal(cleaned, true); assert.equal(cancelled, 1);
});

test("byte streams retain exact bytes even when an owner reuses its read buffer", async t => {
  let cleaned = false;
  const binary = contract({ transport: "http", responses: { "200": { mediaType: "application/octet-stream", stream: {
    framing: "bytes", maxFrameBytes: 4, maxBytes: 12, completion: "EOF.", cancellation: "Stop producer and complete cleanup."
  } } } });
  const owner = await serve(t, { contract: binary, handler: () => ({ status: 200, headers: { "content-length": "12" }, stream: {
    frames: (async function* () { const buffer = Buffer.alloc(4); try { for (const value of [65, 66, 67]) { buffer.fill(value); yield buffer; } } finally { cleaned = true; } })(), cancel: () => undefined
  } }) });
  const response = await fetch(owner.url); assert.equal(response.status, 200); assert.equal(await response.text(), "AAAABBBBCCCC"); assert.equal(cleaned, true);
});

test("finite owner bytes preserve arbitrary valid media types and native error statuses", async t => {
  const bytes = Buffer.from([0, 255, 10]);
  const binary = contract({ transport: "http", responses: { default: { mediaType: "*/*", binary: { maxBytes: 16 } } } });
  for (const [status, mediaType] of [[200, "audio/x-fixture; codec=custom"], [422, "application/problem+json"]] as const) {
    const owner = await serve(t, { contract: binary, handler: () => ({ status, headers: { "content-type": mediaType }, body: bytes }) });
    const response = await fetch(owner.url); assert.equal(response.status, status);
    assert.equal(response.headers.get("content-type"), mediaType); assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes);
  }
  for (const mediaType of [undefined, "not-a-media-type", "audio/*", "audio/wav\r\nx-fixture: injected"]) {
    const owner = await serve(t, { contract: binary, handler: () => ({ status: 200, ...(mediaType === undefined ? {} : { headers: { "content-type": mediaType } }), body: bytes }) });
    const response = await fetch(owner.url); assert.equal(response.status, 500); assert.equal(response.headers.get("x-fixture"), null);
  }
  const overLimit = await serve(t, { contract: binary, handler: () => ({ status: 200, headers: { "content-type": "audio/x-fixture" }, body: Buffer.alloc(17) }) });
  assert.equal((await fetch(overLimit.url)).status, 500);
  assert.throws(() => compileApiOperation({ contract: contract({ transport: "http", responses: { "200": { mediaType: "*/*", schema: true } } }), handler: () => ({ status: 200 }) }), /finite binary contract/);
});

test("backpressure stops pulling and cancellation consumes a yielding finally before releasing the lease", async () => {
  const operation = compileApiOperation({ contract: contract(), handler: () => ({ status: 200 }) });
  const descriptor = operation.contract.responses["200"]!;
  const response = Object.assign(new EventEmitter(), { destroyed: false, writableEnded: false, getHeader: () => undefined,
    write: (bytes: Uint8Array) => { emitted.push(Buffer.from(bytes)); return false; } });
  const emitted: Buffer[] = []; let pulled = 0; let cancelled = 0; let closing = false;
  const cleanupStarted = deferred(); const finishCleanup = deferred(); let cleanupDone = false;
  const source: ApiOperationStream = { frames: (async function* () {
    try { while (!closing) { pulled++; yield { event: "changed", data: { revision: pulled } }; } }
    finally { yield { cleanup: "first" }; cleanupStarted.resolve(); await finishCleanup.promise; yield { cleanup: "last" }; cleanupDone = true; }
  })(), cancel: () => { cancelled++; closing = true; } };
  const controller = new AbortController();
  const writing = writeApiOperationStream(operation, descriptor, source, response as unknown as http.ServerResponse,
    { signal: controller.signal, assertAuthority: () => undefined });
  // Observe rejection immediately while the deliberately pending cleanup runs.
  const result = writing.then(() => ({ failed: false }), () => ({ failed: true }));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(pulled, 1); assert.equal(emitted.length, 1);
  controller.abort(new Error("fixture disconnected")); await cleanupStarted.promise;
  let settled = false; void result.then(() => { settled = true; });
  await new Promise(resolve => setImmediate(resolve)); assert.equal(settled, false); assert.equal(cleanupDone, false);
  finishCleanup.resolve(); assert.equal((await result).failed, true);
  assert.equal(cleanupDone, true); assert.equal(cancelled, 1); assert.equal(pulled, 1); assert.equal(emitted.length, 1);
  assert.equal(response.listenerCount("drain"), 0); assert.equal(response.listenerCount("close"), 0);
});

test("retiring a live SSE registration closes clients and waits for pending-next cleanup", async t => {
  let closing = false; let cancelled = 0; let cleaned = false;
  const stop = deferred(); const cleanupStarted = deferred(); const finish = deferred();
  t.after(() => { stop.resolve(); finish.resolve(); });
  const owner = await serve(t, { contract: contract(), handler: () => ({ status: 200, stream: {
    frames: (async function* () { try { yield { event: "ready", data: { revision: 1 } }; await stop.promise; }
      finally { yield { cleanup: "first" }; cleanupStarted.resolve(); await finish.promise; yield { cleanup: "last" }; cleaned = true; } })(),
    cancel: () => { if (!closing) { closing = true; cancelled++; stop.resolve(); } }
  } }) });
  const response = await fetch(owner.url); const reader = response.body!.getReader(); assert.equal((await reader.read()).done, false);
  let disposed = false; const retiring = owner.registration.dispose().then(() => { disposed = true; });
  await cleanupStarted.promise; await new Promise(resolve => setImmediate(resolve));
  assert.equal(disposed, false); assert.equal(cleaned, false); assert.equal(owner.registration.activeOperationCount(), 1);
  finish.resolve(); await retiring; assert.equal(cleaned, true); assert.equal(cancelled, 1);
  assert.equal(owner.registration.activeOperationCount(), 0);
  await reader.cancel().catch(() => undefined);
  assert.equal((await fetch(owner.url)).status, 404);
});

test("invalid stream contracts and WebSocket declarations cannot publish an HTTP-only route", () => {
  const registry = new ManagerPluginRouteRegistry(); const before = registry.catalogSnapshot();
  const invalid = (value: ApiOperationContract) => registry.registerOperations("bad", [{ contract: value, handler: () => ({ status: 200 }) }]);
  assert.throws(() => invalid(contract({ transport: "http" })), /SSE response framing/);
  assert.throws(() => invalid(contract({ method: "HEAD" })), /HEAD operations/);
  assert.throws(() => invalid(contract({ responses: { "204": contract().responses["200"]! } })), /Bodyless HTTP statuses/);
  assert.throws(() => invalid(fixtureApiContract({ transport: "websocket" })), /Invalid WebSocket upgrade contract/);
  assert.throws(() => invalid(fixtureApiContract({ method: "GET", transport: "websocket", request: { ...fixtureApiContract().request, body: { kind: "none" } },
    responses: { "101": { mediaType: "application/octet-stream", schema: false } }, websocket: { protocol: "fixture", framing: "json", maxMessageBytes: 1024, maxBufferedBytes: 2048,
      incomingSchema: true, outgoingSchema: true, authentication: "Native owner", completion: "Socket closed", cancellation: "Owner cleanup" } })), /upgrade transport binding/);
  assert.equal(registry.catalogSnapshot(), before);
});

test("frame and total byte limits reject before emitting excess bytes and still stop the owner", async () => {
  for (const limits of [{ maxFrameBytes: 3, maxBytes: 100, expected: 0, code: "API_STREAM_FRAME_TOO_LARGE" },
    { maxFrameBytes: 4, maxBytes: 6, expected: 4, code: "API_STREAM_TOO_LARGE" }]) {
    const value = contract({ transport: "http", responses: { "200": { mediaType: "application/octet-stream", stream: {
      framing: "bytes", maxFrameBytes: limits.maxFrameBytes, maxBytes: limits.maxBytes, completion: "EOF.", cancellation: "Stop and finish cleanup."
    } } } });
    const operation = compileApiOperation({ contract: value, handler: () => ({ status: 200 }) });
    let emitted = 0; let stopped = false; let cleaned = false;
    const response = { destroyed: false, writableEnded: false, getHeader: () => undefined,
      write: (bytes: Uint8Array) => { emitted += bytes.byteLength; return true; } } as unknown as http.ServerResponse;
    const source = { frames: (async function* () { try { while (!stopped) yield Buffer.alloc(4); } finally { cleaned = true; } })(), cancel: () => { stopped = true; } };
    await assert.rejects(writeApiOperationStream(operation, operation.contract.responses["200"]!, source, response,
      { signal: new AbortController().signal, assertAuthority: () => undefined }), { code: limits.code });
    assert.equal(emitted, limits.expected); assert.equal(cleaned, true); assert.equal(stopped, true);
  }
});
