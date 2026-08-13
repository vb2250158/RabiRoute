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

function trustedMobileIngress(overrides: Partial<SpeechIngressRecord> = {}): SpeechIngressRecord {
  return ingress({
    sourceDeviceKind: "mobile",
    sourceDeviceId: "test-phone-device",
    sourceDeviceTrust: "speech_runtime_record_binding",
    ...overrides
  });
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

test("allows a trusted paired mobile stream with a wake word even when voiceprint is unknown", () => {
  const decision = decideSpeechHotDeliveryQuality(ingress({
    sourceDeviceKind: "mobile",
    sourceDeviceId: "test-phone-device",
    sourceDeviceTrust: "speech_runtime_record_binding",
    segments: [{
      ...ingress().segments[0],
      speakerDecision: "voiceprint_unknown_cluster",
      speakerId: undefined
    }]
  }), ["夜雨", "秋雨", "听得见"]);
  assert.equal(decision.shouldNotifyAgent, true);
  assert.equal(decision.reason, "quality_gate_passed");
  assert.equal(decision.trustedMobile, true);
});

test("does not let caller-controlled mobile metadata prove a paired device", () => {
  const decision = decideSpeechHotDeliveryQuality(ingress({
    sourceDeviceKind: "mobile",
    sourceDeviceId: "spoofed-phone",
    segments: [{
      ...ingress().segments[0],
      speakerDecision: "voiceprint_unknown_cluster",
      speakerId: undefined
    }]
  }), ["夜雨"]);
  assert.equal(decision.shouldNotifyAgent, false);
  assert.equal(decision.reason, "speaker_unverified");
  assert.equal(decision.trustedMobile, false);
});

test("trusted mobile + wake word + low overall confidence + unknown voiceprint still notifies", () => {
  const decision = decideSpeechHotDeliveryQuality(trustedMobileIngress({
    text: "夜雨，听得见吗",
    segments: [{
      ...ingress().segments[0],
      text: "夜雨，听得见吗",
      speakerDecision: "voiceprint_unknown_cluster",
      speakerId: undefined,
      words: [
        { word: "夜雨", probability: 0.93 },
        { word: "听得见", probability: 0.5 },
        { word: "吗", probability: 0.3 }
      ]
    }]
  }), ["夜雨", "秋雨", "听得见"]);
  assert.equal(decision.shouldNotifyAgent, true);
  assert.equal(decision.reason, "quality_gate_passed");
  assert.equal(decision.trustedMobile, true);
  assert.equal(decision.matchedWakeWord, "夜雨");
});

test("trusted mobile explicit instruction still requires overall confidence when no wake word matches", () => {
  const decision = decideSpeechHotDeliveryQuality(trustedMobileIngress({
    text: "请暂停录音推流。",
    segments: [{
      ...ingress().segments[0],
      text: "请暂停录音推流。",
      speakerDecision: "voiceprint_unknown_cluster",
      speakerId: undefined,
      words: [
        { word: "请", probability: 0.41 },
        { word: "暂停", probability: 0.5 },
        { word: "录音推流", probability: 0.3 }
      ]
    }]
  }), ["夜雨", "秋雨", "听得见"]);
  assert.equal(decision.shouldNotifyAgent, false);
  assert.equal(decision.reason, "asr_quality_low");
  assert.equal(decision.trustedMobile, true);
});

test("trusted mobile low-confidence ambient speech without a wake word remains blocked", () => {
  const decision = decideSpeechHotDeliveryQuality(trustedMobileIngress({
    text: "今天外面的天气看起来不错。",
    segments: [{
      ...ingress().segments[0],
      text: "今天外面的天气看起来不错。",
      speakerDecision: "voiceprint_unknown_cluster",
      speakerId: undefined,
      words: [
        { word: "今天", probability: 0.31 },
        { word: "天气", probability: 0.42 },
        { word: "不错", probability: 0.5 }
      ]
    }]
  }), ["夜雨", "秋雨", "听得见"]);
  assert.equal(decision.shouldNotifyAgent, false);
  assert.equal(decision.reason, "asr_quality_low");
});

test("trusted mobile wake word without auditable word confidence remains unavailable", () => {
  const decision = decideSpeechHotDeliveryQuality(trustedMobileIngress({
    text: "夜雨",
    segments: [{
      ...ingress().segments[0],
      text: "夜雨",
      speakerDecision: "voiceprint_unknown_cluster",
      speakerId: undefined,
      words: []
    }]
  }), ["夜雨"]);
  assert.equal(decision.shouldNotifyAgent, false);
  assert.equal(decision.reason, "asr_quality_unavailable");
});

test("still requires a wake word or explicit instruction for trusted mobile streams", () => {
  const decision = decideSpeechHotDeliveryQuality(ingress({
    sourceDeviceKind: "mobile",
    sourceDeviceId: "test-phone-device",
    sourceDeviceTrust: "speech_runtime_record_binding",
    text: "听得见 听得见",
    segments: [{
      ...ingress().segments[0],
      text: "听得见 听得见",
      speakerDecision: "voiceprint_unknown_cluster",
      speakerId: undefined,
      words: [
        { word: "听", probability: 0.33 },
        { word: "得", probability: 0.77 },
        { word: "见", probability: 0.99 },
        { word: "听", probability: 0.99 },
        { word: "得", probability: 0.99 },
        { word: "见", probability: 0.99 }
      ]
    }]
  }), ["夜雨", "秋雨", "听得见"]);
  assert.equal(decision.shouldNotifyAgent, true);
});

test("does not trust non-rabilink or non-mobile streams as verified speakers", () => {
  const speech = decideSpeechHotDeliveryQuality(ingress({
    messageAdapterType: "speech",
    sourceDeviceKind: "mobile",
    sourceDeviceId: "pc-mobile",
    segments: [{
      ...ingress().segments[0],
      speakerDecision: "voiceprint_unknown_cluster",
      speakerId: undefined
    }]
  }), ["夜雨"]);
  assert.equal(speech.reason, "speaker_unverified");
  const desktop = decideSpeechHotDeliveryQuality(ingress({
    sourceDeviceKind: "desktop",
    sourceDeviceId: "rabi-pc",
    segments: [{
      ...ingress().segments[0],
      speakerDecision: "voiceprint_unknown_cluster",
      speakerId: undefined
    }]
  }), ["夜雨"]);
  assert.equal(desktop.reason, "speaker_unverified");
});
