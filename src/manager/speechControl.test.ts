import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { SpeechRuntimeStatus } from "../shared/speechControlContract.js";
import type { LocalSpeechResponse } from "../speech/localSpeechClient.js";
import { SpeechIngressStore } from "../speechIngressStore.js";
import {
  ManagerSpeechControl,
  SpeechControlError,
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
          stats: { captured: 2, recognized: 1, delivered: 1, recorded: 0, delivery_failed: 0, submitted: 1, submit_failed: 0 },
          config: {
            enabled: true,
            asr_model: "faster-whisper/small",
            record_threshold: 0.01,
            transcribe_threshold: 0.015,
            route_id: "Ilias",
            session_id: "speech-Ilias"
          },
          history: [{ time: 1, text: "勇者", provider: "faster-whisper", model: "small", duration: 0.4, submitted: true, message_id: "speech-one", delivery_status: "delivered" }],
          events: [{ sequence: 1, time: 1, stage: "route", kind: "route_delivery_succeeded", level: "info", message: "Desktop 目标任务已接收", details: { route_id: "Ilias" } }]
        }
      };
    }
  };
  const control = new ManagerSpeechControl({
    serviceUrl: () => "http://127.0.0.1:8781",
    rolesRoot: () => "Z:/missing-roles",
    route: () => undefined,
    routes: () => [],
    deliverTranscript: async () => ({ status: "delivered" }),
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
  assert.equal(microphone.stats.delivered, 1);
  assert.equal(microphone.history[0]?.deliveryStatus, "delivered");
  assert.equal(microphone.history[0]?.messageId, "speech-one");
  assert.equal(microphone.events[0]?.details.routeId, "Ilias");
  assert.equal(JSON.stringify(microphone).includes("route_id"), false);
  assert.equal(JSON.stringify(microphone).includes("asr_model"), false);
});

test("Manager speech control normalizes and updates the host playback volume", async () => {
  const requests: Array<{ pathname: string; init: RequestInit }> = [];
  const localSpeech: ManagerSpeechLocalAdapter = {
    inspect: async () => onlineStatus,
    requestBinary: async () => binaryResponse(),
    requestJson: async (_serviceUrl, pathname, init = {}) => {
      requests.push({ pathname, init });
      const requestedVolume = pathname === "/v1/playback/settings"
        ? Number((JSON.parse(String(init.body || "{}")) as { volume?: unknown }).volume)
        : 42;
      return {
        status: 200,
        data: {
          mode: "host_fifo",
          volume: requestedVolume,
          current: null,
          queued: 0,
          jobs: []
        }
      };
    }
  };
  const control = new ManagerSpeechControl({
    serviceUrl: () => "http://127.0.0.1:8781",
    rolesRoot: () => "Z:/missing-roles",
    route: () => undefined,
    routes: () => [],
    deliverTranscript: async () => ({ status: "delivered" }),
    appendRouteLog: () => {},
    localSpeech
  });

  assert.equal((await control.playbackStatus()).volume, 42);
  assert.equal((await control.setPlaybackVolume({ volume: 73 })).volume, 73);
  assert.equal(requests[1]?.pathname, "/v1/playback/settings");
  assert.equal(requests[1]?.init.method, "PUT");
  assert.deepEqual(JSON.parse(String(requests[1]?.init.body)), { volume: 73 });
  await assert.rejects(() => control.setPlaybackVolume({ volume: 101 }), /between 0 and 100/);
  await assert.rejects(() => control.setPlaybackVolume({ volume: 10.5 }), /integer/);
  await assert.rejects(
    () => control.setPlaybackVolume({ volume: true as unknown as number }),
    /integer/
  );
});

test("Manager speech control maps resident microphone settings to broadcast mode", async () => {
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
    routes: () => [{ id: "Ilias", speechEnabled: true }],
    deliverTranscript: async () => ({ status: "delivered" }),
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
    suppressDuringPlayback: true
  });

  assert.equal(upstreamBody.route_id, null);
  assert.equal(upstreamBody.auto_submit, true);
  assert.equal(upstreamBody.record_threshold, 0.01);
  assert.equal("routeId" in upstreamBody, false);
  assert.equal(status.config.routeId, null);
});

