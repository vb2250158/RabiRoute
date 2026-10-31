import assert from "node:assert/strict";
import http from "node:http";
import { EventEmitter, once } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createPeerProxyHttpOperations } from "./apiProxyHttpOperations.js";
import { createPeerProxyUpgradeOperation } from "./apiProxyUpgradeOperation.js";
import { PeerTunnelRuntime } from "./runtime.js";
import { establishTunnel } from "./session.js";
import { loadTunnelIdentity } from "./security.js";
import { serveTunnel, PEER_PROXY_CONTRACT_HEADER, PEER_PROXY_TARGET_HEADERS } from "./http.js";
import type { TunnelChannel } from "./channel.js";
import { ManagerPluginRouteRegistry } from "../manager/managerPluginRouteRegistry.js";
import { createApiDiscoveryOperations } from "../manager/apiDiscoveryRoutes.js";
import { apiCatalogOpenApi } from "../manager/apiOperationCatalog.js";
import { LanAgentAuthority } from "../manager/lanAgentAuthority.js";
import { evaluateLanAgentRequest, assertTrustedLanAgentPrincipal } from "../manager/lanAgentRequestAccess.js";
import { hasAuthenticatedConnectionRequest, markAuthenticatedConnectionRequest } from "../manager/connectionRequestAccess.js";
import { createManagerClient } from "../../apps/rabi-agent/lib/manager-client.mjs";

const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { promise, resolve }; };
async function fixture(t: test.TestContext) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "peer-api-http-"));
  const a = loadTunnelIdentity(path.join(root, "a.json"), "a", "generation");
  const b = loadTunnelIdentity(path.join(root, "b.json"), "b", "generation");
  const ac = new EventEmitter() as TunnelChannel, bc = new EventEmitter() as TunnelChannel;
  let ended = false;
  ac.send = async bytes => { setImmediate(() => { if (!ended) bc.emit("data", bytes); }); };
  bc.send = async bytes => { setImmediate(() => { if (!ended) ac.emit("data", bytes); }); };
  ac.close = bc.close = () => { if (!ended) { ended = true; ac.emit("close"); bc.emit("close"); } };
  const [caller, receiver] = await Promise.all([
    establishTunnel(ac, a, { deviceId: b.deviceId, publicKey: b.publicKey, services: [] }, true, AbortSignal.timeout(3000)),
    establishTunnel(bc, b, { deviceId: a.deviceId, publicKey: a.publicKey, services: [] }, false, AbortSignal.timeout(3000))
  ]);
  const seen: Array<{ url: string; method: string; headers: http.IncomingHttpHeaders }> = [];
  const sseClosed = deferred();
  const bytes = Buffer.alloc(256 * 1024, 137);
  const upstream = http.createServer((request, response) => {
    seen.push({ url: request.url!, method: request.method!, headers: request.headers });
    if (request.url?.startsWith("/events")) {
      response.writeHead(200, { "content-type": "text/event-stream" }); response.write("event: future\ndata: opaque\n\n");
      response.once("close", sseClosed.resolve); return;
    }
    response.setHeader("content-type", "application/x-future-binary"); response.setHeader("x-future-repeated", ["one", "two"]);
    response.setHeader("x-rabiroute-api-contract", "original-target-response");
    if (["GET", "HEAD", "OPTIONS"].includes(request.method!)) response.end(bytes);
    else { response.statusCode = 201; request.pipe(response); }
  });
  upstream.listen(0, "127.0.0.1"); await once(upstream, "listening");
  serveTunnel(receiver, () => ({ manager: { baseUrl: `http://127.0.0.1:${(upstream.address() as import("node:net").AddressInfo).port}` } }), () => true);
  const authority = new LanAgentAuthority({ statePath: path.join(root, "authority.json") });
  const credential = authority.enroll(authority.issueBootstrapTicket().ticket, "fixture-http-node");
  const admit = (request: http.IncomingMessage) => {
    if (evaluateLanAgentRequest(request, authority, true).kind !== "agent") return false;
    assertTrustedLanAgentPrincipal(request); markAuthenticatedConnectionRequest(request, () => { assertTrustedLanAgentPrincipal(request); }); return true;
  };
  const runtime = new PeerTunnelRuntime({ dataDir: path.join(root, "runtime"), deviceId: "source", generation: "generation",
    allowApplicationConnection: () => true, allowControl: request => hasAuthenticatedConnectionRequest(request),
    discover: async () => [], signal: async () => { throw new Error("Controlled discovery fixture."); },
    relay: () => ({ url: "http://127.0.0.1", token: "fixture" }), services: () => ({}), onStatus: () => {} });
  let acquisitions = 0, gate: Promise<void> | undefined;
  const acquiring = deferred(); runtime.session = async () => { acquisitions++; acquiring.resolve(); if (gate) await gate; return caller; };
  const api = new ManagerPluginRouteRegistry(undefined, { identity: () => ({ applicationGenerationId: "generation", managerInstanceId: "manager", pluginGenerationId: "plugins" }) });
  const definitions = createPeerProxyHttpOperations(runtime);
  const registration = api.registerHttpProxies("peer", definitions);
  const discovery = api.registerOperations("discovery", createApiDiscoveryOperations(api));
  const upgrade = api.registerUpgrades("peer-ws", [createPeerProxyUpgradeOperation(runtime, admit)]);
  const front = http.createServer((request, response) => {
    if (!admit(request)) { response.writeHead(401).end(); return; }
    if (request.url === "/meta") { response.setHeader("content-type", "application/json"); response.end(JSON.stringify({ applicationGenerationId: "generation", managerInstanceId: "manager", health: { live: true, requiredReady: true, state: "healthy" } })); return; }
    if (!api.handle(request, new URL(request.url!, "http://fixture.invalid"), response)) response.writeHead(404).end();
  });
  t.after(async () => {
    await registration.dispose(); await discovery.dispose(); await upgrade.dispose(); const ownerResults = await Promise.allSettled([runtime.stop(), caller.close(), receiver.close()]);
    front.closeAllConnections(); upstream.closeAllConnections();
    await Promise.all([new Promise<void>(r => front.close(() => r())), new Promise<void>(r => upstream.close(() => r()))]);
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir())); await fs.rm(root, { recursive: true, force: true });
    for (const result of ownerResults) if (result.status === "rejected") throw result.reason;
  });
  front.listen(0, "127.0.0.1"); await once(front, "listening");
  const base = `http://127.0.0.1:${(front.address() as import("node:net").AddressInfo).port}`;
  return { api, definitions, registration, base, client: createManagerClient({ managerUrl: base, credential: credential.token }), credential, authority,
    seen, bytes, caller, receiver, acquiring, sseClosed, acquisitions: () => acquisitions, gate: (value: Promise<void>) => { gate = value; } };
}

