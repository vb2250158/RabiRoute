import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import test, { type TestContext } from "node:test";
import { DEFAULT_ALL_DAY_SETTINGS } from "../shared/allDayRecording.js";
import { createHash } from "node:crypto";
import { AllDayRecordingService, atomicRecordingJson } from "./allDayRecording.js";
import { allDayRecordingHandler, createAllDayRecording } from "./allDayRecordingRoutes.js";
import { LanAgentAuthority } from "./lanAgentAuthority.js";
import { RabiGlobalConfigStore } from "./globalConfig.js";
import { assertTrustedLanAgentPrincipal, evaluateLanAgentRequest } from "./lanAgentRequestAccess.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(finish => { resolve = finish; });
  return { promise, resolve };
}
async function fixture(t: TestContext) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "recording-authority-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const authority = new LanAgentAuthority({ statePath: path.join(root, "auth.json") });
  const config = new RabiGlobalConfigStore(root);
  config.patch({ webguiLan: { enabled: true } });
  const credential = authority.enroll(authority.issueBootstrapTicket().ticket, "node-fixture");
  authority.registerAgentCatalog(credential.token, [{ agentId: "worker", provider: "custom-provider" }]);
  const runtime = createAllDayRecording({ roleDirectory: id => path.join(root, id), hostId: "host-fixture", mobileRoot: path.join(root, "mobile"), speechUrl: () => { throw new Error("Unexpected speech call"); }, changed: () => {}, mobileAudio: async () => Buffer.from("RIFFphone") });
  const request = (remote = true, method = "GET", action = "") => {
    const value = { method, url: `/api/roles/persona/all-day-recording${action ? `/${action}` : ""}`, headers: { host: "localhost", "content-type": "application/json", ...(remote ? { authorization: `Bearer ${credential.token}`, "x-rabiroute-agent-id": "worker" } : {}) }, socket: { remoteAddress: remote ? "192.0.2.10" : "127.0.0.1" } } as unknown as IncomingMessage;
    if (remote) assert.equal(evaluateLanAgentRequest(value, authority, true, () => config.getLanAgentAdmissionPolicy()).kind, "agent");
    return value;
  };
  const revoke = () => authority.setAgentEnabled("node-fixture", "worker", false);
  let readOnly = false;
  const invoke = (req: IncomingMessage, readBody: (request: IncomingMessage) => Promise<unknown> = async () => ({})) => {
    const completed = deferred<{ status: number; body: string | Buffer }>();
    let status = 0;
    const response = { writableEnded: false, destroyed: false, headersSent: false, writeHead(code: number) { status = code; this.headersSent = true; return this; }, end(body: string | Buffer) { this.writableEnded = true; completed.resolve({ status, body }); }, destroy() { this.destroyed = true; completed.resolve({ status, body: "" }); } };
    const handler = allDayRecordingHandler(runtime, { local: req => req.socket.remoteAddress === "127.0.0.1", readOnly: () => readOnly, readBody });
    assert.equal(handler(req, new URL(req.url!, "http://localhost"), response as unknown as ServerResponse), true);
    return completed.promise;
  };
  return { root, authority, config, runtime, request, revoke, invoke, setReadOnly: () => { readOnly = true; } };
}
const screenSettings = { ...DEFAULT_ALL_DAY_SETTINGS, sources: { ...DEFAULT_ALL_DAY_SETTINGS.sources, screen: true } };
const hostDependencies = { capture: async () => [], startMicrophone: async () => {}, stopMicrophone: async () => {}, audio: async () => [], audioFile: async () => Buffer.from("RIFF"), changed: () => {} };

test("safe local and authenticated custom-provider Agents share recording queries and settings", async t => {
  const f = await fixture(t);
  f.runtime.service = new AllDayRecordingService(f.runtime.store, hostDependencies);
  t.after(() => f.runtime.service.dispose());
  for (const remote of [false, true]) {
    assert.equal((await f.invoke(f.request(remote))).status, 200);
    assert.equal((await f.invoke(f.request(remote, "PUT", "settings"), async () => screenSettings)).status, 200);
    for (const action of ["recent", "page?direction=older&time=1", "events?since=0&until=1000"]) assert.equal((await f.invoke(f.request(remote, "GET", action))).status, 200);
    assert.equal((await f.invoke(f.request(remote, "POST", "start"))).status, 200);
    assert.equal((await f.runtime.service.snapshot("persona")).running, true);
    assert.equal((await f.invoke(f.request(remote, "POST", "stop"))).status, 200);
    assert.equal((await f.runtime.service.snapshot("persona")).running, false);
  }
  f.setReadOnly();
  for (const remote of [false, true]) {
    assert.equal((await f.invoke(f.request(remote))).status, 200);
    assert.equal((await f.invoke(f.request(remote, "POST", "start"))).status, 403);
  }
});

test("Agent header and unsafe local origins never fall back to local authority", async t => {
  const f = await fixture(t);
  for (const header of [{ "x-rabiroute-agent-id": "worker" }, { origin: "https://outside.invalid" }, { "x-forwarded-for": "192.0.2.1" }, { "sec-fetch-site": "cross-site" }, { "x-rabilink-tunnel-local": "private" }]) {
    const req = f.request(false);
    Object.assign(req.headers, header);
    assert.equal((await f.invoke(req)).status, 403);
  }
  const revoked = f.request();
  Object.defineProperty(revoked.socket, "remoteAddress", { value: "127.0.0.1" });
  f.revoke();
  delete revoked.headers["x-rabiroute-agent-id"];
  assert.equal((await f.invoke(revoked)).status, 403);
});