test("Manager speech reconciliation keeps capture alive until the last Route unsubscribes", async () => {
  let subscribedRoutes = [
    { id: "Xinghai", speechEnabled: true },
    { id: "Rabi", speechEnabled: true }
  ];
  const requests: Array<{ pathname: string; method: string }> = [];
  const localSpeech: ManagerSpeechLocalAdapter = {
    inspect: async () => onlineStatus,
    requestBinary: async () => binaryResponse(),
    requestJson: async (_serviceUrl, pathname, init = {}) => {
      requests.push({ pathname, method: init.method || "GET" });
      return {
        status: 200,
        data: {
          running: pathname !== "/v1/microphone/stop",
          state: pathname === "/v1/microphone/stop" ? "stopped" : "listening",
          config: {
            enabled: pathname !== "/v1/microphone/stop",
            auto_submit: true,
            route_id: null,
            session_id: "rabispeech-microphone"
          }
        }
      };
    }
  };
  const control = new ManagerSpeechControl({
    serviceUrl: () => "http://127.0.0.1:8781",
    rolesRoot: () => "Z:/missing-roles",
    route: routeId => subscribedRoutes.find(route => route.id === routeId),
    routes: () => subscribedRoutes,
    deliverTranscript: async () => ({ status: "delivered" }),
    appendRouteLog: () => {},
    localSpeech
  });

  await control.reconcileMicrophone();
  subscribedRoutes = [{ id: "Rabi", speechEnabled: true }];
  await control.reconcileMicrophone();
  subscribedRoutes = [];
  await control.reconcileMicrophone();

  assert.deepEqual(requests, [
    { pathname: "/v1/microphone/status", method: "GET" },
    { pathname: "/v1/microphone/status", method: "GET" },
    { pathname: "/v1/microphone/status", method: "GET" },
    { pathname: "/v1/microphone/stop", method: "POST" }
  ]);
});

test("Manager speech reconciliation migrates a legacy Route-bound microphone to broadcast mode", async () => {
  const requests: Array<{ pathname: string; body: Record<string, unknown> }> = [];
  const localSpeech: ManagerSpeechLocalAdapter = {
    inspect: async () => onlineStatus,
    requestBinary: async () => binaryResponse(),
    requestJson: async (_serviceUrl, pathname, init = {}) => {
      requests.push({
        pathname,
        body: init.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {}
      });
      if (pathname === "/v1/microphone/status") {
        return {
          status: 200,
          data: {
            running: true,
            state: "listening",
            config: {
              enabled: true,
              auto_submit: false,
              route_id: "Xinghai",
              session_id: "legacy-session",
              asr_model: "faster-whisper/small"
            }
          }
        };
      }
      return {
        status: 200,
        data: {
          running: true,
          state: "listening",
          config: { ...requests[1]?.body, enabled: true }
        }
      };
    }
  };
  const control = new ManagerSpeechControl({
    serviceUrl: () => "http://127.0.0.1:8781",
    rolesRoot: () => "Z:/missing-roles",
    route: routeId => ({ id: routeId, speechEnabled: true }),
    routes: () => [{ id: "Xinghai", speechEnabled: true }],
    deliverTranscript: async () => ({ status: "delivered" }),
    appendRouteLog: () => {},
    localSpeech
  });

  const result = await control.reconcileMicrophone();

  assert.equal(requests[1]?.pathname, "/v1/microphone/settings");
  assert.equal(requests[1]?.body.route_id, null);
  assert.equal(requests[1]?.body.auto_submit, true);
  assert.equal("session_id" in (requests[1]?.body || {}), false);
  assert.equal(result.config.routeId, null);
  assert.equal(result.config.autoSubmit, true);
});

