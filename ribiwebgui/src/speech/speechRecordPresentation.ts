import type { AppLocale } from "../i18n";

export type SpeechAudioCacheReferenceKind = "relative-cache-path" | "legacy-filename";

export function speechAudioCacheReferenceKind(value: string | null | undefined): SpeechAudioCacheReferenceKind | null {
  const normalized = String(value || "").trim();
  if (!normalized) return null;
  return normalized.includes("/") ? "relative-cache-path" : "legacy-filename";
}

export function formatSpeechEpochSeconds(value: number, locale: AppLocale): string {
  if (!Number.isFinite(value) || value <= 0) return "-";
  return new Date(value * 1000).toLocaleString(locale === "en" ? "en-US" : "zh-CN", { hour12: false });
}
