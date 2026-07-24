import type {
  SpeechTranscriptSegment,
  SpeechTranscriptWord
} from "./speechControlContract.js";

const MAX_SEGMENT_TEXT = 100_000;
const MAX_WORD_TEXT = 500;
const MAX_WORDS_PER_SEGMENT = 5_000;

type NormalizeSpeechTranscriptOptions = {
  /** Keep loopback speech-control identity diagnostics out of portable Route/persona records by default. */
  includeDiagnosticNames?: boolean;
};

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function text(value: unknown, maxLength: number): string | undefined {
  const normalized = String(value ?? "").replace(/\s+/g, " ").trim().slice(0, maxLength);
  return normalized || undefined;
}

function number(value: unknown): number | undefined {
  if (value == null || value === "") return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function probability(value: unknown): number | undefined {
  const parsed = number(value);
  return parsed == null ? undefined : Math.max(0, Math.min(1, parsed));
}

export function normalizeSpeechTranscriptWord(value: unknown, index: number): SpeechTranscriptWord | undefined {
  const item = record(value);
  const word = text(item.word ?? item.text ?? item.token, MAX_WORD_TEXT);
  if (!word) return undefined;
  const rawStart = number(item.start ?? item.start_time ?? item.startTime);
  const rawEnd = number(item.end ?? item.end_time ?? item.endTime);
  const start = rawStart == null ? undefined : Math.max(0, rawStart);
  const end = rawEnd == null ? undefined : Math.max(start ?? 0, rawEnd);
  return {
    id: number(item.id) ?? index,
    word,
    start,
    end,
    probability: probability(item.probability),
    confidence: probability(item.confidence),
    speaker: text(item.speaker ?? item.speaker_label ?? item.speakerLabel, 200)
  };
}

export function normalizeSpeechTranscriptSegment(
  value: unknown,
  index: number,
  options: NormalizeSpeechTranscriptOptions = {}
): SpeechTranscriptSegment | undefined {
  const item = record(value);
  const segmentText = String(item.text ?? "").trim().slice(0, MAX_SEGMENT_TEXT);
  if (!segmentText) return undefined;
  const start = Math.max(0, number(item.start) ?? 0);
  const end = Math.max(start, number(item.end) ?? start);
  const speakerClusterId = text(item.speaker_cluster_id ?? item.speakerClusterId, 200);
  const words = Array.isArray(item.words)
    ? item.words.slice(0, MAX_WORDS_PER_SEGMENT)
      .map(normalizeSpeechTranscriptWord)
      .filter((word): word is SpeechTranscriptWord => Boolean(word))
    : [];
  return {
    id: number(item.id) ?? index,
    start,
    end,
    text: segmentText,
    words: words.length > 0 ? words : undefined,
    speaker: text(item.speaker, 200),
    speakerLabel: text(item.speaker_label ?? item.speakerLabel, 200),
    speakerId: options.includeDiagnosticNames
      ? text(item.speaker_id ?? item.speakerId, 200)
      : undefined,
    speakerName: options.includeDiagnosticNames
      ? text(item.speaker_name ?? item.speakerName, 300)
      : undefined,
    speakerDecision: text(item.speaker_decision ?? item.speakerDecision, 200),
    speakerClusterId,
    voiceprintId: text(item.voiceprint_id ?? item.voiceprintId, 200) ?? speakerClusterId,
    speakerScore: number(item.speaker_score ?? item.speakerScore),
    speakerMargin: number(item.speaker_margin ?? item.speakerMargin),
    speakerSampleDuration: number(item.speaker_sample_duration ?? item.speakerSampleDuration),
    speakerModel: text(item.speaker_model ?? item.speakerModel, 300),
    speakerSuggestionId: options.includeDiagnosticNames
      ? text(item.speaker_suggestion_id ?? item.speakerSuggestionId, 200)
      : undefined,
    speakerSuggestionName: options.includeDiagnosticNames
      ? text(item.speaker_suggestion_name ?? item.speakerSuggestionName, 300)
      : undefined
  };
}
