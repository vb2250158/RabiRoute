import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import test from "node:test";
import { createSpeechApiOperations, SpeechApiOwner } from "./speechApiOperations.js";
import type { SpeechApiContext } from "./speechApiContext.js";
import { SpeechControlError, ManagerSpeechControl } from "./speechControl.js";
import { SelectionSpeechSettingsStore } from "./selectionSpeechSettings.js";
import { ManagerPluginRouteRegistry } from "./managerPluginRouteRegistry.js";
import { LanAgentAuthority } from "./lanAgentAuthority.js";
import { evaluateLanAgentRequest, assertTrustedLanAgentPrincipal } from "./lanAgentRequestAccess.js";
import { markAuthenticatedConnectionRequest } from "./connectionRequestAccess.js";
import { registerLanAgentBodyGuard, assertLanAgentBodyAuthority, validateLanAgentRequestBody } from "./lanAgentBodyAuthority.js";
import type { PluginPublication } from "../plugin-kernel/types.js";

async function fixture(t: test.TestContext, options: { control?: Partial<ManagerSpeechControl>; readOnly?: boolean; capture?: SpeechApiContext["capture"] } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "speech-operation-fixture-")), calls: Array<{ method: string; args: unknown[] }> = [], targets: Array<string | undefined> = [];
  const control = new Proxy({}, { get: (_target, method: string) => (...args: unknown[]) => {
    calls.push({ method, args }); const guard = args.at(-1); if (typeof guard === "function") guard();
    if (["models", "personas", "microphoneDevices", "records", "audioStreamEvents"].includes(method)) return [];
    if (["synthesize", "transcribe", "recordAudio"].includes(method)) return Promise.resolve({ status: 200, contentType: "audio/x-fixture", headers: { "x-rabispeech-model": "fixture-model" }, body: Buffer.from([0, 1, 255, 128]) });
    if (method === "audioStreamToken") return "fixture-token";
    if (method === "eventStream") return Promise.resolve(new Response(": native\nevent: fixture\ndata: not-json\n\n", { headers: { "content-type": "text/event-stream" } }));
    return { owner: method };
  } }) as ManagerSpeechControl;
  const effective = new Proxy(control, { get: (target, method: string) => (options.control as any)?.[method] ?? (target as any)[method] });
  const models = { snapshot: () => ({ owner: "snapshot" }), installRuntime: () => ({ owner: "installRuntime", activeJob: { id: "fixture-job" } }), installModel: (id: string) => ({ owner: "installModel", model: id }), directorySettings: () => ({ owner: "directorySettings" }), updateDirectorySettings: (body: unknown) => ({ owner: "updateDirectorySettings", body }) };
  const context: SpeechApiContext = {
    speechControl: effective,
    speechRuntimeControl: { start: async () => ({ owner: "runtime.start" }), stop: async () => ({ owner: "runtime.stop" }) } as any,
    speechModelManager: models as any,
    selectionSpeechSettings: new SelectionSpeechSettingsStore(path.join(root, "selection.json")),
    speechIngressStore: { read: () => undefined, query: () => [], listDeliveryReceipts: () => [] },
    readOnly: () => options.readOnly ?? false,
    identity: () => ({ applicationGenerationId: "fixture-generation", managerInstanceId: "fixture-manager" }),
    hostSpeechCommand: body => ({ ...body, sourceDeviceId: "fixture-host", sourceDeviceName: "Fixture Host" }),
    readProxyJson: async request => { let raw = ""; for await (const chunk of request) raw += chunk; const body = JSON.parse(raw || "{}"); validateLanAgentRequestBody(request, body); return body; },
    capture: options.capture ?? ((request, compute) => { assertTrustedLanAgentPrincipal(request); targets.push(compute); return { targetLocal: false, guard: () => { assertTrustedLanAgentPrincipal(request); }, run: action => action() }; })
  };
  const owner = new SpeechApiOwner(context), registry = new ManagerPluginRouteRegistry(), definitions = createSpeechApiOperations(owner), registration = registry.registerOperations("speech-fixture", definitions.operations), proxyRegistration = registry.registerHttpProxies("speech-proxy-fixture", definitions.proxies);
  const authority = new LanAgentAuthority({ statePath: path.join(root, "authority.json") }), credential = authority.enroll(authority.issueBootstrapTicket().ticket, "speech-node");
  const server = http.createServer((request, response) => {
    if (evaluateLanAgentRequest(request, authority, true).kind !== "agent") { response.writeHead(401).end(); return; }
    markAuthenticatedConnectionRequest(request, () => { assertTrustedLanAgentPrincipal(request); });
    registerLanAgentBodyGuard(request, body => assertLanAgentBodyAuthority(new URL(request.url!, "http://fixture").pathname, body, undefined));
    if (!registry.handle(request, new URL(request.url!, "http://fixture"), response)) response.writeHead(404).end();
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { await Promise.all([registration.dispose(), proxyRegistration.dispose(), owner.events.stop()]); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir())); await fs.rm(root, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${(server.address() as import("node:net").AddressInfo).port}`;
  const send = (url: string, method = "GET", body?: unknown, headers: Record<string, string> = {}, signal?: AbortSignal, onData?: () => void) => new Promise<{ status: number; headers: http.IncomingHttpHeaders; bytes: Buffer; json(): any }>((resolve, reject) => {
    const request = http.request(base + url, { method, signal, headers: { authorization: "Bearer " + credential.token, "content-type": "text/plain", ...headers } }, response => {
      const chunks: Buffer[] = []; response.on("data", chunk => { chunks.push(Buffer.from(chunk)); onData?.(); }); response.on("error", reject);
      response.on("end", () => { const bytes = Buffer.concat(chunks); resolve({ status: response.statusCode!, headers: response.headers, bytes, json: () => JSON.parse(bytes.toString()) }); });
    }); request.on("error", reject); request.setTimeout(10000, () => request.destroy(new Error("Controlled speech fixture request timed out."))); request.end(body === undefined ? undefined : Buffer.isBuffer(body) ? body : typeof body === "string" ? body : JSON.stringify(body));
  });
  return { root, context, owner, registry, definitions, registration, proxyRegistration, send, calls, targets, authority, credential };
}

test("an enrolled empty node reaches all 32 native operations and 7 exact local proxy branches", async t => {
  const f = await fixture(t); assert.equal(f.definitions.operations.length, 32); assert.equal(f.definitions.proxies.length, 7);
  const definitions = [...f.definitions.operations, ...f.definitions.proxies]; assert.equal(new Set(definitions.map(value => value.contract.operationId)).size, 39);
  for (const definition of definitions) {
    assert.deepEqual(definition.contract.aliases, ["speech:" + definition.contract.method + ":" + definition.contract.pathTemplate]);
    const contract = definition.contract, url = contract.pathTemplate.replace(":speakerId", "speaker-fixture").replace(":recordId", "record-fixture").replace(":modelId", "model-fixture");
    const body = contract.method === "GET" || contract.method === "DELETE" ? undefined : contract.operationId.endsWith(".asr") ? Buffer.from("--fixture-boundary\r\nraw-body") : {};
    const reply = await f.send(url, contract.method, body, { "content-type": contract.operationId.endsWith(".asr") ? "multipart/form-data; boundary=fixture-boundary" : "application/json", "x-rabiroute-expected-application-generation-id": "fixture-generation", "x-rabiroute-expected-manager-instance-id": "fixture-manager" });
    assert.equal(reply.status, contract.operationId.endsWith(".install") ? 202 : 200, contract.operationId + ": " + reply.bytes.toString());
    assert.equal(reply.headers["x-rabiroute-api-contract"] !== undefined || f.definitions.proxies.includes(definition as any), true);
  }
  assert.equal(f.calls.filter(call => call.method === "synthesize").length, 1); assert.equal(f.calls.filter(call => call.method === "transcribe").length, 1);
  assert.equal((f.calls.find(call => call.method === "acceptMessage")!.args[0] as any).sourceDeviceId, "fixture-host");
});

test("native audio bytes and headers stay exact; ASR consumes original multipart bytes once", async t => {
  const f = await fixture(t), raw = Buffer.from("--fixture\r\n\u0000original\r\n--fixture--");
  const response = await f.send("/api/speech/asr", "POST", raw, { "content-type": "multipart/form-data; boundary=fixture" });
  assert.equal(response.status, 200); assert.equal(response.headers["content-type"], "audio/x-fixture"); assert.equal(response.headers["x-rabispeech-model"], "fixture-model"); assert.deepEqual(response.bytes, Buffer.from([0, 1, 255, 128]));
  assert.deepEqual(f.calls.find(call => call.method === "transcribe")!.args[1], raw);
  await f.send("/api/speech/models?computeDeviceId=compute-fixture&computeDeviceId=ignored"); await f.send("/api/speech/tts?computeDeviceId=", "POST", {});
  assert.deepEqual(f.targets.slice(-2), ["compute-fixture", ""]);
});

test("directory settings retain connection identity, lifecycle headers, read-only gate and original local decoder", async t => {
  const f = await fixture(t);
  assert.equal((await f.send("/api/speech/model-management/settings", "PATCH", "not-json")).status, 400);
  const headers = { "x-rabiroute-expected-application-generation-id": "fixture-generation", "x-rabiroute-expected-manager-instance-id": "fixture-manager" };
  assert.equal((await f.send("/api/speech/model-management/settings", "PATCH", {}, headers)).status, 415);
  const saved = await f.send("/api/speech/model-management/settings", "PATCH", { expectedRevision: 0, modelRoot: null }, { ...headers, "content-type": "application/json" });
  assert.equal(saved.status, 200); assert.deepEqual(saved.json().data.body, { expectedRevision: 0, modelRoot: null }); assert.equal(saved.headers["cache-control"], "no-store");
  const readOnly = await fixture(t, { readOnly: true }); assert.equal((await readOnly.send("/api/speech/model-management/settings", "PATCH", "not-json")).status, 423);
});

test("native errors and original-node revocation suppress disclosure after accepted audio work", async t => {
  let entered!: () => void, release!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
  t.after(release);
  const f = await fixture(t, { control: { synthesize: async () => { entered(); await gate; return { status: 200, contentType: "audio/wav", headers: {}, body: Buffer.from("private-fixture-audio") }; } } });
  const pending = f.send("/api/speech/tts", "POST", {}); await started; f.authority.setNodeEnabled(f.credential.nodeId, false, true); f.authority.setNodeEnabled(f.credential.nodeId, true, false); release();
  const reply = await pending; assert.equal(reply.status, 403); assert.equal(reply.bytes.includes(Buffer.from("private-fixture-audio")), false);
  const errors = await fixture(t, { control: { startMicrophone: async () => { throw new SpeechControlError("Controlled native command rejection.", 409); } } });
  const error = await errors.send("/api/speech/microphone/start", "POST", {}); assert.equal(error.status, 409); assert.deepEqual(error.json(), { code: -1, message: "Controlled native command rejection." });
});

test("selected-peer exact proxy forwards raw bytes to the captured Manager without decoding or local fallback", async t => {
  const { Duplex } = await import("node:stream");
  const captured: Array<{ service: string; path: string; method: string }> = [], requestChunks: Buffer[] = [];
  class NativeStream extends Duplex {
    readonly response = Promise.resolve({ status: 207, headers: { "content-type": "application/x-fixture", "x-native-owner": "selected-peer" } });
    override _read() {}
    override _write(chunk: Buffer, _encoding: BufferEncoding, done: (error?: Error | null) => void) { requestChunks.push(Buffer.from(chunk)); done(); }
    override _final(done: (error?: Error | null) => void) { done(); this.push(Buffer.from([0, 255, 7])); this.push(null); }
  }
  const f = await fixture(t, { capture: request => ({ guard: () => { assertTrustedLanAgentPrincipal(request); }, run: action => action(), targetLocal: false, selectedPeer: { deviceId: "peer-fixture", runtime: { session: async id => { assert.equal(id, "peer-fixture"); return { remote: { deviceId: "peer-fixture" }, open: (selection: any) => { captured.push(selection); return new NativeStream(); } } as any; } } } }) });
  f.context.speechModelManager.updateDirectorySettings = () => assert.fail("Remote selection must not mutate local settings.");
  const body = Buffer.from("native-opaque-not-json\u0000"), reply = await f.send("/api/speech/model-management/settings?original=yes", "PATCH", body);
  assert.equal(reply.status, 207); assert.equal(reply.headers["x-native-owner"], "selected-peer"); assert.deepEqual(reply.bytes, Buffer.from([0, 255, 7])); assert.deepEqual(Buffer.concat(requestChunks), body);
  assert.deepEqual(captured.map(value => [value.service, value.path, value.method]), [["manager", "/api/speech/model-management/settings?original=yes", "PATCH"]]);
});

test("selected-peer connection failure never invokes the local runtime owner", async t => {
  const f = await fixture(t, { capture: request => ({ guard: () => { assertTrustedLanAgentPrincipal(request); }, run: action => action(), targetLocal: false, selectedPeer: { deviceId: "offline-fixture", runtime: { session: async () => { throw new Error("Controlled peer unavailable."); } } } }) });
  f.context.speechRuntimeControl.start = () => assert.fail("Peer failure must not start local runtime.");
  const reply = await f.send("/api/speech/runtime/start", "POST", "not-json"); assert.equal(reply.status, 502); assert.equal(reply.json().code, -1);
});

test("real speech control uses only a controlled HTTP service and preserves native TTS/ASR wire payloads", async t => {
  const upstreamCalls: Array<{ url: string; bytes: Buffer }> = [];
  const service = http.createServer((request, response) => {
    const chunks: Buffer[] = []; request.on("data", chunk => chunks.push(Buffer.from(chunk))); request.on("end", () => {
      upstreamCalls.push({ url: request.url!, bytes: Buffer.concat(chunks) });
      if (request.url === "/v1/models") { response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ data: [{ id: "fixture-model", capability: "tts" }] })); return; }
      if (request.url === "/v1/audio/transcriptions") { response.writeHead(422, { "content-type": "application/problem+json", "x-rabispeech-provider": "fixture-provider" }).end('{"native":"fixture rejection"}'); return; }
      response.writeHead(200, { "content-type": "audio/x-fixture", "x-rabispeech-model": "fixture-model" }).end(Buffer.from([9, 0, 255]));
    });
  });
  await new Promise<void>(resolve => service.listen(0, "127.0.0.1", resolve)); t.after(async () => { service.closeAllConnections(); await new Promise<void>(resolve => service.close(() => resolve())); });
  const url = `http://127.0.0.1:${(service.address() as import("node:net").AddressInfo).port}`;
  const native = new ManagerSpeechControl({ serviceUrl: () => url, personas: () => [], route: () => undefined, routes: () => [], deliverTranscript: async () => ({ status: "failed", reason: "fixture", detail: "Controlled fixture." }), appendRouteLog: () => {} });
  const f = await fixture(t, { control: { models: native.models.bind(native), synthesize: native.synthesize.bind(native), transcribe: native.transcribe.bind(native) } });
  const models = await f.send("/api/speech/models"); assert.equal(models.status, 200); assert.equal(models.json().data.models[0].id, "fixture-model");
  const tts = await f.send("/api/speech/tts", "POST", { model: "fixture-model", input: " Hello ", voice: "sample", responseFormat: "wav", speed: 1, language: null, instructions: null, play: false, sessionId: null, routeId: null });
  assert.equal(tts.status, 200); assert.deepEqual(tts.bytes, Buffer.from([9, 0, 255])); const sent = JSON.parse(upstreamCalls.find(call => call.url === "/v1/audio/speech")!.bytes.toString()); assert.equal(sent.input, "Hello"); assert.equal(sent.play, false); assert.equal(sent.response_format, "wav");
  const multipart = Buffer.from("--fixture\r\noriginal-asr-bytes\r\n--fixture--");
  const asr = await f.send("/api/speech/asr", "POST", multipart, { "content-type": "multipart/form-data; boundary=fixture" });
  assert.equal(asr.status, 422); assert.equal(asr.headers["content-type"], "application/problem+json"); assert.equal(asr.headers["x-rabispeech-provider"], "fixture-provider"); assert.equal(asr.bytes.toString(), '{"native":"fixture rejection"}'); assert.deepEqual(upstreamCalls.find(call => call.url === "/v1/audio/transcriptions")!.bytes, multipart);
});

