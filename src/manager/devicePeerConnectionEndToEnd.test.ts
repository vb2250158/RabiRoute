import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomBytes, randomUUID, sign } from "node:crypto";
import { createDevicePeerBootstrapRoutes, DEVICE_PEER_BOOTSTRAP_PATH } from "./devicePeerBootstrapRoutes.js";
import { RabiLinkRelayRuntime, type RabiLinkRelayRuntimeConfig } from "./rabiLinkRelayRuntime.js";
import { rabiLinkAgentDevicePrincipal, rabiLinkConnectionScope } from "./rabiLinkAgentDeviceConnection.js";
import { markAuthenticatedConnectionRequest } from "./connectionRequestAccess.js";
import { validateInternalManagerHop, type InternalManagerHopClaims } from "../shared/internalManagerHop.js";
import { createDeviceAgentOwner, deviceAgentOwnerPath } from "../agentAdapters/deviceAgentOwner.js";
import { PeerTunnelRuntime, DEVICE_DELEGATION_DOMAIN, APPLICATION_BOOTSTRAP_DOMAIN } from "../peerTunnel/runtime.js";
import { loadTunnelIdentity, type TunnelIdentity } from "../peerTunnel/security.js";
import { connectWebsocket } from "../peerTunnel/channel.js";
import { establishTunnel, type TunnelSession } from "../peerTunnel/session.js";
import { tunnelFetch } from "../peerTunnel/http.js";

type Reply = { sourceDeviceId: string; deviceId: string; publicKey: string; generation: string; expiresAt: number; epoch: string };
type Wire = { code?: number | string; cookie?: string; app?: { id: string; token: string }; device?: { id: string }; token?: string;
  peers?: Array<{ id: string }>; data?: { structuredContent?: { statusCode?: number; data?: { code?: number | string; data?: Reply } } } };
