import assert from "node:assert/strict";
import http from "node:http";
import { EventEmitter, once } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { WebSocket, WebSocketServer } from "ws";
import { createPeerProxyUpgradeOperation } from "./apiProxyUpgradeOperation.js";
import { PeerTunnelRuntime } from "./runtime.js";
import { serveTunnel, peerProxyRequestHeaders, PEER_PROXY_CONTRACT_HEADER, PEER_PROXY_TARGET_HEADERS } from "./http.js";
import { establishTunnel, TUNNEL_STREAM_LIMITS } from "./session.js";
import { loadTunnelIdentity } from "./security.js";
import type { TunnelChannel } from "./channel.js";
import { ManagerPluginRouteRegistry } from "../manager/managerPluginRouteRegistry.js";
import { createApiDiscoveryOperations } from "../manager/apiDiscoveryRoutes.js";
import { apiCatalogOpenApi } from "../manager/apiOperationCatalog.js";
import { compileApiContract, type ApiOperationContract } from "../manager/apiOperationContract.js";
import { LanAgentAuthority } from "../manager/lanAgentAuthority.js";
import { evaluateLanAgentRequest, assertTrustedLanAgentPrincipal } from "../manager/lanAgentRequestAccess.js";
import { hasAuthenticatedConnectionRequest, markAuthenticatedConnectionRequest } from "../manager/connectionRequestAccess.js";
import { createManagerClient, type ManagerWebSocketOptions } from "../../apps/rabi-agent/lib/manager-client.mjs";
import { fillApiPathTemplate } from "../../apps/rabi-agent/lib/api-path-template.mjs";