test("Manager speech control waits for the Desktop owner terminal receipt", async () => {
  let resolveDelivery: ((value: { status: "delivered"; detail: string }) => void) | undefined;
  const logs: string[] = [];
  const control = new ManagerSpeechControl({
    serviceUrl: () => "http://127.0.0.1:8781",
    rolesRoot: () => "Z:/missing-roles",
    route: routeId => ({ id: routeId, speechEnabled: true }),
    routes: () => [{ id: "Ilias", speechEnabled: true }],
    deliverTranscript: () => new Promise((resolve) => { resolveDelivery = resolve; }),
    appendRouteLog: (_routeId, message) => logs.push(message),
    createMessageId: () => "speech-user-test"
  });

  let settled = false;
  const pending = control.acceptMessage({ routeId: "Ilias", text: "勇者，我在。", sessionId: "speech-Ilias" })
    .finally(() => { settled = true; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(settled, false);
  resolveDelivery?.({ status: "delivered", detail: "Desktop owner accepted start" });
  const delivered = await pending;
  assert.deepEqual(delivered, {
    routeId: "Ilias",
    messageId: "speech-user-test",
    sessionId: "speech-Ilias",
    status: "delivered",
    detail: "Desktop owner accepted start",
    deliveries: [{
      routeId: "Ilias",
      messageId: "speech-user-test",
      status: "delivered",
      detail: "Desktop owner accepted start"
    }]
  });
  assert.match(logs[0] || "", /speech message delivered: speech-user-test/);
});

test("Manager speech control returns recorded and propagates real delivery failures", async () => {
  const logs: string[] = [];
  let delivery: "recorded" | "failed" = "recorded";
  const control = new ManagerSpeechControl({
    serviceUrl: () => "http://127.0.0.1:8781",
    rolesRoot: () => "Z:/missing-roles",
    route: routeId => ({ id: routeId, speechEnabled: true }),
    routes: () => [{ id: "Ilias", speechEnabled: true }],
    deliverTranscript: async () => {
      if (delivery === "failed") throw new SpeechControlError("Desktop unavailable", 502);
      return { status: "recorded", reason: "keyword_not_matched" };
    },
    appendRouteLog: (_routeId, message) => logs.push(message),
    createMessageId: () => "speech-user-test"
  });

  assert.equal((await control.acceptMessage({ routeId: "Ilias", text: "继续讨论", sessionId: "speech-Ilias" })).status, "recorded");
  delivery = "failed";
  await assert.rejects(
    () => control.acceptMessage({ routeId: "Ilias", text: "星海，看看", sessionId: "speech-Ilias" }),
    /Desktop unavailable/
  );
  assert.match(logs.at(-1) || "", /speech message failed: speech-user-test; Desktop unavailable/);
});

test("Manager speech control broadcasts one transcript to every enabled speech Route", async () => {
  const deliveredRoutes: string[] = [];
  let sequence = 0;
  const control = new ManagerSpeechControl({
    serviceUrl: () => "http://127.0.0.1:8781",
    rolesRoot: () => "Z:/missing-roles",
    route: routeId => ({ id: routeId, speechEnabled: routeId !== "disabled" }),
    routes: () => [
      { id: "Xinghai", speechEnabled: true },
      { id: "Rabi", speechEnabled: true },
      { id: "disabled", speechEnabled: false }
    ],
    deliverTranscript: async ({ routeId }) => {
      deliveredRoutes.push(routeId || "");
      return routeId === "Rabi"
        ? { status: "recorded", reason: "keyword_not_matched" }
        : { status: "delivered", detail: "Desktop accepted" };
    },
    appendRouteLog: () => {},
    createMessageId: () => `speech-${++sequence}`
  });

  const result = await control.acceptMessage({ text: "大家继续。", sessionId: "meeting-one" });
  assert.deepEqual(deliveredRoutes, ["Xinghai", "Rabi"]);
  assert.equal(result.routeId, null);
  assert.equal(result.status, "delivered");
  assert.equal(result.deliveries?.length, 2);
  assert.deepEqual(result.deliveries?.map(item => [item.routeId, item.status]), [
    ["Xinghai", "delivered"],
    ["Rabi", "recorded"]
  ]);
  assert.match(result.detail || "", /1 delivered, 1 recorded, 0 failed/);
});

test("Manager speech control stores one raw ingress record before Route fan-out", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-manager-speech-ingress-"));
  const speechIngressStore = new SpeechIngressStore(root);
  const delivered: Array<{ routeId: string; recordId: string; voiceprintId?: string; speakerId?: string; speakerName?: string }> = [];
  const control = new ManagerSpeechControl({
    serviceUrl: () => "http://127.0.0.1:8781",
    rolesRoot: () => "Z:/missing-roles",
    route: routeId => ({ id: routeId, speechEnabled: true }),
    routes: () => [{ id: "Rabi", speechEnabled: true }, { id: "Work", speechEnabled: true }],
    deliverTranscript: async ({ routeId, record }) => {
      delivered.push({
        routeId,
        recordId: record.id,
        voiceprintId: record.segments[0]?.voiceprintId,
        speakerId: record.segments[0]?.speakerId,
        speakerName: record.segments[0]?.speakerName
      });
      return { status: "recorded" };
    },
    appendRouteLog: () => {},
    createMessageId: () => "fallback-speech-id",
    speechIngressStore
  });

  const result = await control.acceptMessage({
    recordId: "speech-source-one",
    text: "这是一段语音",
    sessionId: "day-one",
    provider: "dashscope",
    model: "paraformer-v2",
    segments: [{
      id: 0,
      start: 0,
      end: 1,
      text: "这是一段语音",
      speakerClusterId: "voiceprint-a",
      speakerId: "host-profile-a",
      speakerSuggestionId: "host-candidate-a",
      speakerName: "用户",
      speakerDecision: "voiceprint_auto_match"
    }]
  });

  assert.equal(result.messageId, "speech-source-one");
  assert.deepEqual(delivered, [
    { routeId: "Rabi", recordId: "speech-source-one", voiceprintId: "voiceprint-a", speakerId: undefined, speakerName: undefined },
    { routeId: "Work", recordId: "speech-source-one", voiceprintId: "voiceprint-a", speakerId: undefined, speakerName: undefined }
  ]);
  assert.equal(speechIngressStore.list().length, 1);
});

test("Manager speech control reuses terminal Route receipts for retried and concurrent ASR submissions", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-manager-speech-receipts-"));
  const speechIngressStore = new SpeechIngressStore(path.join(root, "messages"));
  let deliveries = 0;
  const control = new ManagerSpeechControl({
    serviceUrl: () => "http://127.0.0.1:8781",
    rolesRoot: () => "Z:/missing-roles",
    route: routeId => ({ id: routeId, speechEnabled: true }),
    routes: () => [{ id: "Rabi", speechEnabled: true }],
    deliverTranscript: async () => {
      deliveries += 1;
      await new Promise(resolve => setTimeout(resolve, 10));
      return { status: "delivered", reason: "desktop_owner_accepted" };
    },
    appendRouteLog: () => {},
    speechIngressStore
  });
  const command = { recordId: "stable-asr-one", text: "不要重复唤醒", sessionId: "day-one" };

  const concurrent = await Promise.all([control.acceptMessage(command), control.acceptMessage(command)]);
  const retried = await control.acceptMessage(command);

  assert.equal(deliveries, 1);
  assert.deepEqual(concurrent.map(item => item.status), ["delivered", "delivered"]);
  assert.equal(retried.status, "delivered");
  assert.equal(speechIngressStore.readDeliveryReceipt("stable-asr-one", "Rabi")?.reason, "desktop_owner_accepted");
});

