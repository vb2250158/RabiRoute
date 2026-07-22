import assert from "node:assert/strict";
import test from "node:test";
import { speechControlClient } from "../src/speech/speechControlClient";

test("maps speaker identity and persistent record commands to Manager endpoints", async () => {
  const requests: Array<{ url: string; init: RequestInit }> = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = String(input);
    requests.push({ url, init });
    const data = url.startsWith("/api/speech/records")
      ? { records: [] }
      : url === "/api/speech/speakers?sessionId=session-a"
        ? {
            profiles: [],
            bindings: [],
            capability: {
              scope: "loopback-only",
              mode: "manual_session_label_binding",
              manualBinding: true,
              bindingScope: "session_speaker_label",
              aliasesAreMetadataOnly: true,
              diarizationLabelsAreBiometricIdentity: false,
              storesRawEnrollmentAudio: false,
              voiceprint: { supported: false, experimental: false }
            }
          }
        : url === "/api/speech/speakers" && init.method === "POST"
          ? { id: "speaker-00000000000000000000000000000000", displayName: "Alice", aliases: [], createdAt: 1, updatedAt: 1 }
          : url.startsWith("/api/speech/speakers/speaker-") && init.method === "PATCH"
            ? { id: "speaker-00000000000000000000000000000000", displayName: "Alice Renamed", aliases: ["A"], createdAt: 1, updatedAt: 2 }
            : url.startsWith("/api/speech/speakers/speaker-") && init.method === "DELETE"
              ? { deleted: { id: "speaker-00000000000000000000000000000000", displayName: "Alice Renamed", aliases: ["A"], createdAt: 1, updatedAt: 2 }, removedBindings: 1 }
          : url === "/api/speech/speaker-bindings" && init.method === "PUT"
                ? { sessionId: "session-a", recordId: "speech-a", speakerLabel: "Speaker 1", speakerId: "speaker-00000000000000000000000000000000", speakerName: "Alice", decision: "manual_record_binding", createdAt: 1, updatedAt: 1 }
                : { sessionId: "session-a", recordId: "speech-a", speakerLabel: "Speaker 1", speakerId: "speaker-00000000000000000000000000000000", speakerName: "Alice", decision: "manual_record_binding", createdAt: 1, updatedAt: 1 };
    return new Response(JSON.stringify({ code: 0, data }), {
      status: 200,
      headers: { "content-type": "application/json" }
    });
  }) as typeof fetch;

  try {
    await speechControlClient.records({ limit: 100, sessionId: "session-a", routeId: "voice-route" });
    await speechControlClient.speakers("session-a");
    await speechControlClient.createSpeaker({ displayName: "Alice", aliases: ["A"] });
    await speechControlClient.updateSpeaker("speaker-00000000000000000000000000000000", {
      displayName: "Alice Renamed",
      aliases: ["A"]
    });
    await speechControlClient.deleteSpeaker("speaker-00000000000000000000000000000000");
    await speechControlClient.bindSpeaker({
      sessionId: "session-a",
      recordId: "speech-a",
      speakerLabel: "Speaker 1",
      speakerId: "speaker-00000000000000000000000000000000"
    });
    await speechControlClient.unbindSpeaker("session-a", "speech-a", "Speaker 1");
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(requests[0].url, "/api/speech/records?limit=100&sessionId=session-a&routeId=voice-route");
  assert.equal(requests[1].url, "/api/speech/speakers?sessionId=session-a");
  assert.equal(requests[2].url, "/api/speech/speakers");
  assert.equal(requests[2].init.method, "POST");
  assert.deepEqual(JSON.parse(String(requests[2].init.body)), { displayName: "Alice", aliases: ["A"] });
  assert.equal(requests[3].url, "/api/speech/speakers/speaker-00000000000000000000000000000000");
  assert.equal(requests[3].init.method, "PATCH");
  assert.equal(requests[4].url, "/api/speech/speakers/speaker-00000000000000000000000000000000");
  assert.equal(requests[4].init.method, "DELETE");
  assert.equal(requests[5].url, "/api/speech/speaker-bindings");
  assert.equal(requests[5].init.method, "PUT");
  assert.equal(
    requests[6].url,
    "/api/speech/speaker-bindings?sessionId=session-a&recordId=speech-a&speakerLabel=Speaker+1"
  );
  assert.equal(requests[6].init.method, "DELETE");
});

test("updates the host playback volume through the Manager control plane", async () => {
  const requests: Array<{ url: string; init: RequestInit }> = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init: RequestInit = {}) => {
    requests.push({ url: String(input), init });
    return new Response(JSON.stringify({
      code: 0,
      data: { mode: "host_fifo", volume: 36, current: null, queued: 0, jobs: [] }
    }), {
      status: 200,
      headers: { "content-type": "application/json" }
    });
  }) as typeof fetch;

  try {
    const status = await speechControlClient.setPlaybackVolume({ volume: 36 });
    assert.equal(status.volume, 36);
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(requests[0]?.url, "/api/speech/playback/volume");
  assert.equal(requests[0]?.init.method, "PUT");
  assert.deepEqual(JSON.parse(String(requests[0]?.init.body)), { volume: 36 });
});

test("updates and reconciles the host microphone without a Route selector", async () => {
  const requests: Array<{ url: string; init: RequestInit }> = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init: RequestInit = {}) => {
    requests.push({ url: String(input), init });
    return new Response(JSON.stringify({
      code: 0,
      data: {
        running: true,
        state: "listening",
        config: {
          enabled: true,
          autoSubmit: true,
          routeId: null,
          sessionId: "rabispeech-microphone"
        },
        stats: {},
        history: [],
        events: []
      }
    }), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;

  try {
    await speechControlClient.updateMicrophoneSettings({
      device: null,
      sampleRate: 16_000,
      chunkMs: 100,
      preRollMs: 1_500,
      recordThreshold: 0.01,
      transcribeThreshold: 0.015,
      adaptiveThreshold: true,
      adaptiveMultiplier: 2.5,
      adaptiveMargin: 0.004,
      silenceMs: 500,
      minUtteranceMs: 1_000,
      maxUtteranceMs: 60_000,
      inputGain: 1,
      asrModel: "faster-whisper/small",
      language: "zh",
      prompt: null,
      suppressDuringPlayback: true
    });
    await speechControlClient.reconcileMicrophone();
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(requests[0]?.url, "/api/speech/microphone/settings");
  assert.equal(requests[0]?.init.method, "PUT");
  const body = JSON.parse(String(requests[0]?.init.body));
  assert.equal(body.asrModel, "faster-whisper/small");
  assert.equal("routeId" in body, false);
  assert.equal("sessionId" in body, false);
  assert.equal(requests[1]?.url, "/api/speech/microphone/reconcile");
  assert.equal(requests[1]?.init.method, "POST");
});
