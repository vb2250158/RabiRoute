export type SpeechProvider = {
  id: string;
  kind: "tts" | "asr";
  enabled: boolean;
  model?: string;
  transport?: string;
  formats: string[];
  voiceBinding?: string;
  loaded?: boolean;
  loadedDevice?: string;
  preload?: boolean;
  localFilesOnly?: boolean;
  warmupError?: string;
};

export type SpeechRuntimeStatus = {
  state: "online" | "offline" | "invalid";
  checkedAt: string;
  configuredUrl: string;
  latencyMs?: number;
  service?: string;
  localOnly?: boolean;
  relaySafe?: boolean;
  streaming?: boolean;
  defaults: { tts?: string; asr?: string };
  providers: { tts: SpeechProvider[]; asr: SpeechProvider[] };
  error?: string;
};

export type SpeechModel = {
  id: string;
  capability: "tts" | "asr";
  provider: string;
  model: string;
  name: string;
  family: string;
  installed: boolean;
  enabled: boolean;
  loaded: boolean;
  available: boolean;
  isDefault: boolean;
  languages: string[];
  features: string[];
  status?: string;
  note?: string;
  request?: Record<string, unknown>;
};

export type SpeechPersona = {
  id: string;
  voiceReady: boolean;
};

export type SpeechAudioInput = {
  index: number;
  name: string;
  channels: number;
  defaultSampleRate: number;
  isDefault: boolean;
};

export type SpeechMicrophoneConfig = {
  enabled: boolean;
  device: number | string | null;
  sampleRate: number;
  chunkMs: number;
  preRollMs: number;
  recordThreshold: number;
  transcribeThreshold: number;
  adaptiveThreshold: boolean;
  adaptiveMultiplier: number;
  adaptiveMargin: number;
  silenceMs: number;
  minUtteranceMs: number;
  maxUtteranceMs: number;
  inputGain: number;
  asrModel: string;
  language: string | null;
  prompt: string | null;
  autoSubmit: boolean;
  routeId: string | null;
  sessionId: string;
  suppressDuringPlayback: boolean;
};

export type SpeechMicrophoneStats = {
  captured: number;
  recognized: number;
  empty: number;
  submitted: number;
  submitFailed: number;
  dropped: number;
};

export type SpeechHistoryItem = {
  time: number;
  text: string;
  provider: string;
  model: string;
  duration: number;
  submitted: boolean;
  submitError?: string;
};

export type SpeechEvent = {
  sequence: number;
  time: number;
  stage: string;
  kind: string;
  level: "info" | "warning" | "error" | string;
  message: string;
  details: Record<string, unknown>;
};

export type SpeechMicrophoneStatus = {
  running: boolean;
  state: string;
  error?: string;
  lastSubmitError?: string;
  level: number;
  levelHistory: number[];
  noiseFloor: number;
  dynamicThreshold: number;
  utteranceActive: boolean;
  pending: number;
  dropped: number;
  stats: SpeechMicrophoneStats;
  config: SpeechMicrophoneConfig;
  history: SpeechHistoryItem[];
  events: SpeechEvent[];
};

export type SpeechPlaybackJob = {
  id: string;
  status: string;
  provider?: string;
  model?: string;
  voice?: string;
  sessionId?: string | null;
  routeId?: string | null;
  createdAt?: number;
  updatedAt?: number;
  startedAt?: number;
  completedAt?: number;
  error?: string;
};

export type SpeechPlaybackStatus = {
  mode: string;
  current: string | null;
  queued: number;
  jobs: SpeechPlaybackJob[];
};

export type SpeechMicrophoneStartCommand = Omit<SpeechMicrophoneConfig, "enabled">;

export type SpeechSynthesisCommand = {
  model: string;
  input: string;
  voice: string;
  responseFormat: string;
  speed: number;
  language: string | null;
  instructions: string | null;
  sampleRate?: number | null;
  play: boolean;
  sessionId: string | null;
  routeId: string | null;
};

export type SpeechMessageCommand = {
  routeId: string;
  text: string;
  sessionId: string;
};

export type SpeechMessageAccepted = {
  routeId: string;
  messageId: string;
  sessionId: string;
  status: "accepted";
};

export type SpeechModelsPayload = { models: SpeechModel[] };
export type SpeechPersonasPayload = { personas: SpeechPersona[] };
export type SpeechAudioInputsPayload = { devices: SpeechAudioInput[] };

export type SpeechControlEnvelope<T> = {
  code: 0;
  data: T;
} | {
  code: -1;
  message: string;
};