const deferred = <T = void>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; };
async function fixture(t: test.TestContext, typedHttp = false) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "peer-api-upgrade-"));
  const a = loadTunnelIdentity(path.join(root, "a.json"), "a", "a-gen"), b = loadTunnelIdentity(path.join(root, "b.json"), "b", "b-gen");
  const ac = new EventEmitter() as TunnelChannel, bc = new EventEmitter() as TunnelChannel; let closed = false;
  ac.send = async data => { setImmediate(() => { if (!closed) bc.emit("data", data); }); };
  bc.send = async data => { setImmediate(() => { if (!closed) ac.emit("data", data); }); };
  ac.close = bc.close = () => { if (!closed) { closed = true; ac.emit("close"); bc.emit("close"); } };
  const [caller, receiver] = await Promise.all([
    establishTunnel(ac, a, { deviceId: "b", publicKey: b.publicKey, services: [] }, true, AbortSignal.timeout(2000)),
    establishTunnel(bc, b, { deviceId: "a", publicKey: a.publicKey, services: [] }, false, AbortSignal.timeout(2000))
  ]);
  const wireSizes: number[] = [], send = caller.send.bind(caller), frameWaiting = deferred();
  const cipher = Reflect.get(caller, "cipher") as { encode(frame: any): Buffer; decode(bytes: Buffer): unknown };
  Reflect.set(caller, "cipher", { encode(frame: any) {
    if (frame.type === "data") wireSizes.push(Buffer.from(frame.data, "base64").length);
    return cipher.encode(frame);
  }, decode: (bytes: Buffer) => cipher.decode(bytes) });
  let frameGate: Promise<void> | undefined;
  caller.send = (frame, authorize) => {
    const dispatch = () => send(frame, authorize);
    if (frame.type === "data" && frameGate) { const pending = frameGate; frameGate = undefined; frameWaiting.resolve(); return pending.then(dispatch); }
    return dispatch();
  };
  const paths: string[] = [], targetHeaders: http.IncomingHttpHeaders[] = [], payloads: Buffer[] = [];
  const upstream = http.createServer((_request, response) => response.end("target HTTP"));
  const ws = new WebSocketServer({ noServer: true, perMessageDeflate: false });
  upstream.on("upgrade", (request, socket, head) => {
    paths.push(request.url!); targetHeaders.push(request.headers);
    ws.handleUpgrade(request, socket, head, connection => ws.emit("connection", connection, request));
  });
  ws.on("connection", socket => socket.on("message", (data, binary) => { payloads.push(Buffer.from(data as Buffer)); socket.send(data, { binary }); }));
  upstream.listen(0, "127.0.0.1"); await once(upstream, "listening");
  const target = `http://127.0.0.1:${(upstream.address() as import("node:net").AddressInfo).port}`;
  // Unified application admission exposes available services without a second
  // per-service grant, matching PeerTunnelRuntime's production serveTunnel call.
  serveTunnel(receiver, () => ({ manager: { baseUrl: target }, persona: { baseUrl: target } }), () => true);
  const authority = new LanAgentAuthority({ statePath: path.join(root, "authority.json") });
  const credential = authority.enroll(authority.issueBootstrapTicket().ticket, "fixture-peer-proxy-node");
  const admit = (request: http.IncomingMessage) => {
    if (evaluateLanAgentRequest(request, authority, true).kind !== "agent") return false;
    assertTrustedLanAgentPrincipal(request); markAuthenticatedConnectionRequest(request, () => { assertTrustedLanAgentPrincipal(request); }); return true;
  };
  let enabled = true, acquisitions = 0, gate: Promise<void> | undefined;
  const acquiring = deferred();
  const runtime = new PeerTunnelRuntime({ dataDir: path.join(root, "runtime"), deviceId: "source", generation: "source-generation",
    allowApplicationConnection: () => enabled, allowControl: request => hasAuthenticatedConnectionRequest(request),
    discover: async () => [], signal: async () => { throw new Error("Controlled target resolver only."); },
    relay: () => ({ url: "http://127.0.0.1", token: "fixture-application" }), services: () => ({}), onStatus: () => {} });
  // Only target discovery/pooling is controlled. Actual authority, encrypted
  // handshake, TunnelSession framing, HTTP forwarding and sockets remain native.
  runtime.session = async () => { acquisitions++; acquiring.resolve(); if (gate) await gate; return caller; };
  const api = new ManagerPluginRouteRegistry(undefined, { identity: () => ({ applicationGenerationId: "source-generation", managerInstanceId: "source-manager", pluginGenerationId: "plugins" }) });
  let handshakeFields: string[] = [];
  const definition = createPeerProxyUpgradeOperation({ openProxyUpgrade: input => runtime.openProxyUpgrade({ ...input,
    prepareHandshake: headers => { handshakeFields = Object.keys(headers); input.prepareHandshake(headers); }
  }) }, admit);
  const registration = api.registerUpgrades("peer", [definition]);
  const discovery = api.registerOperations("discovery", createApiDiscoveryOperations(api));
  let disposeHttp: () => void | Promise<void> = () => {};
  let server: http.Server | undefined;
  const channels: Array<{ close(): void; closed: Promise<unknown> }> = [];
  t.after(async () => {
    for (const channel of channels) channel.close(); await registration.dispose(); await discovery.dispose(); await disposeHttp();
    for (const channel of channels) await channel.closed;
    const ownerResults = await Promise.allSettled([runtime.stop(), caller.close(), receiver.close()]); for (const socket of ws.clients) socket.terminate();
    await new Promise<void>(resolve => ws.close(() => resolve())); server?.closeAllConnections(); upstream.closeAllConnections();
    await Promise.all([server ? new Promise<void>(resolve => server!.close(() => resolve())) : Promise.resolve(), new Promise<void>(resolve => upstream.close(() => resolve()))]);
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir())); await fs.rm(root, { recursive: true, force: true });
    for (const result of ownerResults) if (result.status === "rejected") throw result.reason;
  });
  if (typedHttp) {
    const { websocket: _websocket, ...httpContract } = definition.contract;
    const contract = { ...httpContract, operationId: "example.peer.http", transport: "http",
      responses: { "200": { mediaType: "text/plain", schema: { type: "string" } } } } as ApiOperationContract;
    const normal = api.registerOperations("http", [{ contract, handler: () => ({ status: 200, body: "typed ordinary HTTP" }) }]);
    disposeHttp = () => normal.dispose();
  } else disposeHttp = api.register("http", [{ routeId: "remaining-peer-http", match: { kind: "prefix", pathPrefix: "/api/rabilink/peer/http/", methods: ["GET"] },
    handler: (_request, _url, response) => { response.end("legacy ordinary HTTP"); return true; } }]);
  server = http.createServer((request, response) => {
    if (!admit(request)) { response.writeHead(401).end(); return; }
    if (request.url === "/meta") { response.setHeader("content-type", "application/json"); response.end(JSON.stringify({
      applicationGenerationId: "source-generation", managerInstanceId: "source-manager", health: { live: true, requiredReady: true, state: "healthy" }
    })); return; }
    if (!api.handle(request, new URL(request.url!, "http://fixture.invalid"), response)) response.writeHead(404).end();
  });
  server.on("upgrade", (request, socket, head) => { if (!api.handleUpgrade(request, new URL(request.url!, "http://fixture.invalid"), socket, head)) socket.destroy(); });
  server.listen(0, "127.0.0.1"); await once(server, "listening"); const base = `http://127.0.0.1:${(server.address() as import("node:net").AddressInfo).port}`;
  const client = createManagerClient({ managerUrl: base, credential: credential.token });
  return { api, registration, definition, client, base, authority, credential, caller, receiver, paths, targetHeaders, payloads, wireSizes, acquiring,
    acquisitions: () => acquisitions, gate: (value: Promise<void>) => { gate = value; }, enabled: (value: boolean) => { enabled = value; },
    frameWaiting, frameGate: (value: Promise<void>) => { frameGate = value; },
    open: async (options: ManagerWebSocketOptions) => {
      try {
        const channel = await client.openOperation(definition.contract.operationId, { path: { deviceId: "target", service: "manager", path: "" }, ...options }); channels.push(channel); return channel;
      } catch (error) {
        if (error instanceof Error) error.message += " Fixture phases: " + JSON.stringify({ acquisitions, paths, requestHeaderNames: targetHeaders.map(headers => Object.keys(headers)), handshakeFields });
        throw error;
      }
    } };
}

