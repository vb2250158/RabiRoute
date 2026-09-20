import type { SpeechAudioStreamStatus } from "@shared/speechControlContract";

type OutputState = Pick<SpeechAudioStreamStatus, "source" | "selectedOnline">;

/** Describe the selected target without treating a missing remote device as local. */
export function playbackOutputLabel(state: OutputState | null, selectedName?: string): string {
  if (!state) return "状态未知";
  if (state.source === "remote" && !state.selectedOnline) return "远端设备（已离线）";
  return selectedName || (state.source === "local" ? "本机" : "远端设备");
}

/** Return the recovery instruction for an unavailable selected output. */
export function playbackOutputError(state: OutputState | null): string | null {
  return state?.source === "remote" && !state.selectedOnline
    ? "所选音频设备已离线，请重新连接设备或切换到本机。"
    : null;
}
