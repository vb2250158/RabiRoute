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
  speakerIdentity?: SpeechSpeakerIdentityCapability;
  error?: string;
};

export type SpeechVoiceprintCapability = {
  supported: boolean;
  available?: boolean;
  experimental: boolean;
  reason?: string;
  model?: string;
  provider?: string;
  validated?: boolean;
  autoAssign?: boolean;
};

export type SpeechSpeakerIdentityCapability = {
  scope: "loopback-only" | string;
  mode: "manual_record_label_binding" | string;
  manualBinding: boolean;
  bindingScope: "record_speaker_label" | string;
  aliasesAreMetadataOnly: boolean;
  diarizationLabelsAreBiometricIdentity: false;
  storesRawEnrollmentAudio: false;
  storesVoiceEmbeddings?: boolean;
  voiceprint: SpeechVoiceprintCapability;
  storageError?: string;
};

export type SpeechSpeakerProfile = {
  id: string;
  displayName: string;
  aliases: string[];
  createdAt: number;
  updatedAt: number;
};

export type SpeechSpeakerBinding = {
  sessionId: string;
  recordId: string;
  speakerLabel: string;
  speakerId: string;
  speakerName?: string;
  decision: "manual_record_binding" | "manual_session_binding" | string;
  createdAt: number;
  updatedAt: number;
};

export type SpeechSpeakerCluster = {
  id: string;
  sampleCount: number;
  totalDuration: number;
  lastSeenAt: number;
};

export type SpeechSpeakerRegistry = {
  profiles: SpeechSpeakerProfile[];
  bindings: SpeechSpeakerBinding[];
  capability: SpeechSpeakerIdentityCapability;
  clusters: SpeechSpeakerCluster[];
};

export type SpeechSpeakerProfileCreateCommand = {
  displayName: string;
  aliases?: string[];
};

export type SpeechSpeakerProfileUpdateCommand = {
  displayName?: string;
  aliases?: string[];
};

export type SpeechSpeakerBindingCommand = {
  sessionId: string;
  recordId: string;
  speakerLabel: string;
  speakerId: string;
};

export type SpeechSpeakerIdentityCommand = {
  sessionId: string;
  recordId: string;
  speakerLabel: string;
  speakerId?: string | null;
  displayName?: string | null;
  aliases?: string[];
};

export type SpeechSpeakerIdentityResult = {
  created: boolean;
  reused: boolean;
  profileUpdated: boolean;
  bindingChanged: boolean;
  matchedBy: "created" | "speaker_id" | "display_name_or_alias" | string;
  profile: SpeechSpeakerProfile;
  binding: SpeechSpeakerBinding;
};

export type SpeechSpeakerProfileDeleteResult = {
  deleted: SpeechSpeakerProfile;
  removedBindings: number;
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
  avatarUrl?: string;
  defaultModel?: string;
  language?: string;
  instructions?: string;
  speed?: number;
  voiceStyleSummary?: string;
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
  /** Compatibility state. Resident microphone transcripts now broadcast through Manager. */
  autoSubmit: boolean;
  /** Deprecated single-Route binding; normalized to null by the broadcast runtime. */
  routeId: string | null;
  /** Host-generated conversation identity; not a user-facing setting. */
  sessionId: string;
  suppressDuringPlayback: boolean;
};

export type SpeechMicrophoneStats = {
  captured: number;
  recognized: number;
  empty: number;
  delivered: number;
  recorded: number;
  deliveryFailed: number;
  /** Compatibility total: delivered + recorded. */
  submitted: number;
  /** Compatibility alias for deliveryFailed. */
  submitFailed: number;
  dropped: number;
};

export type SpeechAudioStreamClient = {
  id: string;
  name: string;
  sampleRate: number;
  chunkMs: number;
  connectedAt: number;
  lastAudioAt?: number | null;
  selected: boolean;
  online: boolean;
};

export type SpeechAudioStreamStatus = {
  enabled: boolean;
  listening: boolean;
  port: number;
  source: "local" | "remote";
  selectedClientId: string | null;
  selectedOnline: boolean;
  captureEnabled: boolean;
  clients: SpeechAudioStreamClient[];
  checkedAt: number;
};