test("transparent upgrade preserves text, binary, raw URI suffix and target versions through real encrypted framing", { timeout: 15000 }, async t => {
  const f = await fixture(t), text = deferred<unknown>(), binary = deferred<unknown>();
  const channel = await f.open({ path: { deviceId: "target", service: "manager", path: "echo//%E6%B1%89" }, query: { tag: ["a", "b"] }, protocols: ["fixture.v1"],
    headers: { "x-rabiroute-api-contract": "target-contract", [PEER_PROXY_TARGET_HEADERS]: JSON.stringify({ "x-rabiroute-expected-manager-instance-id": "target-manager", "x-future-resource": "future" }) },
    onMessage: (value: unknown, metadata: { binary: boolean }) => { (metadata.binary ? binary : text).resolve(value); } });
  assert.equal(channel.protocol, "fixture.v1"); channel.send("opaque text\n"); assert.equal(await text.promise, "opaque text\n");
  const bytes = Buffer.alloc(256 * 1024, 173); channel.send(bytes); assert.deepEqual(await binary.promise, bytes);
  assert.equal(f.paths[0], "/echo//%E6%B1%89?tag=a&tag=b");
  const headers = f.targetHeaders[0]!;
  assert.equal(headers["x-rabiroute-api-contract"], "target-contract"); assert.equal(headers["x-rabiroute-expected-manager-instance-id"], "target-manager");
  assert.equal(headers[PEER_PROXY_CONTRACT_HEADER], undefined); assert.equal(headers[PEER_PROXY_TARGET_HEADERS], undefined); assert.equal(headers["x-future-resource"], "future");
  assert.equal(headers.authorization, undefined); assert.ok(f.wireSizes.length > 16); assert.ok(f.wireSizes.every(size => size <= TUNNEL_STREAM_LIMITS.dataFrameBytes));
  channel.close(); await channel.closed; await f.registration.dispose(); assert.equal(f.registration.activeOperationCount(), 0); assert.equal(f.caller.closed, false);
});

test("same-URL ordinary HTTP retains both legacy dispatch and executable HTTP/OpenAPI ownership", { timeout: 15000 }, async t => {
  for (const typed of [false, true]) {
    const f = await fixture(t, typed), value = await f.client.request("GET", "/api/rabilink/peer/http/target/manager/");
    assert.equal(value.statusCode, 200); assert.equal(value.body, typed ? "typed ordinary HTTP" : "legacy ordinary HTTP");
    const snapshot = f.api.catalogSnapshot(), spec = (await apiCatalogOpenApi(snapshot)) as any;
    const operation = spec.paths["/api/rabilink/peer/http/{deviceId}/{service}/{path}"].get;
    assert.equal(operation["x-rabiroute-path-remainder"], "path");
    if (typed) { assert.equal(operation.operationId, "example.peer.http"); assert.equal(operation["x-rabiroute-upgrades"][0].operationId, f.definition.contract.operationId); }
    else assert.equal(operation.operationId, f.definition.contract.operationId);
    assert.equal(snapshot.coverage.globalCoverage, "not-proven"); assert.equal(snapshot.coverage.complete, typed);
    const channel = await f.open({ onMessage: () => {} }); assert.equal(f.paths[0], "/"); channel.close(); await channel.closed;
  }
});