test("Manager speech control routes PC microphone and mobile audio to different message endpoints", async () => {
  const delivered: Array<{ routeId: string; adapterType: string; channelType: string; sourceDeviceId?: string; sourceStreamId?: string }> = [];
  const routes = [
    { id: "Voice", speechEnabled: true, rabiLinkEnabled: false, routeProfileIds: ["voice-main"] },
    { id: "Mobile", speechEnabled: false, rabiLinkEnabled: true, routeProfileIds: ["mobile-main"] },
    { id: "OtherMobile", speechEnabled: false, rabiLinkEnabled: true, routeProfileIds: ["mobile-other"] }
  ];
  const control = new ManagerSpeechControl({
    serviceUrl: () => "http://127.0.0.1:8781",
    rolesRoot: () => "Z:/missing-roles",
    route: routeId => routes.find(route => route.id === routeId),
    routes: () => routes,
    deliverTranscript: async ({ routeId, record }) => {
      delivered.push({
        routeId,
        adapterType: record.messageAdapterType,
        channelType: record.channelType,
        sourceDeviceId: record.sourceDeviceId,
        sourceStreamId: record.sourceStreamId
      });
      return { status: "delivered" };
    },
    appendRouteLog: () => {}
  });

  await control.acceptMessage({
    recordId: "pc-one",
    text: "本机麦克风",
    messageAdapterType: "speech",
    channelType: "speech.pc_microphone"
  });
  await control.acceptMessage({
    recordId: "mobile-one",
    text: "手机音频流",
    messageAdapterType: "rabilink",
    channelType: "rabilink.mobile_audio",
    routeProfileId: "mobile-main",
    sourceDeviceId: "phone-one",
    sourceStreamId: "phone-one-audio",
    sourceDeviceKind: "mobile"
  });

  assert.deepEqual(delivered, [
    { routeId: "Voice", adapterType: "speech", channelType: "speech.pc_microphone", sourceDeviceId: undefined, sourceStreamId: undefined },
    { routeId: "Mobile", adapterType: "rabilink", channelType: "rabilink.mobile_audio", sourceDeviceId: "phone-one", sourceStreamId: "phone-one-audio" }
  ]);
});

