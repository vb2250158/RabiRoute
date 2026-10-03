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
import { APPLICATION_ACCESS_CAPABILITY, APPLICATION_BOOTSTRAP_DOMAIN, PeerTunnelRuntime } from "./runtime.js";
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
function bootstrap(identity: TunnelIdentity, source = identity.deviceId, target = "b", domain = APPLICATION_BOOTSTRAP_DOMAIN) {
  const fields = { source, publicKey: identity.publicKey, target, expiresAt: Date.now() + 30_000 };
  return { ...fields, kind: "bootstrap-application", signature: sign(null, Buffer.from(domain + JSON.stringify(fields)), identity.privateKey).toString("base64") };
}
function grants(root: string) { return JSON.parse(readFileSync(path.join(root, "tunnel.json"), "utf8")); }

test("application bootstrap is deduplicated, pins both keys and enables all offered services", { timeout: 10_000 }, async t => {
  const root = folder(t); let calls = 0, signals = 0, receiverEnabled = true, receiverToken = "test-application";
  const upstream = await server(t, (request, response) => { calls++; response.setHeader("content-type", "application/json"); response.end(JSON.stringify({ path: request.url, method: request.method })); });
  const lan = await server(t, (_request, response) => response.end());
  const common = { generation: "current", relay, onStatus: () => {}, allowApplicationConnection: () => true,
    services: () => ({ manager: { baseUrl: upstream.url, headers: { "x-test-owner": "fixed" } }, speech: { baseUrl: upstream.url }, resources: { baseUrl: upstream.url, pathPrefix: "/resource-cache" } }) };
  const b = new PeerTunnelRuntime({ ...common, dataDir: path.join(root, "b"), deviceId: "b",
    relay: () => ({ url: "http://127.0.0.1", token: receiverToken }), allowApplicationConnection: () => receiverEnabled,
    discover: async () => [], signal: async () => { throw new Error("unused"); } });
  const a = new PeerTunnelRuntime({ ...common, dataDir: path.join(root, "a"), deviceId: "a",
    discover: async () => [{ id: "b", name: "B", deviceKind: "pc", online: true, peerUrls: [lan.url], capabilities: ["peer-tunnel-v1", PERSONA_REFERENCE_CAPABILITY, APPLICATION_ACCESS_CAPABILITY] }],
    signal: async call => { signals++; assert.equal(call.capability, "transport"); assert.equal(call.operation, "tunnel"); return b.offer(call.input); } });
  t.after(() => { a.stop(); b.stop(); });
  lan.instance.on("upgrade", (request, socket, head) => b.upgrade(request, socket, head));
  await Promise.all(Array.from({ length: 12 }, () => a.ensureApplicationConnection("b")));
  assert.equal(signals, 1);
  const ag = grants(path.join(root, "a")).trustedDevices[0], bg = grants(path.join(root, "b")).trustedDevices[0];
  assert.deepEqual(ag.services, []); assert.equal(ag.publicKey, b.identity.publicKey);
  assert.deepEqual(bg.services, []); assert.equal(bg.publicKey, a.identity.publicKey);
  assert.equal(ag.bootstrapScope, bg.bootstrapScope);
  assert.equal((await a.directory()).peers[0].personaSupported, true);
  // A private tunnel.json entry cannot redirect or relax the persona service.
  const configured = grants(path.join(root, "b")); configured.services = { persona: { baseUrl: "http://127.0.0.1:1", pathPrefix: "/unsafe" } };
  writeFileSync(path.join(root, "b", "tunnel.json"), JSON.stringify(configured));
  const allowed = await a.fetch("b", "persona", "/meta"); assert.equal(allowed.status, 200); assert.equal((await allowed.json()).path, "/meta");
  assert.equal(signals, 1, "Business reads must reuse the bootstrapped session");
  const session = await a.session("b");
  for (const [service, requested, method] of [["manager", "/api/roles/Example/plans", "POST"], ["speech", "/health", "GET"], ["resources", "/audio.wav", "GET"]]) {
    const response = await tunnelFetch(session, service, requested, { method }); assert.equal(response.status, 200); await response.text();
  }
  for (const [service, requested, method] of [["unknown", "/meta", "GET"], ["persona", "/gateways", "GET"], ["persona", "/api/roles/Example/plans", "POST"]]) {
    const response = await tunnelFetch(session, service, requested, { method }); assert.equal(response.status, 403); await response.text();
  }
  assert.equal(calls, 4);
  const style = await a.fetch("b", "persona", "/api/roles/Example/persona-reference/language-style", { method: "POST", body: "{}" });
  assert.equal(style.status, 200); await style.text(); assert.equal(calls, 5);
  for (const [enabled, token] of [[false, "test-application"], [true, ""], [true, "changed-application"]] as const) {
    receiverEnabled = enabled; receiverToken = token;
    const response = await a.fetch("b", "persona", "/meta"); assert.equal(response.status, 403); await response.text();
    assert.equal(calls, 5, "An existing encrypted session must recheck receiver enablement, token and application scope");
  }
  receiverEnabled = true; receiverToken = "test-application";
  configured.trustedDevices[0].services = ["speech"];
  writeFileSync(path.join(root, "b", "tunnel.json"), JSON.stringify(configured));
  const permitted = await a.fetch("b", "manager", "/meta"); assert.equal(permitted.status, 200); await permitted.text();
  assert.equal(calls, 6, "Legacy services fields are not a second authorization source");
  await a.select("b"); assert.equal(a.selected(), "b");
});