test("a captured compute target change suppresses the original result instead of selecting another owner", async t => {
  let current = "original", entered!: () => void, release!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
  t.after(release);
  const f = await fixture(t, { capture: request => { const original = current; return { targetLocal: false, run: action => action(), guard: () => { assertTrustedLanAgentPrincipal(request); if (current !== original) throw new SpeechControlError("Original speech owner changed; inspect original work.", 409); } }; }, control: { models: async () => { entered(); await gate; return [{ id: "original-private-result" }] as any; } } });
  const pending = f.send("/api/speech/models?computeDeviceId=original"); await started; current = "replacement"; release(); const response = await pending;
  assert.equal(response.status, 409); assert.equal(response.bytes.includes(Buffer.from("original-private-result")), false);
});

test("typed audio retirement joins accepted native work after HTTP disconnect", async t => {
  let entered!: () => void, release!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
  t.after(release);
  const f = await fixture(t, { control: { synthesize: async () => { entered(); await gate; return { status: 200, contentType: "audio/wav", headers: {}, body: Buffer.from("fixture") }; } } });
  const abort = new AbortController(), pending = f.send("/api/speech/tts", "POST", {}, {}, abort.signal).catch(() => null); await started; abort.abort(); await pending;
  let retired = false; const retiring = f.registration.dispose().then(() => { retired = true; }); await new Promise<void>(resolve => setImmediate(resolve)); assert.equal(retired, false); release(); await retiring; assert.equal(retired, true);
});

