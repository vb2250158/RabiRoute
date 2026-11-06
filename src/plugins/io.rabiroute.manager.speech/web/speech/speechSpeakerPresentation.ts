import type {
  SpeechSpeakerIdentityCapability,
  SpeechTranscriptSegment
} from "@shared/speechControlContract";

export type VoiceprintPresentation = {
  label: string;
  color: "grey" | "warning" | "success";
};

export function voiceprintPresentation(
  capability: SpeechSpeakerIdentityCapability | null | undefined
): VoiceprintPresentation {
  if (!capability) return { label: "正在读取说话人能力", color: "grey" };
  if (capability.voiceprint.supported) return { label: "自动声纹识别可用", color: "success" };
  if (capability.voiceprint.available && capability.voiceprint.experimental && capability.voiceprint.autoAssign) {
    return { label: "自动声纹识别（实验性）", color: "warning" };
  }
  if (capability.voiceprint.available && !capability.voiceprint.supported) {
    return { label: "声纹聚类可用，自动认人待校准", color: "warning" };
  }
  if (!capability.voiceprint.supported) return { label: "自动声纹识别不可用", color: "grey" };
  return { label: "自动声纹识别不可用", color: "grey" };
}

const VERIFIED_SPEAKER_DECISIONS = new Set([
  "manual_record_binding",
  "manual_session_binding",
  "voiceprint_auto_match"
]);

export function unknownVoiceprintGroupLabel(clusterId?: string): string {
  const suffix = clusterId?.trim().slice(-4).toUpperCase();
  return suffix ? `未知声纹（未验证） ${suffix}` : "未知声纹（未验证）";
}

export function transcriptSpeakerPresentation(segments: SpeechTranscriptSegment[]): string {
  if (!segments.length || segments.some(segment => !VERIFIED_SPEAKER_DECISIONS.has(segment.speakerDecision || ""))) {
    return "未知声纹（未验证）";
  }
  const names = [...new Set(segments.map(segment => (
    segment.speakerName || segment.speakerLabel || segment.speaker || ""
  )).filter(Boolean))];
  return names.length ? names.join(" / ") : "未知声纹（未验证）";
}
