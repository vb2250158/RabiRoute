import assert from "node:assert/strict";
import test from "node:test";
import type { SpeechIngressRecord } from "../shared/speechControlContract.js";
import { decideSpeechHotDeliveryQuality } from "./speechHotDeliveryQuality.js";

function ingress(overrides: Partial<SpeechIngressRecord> = {}): SpeechIngressRecord {
  return {
    schemaVersion: 1,
    id: "speech-test-one",
    recordedAt: "2026-08-01T00:00:00.000Z",
    ingestedAt: "2026-08-01T00:00:01.000Z",
    time: 1,
    source: "mobile_audio_stream",
    transport: "rabispeech_remote_audio",
    channelType: "rabilink.mobile_audio",
    messageAdapterType: "rabilink",
    sessionId: "phone-one",
    text: "夜雨，请告诉我现在的推流状态。",
    segments: [{
      id: 0,
      start: 0,
      end: 2,
      text: "夜雨，请告诉我现在的推流状态。",
      speakerDecision: "voiceprint_auto_match",
      speakerId: "speaker-known",
      words: [
        { word: "夜雨", probability: 0.93 },
        { word: "请告诉我", probability: 0.91 },
        { word: "推流状态", probability: 0.89 }
      ]
    }],
    ...overrides
  };
}

test("quarantines unknown or conflicting voiceprints before hot Agent delivery", () => {
  for (const speakerDecision of ["voiceprint_unknown_cluster", "voiceprint_tentative_known", "voiceprint_overlapping_speech"]) {
    const decision = decideSpeechHotDeliveryQuality(ingress({
      segments: [{
        ...ingress().segments[0],
        speakerDecision,
        speakerId: undefined
      }]
    }), ["夜雨"]);
    assert.equal(decision.shouldNotifyAgent, false);
    assert.equal(decision.reason, "speaker_unverified");
  }
});

test("quarantines transcripts without auditable word confidence", () => {
  const decision = decideSpeechHotDeliveryQuality(ingress({
    segments: [{
      ...ingress().segments[0],
      words: undefined
    }]
  }), ["夜雨"]);
  assert.equal(decision.shouldNotifyAgent, false);
  assert.equal(decision.reason, "asr_quality_unavailable");
});

test("quarantines low-confidence transcripts even when they contain a wake word", () => {
  const decision = decideSpeechHotDeliveryQuality(ingress({
    segments: [{
      ...ingress().segments[0],
      words: [{ word: "夜雨", probability: 0.31 }]
    }]
  }), ["夜雨"]);
  assert.equal(decision.shouldNotifyAgent, false);
  assert.equal(decision.reason, "asr_quality_low");
});

test("quarantines verified high-quality ambient speech without a wake word or explicit instruction", () => {
  const decision = decideSpeechHotDeliveryQuality(ingress({
    text: "今天外面的天气看起来不错。",
    segments: [{
      ...ingress().segments[0],
      text: "今天外面的天气看起来不错。",
      words: [{ word: "天气不错", probability: 0.94 }]
    }]
  }), ["夜雨"]);
  assert.equal(decision.shouldNotifyAgent, false);
  assert.equal(decision.reason, "no_explicit_wake_or_instruction");
});

test("allows a verified high-quality wake phrase or explicit instruction", () => {
  assert.equal(decideSpeechHotDeliveryQuality(ingress(), ["夜雨"]).shouldNotifyAgent, true);
  const instruction = ingress({
    text: "请暂停录音推流。",
    segments: [{
      ...ingress().segments[0],
      text: "请暂停录音推流。",
      words: [{ word: "请暂停录音推流", probability: 0.92 }]
    }]
  });
  assert.equal(decideSpeechHotDeliveryQuality(instruction, ["夜雨"]).shouldNotifyAgent, true);
});
