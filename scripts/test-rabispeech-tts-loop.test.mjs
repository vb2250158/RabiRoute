import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { runRabiSpeechTtsLoopAcceptance } from "./test-rabispeech-tts-loop.mjs";

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function testWave() {
  const sampleRate = 16_000;
  const samples = sampleRate * 2;
  const dataSize = samples * 2;
  const output = Buffer.alloc(44 + dataSize);
  output.write("RIFF", 0, "ascii");
  output.writeUInt32LE(36 + dataSize, 4);
  output.write("WAVE", 8, "ascii");
  output.write("fmt ", 12, "ascii");
  output.writeUInt32LE(16, 16);
  output.writeUInt16LE(1, 20);
  output.writeUInt16LE(1, 22);
  output.writeUInt32LE(sampleRate, 24);
  output.writeUInt32LE(sampleRate * 2, 28);
  output.writeUInt16LE(2, 32);
  output.writeUInt16LE(16, 34);
  output.write("data", 36, "ascii");
  output.writeUInt32LE(dataSize, 40);
  for (let index = 0; index < samples; index += 1) {
    output.writeInt16LE(Math.round(Math.sin(index / 20) * 4000), 44 + index * 2);
  }
  return output;
}

function fakeSpeechRuntime({ apiProviders = false, emitEvents = true, staleManagerEvents = false } = {}) {
  const encoder = new TextEncoder();
  const rows = [];
  let eventController = null;
  const calls = [];
  const provider = apiProviders ? "dashscope-qwen" : "local-tts";
  const asrProvider = apiProviders ? "dashscope-qwen" : "local-asr";
  const emit = (kind, sessionId, id) => {
    if (!emitEvents || !eventController) return;
    eventController.enqueue(encoder.encode(
      `event: records_changed\ndata: ${JSON.stringify({ id, kind, time: 1, session_id: sessionId, route_id: null })}\n\n`
    ));
  };
  const fetchImpl = async (url, init = {}) => {
    const request = new URL(url);
    calls.push(`${init.method || "GET"} ${request.pathname}`);
    if (request.pathname === "/api/speech/events" || request.pathname === "/v1/events") {
      if (staleManagerEvents && request.pathname === "/api/speech/events") {
        return new Response("<!doctype html><title>old manager</title>", {
          status: 200,
          headers: { "content-type": "text/html; charset=utf-8" }
        });
      }
      return new Response(new ReadableStream({
        start(controller) {
          eventController = controller;
          controller.enqueue(encoder.encode("retry: 3000\n\nevent: ready\ndata: {}\n\n"));
        },
        cancel() { eventController = null; }
      }), { status: 200, headers: { "content-type": "text/event-stream" } });
    }
    if (request.pathname === "/health") return jsonResponse({ service: "RabiSpeech", status: "ok" });
    if (request.pathname === "/v1/models") return jsonResponse({ data: [
      {
        id: `${provider}/test-tts`, capability: "tts", provider, model: "test-tts",
        available: true, enabled: true, installed: true, status: "ready",
        request: { properties: { voice: { default: "public-test" } } }
      },
      {
        id: `${asrProvider}/test-asr`, capability: "asr", provider: asrProvider, model: "test-asr",
        available: true, enabled: true, installed: true, status: "ready"
      }
    ] });
    if (request.pathname === "/v1/capabilities") return jsonResponse({
      providers: {
        tts: { [provider]: { transport: apiProviders ? "dashscope" : "local-worker-http", local_only: !apiProviders } },
        asr: { [asrProvider]: { transport: apiProviders ? "dashscope" : "local-worker-http", local_only: !apiProviders } }
      },
      speaker_identity: { voiceprint: { available: true, supported: false, validated: false, model: "speaker-test" } }
    });
    if (request.pathname === "/v1/audio/speech" && init.method === "POST") {
      const body = JSON.parse(init.body);
      rows.unshift({
        id: "tts-record", kind: "tts", session_id: body.session_id,
        provider, model: "test-tts", audio_file: "output/tts-audio/test.wav"
      });
      emit("tts", body.session_id, "tts-record");
      return new Response(testWave(), {
        status: 200,
        headers: { "content-type": "audio/wav", "x-rabispeech-provider": provider, "x-rabispeech-model": "test-tts" }
      });
    }
    if (request.pathname === "/v1/audio/transcriptions" && init.method === "POST") {
      const sessionId = String(init.body.get("session_id"));
      rows.unshift({ id: "asr-record", kind: "asr", session_id: sessionId, provider: asrProvider, model: "test-asr" });
      emit("asr", sessionId, "asr-record");
      return jsonResponse({
        text: "[0] 这是一条由文本转语音模型生成的系统测试音频，用来验证语音转写、声纹提取和事件记录链路。",
        duration: 2,
        segments: [{
          id: 0, start: 0, end: 2, text: "测试", speaker: "0",
          voiceprint_id: "cluster-test", speaker_decision: "voiceprint_unknown_cluster",
          speaker_model: "speaker-test", speaker_sample_duration: 1.8
        }]
      });
    }
    if (request.pathname === "/v1/records") return jsonResponse({ data: rows });
    if (request.pathname === "/api/speech/status") return jsonResponse({ code: 0, data: { state: "online", service: "RabiSpeech" } });
    if (request.pathname === "/api/speech/records") return jsonResponse({
      code: 0,
      data: { records: rows.map(row => ({
        id: row.id,
        kind: row.kind,
        sessionId: row.session_id,
        provider: row.provider,
        model: row.model,
        ...(row.audio_file ? { audioFile: row.audio_file } : {})
      })) }
    });
    return jsonResponse({ message: "not found" }, 404);
  };
  return { fetchImpl, calls };
}

