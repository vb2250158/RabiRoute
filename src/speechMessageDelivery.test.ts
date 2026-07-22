import assert from "node:assert/strict";
import test from "node:test";
import {
  formatSpeechProcessResult,
  parseSpeechProcessResult,
  SPEECH_EXIT_DELIVERED,
  SPEECH_EXIT_FAILED,
  SPEECH_EXIT_NOT_DELIVERED,
  SPEECH_EXIT_RECORDED,
  speechForwardProcessOutcome,
  speechRecordedProcessOutcome
} from "./speechMessageDelivery.js";

test("speech process exit codes distinguish delivered, recorded, and failed outcomes", () => {
  assert.equal(speechForwardProcessOutcome({
    routeKind: "voice_transcript",
    messageId: "voice-one",
    status: "delivered",
    matchedRuleIds: ["speech"],
    matchedRuleCount: 1,
    sentPacketCount: 1,
    adapterOutcomes: [{ routeId: "route", ruleId: "speech", adapter: "codex", status: "delivered" }],
    routes: []
  }).exitCode, SPEECH_EXIT_DELIVERED);

  assert.equal(speechRecordedProcessOutcome(1, "keyword_not_matched").exitCode, SPEECH_EXIT_RECORDED);
  assert.equal(speechRecordedProcessOutcome(0, "keyword_not_matched").exitCode, SPEECH_EXIT_NOT_DELIVERED);
  assert.equal(speechForwardProcessOutcome({
    routeKind: "voice_transcript",
    messageId: "voice-two",
    status: "failed",
    matchedRuleIds: ["speech"],
    matchedRuleCount: 1,
    sentPacketCount: 1,
    adapterOutcomes: [{ routeId: "route", ruleId: "speech", adapter: "codex", status: "failed", error: "Desktop unavailable" }],
    routes: []
  }).exitCode, SPEECH_EXIT_FAILED);
});

test("speech process result marker round-trips the terminal receipt", () => {
  const line = formatSpeechProcessResult({ status: "recorded", reason: "keyword_not_configured", detail: "stored" });
  assert.deepEqual(parseSpeechProcessResult(`ordinary log\n${line}\n`), {
    status: "recorded",
    reason: "keyword_not_configured",
    detail: "stored"
  });
  assert.equal(parseSpeechProcessResult("ordinary log only"), undefined);
});