test("speech plugin retirement joins original installer cleanup even when another native cleanup fails", async () => {
  const plugin = await import(new URL("../../plugins/builtin/io.rabiroute.manager.speech/1.0.0/manager.mjs", import.meta.url).href);
  let start!: () => Promise<() => Promise<void>>, release!: () => void;
  let publication!: PluginPublication;
  const gate = new Promise<void>(resolve => { release = resolve; }), events: string[] = [];
  const runtime = { SpeechApiOwner, createSpeechApiOperations: () => ({ operations: [], proxies: [] }), speechApiContext: {}, managerServicesReady: false, managerReadOnly: false, reconcileSpeechMicrophone: () => {}, reconcileActiveSpeech: undefined as unknown,
    managerPluginRoutes: { registerOperationsAsync: async () => ({ dispose: async () => { events.push("typed-retired"); } }), registerHttpProxies: () => ({ dispose: async () => { events.push("proxy-retired"); } }) },
    speechControl: { stopMicrophone: async () => { events.push("microphone-stop"); throw new Error("Controlled microphone cleanup failure."); }, stopPlayback: async () => { events.push("playback-stop"); } },
    speechRuntimeControl: { stop: async () => { events.push("runtime-stop"); throw new Error("Controlled runtime cleanup failure."); } }, speechModelManager: { stop: async () => { events.push("installer-stop"); await gate; events.push("installer-closed"); } }
  };
  await plugin.activate({ identity: { instanceId: "speech-fixture" }, lifecycle: { signal: new AbortController().signal }, services: { require: () => runtime, provide: () => {} }, contributions: { register: () => {} }, effects: { add: (starter: typeof start) => { start = starter; } }, publication: { add: (entry: PluginPublication) => { publication = entry; } } });
  const retire = await start(); publication.publish(); await publication.afterPublish?.({ signal: new AbortController().signal, previousRetirement: Promise.resolve() });
  let finished = false; const retiring = retire().then(() => null, error => { finished = true; return error; }); await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(finished, false); assert.deepEqual(events, ["typed-retired", "proxy-retired", "runtime-stop", "installer-stop"]);
  release(); const failure = await retiring; assert.match(failure.message, /Controlled runtime cleanup failure/); assert.equal(events.at(-1), "installer-closed");
});