test("Manager speech broadcast records locally when no Route subscribes", async () => {
  const control = new ManagerSpeechControl({
    serviceUrl: () => "http://127.0.0.1:8781",
    rolesRoot: () => "Z:/missing-roles",
    route: () => undefined,
    routes: () => [],
    deliverTranscript: async () => ({ status: "delivered" }),
    appendRouteLog: () => {},
    createMessageId: () => "speech-broadcast"
  });

  const result = await control.acceptMessage({ text: "只记录。", sessionId: "meeting-one" });
  assert.equal(result.status, "recorded");
  assert.equal(result.reason, "no_enabled_speech_routes");
  assert.deepEqual(result.deliveries, []);
});

test("Manager speech control normalizes persistent speech records and redacts unsafe audio paths", async () => {
  let requestedPath = "";
  const localSpeech: ManagerSpeechLocalAdapter = {
    inspect: async () => onlineStatus,
    requestBinary: async () => binaryResponse(),
    requestJson: async (_serviceUrl, pathname) => {
      requestedPath = pathname;
      return {
        status: 200,
        data: {
          data: [
            {
              id: "speech-one",
              kind: "asr",
              source: "microphone",
              time: 10,
              session_id: "meeting-one",
              route_id: "XinghaiBuilder-main",
              provider: "dashscope-qwen",
              model: "paraformer-v2",
              text: "会议内容",
              segments: [{ id: 0, start: 0, end: 1, text: "会议内容", speaker: "Speaker 1" }]
            },
            {
              id: "speech-safe-cache",
              kind: "tts",
              source: "api",
              time: 11,
              provider: "dashscope-qwen",
              model: "qwen3-tts-vc",
              voice: "XinghaiBuilder",
              text: "安全相对路径",
              audio_file: "XinghaiBuilder/voice/cache/tts-audio/speech.wav",
              audio_expires_at: 86_411,
              segments: []
            },
            {
              id: "speech-legacy-cache",
              kind: "tts",
              source: "api",
              time: 12,
              provider: "fake",
              model: "fake",
              voice: "XinghaiBuilder",
              text: "旧记录",
              audio_file: "legacy.wav",
              audio_expires_at: 86_412,
              segments: []
            },
            {
              id: "speech-windows-absolute",
              kind: "tts",
              source: "api",
              time: 13,
              provider: "fake",
              model: "fake",
              text: "绝对路径",
              audio_file: "C:\\Users\\Administrator\\private.wav",
              segments: []
            },
            {
              id: "speech-parent-traversal",
              kind: "tts",
              source: "api",
              time: 14,
              provider: "fake",
              model: "fake",
              text: "父级越界",
              audio_file: "../private.wav",
              segments: []
            },
            {
              id: "speech-file-uri",
              kind: "tts",
              source: "api",
              time: 15,
              provider: "fake",
              model: "fake",
              text: "伪相对 URI",
              audio_file: "file:C:/private.wav",
              segments: []
            },
            {
              id: "speech-encoded-drive",
              kind: "tts",
              source: "api",
              time: 16,
              provider: "fake",
              model: "fake",
              text: "编码盘符",
              audio_file: "C%3A/private.wav",
              segments: []
            },
            {
              id: "speech-backslash-traversal",
              kind: "tts",
              source: "api",
              time: 17,
              provider: "fake",
              model: "fake",
              text: "反斜杠越界",
              audio_file: "voice\\cache\\..\\private.wav",
              segments: []
            },
            {
              id: "speech-control-character",
              kind: "tts",
              source: "api",
              time: 18,
              provider: "fake",
              model: "fake",
              text: "控制字符",
              audio_file: "safe\npath.wav",
              segments: []
            }
          ]
        }
      };
    }
  };
  const control = new ManagerSpeechControl({
    serviceUrl: () => "http://127.0.0.1:8781",
    rolesRoot: () => "Z:/missing-roles",
    route: () => undefined,
    routes: () => [],
    deliverTranscript: async () => ({ status: "delivered" }),
    appendRouteLog: () => {},
    localSpeech
  });

  const records = await control.records({ routeId: "XinghaiBuilder-main" });
  assert.match(requestedPath, /route_id=XinghaiBuilder-main/);
  assert.equal(records[0]?.routeId, "XinghaiBuilder-main");
  assert.equal(records[0]?.segments[0]?.speaker, "Speaker 1");
  assert.equal(records[1]?.audioFile, "XinghaiBuilder/voice/cache/tts-audio/speech.wav");
  assert.equal(records[1]?.audioExpiresAt, 86_411);
  assert.equal(records[2]?.audioFile, "legacy.wav");
  assert.equal(records[3]?.audioFile, undefined);
  assert.equal(records[4]?.audioFile, undefined);
  assert.equal(records[5]?.audioFile, undefined);
  assert.equal(records[6]?.audioFile, undefined);
  assert.equal(records[7]?.audioFile, undefined);
  assert.equal(records[8]?.audioFile, undefined);
  assert.equal(JSON.stringify(records).includes("route_id"), false);
  assert.doesNotMatch(JSON.stringify(records), /C:\\\\Users|\.\.\/|file:C:|C%3A|voice\\\\cache/);
});

