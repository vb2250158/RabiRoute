import assert from "node:assert/strict";
import test from "node:test";
import http from "node:http";
import { once } from "node:events";
import { ManagerPluginRouteRegistry } from "./managerPluginRouteRegistry.js";
import { ManagerPluginRequestTracker } from "./managerPluginRequestTracker.js";
import { fixtureApiContract } from "./apiOperationContractFixtures.js";
import type { ApiHttpProxyDefinition, ApiHttpProxyInput, ApiOperationContract } from "./apiOperationContract.js";
import type { NativeHttpRequestFactory } from "./apiExternalListenerHttpProxy.js";

async function fixture(t: test.TestContext, handler: (input: ApiHttpProxyInput) => Promise<void>, nativeHttpRequestFactory?: NativeHttpRequestFactory,
  options: { contract?: Partial<ApiOperationContract>; identity?(): { applicationGenerationId: string; managerInstanceId: string; pluginGenerationId: string } } = {}) {
  const gateway = new ManagerPluginRouteRegistry(), manager = new ManagerPluginRouteRegistry(undefined, { identity: options.identity ?? (() => ({ applicationGenerationId: "fixture", managerInstanceId: "fixture", pluginGenerationId: "fixture" })), nativeHttpRequestFactory });
  let lease!: ReturnType<typeof gateway.registerExternalListener>;
  const native = http.createServer((request, response) => lease.handle(request, new URL(request.url!, "http://native"), response));
  native.listen(0, "127.0.0.1"); await once(native, "listening");
  lease = gateway.registerExternalListener("native-owner", { listenerId: "fixture.native.responses", address: { protocol: "http", hostname: "127.0.0.1", port: (native.address() as { port: number }).port },
    protocol: "native-http", invocation: "native", authentication: { kind: "none", description: "Original owner." } });
  const contract: ApiHttpProxyDefinition["contract"] = fixtureApiContract({ operationId: "fixture.native.responses", method: "*", pathTemplate: "/native",
    request: { path: true, query: true, headers: true, body: { kind: "passthrough" } },
    httpProxy: { wire: { dataFrameBytes: 1024, streamWindowBytes: 4096, maxConcurrentStreams: 2 }, completion: "Native EOF.", cancellation: "Close native exchange." },
    responses: { default: { mediaType: "*/*", passthrough: true } }, ...options.contract });
  lease.registerHttpProxies([{ contract, handler }]);
  const remove = manager.registerExternalListenerSource("original-native-process", { isCurrent: () => true, read: () => [lease.publication()] });
  const server = http.createServer((request, response) => {
    assert.equal(request.headers.authorization, "Bearer fixture-node");
    if (!manager.handle(request, new URL(request.url!, "http://manager"), response)) response.writeHead(404).end();
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  t.after(async () => { remove(); await lease.dispose(); server.closeAllConnections(); native.closeAllConnections(); await Promise.all([new Promise<void>(resolve => server.close(() => resolve())), new Promise<void>(resolve => native.close(() => resolve()))]); });
  const operation = manager.catalogSnapshot().operations[0]!, access = operation.access!;
  return { manager, origin: `http://127.0.0.1:${(server.address() as { port: number }).port}`, target: access.pathPrefix + "/native", access, operation };
}

test("native proxy retirement preserves an undefined cleanup rejection after actual drain", async t => {
  const sample = await fixture(t, async input => { input.request.resume(); input.prepareResponse(200, {}); input.response.end("native-ready"); });
  assert.equal((await request(sample.origin, sample.target, "GET", {}).result).body, "native-ready");
  const stop = ManagerPluginRequestTracker.prototype.stop;
  let calls = 0;
  ManagerPluginRequestTracker.prototype.stop = async function () { await stop.call(this); calls++; throw undefined; };
  try {
    const retirement = sample.manager.disposeNativeListenerHttp();
    await assert.rejects(retirement, error => error instanceof AggregateError && error.errors.length === 1 && error.errors[0] === undefined);
    assert.equal(sample.manager.disposeNativeListenerHttp(), retirement);
    await assert.rejects(sample.manager.drainRetiredNativeListenerHttp(), error => error instanceof AggregateError && error.errors[0] === undefined);
    assert.equal(calls, 1);
  } finally { ManagerPluginRequestTracker.prototype.stop = stop; }
});
function request(origin: string, target: string, method: string, headers: http.OutgoingHttpHeaders, incomplete = false) {
  let request!: http.ClientRequest;
  const result = new Promise<{ status: number; headers: http.IncomingHttpHeaders; rawHeaders: string[]; body: string }>((resolve, reject) => {
    request = http.request(origin + target, { method, headers: { authorization: "Bearer fixture-node", ...headers } }, response => {
      const chunks: Buffer[] = []; response.on("data", chunk => chunks.push(Buffer.from(chunk))); response.once("error", reject);
      response.once("end", () => resolve({ status: response.statusCode!, headers: response.headers, rawHeaders: response.rawHeaders, body: Buffer.concat(chunks).toString() }));
    }); request.once("error", reject);
    if (incomplete) request.write("ignored-body-still-open"); else request.end();
  });
  return { result, close: () => request.destroy() };
}

test("native early GET response is delivered while ignored upload is still unfinished", { timeout: 4000 }, async t => {
  const sample = await fixture(t, async input => {
    input.request.resume(); input.prepareResponse(200, { "content-type": "text/plain" }); input.response.writeHead(200, { "content-type": "text/plain" }).end("native-ready");
  });
  const pending = request(sample.origin, sample.target + "?unknown=kept", "GET", { "transfer-encoding": "chunked", [sample.access.contractHeader]: sample.access.contractDigest }, true);
  t.after(pending.close);
  const response = await pending.result; assert.equal(response.status, 200); assert.equal(response.body, "native-ready");
  pending.close();
});

test("a raw native remainder cannot select an unregistered network authority", async t => {
  let nativeCalls = 0, otherCalls = 0;
  const other = http.createServer((_request, response) => { otherCalls++; response.end("wrong-owner"); });
  other.listen(0, "127.0.0.1"); await once(other, "listening"); t.after(() => { other.closeAllConnections(); other.close(); });
  const sample = await fixture(t, async input => { nativeCalls++; input.prepareResponse(200, {}); input.response.end("native"); }, undefined, {
    contract: { pathTemplate: "/:resource", request: { pathRemainder: "resource", path: true, query: true, headers: true, body: { kind: "passthrough" } } }
  });
  const result = await request(sample.origin, sample.access.pathPrefix + `//127.0.0.1:${(other.address() as { port: number }).port}/escaped`, "GET", { [sample.access.contractHeader]: sample.access.contractDigest }).result;
  assert.equal(result.status, 400); assert.equal(nativeCalls, 0); assert.equal(otherCalls, 0);
});

test("Manager double-identity replacement fences a native response before its old body is disclosed", async t => {
  let managerIdentity = { applicationGenerationId: "first", managerInstanceId: "first", pluginGenerationId: "plugins" };
  let enter!: () => void, release!: () => void; const entered = new Promise<void>(resolve => { enter = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
  const sample = await fixture(t, async input => {
    input.request.resume(); enter(); await gate; input.prepareResponse(200, {}); input.response.end("old-native-body");
  }, undefined, { identity: () => managerIdentity });
  t.after(release);
  const pending = request(sample.origin, sample.target, "GET", { [sample.access.contractHeader]: sample.access.contractDigest }).result;
  const denied = assert.rejects(pending); await entered;
  managerIdentity = { applicationGenerationId: "second", managerInstanceId: "second", pluginGenerationId: "plugins" }; release(); await denied;
  const next = await request(sample.origin, sample.target, "GET", { [sample.access.contractHeader]: sample.access.contractDigest }).result;
  assert.equal(next.status, 200, "A later admission captures the new identity instead of permanently fencing a reused proxy entry.");
});

test("Manager retirement retains one pending disposal until the real native upstream closes", { timeout: 5000 }, async t => {
  let release!: () => void, destroyRequested!: () => void, upstreamClosed = false;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const stopping = new Promise<void>(resolve => { destroyRequested = resolve; });
  const sample = await fixture(t, async input => {
    input.request.resume(); input.prepareResponse(200, {}); input.response.writeHead(200); input.response.write("native-start");
    if (!input.signal.aborted) await new Promise<void>(resolve => input.signal.addEventListener("abort", () => resolve(), { once: true }));
  }, (target, options) => {
    const nativeRequest = http.request(target, options), originalDestroy = nativeRequest.destroy.bind(nativeRequest);
    nativeRequest.once("close", () => { upstreamClosed = true; });
    // Hold the real ClientRequest/socket teardown, rather than substituting a fake closed Promise.
    nativeRequest.destroy = error => { destroyRequested(); void gate.then(() => originalDestroy(error)); return nativeRequest; };
    return nativeRequest;
  });
  let bodyStarted!: () => void; const started = new Promise<void>(resolve => { bodyStarted = resolve; });
  const incoming = http.request(sample.origin + sample.target, { headers: { authorization: "Bearer fixture-node", [sample.access.contractHeader]: sample.access.contractDigest } }, response => {
    response.on("data", bodyStarted); response.on("error", () => {});
  }); incoming.on("error", () => {}); incoming.end(); t.after(() => { release(); incoming.destroy(); });
  await started; const first = sample.manager.disposeNativeListenerHttp(); assert.equal(sample.manager.disposeNativeListenerHttp(), first);
  await stopping; let finished = false; void first.then(() => { finished = true; });
  await new Promise(resolve => setImmediate(resolve)); assert.equal(finished, false); assert.equal(upstreamClosed, false);
  release(); await first; assert.equal(upstreamClosed, true); assert.equal(sample.manager.disposeNativeListenerHttp(), first);
  await sample.manager.drainRetiredNativeListenerHttp();
});

test("Manager native transport preserves HEAD, 404, repeated public headers, redirect scope and both contract preconditions", async t => {
  let calls = 0;
  const sample = await fixture(t, async input => {
    calls++; input.request.resume(); const value = input.url.searchParams.get("case");
    const status = value === "missing" ? 404 : value?.startsWith("redirect") ? 302 : 200;
    const headers: Record<string, string | string[]> = { "x-native-repeat": ["one", "two"] };
    if (input.request.method === "HEAD") headers["content-length"] = "17";
    if (value === "redirect-same") headers.location = "/native?case=target";
    if (value === "redirect-other") headers.location = "https://example.invalid/landing";
    input.prepareResponse(status, headers); input.response.writeHead(status, headers).end(input.request.method === "HEAD" ? undefined : value === "missing" ? "original-missing" : "original-body");
  });
  const headers = { [sample.access.contractHeader]: sample.access.contractDigest, "x-rabiroute-api-contract": sample.operation.contractDigest };
  const missing = await request(sample.origin, sample.target + "?case=missing", "GET", headers).result;
  assert.equal(missing.status, 404); assert.equal(missing.body, "original-missing"); assert.equal(missing.rawHeaders.filter(value => value.toLowerCase() === "x-native-repeat").length, 2);
  const head = await request(sample.origin, sample.target, "HEAD", headers).result; assert.equal(head.headers["content-length"], "17"); assert.equal(head.body, "");
  const same = await request(sample.origin, sample.target + "?case=redirect-same", "GET", headers).result;
  assert.equal(same.status, 302); assert.equal(same.headers.location, sample.target + "?case=target");
  const other = await request(sample.origin, sample.target + "?case=redirect-other", "GET", headers).result;
  assert.equal(other.status, 302); assert.equal(other.headers.location, "https://example.invalid/landing");
  const count = calls;
  assert.equal((await request(sample.origin, sample.target, "GET", { ...headers, [sample.access.contractHeader]: sample.operation.contractDigest }).result).status, 409);
  assert.equal((await request(sample.origin, sample.target, "GET", { ...headers, "x-rabiroute-api-contract": "sha256:old" }).result).status, 409); assert.equal(calls, count);
});