test("all seven HTTP contracts preserve opaque bytes, raw paths, target conditions and repeated headers through native encryption", { timeout: 15000 }, async t => {
  const f = await fixture(t);
  assert.deepEqual(f.definitions.map(value => value.contract.method), ["GET", "HEAD", "OPTIONS", "POST", "PUT", "PATCH", "DELETE", "*"]);
  for (const method of ["GET", "HEAD", "OPTIONS", "POST", "PUT", "PATCH", "DELETE"]) {
    const result = await f.client.invokeOperation(`manager.rabilink.peer.http.${method.toLowerCase()}`, {
      path: { deviceId: "b", service: "manager", path: method === "GET" ? "" : "future//%E6%B1%89" }, query: { tag: ["one", "two"] }, responseMode: "bytes",
      ...(["POST", "PUT", "PATCH", "DELETE"].includes(method) ? { bodyBytes: f.bytes } : {}),
      headers: { "x-rabiroute-api-contract": "original-target-contract", "if-match": '"original"', "idempotency-key": "original-key",
        [PEER_PROXY_TARGET_HEADERS]: JSON.stringify({ "x-rabiroute-expected-manager-instance-id": "target-instance", "x-future-header": "preserved" }) }
    });
    assert.equal(result.statusCode, ["GET", "HEAD", "OPTIONS"].includes(method) ? 200 : 201, method);
    assert.deepEqual(result.bodyBytes, method === "HEAD" ? Buffer.alloc(0) : f.bytes);
    const received = f.seen.at(-1)!; assert.equal(received.method, method);
    assert.equal(received.url, (method === "GET" ? "/" : "/future//%E6%B1%89") + "?tag=one&tag=two");
    assert.equal(received.headers["x-rabiroute-api-contract"], "original-target-contract");
    assert.equal(received.headers["x-rabiroute-expected-manager-instance-id"], "target-instance");
    assert.equal(received.headers[PEER_PROXY_CONTRACT_HEADER], undefined); assert.equal(received.headers.authorization, undefined);
    assert.equal(received.headers["idempotency-key"], "original-key"); assert.equal(received.headers["x-future-header"], "preserved");
    assert.equal(result.headers?.["x-rabiroute-api-contract"], "original-target-response");
    assert.equal(result.headers?.["x-future-repeated"], "one, two");
  }
  assert.equal(f.registration.activeOperationCount(), 0); assert.equal(f.caller.closed, false);
});