test("native bodyless audio statuses remain bodyless rather than becoming schema failures", async t => {
  for (const status of [204, 304]) {
    const f = await fixture(t, { control: { recordAudio: async () => ({ status, contentType: "audio/x-fixture", headers: {}, body: Buffer.alloc(0) }) } });
    const response = await f.send("/api/speech/records/fixture/audio"); assert.equal(response.status, status); assert.equal(response.bytes.length, 0);
  }
});

test("speech event opening revalidates revoked success and failure without disclosing upstream content", async t => {
  for (const upstreamFails of [false, true]) {
    const f = await fixture(t, { control: { eventStream: async () => { f.authority.setNodeEnabled(f.credential.nodeId, false, true); f.authority.setNodeEnabled(f.credential.nodeId, true, false); if (upstreamFails) throw new Error("private upstream failure"); return new Response("private upstream stream", { headers: { "content-type": "text/event-stream" } }); } } });
    const response = await f.send("/api/speech/events"); assert.equal(response.status, 403); assert.equal(response.bytes.includes(Buffer.from("private upstream")), false);
  }
});

test("real HTTP speech SSE disconnection aborts its native upstream and permits independent status", async t => {
  let upstreamAborted!: () => void;
  const aborted = new Promise<void>(resolve => { upstreamAborted = resolve; });
  const f = await fixture(t, { control: { eventStream: async signal => new Response(new ReadableStream({ start(controller) { controller.enqueue(Buffer.from("event: ready\ndata: {}\n\n")); signal.addEventListener("abort", () => { upstreamAborted(); controller.error(new Error("Controlled upstream closed.")); }, { once: true }); } }), { headers: { "content-type": "text/event-stream" } }) } });
  // Use the same enrolled-node native HTTP fixture, stopping its read with AbortSignal after headers/data arrive.
  let firstChunk!: () => void; const started = new Promise<void>(resolve => { firstChunk = resolve; });
  const abort = new AbortController(), pending = f.send("/api/speech/events", "GET", undefined, {}, abort.signal, firstChunk).catch(() => null);
  await started;
  abort.abort(); await pending; await aborted;
  assert.equal((await f.send("/api/speech/status")).status, 200); await f.owner.events.stop(); assert.equal(f.owner.events.activeCount(), 0);
});