async function readBody(request: http.IncomingMessage): Promise<unknown> {
  const parts: Buffer[] = []; for await (const part of request) parts.push(Buffer.from(part));
  return parts.length ? JSON.parse(Buffer.concat(parts).toString()) : undefined;
}
async function listen(server: http.Server) {
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); assert.ok(address && typeof address !== "string");
  return "http://127.0.0.1:" + address.port;
}
async function until(predicate: () => Promise<boolean>, description: string, timeout = 10_000) {
  const deadline = Date.now() + timeout;
  while (!await predicate()) {
    if (Date.now() >= deadline) throw new Error("Fixture timeout: " + description);
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}
async function fixture(t: test.TestContext) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "rabi-device-e2e-"));
  const probe = http.createServer(); const relayBase = await listen(probe);
  await new Promise<void>(resolve => probe.close(() => resolve()));
  const child = spawn(process.execPath, [path.resolve("scripts/rabilink-relay-server.mjs")], { windowsHide: true, stdio: "ignore",
    env: { ...process.env, HOST: "127.0.0.1", PORT: new URL(relayBase).port, RABILINK_RELAY_DATA_DIR: path.join(dir, "relay"), RABILINK_RELAY_WEBGUI_REQUEST_WAIT_MS: "10000" } });
  const sessions: TunnelSession[] = [];
  let server: http.Server | undefined, route: ReturnType<typeof createDevicePeerBootstrapRoutes> | undefined;
  let peer: PeerTunnelRuntime | undefined, worker: RabiLinkRelayRuntime | undefined;
  t.after(async () => {
    route?.stop(); sessions.forEach(session => session.close()); peer?.stop(); await worker?.stop();
    server?.closeAllConnections(); if (server?.listening) await new Promise<void>(resolve => server!.close(() => resolve()));
    await route?.drain();
    if (child.exitCode === null) { const ended = once(child, "exit"); child.kill(); await ended; }
    rmSync(dir, { recursive: true, force: true });
  });
  async function relayRequest(suffix: string, method = "GET", input?: unknown, credentials: Record<string, string> = {}) {
    const response = await fetch(relayBase + suffix, { method, headers: { "content-type": "application/json", ...credentials },
      ...(input === undefined ? {} : { body: JSON.stringify(input) }), signal: AbortSignal.timeout(15_000) });
    const wire = await response.json() as Wire;
    return { status: response.status, wire, cookie: response.headers.get("set-cookie")?.split(";")[0] ?? "" };
  }
  await until(async () => { try { return (await fetch(relayBase + "/health")).ok; } catch { return false; } }, "Relay child healthy");
  const account = await relayRequest("/manage/api/accounts", "POST", { username: "e2e-owner", password: randomUUID() });
  assert.equal(account.status, 200);
  const application = await relayRequest("/manage/api/apps", "POST", { name: "e2e-application" }, { cookie: account.cookie });
  const app = application.wire.app!; assert.ok(app?.token);
  const target = "fixture-owner-pc", generation = "fixture-manager-generation", serial = "E2E-GLASSES-0001";
  let nativeDeviceId = "", localBase = "";
  const config = { enabled: true, url: relayBase, token: app.token, deviceId: target };
  const scope = rabiLinkConnectionScope(config);
  const admissions: InternalManagerHopClaims[] = [], nativeAdmissions: InternalManagerHopClaims[] = [];
  peer = new PeerTunnelRuntime({ dataDir: path.join(dir, "pc"), deviceId: target, generation,
    relay: () => ({ url: relayBase, token: app.token }), discover: async () => [], signal: async () => { throw new Error("No reciprocal Eye application bootstrap."); },
    allowApplicationConnection: () => true, onStatus: () => {}, services: () => ({ manager: { baseUrl: localBase } }) });
  const owner = createDeviceAgentOwner({ dataDir: path.join(dir, "owner"), ownerInstanceId: "fixture-owner-guid",
    authorize: request => rabiLinkAgentDevicePrincipal(request, config, generation),
    authorizeDelivery: async request => rabiLinkAgentDevicePrincipal(request, config, generation),
    assertDeviceAssignment: async (candidateScope, deviceId) => { if (candidateScope !== scope || deviceId !== nativeDeviceId) throw new Error("Wrong immutable owner assignment."); }
  });
  route = createDevicePeerBootstrapRoutes({ current: () => ({ scope, generation, deviceId: target }), readJsonBody: readBody,
    bootstrap: (input, authority) => peer!.grantDeviceConnection(input, authority),
    jsonResponse: (response, status, body) => { response.writeHead(status, { "content-type": "application/json" }); response.end(JSON.stringify(body)); }
  });
  server = http.createServer((request, response) => {
    const url = new URL(request.url!, "http://fixture.invalid");
    const claims = validateInternalManagerHop(request, { scope, generation });
    if (claims) markAuthenticatedConnectionRequest(request, () => {
      if (!validateInternalManagerHop(request, { scope, generation })) throw new Error("Original transport expired.");
    });
    if (url.pathname === DEVICE_PEER_BOOTSTRAP_PATH && claims) admissions.push(claims);
    if (route!.handle(request, url, response)) return;
    if (url.pathname === "/api/events" || url.pathname === "/api/speech/events") {
      response.writeHead(200, { "content-type": "text/event-stream" }); response.write(": fixture connection\n\n"); return;
    }
    if (url.pathname === "/api/fixture/application-bootstrap") {
      void (async () => {
        try { assert.ok(claims); const data = await peer!.offer(await readBody(request)); response.writeHead(200, { "content-type": "application/json" }); response.end(JSON.stringify({ code: 0, data })); }
        catch { response.writeHead(403, { "content-type": "application/json" }); response.end('{"code":"APPLICATION_BOOTSTRAP_DENIED"}'); }
      })(); return;
    }
    if (deviceAgentOwnerPath(url.pathname)) {
      if (claims) nativeAdmissions.push(claims);
      void readBody(request).then(body => owner.handle(request, response, url, body)).catch(() => { response.writeHead(500); response.end("{}"); }); return;
    }
    if (url.pathname === "/api/fixture/future") {
      response.writeHead(claims ? 200 : 403, { "content-type": "application/json" }); response.end(JSON.stringify({ source: claims?.deviceId })); return;
    }
    response.writeHead(404).end();
  });
  server.on("upgrade", (request, socket, head) => { if (!peer!.upgrade(request, socket, head)) socket.destroy(); });
  localBase = await listen(server);
  worker = new RabiLinkRelayRuntime({ channelRetryDelayMs: 20 });
  const workerConfig: RabiLinkRelayRuntimeConfig = { enabled: true, url: relayBase, token: app.token, deviceId: target, deviceGuid: randomUUID(),
    deviceName: "Fixture PC", claimWaitMs: 60_000, applicationGenerationId: generation, localWebguiUrl: localBase, localSpeechUrl: "" };
  await worker.sync(workerConfig);
  await until(async () => (await relayRequest("/api/rabilink/peers", "GET", undefined, { "x-rabilink-token": app.token })).wire.peers?.some(row => row.id === target) ?? false, "actual PC worker registered");
  const binding = await relayRequest(`/manage/api/apps/${app.id}/devices`, "POST", { serialNumber: serial, connectionTargetDeviceId: target }, { cookie: account.cookie });
  assert.equal(binding.status, 200);
  const credential = await relayRequest("/api/rabilink/devices/token", "POST", { serialNumber: serial });
  assert.equal(credential.status, 200); nativeDeviceId = credential.wire.device!.id;
  assert.match(nativeDeviceId, /^glasses-[a-f0-9]{16}$/); const deviceToken = credential.wire.token!;
  const eye = loadTunnelIdentity(path.join(dir, "eye.json"), nativeDeviceId, "eye-generation");
  const signed = (identity = eye, expiresAt = Date.now() + 40_000) => {
    const fields = { source: identity.deviceId, publicKey: identity.publicKey, target, expiresAt, nonce: randomBytes(24).toString("base64url") };
    return { ...fields, signature: sign(null, Buffer.from(DEVICE_DELEGATION_DOMAIN + JSON.stringify(fields)), identity.privateKey).toString("base64") };
  };
  const generic = async (pathname: string, input: unknown, token = deviceToken) => relayRequest("/api/rabilink/device/api", "POST",
    { targetDeviceId: target, request: { method: "POST", path: pathname, body: input, operationId: randomUUID() } }, { "x-rabilink-token": token });
  const grant = (input = signed(), token = deviceToken) => generic(DEVICE_PEER_BOOTSTRAP_PATH, input, token);
  const connect = async (reply: Pick<Reply, "deviceId" | "publicKey">, identity: TunnelIdentity = eye) => {
    const channel = await connectWebsocket(localBase.replace("http:", "ws:") + "/api/rabilink/peer/tunnel/socket?source=" + identity.deviceId, {}, AbortSignal.timeout(5000));
    const session = await establishTunnel(channel, identity, { deviceId: reply.deviceId, publicKey: reply.publicKey, services: [] }, true, AbortSignal.timeout(5000));
    sessions.push(session); return session;
  };
  const native = async (session: TunnelSession, suffix: string, method = "GET", input?: unknown) => {
    const response = await tunnelFetch(session, "manager", "/api/device-agents/" + nativeDeviceId + suffix,
      { method, headers: { "content-type": "application/json", "x-rabilink-tunnel-device-id": "forged-body-source" }, ...(input === undefined ? {} : { body: JSON.stringify(input) }) });
    return { status: response.status, wire: await response.json() as { code?: number | string; data?: { session?: { sessionId: string; ownerEpoch: string }; delivery?: { deliveryId: string } } } };
  };
  return { eye, target, app, admissions, nativeAdmissions, peer, owner, scope, signed, grant, generic, connect, native, relayRequest,
    deviceToken, nativeDeviceId, worker, workerConfig, dir,
    async revokeDevice() { assert.equal((await relayRequest(`/manage/api/apps/${app.id}/devices`, "POST", { serialNumber: serial }, { cookie: account.cookie })).status, 200); }
  };
}

