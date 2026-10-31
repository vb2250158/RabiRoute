import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import { readAllDayStorage } from "./allDayRecordingReadStorage.js";
import test, { type TestContext } from "node:test";
import { DEFAULT_ALL_DAY_SETTINGS } from "../shared/allDayRecording.js";
import { EventEmitter } from "node:events";
import { createHash } from "node:crypto";
import { AllDayRecordingService, atomicRecordingJson } from "./allDayRecording.js";
import { createAllDayRecording } from "./allDayRecordingRoutes.js";
import { recordingOperationFixture } from "./personaRecordingOperationTestFixtures.js";
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
  const runtime = createAllDayRecording({ roleDirectory: id => path.join(root, id), hostId: "host-fixture", mobileRoot: path.join(root, "mobile"), speechUrl: () => { throw new Error("Unexpected speech call"); }, changed: () => {}, mobileAudio: async () => Buffer.from("RIFFphone"), runRead: async job => readAllDayStorage(job) });
  t.after(() => runtime.dispose());
  runtime.reads.timeline = async (role, since, until) => ({ events: await runtime.store.timeline(role, since, until), loading: false, pendingDays: [], readError: undefined });
  const request = (remote = true, method = "GET", action = "") => {
    const value = { method, url: `/api/roles/persona/all-day-recording${action ? `/${action}` : ""}`, headers: { host: "localhost", "content-type": "application/json", ...(remote ? { authorization: `Bearer ${credential.token}`, "x-rabiroute-agent-id": "worker" } : {}) }, socket: { remoteAddress: remote ? "192.0.2.10" : "127.0.0.1" } } as unknown as IncomingMessage;
    if (remote) assert.equal(evaluateLanAgentRequest(value, authority, true, () => config.getLanAgentAdmissionPolicy()).kind, "agent");
    return value;
  };
  const revoke = () => authority.revokeNode("node-fixture");
  let readOnly = false;
  const invoke = (req: IncomingMessage, readBody: (request: IncomingMessage) => Promise<unknown> = async () => ({})) => {
    const completed = deferred<{ status: number; body: string | Buffer }>();
    let status = 0;
    const response = Object.assign(new EventEmitter(), { writableEnded: false, destroyed: false, headersSent: false, writeHead(code: number) { status = code; this.headersSent = true; return this; }, end(body: string | Buffer) { this.writableEnded = true; completed.resolve({ status, body }); }, destroy() { this.destroyed = true; completed.resolve({ status, body: "" }); } });
    const handler = recordingOperationFixture(runtime, { local: req => req.socket.remoteAddress === "127.0.0.1", readOnly: () => readOnly, readBody });
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
    else { f.revoke(); if (mode === "credential-aba") f.authority.enroll(f.authority.issueBootstrapTicket().ticket, "node-fixture"); }
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

test("revocation during a contended rename stops the next replacement attempt", async t => {
  const f = await fixture(t);
  const file = path.join(f.root, "contended.json");
  await fs.writeFile(file, "original");
  let revoked = false, attempts = 0;
  t.mock.method(fs, "rename", async () => {
    attempts++;
    setTimeout(() => { revoked = true; }, 0);
    throw Object.assign(new Error("busy"), { code: "EBUSY" });
  });
  await assert.rejects(atomicRecordingJson(file, { next: true }, () => {
    if (revoked) throw new Error("revoked");
  }), /revoked/);
  assert.equal(attempts, 1);
  assert.equal(await fs.readFile(file, "utf8"), "original");
  assert.equal((await fs.readdir(f.root)).some(name => name.endsWith(".partial")), false);
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
      f.runtime.reads.media = async () => { entered.resolve(); return fetched.promise; };
      action = `media/2026-01-01/${"b".repeat(64)}.jpg`;
    }
    const pending = f.invoke(f.request(true, "GET", action));
    await entered.promise; f.revoke(); fetched.resolve(Buffer.from("PRIVATE_BYTES"));
    assert.equal((await pending).status, 403);
  }
});

test("index repair acknowledges a bounded job immediately, retains local authorization and publishes completion", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(),"rabi-recording-repair-http-"));
  let finished!: () => void;
  const completed = new Promise<void>(resolve => { finished = resolve; });
  let release!: () => void, entered!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  const started = new Promise<void>(resolve => { entered = resolve; });
  const runtime = createAllDayRecording({ roleDirectory: role => path.join(root,role), hostId:"computer",mobileRoot:path.join(root,"mobile"),
    speechUrl: () => "http://127.0.0.1:1", changed: () => {}, mobileAudio: async () => Buffer.alloc(0),
    runRead: async job => {if(job.kind==="scan") {entered();await blocked;}return readAllDayStorage(job);},
    indexChanged: (role,day,failed) => { assert.equal(role,"one"); assert.equal(day,"2026-10-11"); assert.equal(failed,false); finished(); }
  });
  await runtime.store.append("one",{id:"saved",startedAt:Date.parse("2026-10-11"),endedAt:Date.parse("2026-10-11"),source:"window",deviceId:"computer",kind:"window",text:"Editor",state:"saved"});
  let local = true, readOnly = false;
  const handler = recordingOperationFixture(runtime,{local: () => local,readOnly: () => readOnly,readBody: async () => ({})});
  const server = http.createServer((request,response) => { if(!handler(request,new URL(request.url!,"http://fixture"),response)) { response.writeHead(404); response.end(); } });
  await new Promise<void>(resolve => server.listen(0,"127.0.0.1",resolve));
  t.after(async () => { release();await runtime.dispose(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await fs.rm(root,{recursive:true,force:true}); });
  const url = `http://127.0.0.1:${(server.address() as import("node:net").AddressInfo).port}/api/roles/one/all-day-recording/index-repair/2026-10-11`;
  const submit = () => fetch(url,{method:"POST",headers:{"content-type":"application/json"},body:"{}",signal:AbortSignal.timeout(2000)});
  assert.deepEqual(await (await submit()).json(),{code:0,data:{queued:true}});
  await started;
  local = false; assert.equal((await submit()).status,403);
  local = true; readOnly = true; assert.equal((await submit()).status,403);
  readOnly = false;
  const catalog = await (await fetch(url.replace("/index-repair/2026-10-11","/catalog?day=2026-10-11"))).json() as {data:{incompleteDays:string[]}};
  assert.deepEqual(catalog.data.incompleteDays,["2026-10-11"]);
  release(); await completed;
});


test("recording cleanup failure still joins an accepted derived-index repair", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "recording-cleanup-join-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const entered = deferred<void>(), release = deferred<void>();
  const runtime = createAllDayRecording({ roleDirectory: id => path.join(root, id), hostId: "synthetic", mobileRoot: path.join(root, "mobile"),
    speechUrl: () => { throw new Error("No real speech request"); }, changed() {}, mobileAudio: async () => Buffer.alloc(0),
    runRead: async () => { entered.resolve(); await release.promise; return []; } });
  const failure = new Error("original recording service cleanup failed");
  runtime.service.dispose = async () => { throw failure; };
  const repair = runtime.store.repairIndex("role", "2026-10-31");
  await entered.promise;
  let settled = false;
  const stopping = runtime.dispose().then(() => assert.fail("must preserve cleanup failure"), error => { settled = true; assert.equal(error, failure); });
  t.after(async () => { release.resolve(); await Promise.allSettled([repair, stopping]); });
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(settled, false);
  release.resolve(); await repair; await stopping;
  assert.equal(settled, true);
});
