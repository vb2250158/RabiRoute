import {
  TRANSCRIPT_POLICY_VERSION,
  createTranscriptPolicy,
  normalizeTranscriptText,
  transcriptSimilarity
} from "../utils/transcript-policy.js";

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

assert(TRANSCRIPT_POLICY_VERSION === "fennenote-text-v1", "Transcript policy must expose a stable version.");
assert(normalizeTranscriptText("  你好\n 世界  ") === "你好 世界", "Whitespace should normalize without rewriting words.");
assert(transcriptSimilarity("这是 Agent 的完整提醒。", "这是Agent的完整提醒") >= 0.99, "Punctuation differences should still match playback echo.");

const policy = createTranscriptPolicy({
  duplicateWindowMs: 2500,
  playbackEchoWindowMs: 12000,
  playbackEchoSimilarity: 0.92
});

assert(!policy.evaluate("……", 1000).accepted, "Punctuation-only ASR output must be discarded.");
assert(policy.evaluate("这是一段真实转写", 2000).accepted, "A normal native ASR result must be retained.");
assert(policy.evaluate("这是一段真实转写", 3000).reason === "rapid-duplicate", "A rapid exact native-ASR duplicate must be suppressed.");
assert(policy.evaluate("这是一段真实转写", 5001).accepted, "The same words spoken later must remain a valid observation.");

policy.rememberPlayback("这是 Codex 主动发到眼镜上的提醒。", 10000);
assert(
  policy.evaluate("这是Codex主动发到眼镜上的提醒", 10500).reason === "recent-playback-echo",
  "A near-identical native-TTS echo must not return to the observation queue."
);
assert(
  policy.evaluate("对，你刚才主动提醒的事情我已经处理了", 10600).accepted,
  "A meaningful user response after Agent playback must not be mistaken for echo."
);

policy.rememberPlayback("好的", 12000);
assert(policy.evaluate("好的", 12100).accepted, "Very short user speech must not be removed by the playback guard.");
assert(policy.evaluate("谢谢", 13000).accepted, "Native AIUI ASR must not inherit Whisper-specific phrase blacklists.");

const seeded = createTranscriptPolicy({ duplicateWindowMs: 2500 });
seeded.seedAccepted([{ text: "跨重载重复", createdAt: 20000 }]);
assert(seeded.evaluate("跨重载重复", 21000).reason === "rapid-duplicate", "Pending persisted observations should seed duplicate protection after page reload.");

console.log("RabiLink transcript policy smoke test passed.");
