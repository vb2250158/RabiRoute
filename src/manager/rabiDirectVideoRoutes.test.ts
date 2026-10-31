import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import test from "node:test";
import { RTCPeerConnection } from "werift";
import { RabiDirectVideo, DIRECT_VIDEO_CHANNEL, DIRECT_VIDEO_LIMITS } from "./rabiDirectVideo.js";
import { createDirectVideoOperations } from "./rabiDirectVideoRoutes.js";
import { ManagerPluginRouteRegistry } from "./managerPluginRouteRegistry.js";
import { LanAgentAuthority } from "./lanAgentAuthority.js";
import { evaluateLanAgentRequest, assertTrustedLanAgentPrincipal } from "./lanAgentRequestAccess.js";
import { markAuthenticatedConnectionRequest } from "./connectionRequestAccess.js";
import { registerLanAgentBodyGuard, assertLanAgentBodyAuthority } from "./lanAgentBodyAuthority.js";

async function fixture(t: test.TestContext, readOnly = false) {
  const root = await mkdtemp(path.join(os.tmpdir(), "direct-video-operation-"));
  const receiver = new RabiDirectVideo(path.join(root, "video"), []), registry = new ManagerPluginRouteRegistry();
  let cleanup = async () => { await receiver.stop(); assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir())); await rm(root, { recursive: true, force: true }); };
  t.after(() => cleanup());
  const registration = registry.registerOperations("rabilink", createDirectVideoOperations(receiver, readOnly));
  const authority = new LanAgentAuthority({ statePath: path.join(root, "authority.json") });
  const credential = authority.enroll(authority.issueBootstrapTicket().ticket, "video-node");
  const senders: RTCPeerConnection[] = [];
  let release: (() => void) | undefined;
  const server = http.createServer((request, response) => {
    if (evaluateLanAgentRequest(request, authority, true).kind !== "agent") { response.writeHead(401).end(); return; }
    markAuthenticatedConnectionRequest(request, () => { assertTrustedLanAgentPrincipal(request); });
    registerLanAgentBodyGuard(request, body => assertLanAgentBodyAuthority(new URL(request.url!, "http://fixture").pathname, body, undefined));
    if (!registry.handle(request, new URL(request.url!, "http://fixture"), response)) response.writeHead(404).end();
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  cleanup = async () => { release?.(); const retired = registration.dispose(); await receiver.stop(); await Promise.allSettled(senders.map(sender => sender.close())); await retired;
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir())); await rm(root, { recursive: true, force: true }); };
  const base = "http://127.0.0.1:" + (server.address() as import("node:net").AddressInfo).port;
  const request = (url: string, body?: unknown, signal?: AbortSignal) => new Promise<Response>((resolve, reject) => {
    const request = http.request(base + url, { method: body === undefined ? "GET" : "POST", signal, headers: { authorization: "Bearer " + credential.token, "content-type": "text/plain" } }, response => {
      const chunks: Buffer[] = []; response.on("data", chunk => chunks.push(Buffer.from(chunk))); response.on("error", reject);
      response.on("end", () => resolve(new Response(Buffer.concat(chunks), { status: response.statusCode! })));
    }); request.on("error", reject); request.setTimeout(20000, () => request.destroy(new Error("Owned video HTTP fixture timed out."))); request.end(body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body));
  });
  const makeOffer = async () => { const sender = new RTCPeerConnection({ iceServers: [] }); senders.push(sender); const channel = sender.createDataChannel(DIRECT_VIDEO_CHANNEL);
    await sender.setLocalDescription(await sender.createOffer()); return { sender, channel, body: { deviceId: "fixture-camera", sdp: sender.localDescription!.sdp } }; };
  const holdOffer = () => { const native = receiver.offer.bind(receiver); let entered!: () => void; const started = new Promise<void>(resolve => { entered = resolve; }); const gate = new Promise<void>(resolve => { release = resolve; });
    receiver.offer = async value => { const result = await native(value); entered(); await gate; return result; }; return { started, release: () => release!() }; };
  return { receiver, registry, registration, authority, credential, request, makeOffer, holdOffer };
}