test("wildcard PROPFIND preserves the signed native request, raw path, repeated query and target contract", { timeout: 15000 }, async t => {
  const f = await fixture(t), original = Buffer.from([0, 255, 137, 10, 13, 60, 62]);
  const result = await f.client.invokeOperation("manager.rabilink.peer.http.fallback", {
    method: "PROPFIND", path: { deviceId: "b", service: "manager", path: "future//%E6%B1%89/raw" },
    query: { tag: ["one", "two"], empty: "" }, bodyBytes: original, responseMode: "bytes",
    headers: { "x-rabiroute-api-contract": "original-propfind-contract", "if-match": '"original-property-revision"', "idempotency-key": "original-property-key",
      [PEER_PROXY_TARGET_HEADERS]: JSON.stringify({ "depth": "1", "x-rabiroute-expected-manager-instance-id": "target-instance" }) }
  });
  assert.equal(result.statusCode, 201); assert.deepEqual(result.bodyBytes, original);
  assert.deepEqual(f.seen.map(value => [value.method, value.url]), [["PROPFIND", "/future//%E6%B1%89/raw?tag=one&tag=two&empty="]]);
  const headers = f.seen[0]!.headers;
  assert.equal(headers["x-rabiroute-api-contract"], "original-propfind-contract"); assert.equal(headers["if-match"], '"original-property-revision"');
  assert.equal(headers["idempotency-key"], "original-property-key"); assert.equal(headers.depth, "1"); assert.equal(headers["x-rabiroute-expected-manager-instance-id"], "target-instance");
  assert.equal(headers[PEER_PROXY_CONTRACT_HEADER], undefined); assert.equal(headers.authorization, undefined);
  assert.equal(result.headers?.["x-rabiroute-api-contract"], "original-target-response"); assert.equal(f.registration.activeOperationCount(), 0);
  assert.equal(f.caller.streams.size, 0); assert.equal(f.caller.closed, false);
});

test("wildcard registration retains the native tunnel CONNECT and TRACE rejection", { timeout: 10000 }, async t => {
  const f = await fixture(t);
  for (const method of ["CONNECT", "TRACE"]) {
    const stream = f.caller.open({ service: "manager", path: "/native-denied", method, headers: {} });
    stream.end(); assert.equal((await stream.response).status, 403);
    const chunks: Buffer[] = []; for await (const chunk of stream) chunks.push(Buffer.from(chunk));
    assert.equal(Buffer.concat(chunks).toString(), "Target service unavailable or access denied.");
  }
  assert.equal(f.seen.length, 0); assert.equal(f.caller.closed, false); assert.ok(Number.isFinite(await f.caller.ping()));
});

for (const action of ["disconnect", "retirement"] as const) {
  test(`wildcard PROPFIND ${action} joins its native stream without closing the shared peer`, { timeout: 10000 }, async t => {
    const f = await fixture(t), first = deferred(), controller = new AbortController(); let observed = "";
    const pending = f.client.invokeOperation("manager.rabilink.peer.http.fallback", { method: "PROPFIND", path: { deviceId: "b", service: "manager", path: "events" },
      bodyBytes: Buffer.from("original-propfind-body"), signal: controller.signal, responseMode: "stream", onChunk: bytes => { observed += Buffer.from(bytes).toString(); first.resolve(); } }).catch(() => undefined);
    await first.promise; assert.equal(observed, "event: future\ndata: opaque\n\n"); assert.equal(f.seen[0]!.method, "PROPFIND");
    if (action === "disconnect") controller.abort();
    else await f.registration.dispose();
    await pending; await f.sseClosed.promise;
    await f.registration.dispose(); assert.equal(f.registration.activeOperationCount(), 0);
    assert.equal(f.caller.streams.size, 0); assert.equal(f.caller.closed, false); assert.ok(Number.isFinite(await f.caller.ping()));
  });
}