test("actual Relay device credential → worker MAC → PC grant → Eye encrypted handshake → native session and claim", { timeout: 30_000 }, async t => {
  const f = await fixture(t), began = Date.now(), input = f.signed();
  const result = await f.grant(input);
  assert.equal(result.status, 200); assert.equal(result.wire.data?.structuredContent?.statusCode, 200);
  const reply = result.wire.data!.structuredContent!.data!.data!;
  assert.equal(reply.sourceDeviceId, f.nativeDeviceId); assert.equal(reply.expiresAt, input.expiresAt);
  const original = f.admissions[0]!;
  assert.equal(original.kind, "relay"); assert.equal(original.deviceId, f.nativeDeviceId);
  assert.ok(original.authenticatedAt! >= began && original.authenticatedAt! <= original.issuedAt);
  const session = await f.connect(reply);
  const registered = await f.native(session, "/session", "PUT", { sessionId: "original-eye-session", name: "Fixture Eye", loaded: true, capabilities: ["steer"] });
  assert.equal(registered.status, 200);
  const envelope = { deliveryId: "original-delivery", sentAt: "2026-01-01T00:00:00Z", messageSource: { type: "system" as const, eventType: "fixture", eventName: "Fixture", eventId: "original-delivery" }, messageContent: "Original message" };
  await f.owner.enqueue(f.scope, f.nativeDeviceId, envelope, async () => {});
  const claimed = await f.native(session, "/deliveries/claim", "POST", registered.wire.data!.session);
  assert.equal(claimed.status, 200); assert.equal(claimed.wire.data?.delivery?.deliveryId, "original-delivery");
  assert.equal(f.owner.readDelivery(f.scope, f.nativeDeviceId, "original-delivery")?.ownerAccepted, true);
  assert.equal(f.nativeAdmissions.at(-1)?.deviceId, f.nativeDeviceId); assert.equal(f.nativeAdmissions.at(-1)?.kind, "peer");
});

