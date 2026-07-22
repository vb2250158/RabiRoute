import type { SpeechSpeakerIdentityCapability } from "@shared/speechControlContract";

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