test("Manager speech control exposes manual speaker profiles without claiming voiceprint support", async () => {
  const requests: Array<{ pathname: string; method: string; body?: Record<string, unknown> }> = [];
  const profileId = "speaker-0123456789abcdef0123456789abcdef";
  const localSpeech: ManagerSpeechLocalAdapter = {
    inspect: async () => onlineStatus,
    requestBinary: async () => binaryResponse(),
    requestJson: async (_serviceUrl, pathname, init = {}) => {
      const body = init.body ? JSON.parse(String(init.body)) as Record<string, unknown> : undefined;
      requests.push({ pathname, method: init.method || "GET", body });
      if (pathname.startsWith("/v1/speaker-profiles?")) {
        return {
          status: 200,
          data: {
            profiles: [{ id: profileId, display_name: "秋雨", aliases: ["Qiu Yu"], created_at: 1, updated_at: 2 }],
            bindings: [{
              session_id: "meeting-one",
              record_id: "speech-one",
              speaker_label: "Speaker 1",
              speaker_id: profileId,
              speaker_name: "秋雨",
              decision: "manual_record_binding",
              created_at: 2,
              updated_at: 2
            }],
            capability: {
              scope: "loopback-only",
              mode: "manual_record_label_binding",
              manual_binding: true,
              binding_scope: "record_speaker_label",
              aliases_are_metadata_only: true,
              diarization_labels_are_biometric_identity: false,
              stores_raw_enrollment_audio: false,
              voiceprint: { supported: false, experimental: false, reason: "No validated matcher." }
            }
          }
        };
      }
      if (pathname === "/v1/speaker-profiles" && init.method === "POST") {
        return { status: 200, data: { id: profileId, display_name: body?.display_name, aliases: body?.aliases, created_at: 1, updated_at: 1 } };
      }
      if (pathname === "/v1/speaker-bindings" && init.method === "PUT") {
        return {
          status: 200,
          data: {
            ...body,
            speaker_name: "秋雨",
            decision: "manual_record_binding",
            created_at: 2,
            updated_at: 2
          }
        };
      }
      if (pathname === "/v1/speaker-identities" && init.method === "PUT") {
        return {
          status: 200,
          data: {
            created: false,
            reused: true,
            profile_updated: true,
            binding_changed: false,
            matched_by: "display_name_or_alias",
            profile: {
              id: profileId,
              display_name: "秋雨",
              aliases: ["Qiu Yu", "秋雨老师"],
              created_at: 1,
              updated_at: 3
            },
            binding: {
              session_id: "meeting-one",
              record_id: "speech-one",
              speaker_label: "Speaker 1",
              speaker_id: profileId,
              speaker_name: "秋雨",
              decision: "manual_record_binding",
              created_at: 2,
              updated_at: 2
            }
          }
        };
      }
      if (pathname === `/v1/speaker-profiles/${profileId}` && init.method === "PATCH") {
        return {
          status: 200,
          data: { id: profileId, display_name: body?.display_name, aliases: [], created_at: 1, updated_at: 3 }
        };
      }
      if (pathname.startsWith("/v1/speaker-bindings?") && init.method === "DELETE") {
        return {
          status: 200,
          data: {
            session_id: "meeting-one",
            record_id: "speech-one",
            speaker_label: "Speaker 1",
            speaker_id: profileId,
            speaker_name: "秋雨（QA）",
            decision: "manual_record_binding",
            created_at: 2,
            updated_at: 2
          }
        };
      }
      if (pathname === `/v1/speaker-profiles/${profileId}` && init.method === "DELETE") {
        return {
          status: 200,
          data: {
            deleted: { id: profileId, display_name: "秋雨（QA）", aliases: [], created_at: 1, updated_at: 3 },
            removed_bindings: 0
          }
        };
      }
      throw new Error(`Unexpected path: ${pathname}`);
    }
  };
  const control = new ManagerSpeechControl({
    serviceUrl: () => "http://127.0.0.1:8781",
    rolesRoot: () => "Z:/missing-roles",
    route: () => undefined,
    routes: () => [],
    deliverTranscript: async () => ({ status: "delivered" }),
    appendRouteLog: () => {},
    localSpeech
  });

  const registry = await control.speakerRegistry("meeting-one");
  assert.equal(registry.profiles[0]?.displayName, "秋雨");
  assert.equal(registry.bindings[0]?.speakerLabel, "Speaker 1");
  assert.equal(registry.bindings[0]?.recordId, "speech-one");
  assert.equal(registry.capability.voiceprint.supported, false);
  assert.equal(registry.capability.diarizationLabelsAreBiometricIdentity, false);
  assert.equal(registry.capability.storesRawEnrollmentAudio, false);

  await control.createSpeakerProfile({ displayName: "秋雨", aliases: ["Qiu Yu"] });
  await control.bindSpeaker({ sessionId: "meeting-one", recordId: "speech-one", speakerLabel: "Speaker 1", speakerId: profileId });
  const identified = await control.identifySpeaker({
    sessionId: "meeting-one",
    recordId: "speech-one",
    speakerLabel: "Speaker 1",
    displayName: "qiu yu",
    aliases: ["秋雨老师"]
  });
  const updated = await control.updateSpeakerProfile(profileId, { displayName: "秋雨（QA）" });
  const unbound = await control.unbindSpeaker("meeting-one", "speech-one", "Speaker 1");
  const deleted = await control.deleteSpeakerProfile(profileId);
  assert.equal(updated.displayName, "秋雨（QA）");
  assert.equal(identified.reused, true);
  assert.equal(identified.profileUpdated, true);
  assert.equal(identified.profile.aliases[1], "秋雨老师");
  assert.equal(unbound.speakerName, "秋雨（QA）");
  assert.equal(deleted.deleted.id, profileId);
  assert.match(requests[0]?.pathname || "", /session_id=meeting-one/);
  assert.deepEqual(requests[1]?.body, { display_name: "秋雨", aliases: ["Qiu Yu"] });
  assert.deepEqual(requests[2]?.body, {
    session_id: "meeting-one",
    record_id: "speech-one",
    speaker_label: "Speaker 1",
    speaker_id: profileId
  });
  assert.deepEqual(requests[3]?.body, {
    session_id: "meeting-one",
    record_id: "speech-one",
    speaker_label: "Speaker 1",
    speaker_id: null,
    display_name: "qiu yu",
    aliases: ["秋雨老师"]
  });
  assert.deepEqual(requests[4]?.body, { display_name: "秋雨（QA）" });
  assert.match(requests[5]?.pathname || "", /speaker_label=Speaker\+1/);
  assert.equal(requests[6]?.method, "DELETE");
});
