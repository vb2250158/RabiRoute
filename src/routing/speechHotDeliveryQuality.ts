import {
  matchSpeechTriggerKeyword,
  normalizeSpeechTriggerKeywords
} from "../shared/gatewayConfigModel.js";
import type {
  SpeechIngressRecord,
  SpeechTranscriptSegment
} from "../shared/speechControlContract.js";

const VERIFIED_SPEAKER_DECISIONS = new Set([
  "manual_record_binding",
  "manual_session_binding",
  "voiceprint_auto_match"
]);
const MIN_WORD_CONFIDENCE = 0.72;
const EXPLICIT_INSTRUCTION = /^(?:请|请你|帮我|麻烦|继续|暂停|停止|开始|打开|关闭|切换|播放|查询|查找|查一下|告诉我|记住|记录|提醒|发送|回复|总结|解释|检查|修复|测试|验证|同步|更新|创建|删除|please\b|can you\b|could you\b|would you\b)/i;

export type SpeechHotDeliveryQualityReason =
  | "quality_gate_passed"
  | "speaker_unverified"
  | "asr_quality_unavailable"
  | "asr_quality_low"
  | "no_explicit_wake_or_instruction";

export type SpeechHotDeliveryQualityDecision = {
  shouldNotifyAgent: boolean;
  reason: SpeechHotDeliveryQualityReason;
  averageWordConfidence?: number;
  matchedWakeWord?: string;
  explicitInstruction: boolean;
  speakerDecisions: string[];
  trustedMobile?: boolean;
};

function normalizedSpeakerDecisions(segments: SpeechTranscriptSegment[]): string[] {
  return [...new Set(segments.map(segment => String(segment.speakerDecision || "").trim()).filter(Boolean))];
}

function wordConfidences(segments: SpeechTranscriptSegment[]): number[] {
  return segments.flatMap(segment => (segment.words || []).flatMap(word => {
    const value = word.probability ?? word.confidence;
    return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1 ? [value] : [];
  }));
}

function isTrustedPairedMobile(record: SpeechIngressRecord): boolean {
  return record.messageAdapterType === "rabilink"
    && (record.sourceDeviceKind === "mobile" || record.sourceDeviceKind === "phone")
    && Boolean(record.sourceDeviceId?.trim())
    && record.sourceDeviceTrust === "speech_runtime_record_binding";
}

export function decideSpeechHotDeliveryQuality(
  record: SpeechIngressRecord,
  wakeWordsValue: unknown
): SpeechHotDeliveryQualityDecision {
  const speakerDecisions = normalizedSpeakerDecisions(record.segments);
  const trustedMobile = isTrustedPairedMobile(record);
  const speakersVerified = trustedMobile || record.segments.length > 0
    && record.segments.every(segment => VERIFIED_SPEAKER_DECISIONS.has(String(segment.speakerDecision || "").trim()));
  const text = record.text.trim();
  const matchedWakeWord = matchSpeechTriggerKeyword(text, normalizeSpeechTriggerKeywords(wakeWordsValue));
  const explicitInstruction = EXPLICIT_INSTRUCTION.test(text);
  const trustedMobileWakeBypass = trustedMobile && Boolean(matchedWakeWord);
  if (!speakersVerified) {
    return { shouldNotifyAgent: false, reason: "speaker_unverified", matchedWakeWord, explicitInstruction, speakerDecisions, trustedMobile };
  }

  const confidences = wordConfidences(record.segments);
  if (confidences.length === 0) {
    return {
      shouldNotifyAgent: false,
      reason: "asr_quality_unavailable",
      matchedWakeWord,
      explicitInstruction,
      speakerDecisions,
      trustedMobile
    };
  }
  const averageWordConfidence = confidences.reduce((sum, value) => sum + value, 0) / confidences.length;
  if (averageWordConfidence < MIN_WORD_CONFIDENCE && !trustedMobileWakeBypass) {
    return {
      shouldNotifyAgent: false,
      reason: "asr_quality_low",
      averageWordConfidence,
      matchedWakeWord,
      explicitInstruction,
      speakerDecisions,
      trustedMobile
    };
  }
  if (!matchedWakeWord && !explicitInstruction) {
    return {
      shouldNotifyAgent: false,
      reason: "no_explicit_wake_or_instruction",
      averageWordConfidence,
      explicitInstruction,
      speakerDecisions,
      trustedMobile
    };
  }
  return {
    shouldNotifyAgent: true,
    reason: "quality_gate_passed",
    averageWordConfidence,
    matchedWakeWord,
    explicitInstruction,
    speakerDecisions,
    trustedMobile
  };
}
