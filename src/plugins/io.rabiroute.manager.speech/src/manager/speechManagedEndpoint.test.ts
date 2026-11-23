import assert from "node:assert/strict";
import { createServer } from "node:http";
import { PassThrough } from "node:stream";
import test from "node:test";
import { SpeechRuntimeControl } from "./speechRuntimeControl.js";
import type { SpeechRuntimeStatus } from "@rabiroute/host-api/shared/speechControlContract";

function fixture(options: { nonceValid?: boolean; ownerMatches?: boolean; publish?: boolean; retire?: boolean; port?: number } = {}) {
  const port = options.port ?? 31415;
  let clock = 0, launches = 0, probes = 0, killed = 0, nonce = "", assistantAudioToken = "";
  const child = { pid: 123, exitCode: null as number | null, stdout: new PassThrough(), stderr: new PassThrough(), unref() {} };
  const record = () => ({ schemaVersion: 1, nonce: options.nonceValid === false ? "stale-nonce" : nonce, pid: 456, host: "127.0.0.1", port });
  const control = new SpeechRuntimeControl({
    rootDir: "C:/RabiRoute", platform: "win32", managedEndpoint: () => true,
    serviceUrl: () => "", existsSync: () => true,
    startTimeoutMs: 500, stopTimeoutMs: 500, now: () => clock,
    wait: async ms => { clock += ms; await new Promise(resolve => setImmediate(resolve)); },
    inspectOwner: async requestedPort => { assert.equal(requestedPort, port); return child.exitCode !== null ? null : { pid: options.ownerMatches === false ? 999 : 456, owned: true }; },
    inspect: async url => { probes++; assert.equal(url, `http://127.0.0.1:${port}`); return { state: "online", checkedAt: "fixture", configuredUrl: url, service: "RabiSpeech", defaults: {}, providers: { tts: [], asr: [] } } satisfies SpeechRuntimeStatus; },
    spawnRuntime: (_command, _args, launch) => {
      child.exitCode = null;
      launches++; nonce = String(launch!.env!.RABISPEECH_ENDPOINT_NONCE);
      assistantAudioToken = String(launch!.env!.RABISPEECH_ASSISTANT_AUDIO_TOKEN);
      assert.equal(launch!.env!.RABISPEECH_PORT, "0"); assert.equal(launch!.env!.RABISPEECH_HOST, "127.0.0.1"); assert.equal(launch!.detached, false);
      if (options.publish !== false) queueMicrotask(() => {
        const line = "RABISPEECH_READY:" + JSON.stringify(record()) + "\n";
        child.stdout.write(line.slice(0, 12)); child.stdout.write(line.slice(12));
      });
      return child;
    },
    killProcessTree: async pid => { assert.equal(pid, 123, "only the launched tree may be terminated"); killed++; if (options.retire !== false) child.exitCode = 0; }
  });
  return { control, child, record, assistantAudioToken: () => assistantAudioToken, counts: () => ({ launches, probes, killed }) };
}

test("managed Speech publishes only its verified actual descendant endpoint and coalesces starts", async () => {
  const f = fixture(); assert.throws(() => f.control.serviceUrl(), /尚未发布/);
  await Promise.all([f.control.start(), f.control.start()]);
  assert.equal(f.control.serviceUrl(), "http://127.0.0.1:31415");
  assert.equal(f.counts().launches, 1);
  await f.control.releaseOwnedRuntime();
  assert.equal(f.child.exitCode, 0); assert.throws(() => f.control.serviceUrl(), /尚未发布/);
});

test("wrong nonce or process ownership never becomes a managed endpoint", async () => {
  for (const options of [{ nonceValid: false }, { ownerMatches: false }]) {
    const f = fixture(options);
    await assert.rejects(f.control.start());
    assert.equal(f.counts().probes, 0); assert.equal(f.child.exitCode, 0);
    assert.throws(() => f.control.serviceUrl());
  }
});

test("retirement cancels a pending managed handshake and joins the launched process", async () => {
  const f = fixture({ publish: false });
  const starting = f.control.start();
  const rejected = assert.rejects(starting, /取消|配置已变化/);
  await new Promise(resolve => setImmediate(resolve));
  await f.control.releaseOwnedRuntime(); await rejected;
  assert.equal(f.child.exitCode, 0); assert.equal(f.counts().killed, 1);
  assert.throws(() => f.control.serviceUrl());
});

