export const voiceRuntimeModes = ["aiui_native", "api"] as const;
export type VoiceRuntimeMode = typeof voiceRuntimeModes[number];
export type VoiceAdapterKind = "asr" | "tts";

export type VoiceCapabilityDescriptor = {
  schemaVersion: 1;
  adapterId: string;
  kind: VoiceAdapterKind;
  mode: VoiceRuntimeMode;
  available: boolean;
  requiresApiKey: boolean;
  networkFallback: boolean;
  locale: string;
  locales: readonly string[];
  supportsPartial?: boolean;
  supportsContinuous?: boolean;
  supportsCancel: boolean;
  supportsPlaybackReceipt?: boolean;
  reason: string;
};

export type AsrFinalResult = {
  resultId: string;
  text: string;
  final: true;
  capturedAt: number;
  adapterId: string;
  mode: VoiceRuntimeMode;
  locale: string;
};

export type TtsPlaybackRequest = {
  text: string;
  locale?: string;
  queueMode?: "enqueue" | "flush";
};

export type TtsPlaybackAttempt = {
  attemptId: string;
  messageId: string;
  accepted: boolean;
  status: "accepted" | "rejected";
  acceptedAt: number;
  adapterId: string;
  mode: VoiceRuntimeMode;
  locale: string;
  playbackReceipt: "not_supported" | "pending" | "played" | "failed";
};

export interface AsrInputAdapter {
  readonly adapterId: string;
  readonly mode: VoiceRuntimeMode;
  getCapability(): VoiceCapabilityDescriptor;
}

export interface TtsOutputAdapter {
  readonly adapterId: string;
  readonly mode: VoiceRuntimeMode;
  getCapability(): VoiceCapabilityDescriptor;
}

function text(value: unknown): string {
  return String(value ?? "").trim();
}

function runtimeMode(value: unknown): VoiceRuntimeMode {
  return value === "api" ? "api" : "aiui_native";
}

export function normalizeVoiceCapability(
  value: Partial<VoiceCapabilityDescriptor>,
  defaults: Pick<VoiceCapabilityDescriptor, "adapterId" | "kind">
): VoiceCapabilityDescriptor {
  const mode = runtimeMode(value.mode);
  const locale = text(value.locale) || "zh-CN";
  const locales = Array.isArray(value.locales)
    ? [...new Set(value.locales.map(text).filter(Boolean))]
    : [];
  if (!locales.includes(locale)) locales.unshift(locale);
  const available = value.available === true;

  return {
    schemaVersion: 1,
    adapterId: text(value.adapterId) || defaults.adapterId,
    kind: value.kind === "tts" ? "tts" : defaults.kind,
    mode,
    available,
    requiresApiKey: mode === "api" ? value.requiresApiKey !== false : false,
    networkFallback: value.networkFallback === true,
    locale,
    locales,
    supportsPartial: value.kind === "tts" || defaults.kind === "tts"
      ? undefined
      : value.supportsPartial === true,
    supportsContinuous: value.kind === "tts" || defaults.kind === "tts"
      ? undefined
      : value.supportsContinuous === true,
    supportsCancel: value.supportsCancel === true,
    supportsPlaybackReceipt: value.kind === "tts" || defaults.kind === "tts"
      ? value.supportsPlaybackReceipt === true
      : undefined,
    reason: available ? "" : (text(value.reason) || "Voice capability is unavailable.")
  };
}

export function createAsrFinalResult(
  value: Omit<AsrFinalResult, "final" | "text" | "resultId"> & { text: unknown; resultId: unknown }
): AsrFinalResult {
  const normalizedText = text(value.text);
  const resultId = text(value.resultId);
  if (!normalizedText) throw new Error("ASR final result text is required.");
  if (!resultId) throw new Error("ASR final result id is required.");
  if (!Number.isFinite(value.capturedAt) || value.capturedAt <= 0) {
    throw new Error("ASR final result capturedAt must be a positive timestamp.");
  }
  return {
    ...value,
    resultId,
    text: normalizedText,
    final: true,
    adapterId: text(value.adapterId),
    mode: runtimeMode(value.mode),
    locale: text(value.locale) || "zh-CN"
  };
}

export function createTtsPlaybackAttempt(
  value: Omit<TtsPlaybackAttempt, "attemptId" | "messageId" | "adapterId" | "locale" | "mode"> & {
    attemptId: unknown;
    messageId: unknown;
    adapterId: unknown;
    locale?: unknown;
    mode?: unknown;
  }
): TtsPlaybackAttempt {
  const attemptId = text(value.attemptId);
  const messageId = text(value.messageId);
  const adapterId = text(value.adapterId);
  if (!attemptId) throw new Error("TTS playback attempt id is required.");
  if (!messageId) throw new Error("TTS playback message id is required.");
  if (!adapterId) throw new Error("TTS playback adapter id is required.");
  if (!Number.isFinite(value.acceptedAt) || value.acceptedAt <= 0) {
    throw new Error("TTS playback acceptedAt must be a positive timestamp.");
  }
  return {
    ...value,
    attemptId,
    messageId,
    adapterId,
    locale: text(value.locale) || "zh-CN",
    mode: runtimeMode(value.mode)
  };
}