export type SpeechAudioStreamSelectionCommand = {
  source: "local" | "remote";
  clientId?: string | null;
};

export type SpeechMessageStatus = "delivered" | "recorded" | "failed";

export type SpeechHistoryItem = {
  time: number;
  text: string;
  provider: string;
  model: string;
  duration: number;
  submitted: boolean;
  messageId?: string;
  deliveryStatus?: SpeechMessageStatus;
  deliveryReason?: string;
  submitError?: string;
  segments: SpeechTranscriptSegment[];
};

export type SpeechTranscriptSegment = {
  id: number;
  start: number;
  end: number;
  text: string;
  speaker?: string;
  speakerLabel?: string;
  speakerId?: string;
  speakerName?: string;
  speakerDecision?: string;
  speakerClusterId?: string;
  speakerScore?: number;
  speakerMargin?: number;
  speakerSampleDuration?: number;
  speakerModel?: string;
  speakerSuggestionId?: string;
  speakerSuggestionName?: string;
};

export type SpeechRecord = {
  id: string;
  kind: "asr" | "tts";
  source: string;
  time: number;
  sessionId: string | null;
  routeId: string | null;
  provider: string;
  model: string;
  voice?: string;
  text: string;
  language?: string;
  duration?: number;
  segments: SpeechTranscriptSegment[];
  playbackJobId?: string;
  playbackStatus?: string;
  /**
   * Safe POSIX-style cache-relative reference. New records include the persona cache path;
   * legacy records may contain only the filename. Never contains a host absolute path.
   */
  audioFile?: string;
  /** Expected cache expiry as Unix epoch seconds; this is not proof that cleanup already ran. */
  audioExpiresAt?: number;
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
  volume: number;
  current: string | null;
  queued: number;
  jobs: SpeechPlaybackJob[];
};

export type SpeechPlaybackVolumeCommand = {
  volume: number;
};

export type SpeechMicrophoneSettingsCommand = Omit<
  SpeechMicrophoneConfig,
  "enabled" | "autoSubmit" | "routeId" | "sessionId"
>;

export type SpeechMicrophoneStartCommand = SpeechMicrophoneSettingsCommand;

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
  /** Omit to broadcast to every enabled speech message endpoint. */
  routeId?: string | null;
  text: string;
  sessionId?: string | null;
};

export type SpeechRouteDeliveryResult = {
  routeId: string;
  messageId: string;
  status: SpeechMessageStatus;
  reason?: string;
  detail?: string;
};

export type SpeechMessageResult = {
  routeId: string | null;
  messageId: string;
  sessionId: string;
  status: SpeechMessageStatus;
  reason?: string;
  detail?: string;
  deliveries?: SpeechRouteDeliveryResult[];
};

export type SpeechModelsPayload = { models: SpeechModel[] };
export type SpeechPersonasPayload = { personas: SpeechPersona[] };
export type SpeechAudioInputsPayload = { devices: SpeechAudioInput[] };
export type SpeechAudioStreamsPayload = { audioStream: SpeechAudioStreamStatus };

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

export const SPEECH_ROUTE_VARIABLE_KEYS = [
  "speechAsrModel",
  "speechTtsModel",
  "speechVoice",
  "speechLanguage",
  "speechSpeed",
  "speechInstructions",
  "speechThreshold",
  "speechTranscribeThreshold",
  "speechAdaptiveThreshold",
  "speechSilenceMs",
  "speechMinUtteranceMs",
  "speechMaxUtteranceMs",
  "speechPreRollMs",
  "speechInputGain",
  "speechAutoSubmit",
  "speechAutoPlay"
] as const;

const SPEECH_ROUTE_VARIABLE_KEY_SET: ReadonlySet<string> = new Set(SPEECH_ROUTE_VARIABLE_KEYS);

export function isSpeechRouteVariableKey(value: string): boolean {
  return SPEECH_ROUTE_VARIABLE_KEY_SET.has(value);
}

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