test("unconfirmed process retirement retains its owner for a later release", async () => {
  const f = fixture({ retire: false }); await f.control.start();
  await assert.rejects(f.control.releaseOwnedRuntime(), /无法确认/);
  assert.equal(f.child.exitCode, null); assert.throws(() => f.control.serviceUrl());
  f.child.exitCode = 0; await f.control.releaseOwnedRuntime();
});

test("configured Speech URLs remain explicit and never require a managed handshake", () => {
  const control = new SpeechRuntimeControl({ rootDir: "fixture", serviceUrl: () => "https://speech.example.test:9443", managedEndpoint: () => false });
  assert.equal(control.serviceUrl(), "https://speech.example.test:9443");
});

test("an unstarted managed owner with no raw URL can stop and release without probing a fixed address", async () => {
  const f = fixture();
  assert.equal((await f.control.stop()).action, "already_offline");
  await f.control.releaseOwnedRuntime();
  assert.deepEqual(f.counts(), { launches: 0, probes: 0, killed: 0 });
});

test("configured URL changes release the original child and bind before launching the next configured target", async () => {
  let url = "http://127.0.0.1:31415";
  const children: Array<{ pid: number; exitCode: number | null; port: number; unref(): void }> = [];
  const actions: string[] = [];
  const control = new SpeechRuntimeControl({
    rootDir: "C:/RabiRoute", platform: "win32", managedEndpoint: () => false, serviceUrl: () => url, existsSync: () => true,
    inspect: async value => ({ state: children.some(child => child.exitCode === null && child.port === Number(new URL(value).port)) ? "online" : "offline", checkedAt: "fixture", configuredUrl: value, defaults: {}, providers: { tts: [], asr: [] } }),
    spawnRuntime: (_command, _args, options) => {
      const port = Number(options!.env!.RABISPEECH_PORT);
      assert.equal(options!.env!.RABISPEECH_HOST, "127.0.0.1");
      actions.push("start:" + port);
      const child = { pid: children.length + 100, exitCode: null, port, unref() {} }; children.push(child); return child;
    },
    inspectOwner: async port => { const child = children.find(child => child.port === port && child.exitCode === null); return child ? { pid: child.pid, owned: true } : null; },
    killProcessTree: async pid => { const child = children.find(child => child.pid === pid)!; actions.push("stop:" + child.port); child.exitCode = 0; }
  });
  await control.start();
  url = "http://127.0.0.1:31416"; await control.reconfigure();
  assert.deepEqual(actions, ["start:31415", "stop:31415", "start:31416"]);
  assert.equal(children[0].exitCode, 0); assert.equal(children[1].exitCode, null);
  await control.releaseOwnedRuntime(); assert.equal(children[1].exitCode, 0);
});

test("remote configured changes query the current provider without acquiring or stopping a local runtime", async () => {
  let url = "https://speech-a.example.test";
  const queries: string[] = [];
  const control = new SpeechRuntimeControl({ rootDir: "fixture", serviceUrl: () => url, managedEndpoint: () => false,
    inspect: async address => { queries.push(address); return { state: "offline", checkedAt: "fixture", configuredUrl: address, defaults: {}, providers: { tts: [], asr: [] } }; },
    inspectOwner: async () => { assert.fail("external providers have no local ownership lookup"); },
    spawnRuntime: () => { assert.fail("external providers are not locally launched"); },
    killProcessTree: async () => { assert.fail("external providers are not locally stopped"); }
  });
  const superseded = control.reconfigure(); const rejected = assert.rejects(superseded, /配置已再次变化/);
  url = "https://speech-b.example.test";
  const latest = await control.reconfigure(); await rejected;
  assert.equal(latest.action, "already_offline"); assert.deepEqual(queries, [url]);
});

test("configuration reconciliation never replaces an owner whose process retirement remains unconfirmed", async () => {
  const f = fixture({ retire: false }); await f.control.start();
  await assert.rejects(f.control.reconfigure(), /无法确认/);
  assert.equal(f.counts().launches, 1); assert.equal(f.child.exitCode, null);
  assert.throws(() => f.control.serviceUrl());
  f.child.exitCode = 0; await f.control.releaseOwnedRuntime();
});