test("revocation and admission or credential ABA during body read block configuration", async t => {
  for (const mode of ["revoke", "admission-aba", "credential-aba"]) {
    const f = await fixture(t);
    const body = deferred<unknown>();
    const entered = deferred<void>();
    const pending = f.invoke(f.request(true, "PUT", "settings"), async () => { entered.resolve(); return body.promise; });
    await entered.promise;
    if (mode === "admission-aba") { f.config.patch({ webguiLan: { enabled: false } }); f.config.patch({ webguiLan: { enabled: true } }); }
    else { f.revoke(); if (mode === "credential-aba") f.authority.setAgentEnabled("node-fixture", "worker", true); }
    body.resolve(screenSettings);
    assert.equal((await pending).status, 403);
    await assert.rejects(fs.access(path.join(f.runtime.store.directory("persona"), "settings.json")), { code: "ENOENT" });
  }
});

test("queued recording control revalidates before writes or Host dispatch", async t => {
  const f = await fixture(t);
  const entered = deferred<void>();
  const release = deferred<void>();
  const configure = f.runtime.store.configure.bind(f.runtime.store);
  f.runtime.store.configure = async (...args) => { entered.resolve(); await release.promise; return configure(...args); };
  const service = new AllDayRecordingService(f.runtime.store, hostDependencies);
  t.after(() => service.dispose());
  const first = service.configure("persona", screenSettings);
  await entered.promise;
  const req = f.request();
  const guard = () => { assertTrustedLanAgentPrincipal(req); };
  const queued = service.start("persona", guard);
  const rejected = assert.rejects(queued, /revoked or replaced/);
  f.revoke(); release.resolve();
  await first; await rejected;
  assert.equal((await service.snapshot("persona")).running, false);
  assert.equal(await f.runtime.store.enabledRole(), null);
});

test("revocation after filesystem await or before rename suppresses publication and cleans partials", async t => {
  const f = await fixture(t);
  for (const revokeAt of [3, 6, 9]) {
    let checks = 0;
    const file = path.join(f.root, `fenced-${revokeAt}`, "settings.json");
    await assert.rejects(atomicRecordingJson(file, {}, () => { if (++checks >= revokeAt) throw new Error("revoked"); }), /revoked/);
    assert.deepEqual(await fs.readdir(path.dirname(file)), []);
  }
});

test("private mobile audio keeps phone owner and fences fetched raw bytes", async t => {
  const f = await fixture(t);
  const owner = "authenticated-phone-owner";
  const chunks = ["a".repeat(64)];
  const time = Date.now() - 1000;
  await f.runtime.store.receiveMobile(owner, { id: "event", startedAt: time, endedAt: time, text: "phone transcription", chunks });
  const deviceId = createHash("sha256").update(owner).digest("hex");
  await f.runtime.store.configure("persona", { ...DEFAULT_ALL_DAY_SETTINGS, mobileDeviceIds: [deviceId] });
  const event = (await f.runtime.store.timeline("persona", time - 1, time + 1))[0];
  const req = f.request(true, "GET", `audio?since=${time - 1}&until=${time + 1}&id=${encodeURIComponent(event.id)}`);
  const bytes = deferred<Buffer>();
  const entered = deferred<void>();
  f.runtime.mobileAudio = async (actualOwner, actualChunks, authorize) => { assert.equal(actualOwner, owner); assert.deepEqual(actualChunks, chunks); authorize?.(); entered.resolve(); return bytes.promise; };
  const pending = f.invoke(req);
  await entered.promise; f.revoke(); bytes.resolve(Buffer.from("RIFFprivate"));
  const reply = await pending;
  assert.equal(reply.status, 403);
  assert.doesNotMatch(String(reply.body), /RIFFprivate/);
});

test("media and speech audio are withheld after revocation at fetch settlement", async t => {
  for (const speech of [false, true]) {
    const f = await fixture(t);
    const time = Date.now() - 1000;
    const fetched = deferred<Buffer>();
    const entered = deferred<void>();
    let action: string;
    if (speech) {
      await f.runtime.store.append("persona", { id: "audio", speechRecordId: "record", startedAt: time, endedAt: time, source: "microphone", deviceId: "host-fixture", kind: "audio", text: "transcript", state: "saved" });
      f.runtime.audio = async () => { entered.resolve(); const body = await fetched.promise; return { status: 200, contentType: "audio/wav", headers: {}, body }; };
      action = `audio?since=${time - 1}&until=${time + 1}&id=audio`;
    } else {
      f.runtime.store.media = async () => { entered.resolve(); return fetched.promise; };
      action = `media/2026-01-01/${"b".repeat(64)}.jpg`;
    }
    const pending = f.invoke(f.request(true, "GET", action));
    await entered.promise; f.revoke(); fetched.resolve(Buffer.from("PRIVATE_BYTES"));
    assert.equal((await pending).status, 403);
  }
});
