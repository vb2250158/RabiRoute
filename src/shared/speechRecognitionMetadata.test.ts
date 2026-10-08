import assert from "node:assert/strict";
import test from "node:test";
import { normalizeSpeechRecognitionMetadata } from "./speechRecognitionMetadata.js";

test("recognition observations preserve future labels and ordered raw tags without changing transcript", () => {
  const input = { text: "你好", emotion: "FUTURE_LABEL", emotion_labels: ["FUTURE_LABEL", "NEUTRAL"],
    audio_events: ["Speech", "FutureEvent"], raw_tags: ["<|zh|>", "<|NEUTRAL|>", "<|zh|>"], confidence: 0.97 };
  assert.deepEqual(normalizeSpeechRecognitionMetadata(input), {
    emotion: "FUTURE_LABEL", emotionLabels: ["FUTURE_LABEL", "NEUTRAL"],
    audioEvents: ["Speech", "FutureEvent"], rawTags: ["<|zh|>", "<|NEUTRAL|>", "<|zh|>"], confidence: 0.97
  });
  assert.equal(input.text, "你好");
});

test("unknown providers and invalid optional observations remain absent", () => {
  for (const confidence of [NaN, Infinity, -0.1, 1.1, "0.9", true]) {
    const result = normalizeSpeechRecognitionMetadata({ confidence, emotion: {}, audio_events: [null, 1, "Speech"], raw_tags: "wrong" });
    assert.equal(result.confidence, undefined);
    assert.equal(result.emotion, undefined);
    assert.equal(result.rawTags, undefined);
    assert.deepEqual(result.audioEvents, ["Speech"]);
  }
  assert.equal(JSON.stringify(normalizeSpeechRecognitionMetadata({})), "{}");
});
