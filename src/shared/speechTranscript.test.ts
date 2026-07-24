import assert from "node:assert/strict";
import test from "node:test";
import {
  normalizeSpeechTranscriptSegment,
  normalizeSpeechTranscriptWord
} from "./speechTranscript.js";

test("speech transcript normalization preserves portable word timestamps and confidence", () => {
  assert.deepEqual(normalizeSpeechTranscriptWord({
    id: 7,
    text: "  测试  ",
    start_time: -1,
    end_time: 0.6,
    probability: 1.4,
    confidence: 0.82,
    speaker_label: "Speaker 1"
  }, 0), {
    id: 7,
    word: "测试",
    start: 0,
    end: 0.6,
    probability: 1,
    confidence: 0.82,
    speaker: "Speaker 1"
  });
});

test("speech transcript normalization separates portable evidence from host diagnostic names", () => {
  const source = {
    id: 1,
    start: 0,
    end: 1,
    text: "开始处理",
    speaker_id: "host-profile-one",
    speaker_name: "主机资料名称",
    speaker_suggestion_id: "host-profile-two",
    speaker_suggestion_name: "主机候选名称",
    speaker_cluster_id: "cluster-one",
    words: [{ token: "开始", start: 0, end: 0.4, confidence: 0.9 }]
  };
  const portable = normalizeSpeechTranscriptSegment(source, 0);
  const diagnostic = normalizeSpeechTranscriptSegment(source, 0, { includeDiagnosticNames: true });

  assert.equal(portable?.voiceprintId, "cluster-one");
  assert.equal(portable?.speakerId, undefined);
  assert.equal(portable?.speakerName, undefined);
  assert.equal(portable?.speakerSuggestionId, undefined);
  assert.equal(portable?.speakerSuggestionName, undefined);
  assert.equal(portable?.words?.[0]?.word, "开始");
  assert.equal(diagnostic?.speakerId, "host-profile-one");
  assert.equal(diagnostic?.speakerName, "主机资料名称");
  assert.equal(diagnostic?.speakerSuggestionId, "host-profile-two");
  assert.equal(diagnostic?.speakerSuggestionName, "主机候选名称");
});