test("receiver bootstrap requires application enablement and token; read-only runtimes cannot bootstrap", async t => {
  const root = folder(t); let enabled = false, token = "test-application";
  const a = loadTunnelIdentity(path.join(root, "a.json"), "a", "a-current");
  const options = { deviceId: "b", generation: "b-current", relay: () => ({ url: "http://127.0.0.1", token }),
    allowApplicationConnection: () => enabled, discover: async () => [], signal: async () => {}, services: () => ({}), onStatus: () => {} };
  const b = new PeerTunnelRuntime({ ...options, dataDir: path.join(root, "b") });
  const readOnly = new PeerTunnelRuntime({ ...options, dataDir: path.join(root, "readonly"), readOnly: true });
  t.after(() => { b.stop(); readOnly.stop(); });
  await assert.rejects(b.offer(bootstrap(a)), /peer_service_denied/);
  enabled = true; token = "";
  await assert.rejects(b.offer(bootstrap(a)), /peer_service_denied/);
  assert.equal(existsSync(path.join(root, "b", "tunnel.json")), false);
  token = "test-application";
  await assert.rejects(readOnly.offer(bootstrap(a)), /manager_read_only/);
  await assert.rejects(readOnly.ensureApplicationConnection("a"), /manager_read_only/);
  assert.equal(existsSync(path.join(root, "readonly", "tunnel.json")), false);
  await b.offer(bootstrap(a));
  assert.deepEqual(grants(path.join(root, "b")).trustedDevices[0].services, []);
});

test("an application token change never reauthorizes an already established channel", { timeout: 10_000 }, async t => {
  const root = folder(t); let token = "first-application", calls = 0, signals = 0;
  const upstream = await server(t, (_request, response) => { calls++; response.end("allowed"); });
  const lan = await server(t, (_request, response) => response.end());
  const common = { generation: "current", relay: () => ({ url: "http://127.0.0.1", token }), onStatus: () => {}, allowApplicationConnection: () => true,
    services: () => ({ manager: { baseUrl: upstream.url } }) };
  const b = new PeerTunnelRuntime({ ...common, dataDir: path.join(root, "b"), deviceId: "b", discover: async () => [], signal: async () => {} });
  const a = new PeerTunnelRuntime({ ...common, dataDir: path.join(root, "a"), deviceId: "a",
    discover: async () => [{ id: "b", name: "B", deviceKind: "pc", online: true, peerUrls: [lan.url], capabilities: ["peer-tunnel-v1", APPLICATION_ACCESS_CAPABILITY] }],
    signal: async call => { signals++; return b.offer(call.input); } });
  t.after(() => { a.stop(); b.stop(); });
  lan.instance.on("upgrade", (request, socket, head) => b.upgrade(request, socket, head));
  const oldSession = await a.session("b");
  assert.equal(await (await tunnelFetch(oldSession, "manager", "/meta")).text(), "allowed");
  token = "second-application";
  await a.ensureApplicationConnection("b");
  assert.equal(signals, 2);
  const denied = await tunnelFetch(oldSession, "manager", "/meta"); assert.equal(denied.status, 403); await denied.text();
  assert.equal(calls, 1, "Rebinding a pin to a new scope must not authorize an old channel");
  await assert.rejects(a.session("b"), /peer_service_denied/); assert.equal(oldSession.closed, true);
  assert.equal(await (await a.fetch("b", "manager", "/meta")).text(), "allowed"); assert.equal(calls, 2);
});

test("LAN discovery and copied manual pins cannot bypass current application authentication", async t => {
  const root = folder(t); let enabled = false, token = "application", signals = 0;
  const remote = loadTunnelIdentity(path.join(root, "remote.json"), "b", "b-current");
  const a = new PeerTunnelRuntime({ dataDir: path.join(root, "a"), deviceId: "a", generation: "a-current", allowApplicationConnection: () => enabled,
    relay: () => ({ url: "http://127.0.0.1", token }), services: () => ({}), onStatus: () => {},
    discover: async () => [{ id: "b", name: "B", deviceKind: "pc", online: true, peerUrls: ["http://127.0.0.1:1"], capabilities: ["peer-tunnel-v1", APPLICATION_ACCESS_CAPABILITY] }],
    signal: async () => { signals++; throw new Error("No authenticated signal"); } });
  t.after(() => a.stop());
  writeFileSync(path.join(root, "a", "tunnel.json"), JSON.stringify({ selectedDeviceId: "", services: {}, trustedDevices: [{ deviceId: "b", publicKey: remote.publicKey, services: ["manager"] }] }));
  assert.equal((await a.directory()).peers[0].trusted, false);
  await assert.rejects(a.session("b"), /peer_service_denied/);
  enabled = true; token = "";
  await assert.rejects(a.select("b"), /peer_service_denied/); assert.equal(signals, 0);
  token = "application";
  await assert.rejects(a.session("b"), /No authenticated signal/); assert.equal(signals, 1);
  assert.equal(grants(path.join(root, "a")).trustedDevices[0].bootstrapScope, undefined);
});

