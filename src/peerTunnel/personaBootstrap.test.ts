import assert from "node:assert/strict";
import { sign } from "node:crypto";
import { EventEmitter, once } from "node:events";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { PERSONA_BOOTSTRAP_DOMAIN, PERSONA_REFERENCE_CAPABILITY, personaPeerRequestAllowed } from "../shared/personaPeerService.js";
import type { TunnelChannel } from "./channel.js";
import { serveTunnel, tunnelFetch } from "./http.js";
import { PeerTunnelRuntime } from "./runtime.js";
import { isTunnelPublicKey, loadTunnelIdentity, type TunnelIdentity } from "./security.js";
import { establishTunnel } from "./session.js";

function folder(t: test.TestContext): string {
  const root = mkdtempSync(path.join(os.tmpdir(), "rabi-persona-bootstrap-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}
async function server(t: test.TestContext, handler: http.RequestListener) {
  const instance = http.createServer(handler);
  instance.listen(0, "127.0.0.1"); await once(instance, "listening");
  t.after(() => { instance.closeAllConnections(); instance.close(); });
  return { instance, url: `http://127.0.0.1:${(instance.address() as import("node:net").AddressInfo).port}` };
}
const relay = () => ({ url: "http://127.0.0.1", token: "test-application" });
function bootstrap(identity: TunnelIdentity, source = identity.deviceId, target = "b", domain = PERSONA_BOOTSTRAP_DOMAIN) {
  const fields = { source, publicKey: identity.publicKey, target, expiresAt: Date.now() + 30_000 };
  return { ...fields, kind: "bootstrap-persona", signature: sign(null, Buffer.from(domain + JSON.stringify(fields)), identity.privateKey).toString("base64") };
}
function grants(root: string) { return JSON.parse(readFileSync(path.join(root, "tunnel.json"), "utf8")); }

test("application bootstrap is deduplicated, pins both keys and grants B only the restricted persona service", { timeout: 10_000 }, async t => {
  const root = folder(t); let calls = 0, signals = 0, receiverEnabled = true, receiverToken = "test-application";
  const upstream = await server(t, (request, response) => { calls++; response.setHeader("content-type", "application/json"); response.end(JSON.stringify({ path: request.url, method: request.method })); });
  const lan = await server(t, (_request, response) => response.end());
  const common = { generation: "current", relay, onStatus: () => {}, allowPersonaBootstrap: () => true,
    services: () => ({ manager: { baseUrl: upstream.url, headers: { "x-test-owner": "fixed" } } }) };
  const b = new PeerTunnelRuntime({ ...common, dataDir: path.join(root, "b"), deviceId: "b",
    relay: () => ({ url: "http://127.0.0.1", token: receiverToken }), allowPersonaBootstrap: () => receiverEnabled,
    discover: async () => [], signal: async () => { throw new Error("unused"); } });
  const a = new PeerTunnelRuntime({ ...common, dataDir: path.join(root, "a"), deviceId: "a",
    discover: async () => [{ id: "b", name: "B", deviceKind: "pc", online: true, peerUrls: [lan.url], capabilities: ["peer-tunnel-v1", PERSONA_REFERENCE_CAPABILITY] }],
    signal: async call => { signals++; assert.equal(call.capability, "transport"); assert.equal(call.operation, "tunnel"); return b.offer(call.input); } });
  t.after(() => { a.stop(); b.stop(); });
  lan.instance.on("upgrade", (request, socket, head) => b.upgrade(request, socket, head));
  await Promise.all(Array.from({ length: 12 }, () => a.ensurePersonaService("b")));
  assert.equal(signals, 1);
  const ag = grants(path.join(root, "a")).trustedDevices[0], bg = grants(path.join(root, "b")).trustedDevices[0];
  assert.deepEqual(ag.services, []); assert.equal(ag.publicKey, b.identity.publicKey);
  assert.deepEqual(bg.services, ["persona"]); assert.equal(bg.publicKey, a.identity.publicKey);
  assert.equal(ag.bootstrapScope, bg.bootstrapScope);
  assert.equal((await a.directory()).peers[0].personaSupported, true);
  // A private tunnel.json entry cannot redirect or relax the persona service.
  const configured = grants(path.join(root, "b")); configured.services = { persona: { baseUrl: "http://127.0.0.1:1", pathPrefix: "/unsafe" } };
  writeFileSync(path.join(root, "b", "tunnel.json"), JSON.stringify(configured));
  const allowed = await a.fetch("b", "persona", "/meta"); assert.equal(allowed.status, 200); assert.equal((await allowed.json()).path, "/meta");
  assert.equal(signals, 1, "Business reads must reuse the bootstrapped session");
  const session = await a.session("b");
  for (const [service, requested, method] of [["manager", "/meta", "GET"], ["speech", "/health", "GET"], ["persona", "/gateways", "GET"], ["persona", "/api/roles/Example/plans", "POST"]]) {
    const response = await tunnelFetch(session, service, requested, { method }); assert.equal(response.status, 403); await response.text();
  }
  assert.equal(calls, 1);
  const style = await a.fetch("b", "persona", "/api/roles/Example/persona-reference/language-style", { method: "POST", body: "{}" });
  assert.equal(style.status, 200); await style.text(); assert.equal(calls, 2);
  for (const [enabled, token] of [[false, "test-application"], [true, ""], [true, "changed-application"]] as const) {
    receiverEnabled = enabled; receiverToken = token;
    const response = await a.fetch("b", "persona", "/meta"); assert.equal(response.status, 403); await response.text();
    assert.equal(calls, 2, "An existing encrypted session must recheck receiver enablement, token and application scope");
  }
  receiverEnabled = true; receiverToken = "test-application";
  configured.trustedDevices[0] = { deviceId: "a", publicKey: a.identity.publicKey, services: [] };
  writeFileSync(path.join(root, "b", "tunnel.json"), JSON.stringify(configured));
  const denied = await a.fetch("b", "persona", "/meta"); assert.equal(denied.status, 403); await denied.text();
  assert.equal(calls, 2, "An existing session must recheck an administrator's service revocation");
});

test("receiver bootstrap requires application enablement and token; read-only runtimes cannot bootstrap", async t => {
  const root = folder(t); let enabled = false, token = "test-application";
  const a = loadTunnelIdentity(path.join(root, "a.json"), "a", "a-current");
  const options = { deviceId: "b", generation: "b-current", relay: () => ({ url: "http://127.0.0.1", token }),
    allowPersonaBootstrap: () => enabled, discover: async () => [], signal: async () => {}, services: () => ({}), onStatus: () => {} };
  const b = new PeerTunnelRuntime({ ...options, dataDir: path.join(root, "b") });
  const readOnly = new PeerTunnelRuntime({ ...options, dataDir: path.join(root, "readonly"), readOnly: true });
  t.after(() => { b.stop(); readOnly.stop(); });
  await assert.rejects(b.offer(bootstrap(a)), /peer_service_denied/);
  enabled = true; token = "";
  await assert.rejects(b.offer(bootstrap(a)), /peer_service_denied/);
  assert.equal(existsSync(path.join(root, "b", "tunnel.json")), false);
  token = "test-application";
  await assert.rejects(readOnly.offer(bootstrap(a)), /manager_read_only/);
  await assert.rejects(readOnly.ensurePersonaService("a"), /manager_read_only/);
  assert.equal(existsSync(path.join(root, "readonly", "tunnel.json")), false);
  await b.offer(bootstrap(a));
  assert.deepEqual(grants(path.join(root, "b")).trustedDevices[0].services, ["persona"]);
});

test("persona bootstrap rejects key rotation, wrong signature domain and explicit manual denials", async t => {
  const root = folder(t);
  const a = loadTunnelIdentity(path.join(root, "a.json"), "a", "a-current"), rotated = loadTunnelIdentity(path.join(root, "rotated.json"), "a", "a-next");
  const b = new PeerTunnelRuntime({ dataDir: path.join(root, "b"), deviceId: "b", generation: "b-current", relay,
    allowPersonaBootstrap: () => true, discover: async () => [], signal: async () => {}, services: () => ({}), onStatus: () => {} });
  t.after(() => b.stop());
  await b.offer(bootstrap(a));
  await assert.rejects(b.offer(bootstrap(rotated)), /peer_identity_changed/);
  await assert.rejects(b.offer(bootstrap(a, "a", "b", "rabi-speech-bootstrap-v1")), /peer_signature_denied/);
  await assert.rejects(b.offer({ ...bootstrap(a), publicKey: "invalid" }), /peer_signature_denied/);
  for (const services of [[], ["speech"]]) {
    writeFileSync(path.join(root, "b", "tunnel.json"), JSON.stringify({ selectedDeviceId: "", services: {}, trustedDevices: [{ deviceId: "a", publicKey: a.publicKey, services }] }));
    await assert.rejects(b.offer(bootstrap(a)), /peer_service_denied/);
    assert.deepEqual(grants(path.join(root, "b")).trustedDevices[0].services, services);
  }
  for (const services of [["persona"], ["manager"]]) {
    writeFileSync(path.join(root, "b", "tunnel.json"), JSON.stringify({ selectedDeviceId: "", services: {}, trustedDevices: [{ deviceId: "a", publicKey: a.publicKey, services }] }));
    await b.offer(bootstrap(a));
    assert.deepEqual(grants(path.join(root, "b")).trustedDevices[0].services, services, "An existing manual grant must not be enlarged");
  }
});

test("persona bootstrap requires enabled application authentication and current scope", async t => {
  const root = folder(t); let enabled = false, token = "test-application", signals = 0;
  let release!: (value: unknown) => void;
  const identity = loadTunnelIdentity(path.join(root, "target.json"), "b", "b-current");
  const a = new PeerTunnelRuntime({ dataDir: path.join(root, "a"), deviceId: "a", generation: "a-current",
    relay: () => ({ url: "http://127.0.0.1", token }), allowPersonaBootstrap: () => enabled,
    discover: async () => [{ id: "b", name: "B", deviceKind: "pc", online: true, peerUrls: [], capabilities: ["peer-tunnel-v1", PERSONA_REFERENCE_CAPABILITY] }],
    signal: async () => { signals++; return new Promise(resolve => { release = resolve; }); }, services: () => ({}), onStatus: () => {} });
  t.after(() => a.stop());
  await assert.rejects(a.ensurePersonaService("b"), /peer_service_denied/); assert.equal(signals, 0);
  enabled = true; token = "";
  await assert.rejects(a.ensurePersonaService("b"), /peer_service_denied/); assert.equal(signals, 0);
  token = "test-application";
  const pending = a.ensurePersonaService("b"); await new Promise(resolve => setImmediate(resolve));
  token = "different-application";
  release({ deviceId: "b", generation: "b-current", publicKey: identity.publicKey });
  await assert.rejects(pending, /peer_service_denied/);
  assert.equal(existsSync(path.join(root, "a", "tunnel.json")), false);
});

test("persona client rejects unsupported targets and rotated reply keys without overwriting pins", async t => {
  const root = folder(t); let capable = false, signals = 0;
  const prior = loadTunnelIdentity(path.join(root, "prior.json"), "b", "b-current"), rotated = loadTunnelIdentity(path.join(root, "rotated.json"), "b", "b-current");
  const a = new PeerTunnelRuntime({ dataDir: path.join(root, "a"), deviceId: "a", generation: "a-current", relay, allowPersonaBootstrap: () => true,
    discover: async () => [{ id: "b", name: "B", deviceKind: "pc", online: true, peerUrls: [], capabilities: ["peer-tunnel-v1", ...(capable ? [PERSONA_REFERENCE_CAPABILITY] : [])] }],
    signal: async () => { signals++; return { deviceId: "b", generation: "b-current", publicKey: rotated.publicKey }; }, services: () => ({}), onStatus: () => {} });
  t.after(() => a.stop());
  await assert.rejects(a.ensurePersonaService("b"), /peer_persona_upgrade_required/); assert.equal(signals, 0);
  assert.equal((await a.directory()).peers[0].personaSupported, false);
  capable = true; await a.directory(true);
  writeFileSync(path.join(root, "a", "tunnel.json"), JSON.stringify({ selectedDeviceId: "", services: {}, trustedDevices: [{ deviceId: "b", publicKey: prior.publicKey, services: [] }] }));
  await assert.rejects(a.ensurePersonaService("b"), /peer_identity_changed/);
  assert.equal(grants(path.join(root, "a")).trustedDevices[0].publicKey, prior.publicKey);
  assert.equal(isTunnelPublicKey("not a key"), false); assert.equal(isTunnelPublicKey(prior.publicKey), true);
});

test("target HTTP guard rejects redirects and upgrades even when the caller bypasses its local policy", { timeout: 5_000 }, async t => {
  const root = folder(t), a = loadTunnelIdentity(path.join(root, "a.json"), "a", "a-current"), b = loadTunnelIdentity(path.join(root, "b.json"), "b", "b-current");
  const ac = new EventEmitter() as TunnelChannel, bc = new EventEmitter() as TunnelChannel;
  let closed = false;
  ac.send = async data => { setImmediate(() => { if (!closed) bc.emit("data", data); }); };
  bc.send = async data => { setImmediate(() => { if (!closed) ac.emit("data", data); }); };
  ac.close = bc.close = () => { if (!closed) { closed = true; ac.emit("close"); bc.emit("close"); } };
  const signal = AbortSignal.timeout(2_000);
  const [caller, receiver] = await Promise.all([establishTunnel(ac, a, { deviceId: "b", publicKey: b.publicKey, services: [] }, true, signal), establishTunnel(bc, b, { deviceId: "a", publicKey: a.publicKey, services: ["persona"] }, false, signal)]);
  t.after(() => { caller.close(); receiver.close(); });
  let upgrades = 0, calls = 0;
  const upstream = await server(t, (request, response) => { calls++; response.writeHead(302, { location: request.url?.includes("invalid") ? "http://[invalid" : "/gateways" }); response.end(); });
  upstream.instance.on("upgrade", (_request, socket) => { upgrades++; socket.destroy(); });
  serveTunnel(receiver, () => ({ persona: { baseUrl: upstream.url, requestAllowed: personaPeerRequestAllowed } }));
  for (const requested of ["/meta", "/meta?invalid=1"]) {
    const response = await tunnelFetch(caller, "persona", requested); assert.equal(response.status, 403); await response.text();
  }
  const stream = caller.open({ service: "persona", method: "GET", path: "/meta", headers: {}, upgrade: true }); stream.end();
  assert.equal((await stream.response).status, 403); stream.resume();
  assert.equal(calls, 2); assert.equal(upgrades, 0);
  assert.equal((await tunnelFetch(caller, "persona", "/api/roles/Example/../../meta")).status, 403);
});