test("assistant PCM reads are scoped to the owning managed process and carry the sample cursor", async () => {
  const bytes = Buffer.from([1, 0, 2, 0]);
  const requests: Array<{ path: string | undefined; token: unknown; aliases?: string[] }> = [];
  const profile = {
    model: "sherpa-onnx-kws-zipformer-zh-en-3M-2025-12-20",
    keywords: "Y E @rabi-0/D A @rabi-1",
    tokensSha256: "1".repeat(64)
  };
  const endpoint = createServer(async (request, response) => {
    const entry: typeof requests[number] = { path: request.url, token: request.headers["x-rabispeech-assistant-token"] };
    requests.push(entry);
    if (request.method === "POST") {
      const body = [];
      for await (const chunk of request) body.push(chunk as Buffer);
      entry.aliases = JSON.parse(Buffer.concat(body).toString()).aliases;
      if (request.url === "/v1/internal/assistant-keywords") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify(profile));
        return;
      }
      response.writeHead(200, { "content-type": "application/x-ndjson" });
      response.end('{"type":"ready"}\n');
    } else {
      response.writeHead(200, { "content-type": "application/octet-stream" });
      response.end(bytes);
    }
  });
  try {
    await new Promise<void>(resolve => endpoint.listen(0, "127.0.0.1", resolve));
    const address = endpoint.address();
    assert(address && typeof address === "object");
    const f = fixture({ port: address.port }), signal = AbortSignal.timeout(3000);
    assert.throws(() => f.control.openAssistantCapture(signal), /尚未发布/);
    await f.control.start();
    try {
      const response = await f.control.openAssistantCapture(signal, { captureId: "window-a", sample: 1440 });
      assert.equal(response.statusCode, 200);
      const received = [];
      for await (const chunk of response) received.push(chunk as Buffer);
      assert.deepEqual(Buffer.concat(received), bytes);
      assert.equal(requests.length, 1);
      assert.equal(requests[0].path, "/v1/internal/assistant-capture?capture_id=window-a&from_sample=1440");
      assert(f.assistantAudioToken().length > 30);
      assert.equal(requests[0].token, f.assistantAudioToken());
      const wakes = await f.control.openAssistantWake(["夜雨", "大肥鱼"], signal);
      const frames = [];
      for await (const frame of wakes) frames.push(frame as Buffer);
      assert.equal(JSON.parse(Buffer.concat(frames).toString()).type, "ready");
      assert.equal(requests[1].path, "/v1/internal/assistant-wake");
      assert.deepEqual(requests[1].aliases, ["夜雨", "大肥鱼"]);
      assert.equal(requests[1].token, f.assistantAudioToken());
      assert.deepEqual(await f.control.assistantKeywordProfile(["夜雨", "大肥鱼"], signal), profile);
      assert.equal(requests[2].path, "/v1/internal/assistant-keywords");
      assert.deepEqual(requests[2].aliases, ["夜雨", "大肥鱼"]);
      assert.equal(requests[2].token, f.assistantAudioToken());
      await assert.rejects(f.control.assistantKeywordProfile(["夜雨"], signal), /位置不匹配/);
    } finally {
      await f.control.releaseOwnedRuntime();
    }
    assert.throws(() => f.control.openAssistantCapture(signal), /尚未发布/);
  } finally {
    await new Promise<void>(resolve => endpoint.close(() => resolve()));
  }
});