test("an enrolled empty node negotiates native direct SDP and reads the same WebRTC owner", { timeout: 30000 }, async t => {
  const f = await fixture(t); assert.deepEqual(await (await f.request("/api/rabilink/video/status?ignored=yes")).json(), { sessions: [], relay: false });
  const { sender, channel, body } = await f.makeOffer(); const opened = channel.stateChange.watch(state => state === "open", 12000);
  const response = await f.request("/api/rabilink/video/offer?ignored=yes", body); assert.equal(response.status, 200); const answer = await response.json();
  assert.equal(answer.type, "answer"); assert.equal(answer.relay, false); assert.ok(answer.sdp.startsWith("v=0")); assert.ok(!answer.sdp.includes(" typ relay"));
  await sender.setRemoteDescription({ type: "answer", sdp: answer.sdp }); await opened;
  const status = await (await f.request("/api/rabilink/video/status")).json(); assert.equal(status.sessions.length, 1); assert.equal(status.sessions[0].id, answer.sessionId); assert.equal(status.sessions[0].deviceId, "fixture-camera");
  assert.equal((await f.request("/api/rabilink/video/offer", body)).status, 400);
});

test("native signalling limits reject payload upload, relay candidates and invalid SDP before allocation", { timeout: 10000 }, async t => {
  const f = await fixture(t), sdp = "v=0\r\nm=application 9 UDP/DTLS/SCTP webrtc-datachannel";
  for (const body of [{ deviceId: "camera", sdp, bytes: "not media transport" }, { deviceId: "../bad", sdp }, { deviceId: "camera", sdp: sdp + "\r\na=candidate:1 1 udp 1 127.0.0.1 1234 typ relay\r\n" }, { deviceId: "camera", sdp: sdp + "\r\nm=video 9 UDP/TLS/RTP/SAVPF 96" }, { deviceId: "camera", sdp: sdp + "界".repeat(Math.floor(DIRECT_VIDEO_LIMITS.sdpBytes / 3)) }, { deviceId: "camera", sdp: "x".repeat(DIRECT_VIDEO_LIMITS.signalBytes) }]) assert.equal((await f.request("/api/rabilink/video/offer", body)).status, Buffer.byteLength(JSON.stringify(body)) > DIRECT_VIDEO_LIMITS.signalBytes ? 413 : 400);
  assert.deepEqual(f.receiver.status(), []);
});

test("read-only native mode rejects before consuming malformed JSON and still permits status reads", async t => {
  const f = await fixture(t, true); assert.equal((await f.request("/api/rabilink/video/offer", "not-json")).status, 403); assert.equal((await f.request("/api/rabilink/video/status")).status, 200); assert.deepEqual(f.receiver.status(), []);
});

test("original-node revocation suppresses a native negotiated answer without replacing its session", { timeout: 30000 }, async t => {
  const f = await fixture(t), hold = f.holdOffer(), { body } = await f.makeOffer(); const pending = f.request("/api/rabilink/video/offer", body); await hold.started;
  assert.equal(f.receiver.status().length, 1); f.authority.setNodeEnabled(f.credential.nodeId, false, true); f.authority.setNodeEnabled(f.credential.nodeId, true, false); hold.release();
  const response = await pending; assert.equal(response.status, 403); assert.ok(!(await response.text()).includes("v=0")); assert.equal(f.receiver.status().length, 1);
});

test("retirement joins an accepted native offer after HTTP disconnect and receiver shutdown", { timeout: 30000 }, async t => {
  const f = await fixture(t), hold = f.holdOffer(), { body } = await f.makeOffer(), controller = new AbortController();
  const pending = f.request("/api/rabilink/video/offer", body, controller.signal).catch(() => undefined); await hold.started; controller.abort(); await pending;
  let retired = false; const retirement = f.registration.dispose().then(() => { retired = true; }); await new Promise<void>(resolve => setImmediate(resolve)); assert.equal(retired, false);
  await f.receiver.stop(); assert.deepEqual(f.receiver.status(), []); assert.equal(retired, false); hold.release(); await retirement;
});


test("a negotiated answer is not disclosed after its original native session is closed", { timeout: 30000 }, async t => {
  const f = await fixture(t), hold = f.holdOffer(), { body } = await f.makeOffer(); const pending = f.request("/api/rabilink/video/offer", body); await hold.started;
  await f.receiver.stop(); hold.release(); const response = await pending; assert.equal(response.status, 400); assert.ok(!(await response.text()).includes("v=0")); assert.deepEqual(f.receiver.status(), []);
});