test("application bootstrap rejects key rotation and migrates obsolete manual service grants", async t => {
  const root = folder(t);
  const a = loadTunnelIdentity(path.join(root, "a.json"), "a", "a-current"), rotated = loadTunnelIdentity(path.join(root, "rotated.json"), "a", "a-next");
  const b = new PeerTunnelRuntime({ dataDir: path.join(root, "b"), deviceId: "b", generation: "b-current", relay,
    allowApplicationConnection: () => true, discover: async () => [], signal: async () => {}, services: () => ({}), onStatus: () => {} });
  t.after(() => b.stop());
  await b.offer(bootstrap(a));
  await assert.rejects(b.offer(bootstrap(rotated)), /peer_identity_changed/);
  await assert.rejects(b.offer(bootstrap(a, "a", "b", "rabi-speech-bootstrap-v1")), /peer_signature_denied/);
  await assert.rejects(b.offer({ ...bootstrap(a), publicKey: "invalid" }), /peer_signature_denied/);
  for (const services of [[], ["speech"], ["persona"], ["manager"]]) {
    writeFileSync(path.join(root, "b", "tunnel.json"), JSON.stringify({ selectedDeviceId: "", services: {}, trustedDevices: [{ deviceId: "a", publicKey: a.publicKey, services }] }));
    await b.offer(bootstrap(a));
    assert.deepEqual(grants(path.join(root, "b")).trustedDevices[0].services, [], "Authenticated bootstrap retires a copied manual service policy");
    assert.match(grants(path.join(root, "b")).trustedDevices[0].bootstrapScope, /^[a-f0-9]{64}$/);
  }
});

test("persona bootstrap requires enabled application authentication and current scope", async t => {
  const root = folder(t); let enabled = false, token = "test-application", signals = 0;
  let release!: (value: unknown) => void;
  const identity = loadTunnelIdentity(path.join(root, "target.json"), "b", "b-current");
  const a = new PeerTunnelRuntime({ dataDir: path.join(root, "a"), deviceId: "a", generation: "a-current",
    relay: () => ({ url: "http://127.0.0.1", token }), allowApplicationConnection: () => enabled,
    discover: async () => [{ id: "b", name: "B", deviceKind: "pc", online: true, peerUrls: [], capabilities: ["peer-tunnel-v1", PERSONA_REFERENCE_CAPABILITY, APPLICATION_ACCESS_CAPABILITY] }],
    signal: async () => { signals++; return new Promise(resolve => { release = resolve; }); }, services: () => ({}), onStatus: () => {} });
  t.after(() => a.stop());
  await assert.rejects(a.ensureApplicationConnection("b"), /peer_service_denied/); assert.equal(signals, 0);
  enabled = true; token = "";
  await assert.rejects(a.ensureApplicationConnection("b"), /peer_service_denied/); assert.equal(signals, 0);
  token = "test-application";
  const pending = a.ensureApplicationConnection("b"); await new Promise(resolve => setImmediate(resolve));
  token = "different-application";
  release({ deviceId: "b", generation: "b-current", publicKey: identity.publicKey });
  await assert.rejects(pending, /peer_service_denied/);
  assert.equal(existsSync(path.join(root, "a", "tunnel.json")), false);
});

test("persona client rejects unsupported targets and rotated reply keys without overwriting pins", async t => {
  const root = folder(t); let capable = false, signals = 0;
  const prior = loadTunnelIdentity(path.join(root, "prior.json"), "b", "b-current"), rotated = loadTunnelIdentity(path.join(root, "rotated.json"), "b", "b-current");
  const a = new PeerTunnelRuntime({ dataDir: path.join(root, "a"), deviceId: "a", generation: "a-current", relay, allowApplicationConnection: () => true,
    discover: async () => [{ id: "b", name: "B", deviceKind: "pc", online: true, peerUrls: [], capabilities: ["peer-tunnel-v1", PERSONA_REFERENCE_CAPABILITY, ...(capable ? [APPLICATION_ACCESS_CAPABILITY] : [])] }],
    signal: async () => { signals++; return { deviceId: "b", generation: "b-current", publicKey: rotated.publicKey }; }, services: () => ({}), onStatus: () => {} });
  t.after(() => a.stop());
  await assert.rejects(a.ensureApplicationConnection("b"), /peer_upgrade_required/); assert.equal(signals, 0);
  assert.equal((await a.directory()).peers[0].personaSupported, false);
  capable = true; await a.directory(true);
  writeFileSync(path.join(root, "a", "tunnel.json"), JSON.stringify({ selectedDeviceId: "", services: {}, trustedDevices: [{ deviceId: "b", publicKey: prior.publicKey, services: [] }] }));
  await assert.rejects(a.ensureApplicationConnection("b"), /peer_identity_changed/);
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