export type SpeechRouteProfile = {
  asrModel: string;
  ttsModel: string;
  voice: string;
  language: string;
  speed: number;
  recordThreshold: number;
  transcribeThreshold: number;
  adaptiveThreshold: boolean;
  silenceMs: number;
  minUtteranceMs: number;
  maxUtteranceMs: number;
  preRollMs: number;
  inputGain: number;
  autoSubmit: boolean;
  autoPlay: boolean;
};

export const DEFAULT_SPEECH_ROUTE_PROFILE: Readonly<SpeechRouteProfile> = Object.freeze({
  asrModel: "faster-whisper/small",
  ttsModel: "local-tts/gpt-sovits",
  voice: "Rabi",
  language: "zh",
  speed: 1,
  recordThreshold: 0.01,
  transcribeThreshold: 0.015,
  adaptiveThreshold: true,
  silenceMs: 500,
  minUtteranceMs: 1_000,
  maxUtteranceMs: 60_000,
  preRollMs: 1_500,
  inputGain: 1,
  autoSubmit: true,
  autoPlay: true
});

function finiteNumber(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function booleanValue(value: unknown, fallback: boolean): boolean {
  if (value == null || value === "") return fallback;
  if (typeof value === "boolean") return value;
  return String(value).toLowerCase() !== "false";
}

export function resolveSpeechRouteProfile(
  variables: Record<string, string> | undefined,
  fallbackVoice = DEFAULT_SPEECH_ROUTE_PROFILE.voice
): SpeechRouteProfile {
  const source = variables ?? {};
  const recordThreshold = finiteNumber(source.speechThreshold, DEFAULT_SPEECH_ROUTE_PROFILE.recordThreshold);
  return {
    asrModel: source.speechAsrModel || DEFAULT_SPEECH_ROUTE_PROFILE.asrModel,
    ttsModel: source.speechTtsModel || DEFAULT_SPEECH_ROUTE_PROFILE.ttsModel,
    voice: source.speechVoice || fallbackVoice,
    language: source.speechLanguage || DEFAULT_SPEECH_ROUTE_PROFILE.language,
    speed: finiteNumber(source.speechSpeed, DEFAULT_SPEECH_ROUTE_PROFILE.speed),
    recordThreshold,
    transcribeThreshold: Math.max(
      recordThreshold,
      finiteNumber(source.speechTranscribeThreshold, DEFAULT_SPEECH_ROUTE_PROFILE.transcribeThreshold)
    ),
    adaptiveThreshold: booleanValue(source.speechAdaptiveThreshold, DEFAULT_SPEECH_ROUTE_PROFILE.adaptiveThreshold),
    silenceMs: finiteNumber(source.speechSilenceMs, DEFAULT_SPEECH_ROUTE_PROFILE.silenceMs),
    minUtteranceMs: finiteNumber(source.speechMinUtteranceMs, DEFAULT_SPEECH_ROUTE_PROFILE.minUtteranceMs),
    maxUtteranceMs: finiteNumber(source.speechMaxUtteranceMs, DEFAULT_SPEECH_ROUTE_PROFILE.maxUtteranceMs),
    preRollMs: finiteNumber(source.speechPreRollMs, DEFAULT_SPEECH_ROUTE_PROFILE.preRollMs),
    inputGain: finiteNumber(source.speechInputGain, DEFAULT_SPEECH_ROUTE_PROFILE.inputGain),
    autoSubmit: booleanValue(source.speechAutoSubmit, DEFAULT_SPEECH_ROUTE_PROFILE.autoSubmit),
    autoPlay: booleanValue(source.speechAutoPlay, DEFAULT_SPEECH_ROUTE_PROFILE.autoPlay)
  };
}

export function applySpeechRouteVariableDefaults(
  variables: Record<string, string> | undefined,
  fallbackVoice = DEFAULT_SPEECH_ROUTE_PROFILE.voice
): Record<string, string> {
  const profile = resolveSpeechRouteProfile(variables, fallbackVoice);
  return {
    ...(variables ?? {}),
    speechAsrModel: profile.asrModel,
    speechTtsModel: profile.ttsModel,
    speechVoice: profile.voice,
    speechLanguage: profile.language,
    speechSpeed: String(profile.speed),
    speechThreshold: String(profile.recordThreshold),
    speechTranscribeThreshold: String(profile.transcribeThreshold),
    speechAdaptiveThreshold: String(profile.adaptiveThreshold),
    speechSilenceMs: String(profile.silenceMs),
    speechMinUtteranceMs: String(profile.minUtteranceMs),
    speechMaxUtteranceMs: String(profile.maxUtteranceMs),
    speechPreRollMs: String(profile.preRollMs),
    speechInputGain: String(profile.inputGain),
    speechAutoSubmit: String(profile.autoSubmit),
    speechAutoPlay: String(profile.autoPlay)
  };
}
