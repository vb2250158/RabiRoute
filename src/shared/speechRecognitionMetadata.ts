import type { SpeechRecognitionMetadata } from "./speechControlContract.js";

function label(value: unknown): string | undefined {
  return typeof value === "string" ? value.trim().slice(0, 256) || undefined : undefined;
}

function labels(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const result = value.slice(0, 4096).map(label).filter((item): item is string => item !== undefined);
  return result.length ? result : undefined;
}

export function normalizeSpeechRecognitionMetadata(value: Record<string, unknown>): SpeechRecognitionMetadata {
  const confidence = value.confidence;
  return {
    emotion: label(value.emotion),
    emotionLabels: labels(value.emotion_labels ?? value.emotionLabels),
    audioEvents: labels(value.audio_events ?? value.audioEvents),
    rawTags: labels(value.raw_tags ?? value.rawTags),
    confidence: typeof confidence === "number" && Number.isFinite(confidence) && confidence >= 0 && confidence <= 1
      ? confidence : undefined
  };
}