test("actual app-token transport cannot grant Eye and a real ordinary phone tunnel cannot claim Eye", { timeout: 30_000 }, async t => {
  const f = await fixture(t);
  assert.equal((await f.grant(f.signed(), f.app.token)).wire.data?.structuredContent?.statusCode, 403);
  assert.equal(f.admissions.at(-1)?.deviceId, "$application");
  const ordinary = (identity: TunnelIdentity) => {
    const fields = { source: identity.deviceId, publicKey: identity.publicKey, target: f.target, expiresAt: Date.now() + 30_000 };
    return { ...fields, kind: "bootstrap-application", signature: sign(null, Buffer.from(APPLICATION_BOOTSTRAP_DOMAIN + JSON.stringify(fields)), identity.privateKey).toString("base64") };
  };
  assert.equal((await f.generic("/api/fixture/application-bootstrap", ordinary(f.eye), f.app.token)).wire.data?.structuredContent?.statusCode, 403);
  const grant = await f.grant(), eyeSession = await f.connect(grant.wire.data!.structuredContent!.data!.data!);
  const registered = await f.native(eyeSession, "/session", "PUT", { sessionId: "original-eye", name: "Eye", loaded: true, capabilities: [] });
  assert.equal(registered.status, 200);
  const phone = loadTunnelIdentity(path.join(f.dir, "phone.json"), "phone-fixture", "phone-generation");
  const phoneGrant = await f.generic("/api/fixture/application-bootstrap", ordinary(phone), f.app.token);
  assert.equal(phoneGrant.wire.data?.structuredContent?.statusCode, 200);
  const phoneSession = await f.connect(phoneGrant.wire.data!.structuredContent!.data!.data!, phone);
  const publicResponse = await tunnelFetch(phoneSession, "manager", "/api/fixture/future");
  assert.equal(publicResponse.status, 200); assert.deepEqual(await publicResponse.json(), { source: phone.deviceId });
  assert.equal((await f.native(phoneSession, "/deliveries/claim", "POST", registered.wire.data!.session)).status, 403);
  assert.equal((await f.native(phoneSession, "/session", "PUT", { ...registered.wire.data!.session, name: "Fake Eye", loaded: true, capabilities: [] })).status, 403);
  assert.equal(f.owner.sessions(f.scope)[0]?.name, "Eye");
});

