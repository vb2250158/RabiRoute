import type { SpeechAudioStreamStatus } from "@shared/speechControlContract";

type OutputState = Pick<SpeechAudioStreamStatus, "source" | "selectedOnline" | "selectionStorageError">;

/** Describe the selected target without treating a missing remote device as local. */
export function playbackOutputLabel(state: OutputState | null, selectedName?: string): string {
  if (!state) return "状态未知";
  if (state.source === "unavailable" || state.selectionStorageError) return "请重新选择音频设备";
  if (state.source === "remote" && !state.selectedOnline) return "远端设备（已离线）";
  return selectedName || (state.source === "local" ? "本机" : "远端设备");
}

/** Return the recovery instruction for an unavailable selected output. */
export function playbackOutputError(state: OutputState | null): string | null {
  if (state?.source === "unavailable" || state?.selectionStorageError)
    return "音频设备选择暂不可用。请重新选择设备；原设置会保留备份。";
  return state?.source === "remote" && !state.selectedOnline
    ? "所选音频设备已离线，请重新连接设备或切换到本机。"
    : null;
}