test("old target contract headers remain end-to-end; only the declared outer contract can reject a new upgrade", { timeout: 15000 }, async t => {
  const f = await fixture(t), response = deferred<unknown>();
  const raw = new WebSocket(f.base.replace("http:", "ws:") + "/api/rabilink/peer/http/target/manager/", { headers: { authorization: "Bearer " + f.credential.token, "x-rabiroute-api-contract": "legacy-target-contract" } });
  raw.on("error", () => {}); await once(raw, "open"); raw.close(); await once(raw, "close");
  assert.equal(f.targetHeaders[0]!["x-rabiroute-api-contract"], "legacy-target-contract");
  const rejected = new WebSocket(f.base.replace("http:", "ws:") + "/api/rabilink/peer/http/target/manager/", { headers: { [PEER_PROXY_CONTRACT_HEADER]: "stale" } });
  rejected.on("error", () => {}); rejected.on("unexpected-response", (_request, incoming) => { response.resolve(incoming.statusCode); incoming.resume(); rejected.terminate(); });
  assert.equal(await response.promise, 409); assert.equal(f.acquisitions(), 1);
});

test("retirement waits for native target acquisition and does not start a stream after the caller is gone", { timeout: 15000 }, async t => {
  const f = await fixture(t), release = deferred(); t.after(() => release.resolve()); f.gate(release.promise);
  const opening = f.open({ onMessage: () => {} }).then(() => "opened", () => "closed"); await f.acquiring.promise;
  let done = false; const retiring = f.registration.dispose().then(() => { done = true; });
  try { await new Promise<void>(resolve => setImmediate(resolve)); assert.equal(done, false); assert.equal(f.registration.activeOperationCount(), 1); }
  finally { release.resolve(); }
  await retiring; assert.equal(await opening, "closed"); assert.equal(f.receiver.streams.size, 0); assert.equal(f.paths.length, 0);
});

test("node disable/re-enable cannot disclose another byte through the original admitted proxy", { timeout: 15000 }, async t => {
  const f = await fixture(t), received = deferred<unknown>(); const channel = await f.open({ onMessage: value => received.resolve(value) });
  channel.send("before"); assert.equal(await received.promise, "before");
  f.authority.setNodeEnabled(f.credential.nodeId, false, true); f.authority.setNodeEnabled(f.credential.nodeId, true, false);
  channel.send("revoked"); await channel.closed; await f.registration.dispose();
  assert.deepEqual(f.payloads.map(value => value.toString()), ["before"]); assert.equal(f.caller.closed, false);
});

test("raw suffixes and opaque contracts preserve encoded paths while rejecting ambiguous metadata", () => {
  const template = "/api/peer/:target/:path";
  assert.equal(fillApiPathTemplate(template, { target: "one/two", path: "" }, [], "path"), "/api/peer/one%2Ftwo/");
  assert.equal(fillApiPathTemplate(template, { target: "one", path: "x//%2F/%zz" }, [], "path"), "/api/peer/one/x//%2F/%zz");
  assert.throws(() => fillApiPathTemplate(template, { target: "one", path: "x?token=bad" }, [], "path"), /raw API path/);
  const contract = createPeerProxyUpgradeOperation({ openProxyUpgrade: async () => {} }, () => true).contract;
  assert.equal(compileApiContract({ contract }).pathRemainder, "path");
  assert.throws(() => compileApiContract({ contract: { ...contract, websocket: { ...contract.websocket!, maxMessageBytes: 1024 } as any } }), /Invalid WebSocket/);
});