test("mobile local ASR proves exact owned worker and authenticated private route before accepting bytes", async () => {
  let modelAvailable = true, modelEnabled: boolean | undefined, providerEnabled = true;
  let transport = "loopback-http", transcribeStatus = 422, redirectTargetHits = 0;
  const calls: Array<{ path: string | undefined; token: unknown; bytes: number }> = [];
  let announceProbe!: () => void, releaseProbe!: () => void;
  const probeStarted = new Promise<void>(resolve => { announceProbe = resolve; });
  const probeContinues = new Promise<void>(resolve => { releaseProbe = resolve; });
  const endpoint = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk as Buffer);
    const bytes = Buffer.concat(chunks).length;
    calls.push({ path: request.url, token: request.headers["x-rabispeech-assistant-token"], bytes });
    const send = (status: number, body: object) => response.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
    if (request.url === "/v1/capabilities") {
      announceProbe();
      await probeContinues;
      send(200, { relay_safe: false, providers: { asr: { fireredasr2: { transport, enabled: providerEnabled,
        models: [{ id: "fireredasr2-aed", installed: modelAvailable, enabled: modelEnabled }] } } } });
    } else if (request.url === "/untrusted") {
      redirectTargetHits++;
      send(200, { text: "untrusted" });
    } else if (bytes && transcribeStatus === 307) {
      response.writeHead(307, { location: "/untrusted" }).end();
    } else if (bytes) {
      send(200, { text: "local result" });
    } else {
      send(transcribeStatus, { detail: transcribeStatus === 422 ? "ASSISTANT_LOCAL_AUDIO_EMPTY" : "unavailable" });
    }
  });
  try {
    await new Promise<void>(resolve => endpoint.listen(0, "127.0.0.1", resolve));
    const address = endpoint.address();
    assert(address && typeof address === "object");
    const signal = AbortSignal.timeout(10_000);
    const wav = Buffer.alloc(46);
    const f = fixture({ port: address.port });
    assert.equal(await f.control.assistantLocalAsrModel(signal), undefined);
    await assert.rejects(f.control.transcribeMobileAssistantAudio(wav, signal), /MOBILE_LOCAL_ASR_UNAVAILABLE/);
    assert.equal(calls.length, 0);
    await f.control.start();
    const stateRead = new AbortController();
    const initialCheck = f.control.assistantLocalAsrModel(stateRead.signal);
    const initialRejected = assert.rejects(initialCheck, { name: "AbortError" });
    await probeStarted;
    stateRead.abort();
    await initialRejected;
    const rejectedSpeech = new AbortController();
    const rejectedRequest = assert.rejects(f.control.transcribeMobileAssistantAudio(wav, rejectedSpeech.signal), { name: "AbortError" });
    const validRequest = f.control.transcribeMobileAssistantAudio(wav, signal);
    rejectedSpeech.abort();
    await rejectedRequest;
    assert.equal(calls.length, 1, "state timeout must not cancel or duplicate the shared probe");
    releaseProbe();
    assert.deepEqual(await validRequest, { text: "local result" });
    assert.equal(await f.control.assistantLocalAsrModel(signal), "fireredasr2/fireredasr2-aed");
    assert.deepEqual(calls.map(call => [call.path, call.bytes]), [
      ["/v1/capabilities", 0], ["/v1/internal/assistant-transcribe", 0], ["/v1/internal/assistant-transcribe", 46],
    ]);
    assert(calls.every(call => call.token === f.assistantAudioToken()));
    transcribeStatus = 307;
    await assert.rejects(f.control.transcribeMobileAssistantAudio(wav, signal), /本机识别未完成/);
    assert.equal(redirectTargetHits, 0);
    await f.control.releaseOwnedRuntime();
    assert.equal(await f.control.assistantLocalAsrModel(signal), undefined);
    await assert.rejects(f.control.transcribeMobileAssistantAudio(wav, signal), /MOBILE_LOCAL_ASR_UNAVAILABLE/);
    assert.equal(calls.length, 4);
    const originalToken = f.assistantAudioToken();
    transport = "https";
    await f.control.start();
    assert.notEqual(f.assistantAudioToken(), originalToken);
    assert.equal(await f.control.assistantLocalAsrModel(signal), undefined);
    await assert.rejects(f.control.transcribeMobileAssistantAudio(wav, signal), /MOBILE_LOCAL_ASR_UNAVAILABLE/);
    assert.deepEqual(calls[4], { path: "/v1/capabilities", token: f.assistantAudioToken(), bytes: 0 });
    assert.equal(calls.length, 5);
    transcribeStatus = 422;
    assert.deepEqual(await f.control.transcribeAssistantAudio(wav, signal), { text: "local result" });
    assert.deepEqual(calls[5], { path: "/v1/internal/assistant-transcribe", token: f.assistantAudioToken(), bytes: 46 });
    await f.control.releaseOwnedRuntime();

    for (const failure of ["provider-transport", "provider-disabled", "model-disabled", "model-unavailable", "old-endpoint"]) {
      const candidate = fixture({ port: address.port });
      transport = failure === "provider-transport" ? "https" : "loopback-http";
      providerEnabled = failure !== "provider-disabled";
      modelEnabled = failure === "model-disabled" ? false : undefined;
      modelAvailable = failure !== "model-unavailable";
      transcribeStatus = failure === "old-endpoint" ? 404 : 422;
      await candidate.control.start();
      const start = calls.length;
      assert.equal(await candidate.control.assistantLocalAsrModel(signal), undefined, failure);
      await assert.rejects(candidate.control.transcribeMobileAssistantAudio(wav, signal), /MOBILE_LOCAL_ASR_UNAVAILABLE/);
      assert(calls.slice(start).every(call => call.bytes === 0 && call.token === candidate.assistantAudioToken()));
      await candidate.control.releaseOwnedRuntime();
    }
  } finally {
    releaseProbe();
    await new Promise<void>(resolve => endpoint.close(() => resolve()));
  }
});