test("real credential revocation blocks renewal and absolute lease expiry blocks native IO", { timeout: 30_000 }, async t => {
  const f = await fixture(t), input = f.signed(f.eye, Date.now() + 2500);
  const registered = await f.grant(input); assert.equal(registered.wire.data?.structuredContent?.statusCode, 200);
  const session = await f.connect(registered.wire.data!.structuredContent!.data!.data!);
  const initial = await f.native(session, "/session", "PUT", { sessionId: "original-eye", name: "Original Eye", loaded: true, capabilities: [] });
  assert.equal(initial.status, 200);
  await f.revokeDevice(); assert.equal((await f.grant()).status, 401);
  await new Promise(resolve => setTimeout(resolve, Math.max(0, input.expiresAt - Date.now() + 50)));
  let denied = false;
  try { denied = (await f.native(session, "/session", "PUT", { ...initial.wire.data!.session, name: "Expired mutation", loaded: true, capabilities: [] })).status === 403; }
  catch { denied = true; }
  assert.equal(denied, true); assert.equal(f.owner.sessions(f.scope)[0]?.name, "Original Eye");
  await assert.rejects(f.connect(registered.wire.data!.structuredContent!.data!.data!), /403|closed|cancel/i);
  await assert.rejects(f.peer.ensureApplicationConnection(f.nativeDeviceId), /peer_device_authority_expired/);
});

test("actual queued device authorization expires before a freshly signed main-process hop can grant", { timeout: 30_000 }, async t => {
  const f = await fixture(t); await f.worker.stop();
  const registration = new URLSearchParams({ deviceId: f.target, deviceGuid: f.workerConfig.deviceGuid, deviceName: "Fixture PC", deviceKind: "pc", waitMs: "0", capabilities: "webgui" });
  assert.equal((await f.relayRequest("/worker/webgui-requests?" + registration, "GET", undefined, { "x-rabilink-token": f.app.token })).status, 200);
  const input = f.signed(f.eye, Date.now() + 500), operationId = randomUUID();
  const pending = f.relayRequest("/api/rabilink/device/api", "POST", { targetDeviceId: f.target,
    request: { method: "POST", path: DEVICE_PEER_BOOTSTRAP_PATH, body: input, operationId } }, { "x-rabilink-token": f.deviceToken });
  await until(async () => {
    const result = await f.relayRequest("/api/rabilink/device/api/operations/" + operationId, "GET", undefined, { "x-rabilink-token": f.deviceToken });
    return (result.wire.data as { receipt?: { state: string } })?.receipt?.state === "pending";
  }, "original operation queued before worker restart");
  await new Promise(resolve => setTimeout(resolve, Math.max(0, input.expiresAt - Date.now() + 50)));
  await f.worker.sync(f.workerConfig);
  const finished = await pending;
  assert.equal(finished.status, 200); assert.equal(finished.wire.data?.structuredContent?.statusCode, 400, JSON.stringify(finished.wire));
  const admission = f.admissions.at(-1)!;
  assert.equal(admission.deviceId, f.nativeDeviceId);
  assert.ok(admission.authenticatedAt! < input.expiresAt && admission.issuedAt > input.expiresAt);
  await assert.rejects(f.peer.ensureApplicationConnection(f.nativeDeviceId), /peer_device_authority_expired/);
});