test("TTS loop acceptance waits for SSE events and queries records once after completion", async () => {
  const runtime = fakeSpeechRuntime();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rabispeech-tts-loop-"));
  const result = await runRabiSpeechTtsLoopAcceptance({
    outputPath: path.join(root, "report.json"),
    timeoutMs: 2_000
  }, {
    fetchImpl: runtime.fetchImpl,
    now: () => new Date("2026-07-23T12:00:00.000Z")
  });

  assert.equal(result.exitCode, 0);
  assert.equal(result.report.acceptancePassed, true);
  assert.equal(result.report.routeDeliveryAttempted, false);
  assert.equal(result.report.voiceprint.evidenceCount, 1);
  assert.equal(runtime.calls.filter(value => value === "GET /v1/records").length, 1);
  assert.equal(runtime.calls.filter(value => value === "GET /api/speech/records").length, 1);
  assert.ok(runtime.calls.indexOf("GET /api/speech/events") < runtime.calls.indexOf("POST /v1/audio/speech"));
  assert.equal(fs.existsSync(result.wavPath), true);
  const evidence = fs.readFileSync(result.evidencePath, "utf8");
  assert.equal(evidence.includes("cluster-test"), false);
  assert.equal(evidence.includes("public-test"), false);
  assert.equal(evidence.includes("这是一条"), false);
});

test("API providers require explicit authorization", async () => {
  const runtime = fakeSpeechRuntime({ apiProviders: true });
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rabispeech-tts-loop-api-"));
  const denied = await runRabiSpeechTtsLoopAcceptance({
    outputPath: path.join(root, "denied.json"),
    timeoutMs: 2_000
  }, { fetchImpl: runtime.fetchImpl });
  assert.equal(denied.exitCode, 1);
  assert.match(denied.report.error, /--allow-api-provider/);

  const allowed = await runRabiSpeechTtsLoopAcceptance({
    outputPath: path.join(root, "allowed.json"),
    allowApiProvider: true,
    timeoutMs: 2_000
  }, { fetchImpl: fakeSpeechRuntime({ apiProviders: true }).fetchImpl });
  assert.equal(allowed.exitCode, 0);
});

test("missing records_changed events fail by one-shot deadline without record polling", async () => {
  const runtime = fakeSpeechRuntime({ emitEvents: false });
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rabispeech-tts-loop-events-"));
  const result = await runRabiSpeechTtsLoopAcceptance({
    outputPath: path.join(root, "report.json"),
    timeoutMs: 80
  }, { fetchImpl: runtime.fetchImpl });

  assert.equal(result.exitCode, 1);
  assert.match(result.report.error, /one-shot deadline/);
  assert.equal(runtime.calls.includes("GET /v1/records"), false);
  assert.equal(runtime.calls.includes("GET /api/speech/records"), false);
});

test("acceptance refuses non-loopback service URLs", async () => {
  await assert.rejects(
    () => runRabiSpeechTtsLoopAcceptance({ speechUrl: "https://speech.example.com" }),
    /loopback URL/
  );
});

test("stale Manager HTML fails closed instead of falling back to record polling", async () => {
  const runtime = fakeSpeechRuntime({ staleManagerEvents: true });
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rabispeech-tts-loop-stale-manager-"));
  const result = await runRabiSpeechTtsLoopAcceptance({
    outputPath: path.join(root, "report.json"),
    timeoutMs: 2_000
  }, { fetchImpl: runtime.fetchImpl });

  assert.equal(result.exitCode, 1);
  assert.match(result.report.error, /running Manager may not expose the current speech SSE API/);
  assert.equal(runtime.calls.includes("POST /v1/audio/speech"), false);
  assert.equal(runtime.calls.includes("GET /v1/records"), false);
});
