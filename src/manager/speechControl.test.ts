import assert from "node:assert/strict";
import test from "node:test";
import type { SpeechRuntimeStatus } from "../shared/speechControlContract.js";
import type { LocalSpeechResponse } from "../speech/localSpeechClient.js";
import {
  ManagerSpeechControl,
  type ManagerSpeechLocalAdapter
} from "./speechControl.js";

const onlineStatus: SpeechRuntimeStatus = {
  state: "online",
  checkedAt: "2026-07-18T00:00:00.000Z",
  configuredUrl: "http://127.0.0.1:8781",
  defaults: { tts: "local-tts", asr: "faster-whisper" },
  providers: { tts: [], asr: [] }
};

function binaryResponse(): LocalSpeechResponse {
  return {
    status: 200,
    contentType: "audio/wav",
    headers: {},
    body: Buffer.from([1, 2, 3])
  };
}

test("Manager speech control owns camelCase microphone and model contracts", async () => {
  const localSpeech: ManagerSpeechLocalAdapter = {
    inspect: async () => onlineStatus,
    requestBinary: async () => binaryResponse(),
    requestJson: async (_serviceUrl, pathname) => {
      if (pathname === "/v1/models") {
        return {
          status: 200,
          data: {
            data: [{
              id: "faster-whisper/small",
              capability: "asr",
              provider: "faster-whisper",
              model: "small",
              name: "small",
              family: "Whisper",
              installed: true,
              enabled: true,
              loaded: true,
              available: true,
              default: true,
              languages: ["zh"],
              features: ["timestamps"]
            }]
          }
        };
      }
      return {
        status: 200,
        data: {
          running: true,
          state: "listening",
          level: 0.02,
          level_history: [0.01, 0.02],
          noise_floor: 0.003,
          dynamic_threshold: 0.011,
          utterance_active: false,
          pending: 0,
          stats: { captured: 2, recognized: 1, submit_failed: 0 },
          config: {
            enabled: true,
            asr_model: "faster-whisper/small",
            record_threshold: 0.01,
            transcribe_threshold: 0.015,
            route_id: "Ilias",
            session_id: "speech-Ilias"
          },
          history: [{ time: 1, text: "勇者", provider: "faster-whisper", model: "small", duration: 0.4, submitted: true }],
          events: [{ sequence: 1, time: 1, stage: "route", kind: "accepted", level: "info", message: "已受理", details: { route_id: "Ilias" } }]
        }
      };
    }
  };
  const control = new ManagerSpeechControl({
    serviceUrl: () => "http://127.0.0.1:8781",
    rolesRoot: () => "Z:/missing-roles",
    route: () => undefined,
    deliverTranscript: async () => {},
    appendRouteLog: () => {},
    localSpeech
  });

  const models = await control.models();
  assert.equal(models[0]?.isDefault, true);
  assert.equal(models[0]?.capability, "asr");

  const microphone = await control.microphoneStatus();
  assert.equal(microphone.config.asrModel, "faster-whisper/small");
  assert.equal(microphone.config.routeId, "Ilias");
  assert.deepEqual(microphone.levelHistory, [0.01, 0.02]);
  assert.equal(microphone.events[0]?.details.routeId, "Ilias");
  assert.equal(JSON.stringify(microphone).includes("route_id"), false);
  assert.equal(JSON.stringify(microphone).includes("asr_model"), false);
});

test("Manager speech control validates Route policy and maps start commands only in its local adapter", async () => {
  let upstreamBody: Record<string, unknown> = {};
  const localSpeech: ManagerSpeechLocalAdapter = {
    inspect: async () => onlineStatus,
    requestBinary: async () => binaryResponse(),
    requestJson: async (_serviceUrl, _pathname, init) => {
      upstreamBody = JSON.parse(String(init?.body || "{}")) as Record<string, unknown>;
      return {
        status: 200,
        data: { running: true, state: "listening", config: upstreamBody }
      };
    }
  };
  const control = new ManagerSpeechControl({
    serviceUrl: () => "http://127.0.0.1:8781",
    rolesRoot: () => "Z:/missing-roles",
    route: routeId => routeId === "Ilias" ? { id: routeId, speechEnabled: true } : undefined,
    deliverTranscript: async () => {},
    appendRouteLog: () => {},
    localSpeech
  });

  const status = await control.startMicrophone({
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
    autoSubmit: true,
    routeId: "Ilias",
    sessionId: "speech-Ilias",
    suppressDuringPlayback: true
  });

  assert.equal(upstreamBody.route_id, "Ilias");
  assert.equal(upstreamBody.record_threshold, 0.01);
  assert.equal("routeId" in upstreamBody, false);
  assert.equal(status.config.routeId, "Ilias");
  await assert.rejects(() => control.startMicrophone({
    ...status.config,
    autoSubmit: true,
    routeId: "missing"
  }), /Select a configured speech Route/);
});

test("Manager speech control acknowledges transcript before background delivery finishes", async () => {
  let rejectDelivery: ((error: Error) => void) | undefined;
  const logs: string[] = [];
  const control = new ManagerSpeechControl({
    serviceUrl: () => "http://127.0.0.1:8781",
    rolesRoot: () => "Z:/missing-roles",
    route: routeId => ({ id: routeId, speechEnabled: true }),
    deliverTranscript: () => new Promise<void>((_resolve, reject) => { rejectDelivery = reject; }),
    appendRouteLog: (_routeId, message) => logs.push(message),
    createMessageId: () => "speech-user-test"
  });

  const accepted = control.acceptMessage({ routeId: "Ilias", text: "勇者，我在。", sessionId: "speech-Ilias" });
  assert.deepEqual(accepted, {
    routeId: "Ilias",
    messageId: "speech-user-test",
    sessionId: "speech-Ilias",
    status: "accepted"
  });
  rejectDelivery?.(new Error("later failure"));
  await new Promise(resolve => setImmediate(resolve));
  assert.match(logs[0] || "", /speech-user-test; later failure/);
});