test("passthrough discovery describes native bounds without whole-body limits or a fabricated application schema", async t => {
  const f = await fixture(t), contract = f.definitions[0]!.contract;
  assert.throws(() => f.api.registerOperations("wrong-binding", [{ contract, handler: () => ({ status: 200 }) }]), /native transport binding/);
  const spec = (await apiCatalogOpenApi(f.api.catalogSnapshot())) as any;
  const entry = spec.paths["/api/rabilink/peer/http/{deviceId}/{service}/{path}"].get;
  assert.equal(entry["x-rabiroute-http-proxy"].wire.dataFrameBytes, 12000);
  assert.equal(entry["x-rabiroute-request"].body.kind, "passthrough"); assert.equal(entry["x-rabiroute-request"].body.maxBytes, undefined);
  assert.equal(entry.responses.default.content["*/*"].schema, undefined);
  assert.equal(entry["x-rabiroute-upgrades"][0].operationId, "manager.rabilink.peer.websocket.proxy");
  const response = await f.client.request("GET", "/api/rabilink/peer/http/b/manager/", { headers: { [PEER_PROXY_CONTRACT_HEADER]: "stale" } });
  assert.equal(response.statusCode, 409); assert.equal(f.acquisitions(), 0);
});

test("SSE remains an opaque live stream and retirement joins the native stream without closing the shared session", { timeout: 10000 }, async t => {
  const f = await fixture(t), first = deferred(); let observed = "";
  const request = f.client.invokeOperation("manager.rabilink.peer.http.get", { path: { deviceId: "b", service: "manager", path: "events" },
    responseMode: "stream", onChunk: bytes => { observed += Buffer.from(bytes).toString(); first.resolve(); } }).catch(() => undefined);
  await first.promise; assert.equal(observed, "event: future\ndata: opaque\n\n");
  await f.registration.dispose(); await request; await f.sseClosed.promise;
  assert.equal(f.registration.activeOperationCount(), 0); assert.equal(f.caller.streams.size, 0); assert.equal(f.caller.closed, false);
  assert.ok(Number.isFinite(await f.caller.ping()));
});

test("retirement waits for target acquisition and never dispatches an already cancelled HTTP operation", { timeout: 10000 }, async t => {
  const f = await fixture(t), release = deferred(); t.after(release.resolve); f.gate(release.promise);
  const request = f.client.invokeOperation("manager.rabilink.peer.http.put", { path: { deviceId: "b", service: "manager", path: "future" }, bodyBytes: f.bytes, responseMode: "bytes" }).catch(() => undefined);
  await f.acquiring.promise; let done = false; const disposing = f.registration.dispose().then(() => { done = true; });
  try { await new Promise<void>(r => setImmediate(r)); assert.equal(done, false); assert.equal(f.registration.activeOperationCount(), 1); }
  finally { release.resolve(); }
  await disposing; await request; assert.equal(f.seen.length, 0); assert.equal(f.caller.streams.size, 0);
});

test("queued upload revocation dispatches no data and retains its lease until the accepted write settles", { timeout: 10000 }, async t => {
  const f = await fixture(t), waiting = deferred(), release = deferred(); t.after(release.resolve);
  const send = f.caller.send.bind(f.caller); let dispatched = 0, held = false;
  f.caller.send = async (frame, authorize) => {
    if (frame.type === "data") {
      if (!held) { held = true; waiting.resolve(); await release.promise; }
      authorize?.(); dispatched++;
    }
    return send(frame, authorize);
  };
  const request = f.client.invokeOperation("manager.rabilink.peer.http.put", { path: { deviceId: "b", service: "manager", path: "write" }, bodyBytes: f.bytes, responseMode: "bytes" }).catch(() => undefined);
  await waiting.promise;
  f.authority.setNodeEnabled(f.credential.nodeId, false, true); f.authority.setNodeEnabled(f.credential.nodeId, true, false);
  let disposed = false; const disposal = f.registration.dispose().then(() => { disposed = true; });
  try { await new Promise<void>(r => setImmediate(r)); assert.equal(disposed, false); assert.equal(f.registration.activeOperationCount(), 1); }
  finally { release.resolve(); }
  await disposal; await request;
  assert.equal(dispatched, 0); assert.equal(f.caller.closed, false); assert.ok(Number.isFinite(await f.caller.ping()));
});
