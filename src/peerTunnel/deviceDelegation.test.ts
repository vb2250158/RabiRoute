import assert from "node:assert/strict";
import { createHash, randomBytes, sign } from "node:crypto";
import { once } from "node:events";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createDevicePeerBootstrapOperation, DEVICE_PEER_BOOTSTRAP_PATH } from "../manager/devicePeerBootstrapRoutes.js";
import { ManagerPluginRouteRegistry } from "../manager/managerPluginRouteRegistry.js";
import { markAuthenticatedConnectionRequest } from "../manager/connectionRequestAccess.js";
import { issueInternalManagerHopHeaders, validateInternalManagerHop } from "../shared/internalManagerHop.js";
import { connectWebsocket } from "./channel.js";
import { tunnelFetch } from "./http.js";
import { APPLICATION_BOOTSTRAP_DOMAIN, DEVICE_DELEGATION_DOMAIN, PeerTunnelRuntime } from "./runtime.js";
import { loadTunnelIdentity, type TunnelIdentity } from "./security.js";
import { establishTunnel } from "./session.js";

const source = "glasses-0123456789abcdef", generation = "fixture-generation";
type Reply = { sourceDeviceId: string; deviceId: string; publicKey: string; generation: string; managerGeneration: string; expiresAt: number; epoch: string };
async function fixture(t: test.TestContext) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "rabi-device-delegation-"));
  const eye = loadTunnelIdentity(path.join(dir, "eye.json"), source, "eye-generation");
  let token = "fixture-application", enabled = true, captured: http.IncomingMessage | undefined, eventResponse: http.ServerResponse | undefined;
  const upgradedBytes: string[] = [];
  const upgradedSockets = new Set<import("node:stream").Duplex>();
  const relay = () => ({ url: "http://127.0.0.1", token });
  const scope = () => createHash("sha256").update(relay().url + "\n" + token).digest("hex");
  let url = "";
  const runtime = new PeerTunnelRuntime({ dataDir: path.join(dir, "pc"), deviceId: "pc", generation,
    allowApplicationConnection: () => enabled, discover: async () => [], signal: async () => { throw new Error("No application bootstrap for Eye."); },
    relay, services: () => ({ manager: { baseUrl: url } }), onStatus: () => {} });
  const route = createDevicePeerBootstrapOperation({ current: () => ({ generation, scope: scope(), deviceId: "pc" }),
    bootstrap: (input, authority) => runtime.grantDeviceConnection(input, authority) });
  const registry = new ManagerPluginRouteRegistry(), registration = registry.registerOperations("peer", [route.operation]);
  const server = http.createServer((req, res) => {
    const claims = validateInternalManagerHop(req, { generation, scope: scope() });
    if (claims) markAuthenticatedConnectionRequest(req);
    if (registry.handle(req, new URL(req.url!, url), res)) return;
    if (req.url === "/api/future/owner") {
      captured = req; res.writeHead(claims ? 200 : 403); res.end(JSON.stringify({ source: claims?.deviceId, kind: claims?.kind })); return;
    }
    if (req.url === "/api/future/events" && claims) {
      eventResponse = res; res.writeHead(200, { "content-type": "text/event-stream" }); res.write("data: ready\n\n"); return;
    }
    res.writeHead(404); res.end();
  });
  server.on("upgrade", (req, socket, head) => {
    if (runtime.upgrade(req, socket, head)) return;
    const claims = validateInternalManagerHop(req, { generation, scope: scope() });
    if (req.url !== "/api/future/socket" || !claims) { socket.destroy(); return; }
    upgradedSockets.add(socket); socket.once("close", () => upgradedSockets.delete(socket));
    socket.write("HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n");
    socket.on("data", bytes => { upgradedBytes.push(bytes.toString()); socket.write(bytes); });
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  url = "http://127.0.0.1:" + (server.address() as import("node:net").AddressInfo).port;
  t.after(async () => {
    route.stop(); const stopping = runtime.stop(), retiring = registration.dispose(); server.closeAllConnections();
    // Node excludes upgraded sockets from closeAllConnections; these belong to this fixture.
    const upgradesClosed = Promise.all([...upgradedSockets].map(socket => new Promise<void>(resolve => {
      socket.once("close", () => resolve()); socket.destroy();
    })));
    const closed = new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    const results = await Promise.allSettled([stopping, retiring, upgradesClosed, closed]);
    assert.equal(path.dirname(path.resolve(dir)), path.resolve(os.tmpdir())); rmSync(dir, { recursive: true, force: true });
    for (const result of results) if (result.status === "rejected") throw result.reason;
  });
  const signed = (identity = eye, expiresAt = Date.now() + 40_000) => {
    const fields = { source: identity.deviceId, publicKey: identity.publicKey, target: "pc", expiresAt, nonce: randomBytes(24).toString("base64url") };
    return { ...fields, signature: sign(null, Buffer.from(DEVICE_DELEGATION_DOMAIN + JSON.stringify(fields)), identity.privateKey).toString("base64") };
  };
  const register = async (input = signed(), authenticatedAt = Date.now(), kind: "relay" | "peer" = "relay", deviceId = source) => {
    const headers = issueInternalManagerHopHeaders({ kind, generation, scope: scope(), deviceId, method: "POST", target: DEVICE_PEER_BOOTSTRAP_PATH, authenticatedAt });
    const response = await fetch(url + DEVICE_PEER_BOOTSTRAP_PATH, { method: "POST", headers: { ...headers, "content-type": "application/json", connection: "close" }, body: JSON.stringify(input) });
    return { status: response.status, ...(await response.json() as { data?: Reply; error?: string }) };
  };
  const connect = async (reply: Reply, identity: TunnelIdentity = eye) => {
    const channel = await connectWebsocket(url.replace("http:", "ws:") + "/api/rabilink/peer/tunnel/socket?source=" + identity.deviceId, {}, AbortSignal.timeout(2_000));
    const session = await establishTunnel(channel, identity, { deviceId: reply.deviceId, publicKey: reply.publicKey, services: [] }, true, AbortSignal.timeout(2_000));
    t.after(() => session.close()); return session;
  };
  return { dir, eye, runtime, signed, register, connect, scope, captured: () => captured, eventResponse: () => eventResponse!, upgradedBytes,
    disable: () => { enabled = false; }, changeScope: () => { token = "next-fixture-application"; } };
}

test("actual Relay-device HTTP admission registers an independent Eye LAN tunnel and native identity", { timeout: 10_000 }, async t => {
  const f = await fixture(t), result = await f.register(); assert.equal(result.status, 200);
  const reply = result.data!; assert.equal(reply.sourceDeviceId, source); assert.equal(reply.managerGeneration, generation);
  const session = await f.connect(reply);
  const response = await tunnelFetch(session, "manager", "/api/future/owner", { headers: { "x-rabilink-tunnel-device-id": "forged", "x-rabiroute-relay-proxy": "1" } });
  assert.equal(response.status, 200); assert.deepEqual(await response.json(), { source, kind: "peer" });
  assert.equal(existsSync(path.join(f.dir, "pc", "tunnel.json")), false);
  assert.ok(validateInternalManagerHop(f.captured()!, { generation, scope: f.scope() }));
});

test("application and peer proofs cannot register Eye; application TOFU cannot impersonate reserved Eye IDs", async t => {
  const f = await fixture(t);
  assert.equal((await f.register(f.signed(), Date.now(), "peer")).status, 403);
  assert.equal((await f.register(f.signed(), Date.now(), "relay", "$application")).status, 403);
  const fields = { source, publicKey: f.eye.publicKey, target: "pc", expiresAt: Date.now() + 30_000 };
  const input = { ...fields, kind: "bootstrap-application", signature: sign(null, Buffer.from(APPLICATION_BOOTSTRAP_DOMAIN + JSON.stringify(fields)), f.eye.privateKey).toString("base64") };
  await assert.rejects(f.runtime.offer(input), /peer_device_bootstrap_required/);
  await assert.rejects(f.runtime.ensureApplicationConnection(source), /peer_device_authority_expired/);
});

test("queued authentication cannot renew its absolute 45-second deadline and signatures bind all fields", async t => {
  const f = await fixture(t), now = Date.now();
  assert.equal((await f.register(f.signed(f.eye, now + 40_000), now - 20_000)).status, 400);
  assert.equal((await f.register(f.signed(f.eye, now + 10_000), now - 20_000)).status, 200);
  for (const field of ["source", "publicKey", "target", "expiresAt", "nonce", "signature"] as const) {
    const original = f.signed();
    const changed = { ...original, [field]: field === "expiresAt" ? original.expiresAt - 1 : original[field] + "changed" };
    assert.notEqual((await f.register(changed)).status, 200, field);
  }
});

test("same-key renewal preserves the active epoch; rotating the key closes the original session", { timeout: 10_000 }, async t => {
  const f = await fixture(t);
  const first = (await f.register(f.signed(f.eye, Date.now() + 20_000))).data!, session = await f.connect(first);
  const renewal = (await f.register()).data!; assert.equal(renewal.epoch, first.epoch); assert.ok(renewal.expiresAt > first.expiresAt);
  const oldReply = await tunnelFetch(session, "manager", "/api/future/owner"); assert.equal(oldReply.status, 200); await oldReply.text();
  const replacement = loadTunnelIdentity(path.join(f.dir, "replacement.json"), source, "next-eye-generation");
  const closed = once(session, "close"), changed = (await f.register(f.signed(replacement))).data!;
  assert.notEqual(changed.epoch, first.epoch); await closed;
  const next = await f.connect(changed, replacement), response = await tunnelFetch(next, "manager", "/api/future/owner");
  assert.equal(response.status, 200); await response.text();
});

test("lease expiry invalidates admitted Manager requests, new IO and new sessions without application fallback", { timeout: 10_000 }, async t => {
  let now = Date.now(); t.mock.method(Date, "now", () => now);
  const f = await fixture(t), reply = (await f.register()).data!, session = await f.connect(reply);
  const initial = await tunnelFetch(session, "manager", "/api/future/owner"); await initial.text();
  const req = f.captured()!; assert.ok(validateInternalManagerHop(req, { generation, scope: f.scope() }));
  now = reply.expiresAt + 1;
  assert.equal(validateInternalManagerHop(req, { generation, scope: f.scope() }), null);
  await assert.rejects(f.runtime.ensureApplicationConnection(source), /peer_device_authority_expired/);
  const denied = await tunnelFetch(session, "manager", "/api/future/owner"); assert.equal(denied.status, 403); await denied.text();
  await assert.rejects(f.connect(reply), /403/);
});

test("scope change and Runtime stop revoke already admitted Eye requests", { timeout: 10_000 }, async t => {
  for (const revoke of ["scope", "stop"] as const) {
    const f = await fixture(t), reply = (await f.register()).data!, session = await f.connect(reply);
    const response = await tunnelFetch(session, "manager", "/api/future/owner"); await response.text();
    const req = f.captured()!, oldScope = f.scope();
    if (revoke === "scope") f.changeScope(); else f.runtime.stop();
    assert.equal(validateInternalManagerHop(req, { generation, scope: oldScope }), null);
  }
});

test("delegated lease expiry stops active SSE and upgraded duplex bytes", { timeout: 10_000 }, async t => {
  let now = Date.now(); t.mock.method(Date, "now", () => now);
  const f = await fixture(t), reply = (await f.register()).data!, session = await f.connect(reply);
  const response = await tunnelFetch(session, "manager", "/api/future/events"), reader = response.body!.getReader();
  assert.match(Buffer.from((await reader.read()).value!).toString(), /ready/);
  const stream = session.open({ service: "manager", path: "/api/future/socket", method: "GET", headers: {}, upgrade: true });
  assert.equal((await stream.response).status, 101);
  const echoed = once(stream, "data"); stream.write("before"); assert.equal((await echoed)[0].toString(), "before");
  now = reply.expiresAt + 1;
  const closed = new Promise<void>(resolve => stream.once("close", resolve));
  stream.write("after"); f.eventResponse().write("data: after\n\n");
  await closed;
  await assert.rejects(reader.read(), /interrupted|closed|reset|disconnected|cancelled/i);
  assert.deepEqual(f.upgradedBytes, ["before"]);
});
