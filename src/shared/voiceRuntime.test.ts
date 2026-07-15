import assert from "node:assert/strict";
import test from "node:test";
import {
  createAsrFinalResult,
  createTtsPlaybackAttempt,
  normalizeVoiceCapability
} from "./voiceRuntime.js";

test("AIUI native voice capability never requires an API key or hidden network fallback", () => {
  const capability = normalizeVoiceCapability({
    mode: "aiui_native",
    available: true,
    requiresApiKey: true,
    networkFallback: false,
    locale: "zh-CN",
    supportsCancel: true,
    supportsPartial: false,
    supportsContinuous: false
  }, {
    adapterId: "aiui-native-asr",
    kind: "asr"
  });

  assert.equal(capability.mode, "aiui_native");
  assert.equal(capability.requiresApiKey, false);
  assert.equal(capability.networkFallback, false);
  assert.equal(capability.available, true);
  assert.deepEqual(capability.locales, ["zh-CN"]);
});

test("unavailable capabilities keep a clear reason", () => {
  const capability = normalizeVoiceCapability({
    available: false,
    reason: "SpeechRecognition is unavailable."
  }, {
    adapterId: "aiui-native-asr",
    kind: "asr"
  });

  assert.equal(capability.available, false);
  assert.equal(capability.reason, "SpeechRecognition is unavailable.");
});

test("ASR results normalize to one final portable DTO", () => {
  const result = createAsrFinalResult({
    resultId: " asr-1 ",
    text: " 你好，RabiLink。 ",
    capturedAt: 1_784_031_000_000,
    adapterId: "aiui-native-asr",
    mode: "aiui_native",
    locale: "zh-CN"
  });

  assert.deepEqual(result, {
    resultId: "asr-1",
    text: "你好，RabiLink。",
    final: true,
    capturedAt: 1_784_031_000_000,
    adapterId: "aiui-native-asr",
    mode: "aiui_native",
    locale: "zh-CN"
  });
});

test("TTS accepted attempts do not falsely claim playback completion", () => {
  const attempt = createTtsPlaybackAttempt({
    attemptId: "tts-1",
    messageId: "message-1",
    accepted: true,
    status: "accepted",
    acceptedAt: 1_784_031_000_000,
    adapterId: "aiui-native-tts",
    mode: "aiui_native",
    locale: "zh-CN",
    playbackReceipt: "not_supported"
  });

  assert.equal(attempt.accepted, true);
  assert.equal(attempt.messageId, "message-1");
  assert.equal(attempt.status, "accepted");
  assert.equal(attempt.playbackReceipt, "not_supported");
});

test("voice DTO constructors reject empty identities and text", () => {
  assert.throws(() => createAsrFinalResult({
    resultId: "",
    text: "",
    capturedAt: 1,
    adapterId: "aiui-native-asr",
    mode: "aiui_native",
    locale: "zh-CN"
  }), /text is required/);

  assert.throws(() => createTtsPlaybackAttempt({
    attemptId: "",
    messageId: "message-1",
    accepted: false,
    status: "rejected",
    acceptedAt: 1,
    adapterId: "aiui-native-tts",
    mode: "aiui_native",
    locale: "zh-CN",
    playbackReceipt: "failed"
  }), /attempt id is required/);
});