test("HTTP and upgrade registrations share a URL in either order while same-plane collisions preserve the active snapshot", async () => {
  for (const upgradeFirst of [true, false]) {
    const registry = new ManagerPluginRouteRegistry();
    const definition = createPeerProxyUpgradeOperation({ openProxyUpgrade: async () => {} }, () => true);
    const { websocket: _websocket, ...base } = definition.contract;
    const http = { contract: { ...base, operationId: upgradeFirst ? "z.http" : "a.http", transport: "http" as const,
      responses: { "200": { mediaType: "text/plain", schema: { type: "string" } } } }, handler: () => ({ status: 200, body: "HTTP" }) };
    let normal, upgrade;
    if (upgradeFirst) { upgrade = registry.registerUpgrades("ws", [definition]); normal = registry.registerOperations("http", [http]); }
    else { normal = registry.registerOperations("http", [http]); upgrade = registry.registerUpgrades("ws", [definition]); }
    const snapshot = registry.catalogSnapshot(), projection = (await apiCatalogOpenApi(snapshot)) as any;
    assert.equal(projection.paths["/api/rabilink/peer/http/{deviceId}/{service}/{path}"].get["x-rabiroute-upgrades"].length, 1);
    assert.throws(() => registry.registerUpgrades("collision", [{ ...definition, contract: { ...definition.contract, operationId: "other.ws" } }]), /overlap/);
    assert.equal(registry.catalogSnapshot(), snapshot);
    assert.throws(() => registry.registerUpgrades("nested", [{ ...definition, contract: { ...definition.contract, operationId: "nested.ws",
      pathTemplate: "/api/rabilink/peer/http/:deviceId/:service/literal/:path" } }]), /overlap/);
    await upgrade.dispose(); assert.equal(registry.catalogSnapshot().operations.length, 1); await normal.dispose();
  }
});

test("malformed metadata is rejected while the persona alias supports authenticated upgrades", { timeout: 15000 }, async t => {
  const f = await fixture(t);
  await assert.rejects(f.open({ headers: { [PEER_PROXY_TARGET_HEADERS]: "{" }, onMessage: () => {} }));
  assert.equal(f.acquisitions(), 0);
  const channel = await f.open({ path: { deviceId: "target", service: "persona", path: "events" }, onMessage: () => {} });
  assert.equal(f.acquisitions(), 1); assert.equal(f.paths.length, 1); channel.close(); await channel.closed;
});

test("revocation while a native frame is queued sends no later data and preserves the shared encrypted session", { timeout: 15000 }, async t => {
  const f = await fixture(t), release = deferred(), channel = await f.open({ onMessage: () => {} });
  try {
    f.frameGate(release.promise); channel.send(Buffer.alloc(256 * 1024, 9)); await f.frameWaiting.promise;
    f.authority.setNodeEnabled(f.credential.nodeId, false, true); release.resolve(); await channel.closed; await f.registration.dispose();
    assert.equal(f.wireSizes.length, 0, "A frame queued before revocation must recheck authority at actual dispatch.");
    assert.equal(f.caller.closed, false); assert.ok(Number.isFinite(await f.caller.ping()));
  } finally {
    release.resolve(); await Promise.allSettled([f.registration.dispose(), channel.closed]);
  }
});

test("retirement retains its lease until an accepted native write callback has actually settled", { timeout: 15000 }, async t => {
  const f = await fixture(t), release = deferred(), channel = await f.open({ onMessage: () => {} });
  f.frameGate(release.promise); channel.send(Buffer.alloc(256 * 1024, 10)); await f.frameWaiting.promise;
  let stopped = false; const retired = f.registration.dispose().then(() => { stopped = true; });
  try { await new Promise<void>(resolve => setImmediate(resolve)); await new Promise<void>(resolve => setImmediate(resolve)); assert.equal(stopped, false); }
  finally { release.resolve(); }
  await retired; await channel.closed; assert.equal(f.registration.activeOperationCount(), 0);
});

test("future target header names remain data properties without changing header-object prototypes", () => {
  const target = JSON.parse('{"__proto__":["future"],"constructor":"literal","x-new-header":"value"}');
  const forwarded = peerProxyRequestHeaders({ [PEER_PROXY_TARGET_HEADERS]: JSON.stringify(target) });
  assert.equal(Object.getPrototypeOf(forwarded), Object.prototype);
  assert.equal(Object.hasOwn(forwarded, "__proto__"), true); assert.deepEqual(forwarded.__proto__, ["future"]);
  assert.equal(forwarded.constructor, "literal"); assert.equal(forwarded["x-new-header"], "value");
});
