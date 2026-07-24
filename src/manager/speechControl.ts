import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import {
  DEFAULT_SPEECH_ROUTE_PROFILE,
  type SpeechAudioStreamSelectionCommand,
  type SpeechAudioStreamStatus,
  type SpeechAudioInput,
  type SpeechHistoryItem,
  type SpeechIngressRecord,
  type SpeechMessageCommand,
  type SpeechMessageResult,
  type SpeechMicrophoneConfig,
  type SpeechMicrophoneStartCommand,
  type SpeechMicrophoneSettingsCommand,
  type SpeechMicrophoneStats,
  type SpeechMicrophoneStatus,
  type SpeechModel,
  type SpeechPersona,
  type SpeechPlaybackJob,
  type SpeechPlaybackStatus,
  type SpeechPlaybackVolumeCommand,
  type SpeechRecord,
  type SpeechRuntimeStatus,
  type SpeechSpeakerBinding,
  type SpeechSpeakerBindingCommand,
  type SpeechSpeakerIdentityCapability,
  type SpeechSpeakerIdentityCommand,
  type SpeechSpeakerIdentityResult,
  type SpeechSpeakerProfile,
  type SpeechSpeakerProfileCreateCommand,
  type SpeechSpeakerProfileDeleteResult,
  type SpeechSpeakerProfileUpdateCommand,
  type SpeechSpeakerRegistry,
  type SpeechSynthesisCommand,
  type SpeechRouteDeliveryResult,
  type SpeechTranscriptSegment
} from "../shared/speechControlContract.js";
import { normalizeSpeechTranscriptSegment } from "../shared/speechTranscript.js";
import {
  normalizeSpeechIngressRecord,
  type SpeechIngressAppendResult,
  type SpeechRouteDeliveryReceipt
} from "../speechIngressStore.js";
import { roleFolderPath } from "../shared/routePaths.js";
import { sanitizeRoleId } from "../shared/routeIdentity.js";
import { personaAvatarPresentation } from "./personaAvatarRoutes.js";
import {
  localSpeechEndpoint,
  requestLocalSpeech,
  requestLocalSpeechJson,
  type LocalSpeechResponse
} from "../speech/localSpeechClient.js";
import { inspectLocalSpeechService } from "./speechServiceStatus.js";

type JsonRequestResult = { status: number; data: Record<string, unknown> };

export type ManagerSpeechLocalAdapter = {
  inspect(serviceUrl: string): Promise<SpeechRuntimeStatus>;
  requestJson(
    serviceUrl: string,
    pathname: string,
    init?: RequestInit,
    timeoutMs?: number
  ): Promise<JsonRequestResult>;
  requestBinary(
    serviceUrl: string,
    pathname: string,
    init?: RequestInit,
    timeoutMs?: number
  ): Promise<LocalSpeechResponse>;
};

export type ManagerSpeechRoute = {
  id: string;
  speechEnabled: boolean;
  rabiLinkEnabled?: boolean;
  routeProfileIds?: string[];
};

export type ManagerSpeechDeliveryOutcome = Pick<SpeechMessageResult, "status" | "reason" | "detail">;

export type ManagerSpeechDeliveryCommand = {
  routeId: string;
  record: SpeechIngressRecord;
};

export type ManagerSpeechIngressStore = {
  append(command: SpeechMessageCommand, fallbackId?: string): SpeechIngressAppendResult;
  readDeliveryReceipt?(recordId: string, routeId: string): SpeechRouteDeliveryReceipt | undefined;
  appendDeliveryReceipt?(receipt: SpeechRouteDeliveryReceipt): SpeechRouteDeliveryReceipt;
};

export type ManagerSpeechControlDependencies = {
  serviceUrl(): string;
  rolesRoot(): string;
  route(routeId: string): ManagerSpeechRoute | undefined;
  routes(): ManagerSpeechRoute[];
  deliverTranscript(command: ManagerSpeechDeliveryCommand): Promise<ManagerSpeechDeliveryOutcome>;
  appendRouteLog(routeId: string, message: string): void;
  speechIngressStore?: ManagerSpeechIngressStore;
  localSpeech?: ManagerSpeechLocalAdapter;
  createMessageId?: () => string;
};

export class SpeechControlError extends Error {
  constructor(
    message: string,
    readonly status: number
  ) {
    super(message);
    this.name = "SpeechControlError";
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function stringValue(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : value == null ? fallback : String(value);
}

function optionalString(value: unknown): string | undefined {
  const normalized = stringValue(value).trim();
  return normalized || undefined;
}

function safeRelativeAudioFile(value: unknown): string | undefined {
  const normalized = optionalString(value);
  if (!normalized || normalized.length > 1_024) return undefined;
  if (normalized.includes("\\") || normalized.includes("%") || normalized.includes(":") || /[\u0000-\u001f\u007f]/.test(normalized)) {
    return undefined;
  }
  if (normalized.startsWith("/") || /^[a-z]:/i.test(normalized)) return undefined;
  const segments = normalized.split("/");
  if (segments.some(segment => !segment || segment === "." || segment === "..")) return undefined;
  return normalized;
}

function optionalPositiveNumber(value: unknown): number | undefined {
  if (value == null || value === "") return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function optionalFiniteNumber(value: unknown): number | undefined {
  if (value == null || value === "") return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function numberValue(value: unknown, fallback = 0): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function booleanValue(value: unknown, fallback = false): boolean {
  return typeof value === "boolean" ? value : value == null ? fallback : String(value).toLowerCase() === "true";
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map(item => stringValue(item).trim()).filter(Boolean) : [];
}

function numberArray(value: unknown): number[] {
  return Array.isArray(value)
    ? value.map(item => Number(item)).filter(item => Number.isFinite(item))
    : [];
}

function rows(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.map(asRecord) : [];
}

function upstreamErrorMessage(data: Record<string, unknown>, status: number): string {
  const detail = asRecord(data.detail);
  return optionalString(data.message)
    || optionalString(data.detail)
    || optionalString(detail.message)
    || `RabiSpeech request failed (HTTP ${status}).`;
}

function assertSuccess(result: JsonRequestResult): Record<string, unknown> {
  if (result.status < 200 || result.status >= 300) {
    throw new SpeechControlError(upstreamErrorMessage(result.data, result.status), result.status);
  }
  return result.data;
}

const defaultLocalSpeechAdapter: ManagerSpeechLocalAdapter = {
  inspect: inspectLocalSpeechService,
  requestJson: (serviceUrl, pathname, init = {}, timeoutMs) => requestLocalSpeechJson<Record<string, unknown>>(
    serviceUrl,
    pathname,
    init,
    timeoutMs == null ? {} : { timeoutMs }
  ),
  requestBinary: (serviceUrl, pathname, init = {}, timeoutMs) => requestLocalSpeech(
    serviceUrl,
    pathname,
    init,
    timeoutMs == null ? {} : { timeoutMs }
  )
};

function normalizeModel(value: Record<string, unknown>): SpeechModel {
  const capability = value.capability === "asr" ? "asr" : "tts";
  return {
    id: stringValue(value.id),
    capability,
    provider: stringValue(value.provider),
    model: stringValue(value.model),
    name: stringValue(value.name || value.model || value.id),
    family: stringValue(value.family || value.provider),
    installed: booleanValue(value.installed, true),
    enabled: booleanValue(value.enabled, true),
    loaded: booleanValue(value.loaded),
    available: booleanValue(value.available, true),
    isDefault: booleanValue(value.default),
    languages: stringArray(value.languages),
    features: stringArray(value.features),
    status: optionalString(value.status),
    note: optionalString(value.note),
    request: Object.keys(asRecord(value.request)).length > 0 ? asRecord(value.request) : undefined
  };
}

function normalizeAudioInput(value: Record<string, unknown>): SpeechAudioInput {
  return {
    index: numberValue(value.index),
    name: stringValue(value.name || `Input ${numberValue(value.index)}`),
    channels: numberValue(value.channels),
    defaultSampleRate: numberValue(value.default_sample_rate ?? value.defaultSampleRate),
    isDefault: booleanValue(value.default ?? value.isDefault)
  };
}

function normalizeMicrophoneConfig(value: unknown): SpeechMicrophoneConfig {
  const config = asRecord(value);
  const recordThreshold = numberValue(
    config.record_threshold ?? config.recordThreshold,
    DEFAULT_SPEECH_ROUTE_PROFILE.recordThreshold
  );
  return {
    enabled: booleanValue(config.enabled),
    device: typeof config.device === "number" || typeof config.device === "string" ? config.device : null,
    sampleRate: numberValue(config.sample_rate ?? config.sampleRate, 16_000),
    chunkMs: numberValue(config.chunk_ms ?? config.chunkMs, 100),
    preRollMs: numberValue(config.pre_roll_ms ?? config.preRollMs, DEFAULT_SPEECH_ROUTE_PROFILE.preRollMs),
    recordThreshold,
    transcribeThreshold: Math.max(
      recordThreshold,
      numberValue(config.transcribe_threshold ?? config.transcribeThreshold, DEFAULT_SPEECH_ROUTE_PROFILE.transcribeThreshold)
    ),
    adaptiveThreshold: booleanValue(config.adaptive_threshold ?? config.adaptiveThreshold, DEFAULT_SPEECH_ROUTE_PROFILE.adaptiveThreshold),
    adaptiveMultiplier: numberValue(config.adaptive_multiplier ?? config.adaptiveMultiplier, 2.5),
    adaptiveMargin: numberValue(config.adaptive_margin ?? config.adaptiveMargin, 0.004),
    silenceMs: numberValue(config.silence_ms ?? config.silenceMs, DEFAULT_SPEECH_ROUTE_PROFILE.silenceMs),
    minUtteranceMs: numberValue(config.min_utterance_ms ?? config.minUtteranceMs, DEFAULT_SPEECH_ROUTE_PROFILE.minUtteranceMs),
    maxUtteranceMs: numberValue(config.max_utterance_ms ?? config.maxUtteranceMs, DEFAULT_SPEECH_ROUTE_PROFILE.maxUtteranceMs),
    inputGain: numberValue(config.input_gain ?? config.inputGain, DEFAULT_SPEECH_ROUTE_PROFILE.inputGain),
    asrModel: stringValue(config.asr_model ?? config.asrModel, DEFAULT_SPEECH_ROUTE_PROFILE.asrModel),
    language: config.language == null ? null : stringValue(config.language),
    prompt: config.prompt == null ? null : stringValue(config.prompt),
    autoSubmit: booleanValue(config.auto_submit ?? config.autoSubmit),
    routeId: config.route_id == null && config.routeId == null ? null : stringValue(config.route_id ?? config.routeId),
    sessionId: stringValue(config.session_id ?? config.sessionId, "rabispeech-microphone"),
    suppressDuringPlayback: booleanValue(config.suppress_during_playback ?? config.suppressDuringPlayback, true)
  };
}

function normalizeStats(value: unknown): SpeechMicrophoneStats {
  const stats = asRecord(value);
  const delivered = numberValue(stats.delivered);
  const recorded = numberValue(stats.recorded);
  const deliveryFailed = numberValue(stats.delivery_failed ?? stats.deliveryFailed ?? stats.submit_failed ?? stats.submitFailed);
  return {
    captured: numberValue(stats.captured),
    recognized: numberValue(stats.recognized),
    empty: numberValue(stats.empty),
    delivered,
    recorded,
    deliveryFailed,
    submitted: numberValue(stats.submitted, delivered + recorded),
    submitFailed: numberValue(stats.submit_failed ?? stats.submitFailed, deliveryFailed),
    dropped: numberValue(stats.dropped)
  };
}

function normalizeAudioStreamStatus(value: Record<string, unknown>): SpeechAudioStreamStatus {
  return {
    enabled: booleanValue(value.enabled),
    listening: booleanValue(value.listening),
    port: numberValue(value.port),
    source: value.source === "remote" ? "remote" : "local",
    selectedClientId: value.selected_client_id == null ? null : stringValue(value.selected_client_id),
    selectedOnline: booleanValue(value.selected_online, true),
    captureEnabled: booleanValue(value.capture_enabled),
    checkedAt: numberValue(value.checked_at),
    clients: rows(value.clients).map(client => {
      const messageAdapterType: "speech" | "rabilink" = client.message_adapter_type === "rabilink" || client.messageAdapterType === "rabilink"
        ? "rabilink"
        : "speech";
      return {
        id: stringValue(client.id),
        name: stringValue(client.name || client.id),
        kind: optionalString(client.kind),
        messageAdapterType,
        sampleRate: numberValue(client.sample_rate ?? client.sampleRate, 16_000),
        chunkMs: numberValue(client.chunk_ms ?? client.chunkMs, 100),
        connectedAt: numberValue(client.connected_at ?? client.connectedAt),
        lastAudioAt: client.last_audio_at == null && client.lastAudioAt == null
          ? null
          : numberValue(client.last_audio_at ?? client.lastAudioAt),
        selected: booleanValue(client.selected),
        online: booleanValue(client.online, true)
      };
    }).filter(client => Boolean(client.id))
  };
}

function normalizeHistoryItem(value: Record<string, unknown>): SpeechHistoryItem {
  return {
    time: numberValue(value.time),
    text: stringValue(value.text),
    provider: stringValue(value.provider),
    model: stringValue(value.model),
    duration: numberValue(value.duration),
    submitted: booleanValue(value.submitted),
    messageId: optionalString(value.message_id ?? value.messageId),
    deliveryStatus: value.delivery_status === "delivered" || value.deliveryStatus === "delivered"
      ? "delivered"
      : value.delivery_status === "recorded" || value.deliveryStatus === "recorded"
        ? "recorded"
        : value.delivery_status === "failed" || value.deliveryStatus === "failed"
          ? "failed"
          : undefined,
    deliveryReason: optionalString(value.delivery_reason ?? value.deliveryReason),
    submitError: optionalString(value.submit_error ?? value.submitError),
    segments: rows(value.segments).map(normalizeTranscriptSegment),
    source: optionalString(value.source),
    transport: optionalString(value.transport),
    channelType: optionalString(value.channel_type ?? value.channelType),
    messageAdapterType: value.message_adapter_type === "rabilink" || value.messageAdapterType === "rabilink"
      ? "rabilink"
      : value.message_adapter_type === "speech" || value.messageAdapterType === "speech"
        ? "speech"
        : undefined,
    sourceDeviceId: optionalString(value.source_device_id ?? value.sourceDeviceId),
    sourceDeviceName: optionalString(value.source_device_name ?? value.sourceDeviceName),
    sourceDeviceKind: optionalString(value.source_device_kind ?? value.sourceDeviceKind),
    sampleRate: optionalFiniteNumber(value.sample_rate ?? value.sampleRate)
  };
}

function normalizeTranscriptSegment(value: Record<string, unknown>, index: number): SpeechTranscriptSegment {
  return normalizeSpeechTranscriptSegment(value, index, { includeDiagnosticNames: true }) ?? {
    id: numberValue(value.id ?? index),
    start: numberValue(value.start),
    end: numberValue(value.end),
    text: stringValue(value.text)
  };
}

function normalizeSpeakerIdentityCapability(value: unknown): SpeechSpeakerIdentityCapability {
  const detail = asRecord(value);
  const voiceprint = asRecord(detail.voiceprint);
  return {
    scope: stringValue(detail.scope, "loopback-only"),
    mode: stringValue(detail.mode, "manual_record_label_binding"),
    manualBinding: booleanValue(detail.manual_binding ?? detail.manualBinding),
    bindingScope: stringValue(detail.binding_scope ?? detail.bindingScope, "record_speaker_label"),
    aliasesAreMetadataOnly: booleanValue(detail.aliases_are_metadata_only ?? detail.aliasesAreMetadataOnly, true),
    diarizationLabelsAreBiometricIdentity: false,
    storesRawEnrollmentAudio: false,
    storesVoiceEmbeddings: booleanValue(detail.stores_voice_embeddings ?? detail.storesVoiceEmbeddings),
    voiceprint: {
      supported: booleanValue(voiceprint.supported),
      available: booleanValue(voiceprint.available),
      experimental: booleanValue(voiceprint.experimental),
      reason: optionalString(voiceprint.reason),
      model: optionalString(voiceprint.model),
      provider: optionalString(voiceprint.provider),
      validated: booleanValue(voiceprint.validated),
      validationRequested: booleanValue(voiceprint.validation_requested ?? voiceprint.validationRequested),
      validationReport: optionalString(voiceprint.validation_report ?? voiceprint.validationReport),
      autoAssign: booleanValue(voiceprint.auto_assign ?? voiceprint.autoAssign)
    },
    storageError: optionalString(detail.storage_error ?? detail.storageError)
  };
}

function normalizeSpeakerProfile(value: Record<string, unknown>): SpeechSpeakerProfile {
  return {
    id: stringValue(value.id),
    displayName: stringValue(value.display_name ?? value.displayName),
    aliases: stringArray(value.aliases),
    createdAt: numberValue(value.created_at ?? value.createdAt),
    updatedAt: numberValue(value.updated_at ?? value.updatedAt)
  };
}

function normalizeSpeakerBinding(value: Record<string, unknown>): SpeechSpeakerBinding {
  return {
    sessionId: stringValue(value.session_id ?? value.sessionId),
    recordId: stringValue(value.record_id ?? value.recordId),
    speakerLabel: stringValue(value.speaker_label ?? value.speakerLabel),
    speakerId: stringValue(value.speaker_id ?? value.speakerId),
    speakerName: optionalString(value.speaker_name ?? value.speakerName),
    decision: stringValue(value.decision, "manual_session_binding"),
    createdAt: numberValue(value.created_at ?? value.createdAt),
    updatedAt: numberValue(value.updated_at ?? value.updatedAt)
  };
}

function normalizeSpeakerRegistry(value: Record<string, unknown>): SpeechSpeakerRegistry {
  return {
    profiles: rows(value.profiles).map(normalizeSpeakerProfile).filter(profile => Boolean(profile.id)),
    bindings: rows(value.bindings).map(normalizeSpeakerBinding).filter(binding => Boolean(binding.sessionId && binding.speakerLabel)),
    capability: normalizeSpeakerIdentityCapability(value.capability),
    clusters: rows(value.clusters).map(cluster => ({
      id: stringValue(cluster.id),
      sampleCount: numberValue(cluster.sample_count ?? cluster.sampleCount),
      totalDuration: numberValue(cluster.total_duration ?? cluster.totalDuration),
      lastSeenAt: numberValue(cluster.last_seen_at ?? cluster.lastSeenAt)
    })).filter(cluster => Boolean(cluster.id))
  };
}

function normalizeSpeakerIdentityResult(value: Record<string, unknown>): SpeechSpeakerIdentityResult {
  return {
    created: booleanValue(value.created),
    reused: booleanValue(value.reused),
    profileUpdated: booleanValue(value.profile_updated ?? value.profileUpdated),
    bindingChanged: booleanValue(value.binding_changed ?? value.bindingChanged),
    matchedBy: stringValue(value.matched_by ?? value.matchedBy),
    profile: normalizeSpeakerProfile(asRecord(value.profile)),
    binding: normalizeSpeakerBinding(asRecord(value.binding))
  };
}

function normalizeSpeechRecord(value: Record<string, unknown>): SpeechRecord {
  return {
    id: stringValue(value.id),
    kind: stringValue(value.kind) === "tts" ? "tts" : "asr",
    source: stringValue(value.source),
    time: numberValue(value.time),
    sessionId: value.session_id == null && value.sessionId == null ? null : stringValue(value.session_id ?? value.sessionId),
    routeId: value.route_id == null && value.routeId == null ? null : stringValue(value.route_id ?? value.routeId),
    provider: stringValue(value.provider),
    model: stringValue(value.model),
    voice: optionalString(value.voice),
    text: stringValue(value.text),
    language: optionalString(value.language),
    duration: value.duration == null ? undefined : numberValue(value.duration),
    segments: rows(value.segments).map(normalizeTranscriptSegment),
    playbackJobId: optionalString(value.playback_job_id ?? value.playbackJobId),
    playbackStatus: optionalString(value.playback_status ?? value.playbackStatus),
    audioFile: safeRelativeAudioFile(value.audio_file ?? value.audioFile),
    audioExpiresAt: optionalPositiveNumber(value.audio_expires_at ?? value.audioExpiresAt)
  };
}

function normalizeEventDetails(value: unknown): Record<string, unknown> {
  const details = { ...asRecord(value) };
  if ("route_id" in details) {
    details.routeId = details.route_id;
    delete details.route_id;
  }
  if ("session_id" in details) {
    details.sessionId = details.session_id;
    delete details.session_id;
  }
  return details;
}

function normalizeMicrophoneStatus(value: Record<string, unknown>): SpeechMicrophoneStatus {
  const stats = normalizeStats(value.stats);
  return {
    running: booleanValue(value.running),
    state: stringValue(value.state, "unknown"),
    error: optionalString(value.error),
    lastSubmitError: optionalString(value.last_submit_error ?? value.lastSubmitError),
    level: numberValue(value.level),
    levelHistory: numberArray(value.level_history ?? value.levelHistory),
    noiseFloor: numberValue(value.noise_floor ?? value.noiseFloor),
    dynamicThreshold: numberValue(value.dynamic_threshold ?? value.dynamicThreshold),
    utteranceActive: booleanValue(value.utterance_active ?? value.utteranceActive),
    pending: numberValue(value.pending),
    dropped: numberValue(value.dropped, stats.dropped),
    stats,
    config: normalizeMicrophoneConfig(value.config),
    history: rows(value.history).map(normalizeHistoryItem),
    events: rows(value.events).map(event => ({
      sequence: numberValue(event.sequence),
      time: numberValue(event.time),
      stage: stringValue(event.stage),
      kind: stringValue(event.kind),
      level: stringValue(event.level, "info"),
      message: stringValue(event.message),
      details: normalizeEventDetails(event.details)
    }))
  };
}

function normalizePlaybackJob(value: Record<string, unknown>): SpeechPlaybackJob {
  return {
    id: stringValue(value.id),
    status: stringValue(value.status),
    provider: optionalString(value.provider),
    model: optionalString(value.model),
    voice: optionalString(value.voice),
    sessionId: value.session_id == null && value.sessionId == null ? null : stringValue(value.session_id ?? value.sessionId),
    routeId: value.route_id == null && value.routeId == null ? null : stringValue(value.route_id ?? value.routeId),
    createdAt: value.created_at == null && value.createdAt == null ? undefined : numberValue(value.created_at ?? value.createdAt),
    updatedAt: value.updated_at == null && value.updatedAt == null ? undefined : numberValue(value.updated_at ?? value.updatedAt),
    startedAt: value.started_at == null && value.startedAt == null ? undefined : numberValue(value.started_at ?? value.startedAt),
    completedAt: value.completed_at == null && value.completedAt == null ? undefined : numberValue(value.completed_at ?? value.completedAt),
    error: optionalString(value.error)
  };
}

function normalizePlaybackStatus(value: Record<string, unknown>): SpeechPlaybackStatus {
  return {
    mode: stringValue(value.mode, "host_fifo"),
    volume: Math.min(100, Math.max(0, numberValue(value.volume, 100))),
    current: value.current == null ? null : stringValue(value.current),
    queued: numberValue(value.queued),
    jobs: rows(value.jobs).map(normalizePlaybackJob)
  };
}

function microphoneStartPayload(command: SpeechMicrophoneStartCommand): Record<string, unknown> {
  return {
    device: command.device,
    sample_rate: command.sampleRate,
    chunk_ms: command.chunkMs,
    pre_roll_ms: command.preRollMs,
    record_threshold: command.recordThreshold,
    transcribe_threshold: Math.max(command.recordThreshold, command.transcribeThreshold),
    adaptive_threshold: command.adaptiveThreshold,
    adaptive_multiplier: command.adaptiveMultiplier,
    adaptive_margin: command.adaptiveMargin,
    silence_ms: command.silenceMs,
    min_utterance_ms: command.minUtteranceMs,
    max_utterance_ms: command.maxUtteranceMs,
    input_gain: command.inputGain,
    asr_model: command.asrModel,
    language: command.language,
    prompt: command.prompt,
    auto_submit: true,
    route_id: null,
    suppress_during_playback: command.suppressDuringPlayback
  };
}

function microphoneSettingsFromConfig(config: SpeechMicrophoneConfig): SpeechMicrophoneSettingsCommand {
  return {
    device: config.device,
    sampleRate: config.sampleRate,
    chunkMs: config.chunkMs,
    preRollMs: config.preRollMs,
    recordThreshold: config.recordThreshold,
    transcribeThreshold: config.transcribeThreshold,
    adaptiveThreshold: config.adaptiveThreshold,
    adaptiveMultiplier: config.adaptiveMultiplier,
    adaptiveMargin: config.adaptiveMargin,
    silenceMs: config.silenceMs,
    minUtteranceMs: config.minUtteranceMs,
    maxUtteranceMs: config.maxUtteranceMs,
    inputGain: config.inputGain,
    asrModel: config.asrModel,
    language: config.language,
    prompt: config.prompt,
    suppressDuringPlayback: config.suppressDuringPlayback
  };
}

function synthesisPayload(command: SpeechSynthesisCommand): Record<string, unknown> {
  return {
    model: command.model,
    input: command.input,
    voice: command.voice,
    response_format: command.responseFormat,
    speed: command.speed,
    language: command.language,
    instructions: command.instructions,
    sample_rate: command.sampleRate ?? null,
    play: command.play,
    session_id: command.sessionId,
    route_id: command.routeId
  };
}

export class ManagerSpeechControl {
  private readonly localSpeech: ManagerSpeechLocalAdapter;
  private readonly createMessageId: () => string;
  private readonly deliveryFlights = new Map<string, Promise<SpeechRouteDeliveryResult>>();

  constructor(private readonly dependencies: ManagerSpeechControlDependencies) {
    this.localSpeech = dependencies.localSpeech ?? defaultLocalSpeechAdapter;
    this.createMessageId = dependencies.createMessageId ?? (() => `speech-user-${randomUUID()}`);
  }

  status(): Promise<SpeechRuntimeStatus> {
    return this.localSpeech.inspect(this.dependencies.serviceUrl());
  }

  eventStream(signal: AbortSignal): Promise<Response> {
    return fetch(localSpeechEndpoint(this.dependencies.serviceUrl(), "/v1/events"), {
      method: "GET",
      headers: { accept: "text/event-stream" },
      signal
    });
  }

  async models(): Promise<SpeechModel[]> {
    const raw = assertSuccess(await this.localSpeech.requestJson(this.dependencies.serviceUrl(), "/v1/models", {}, 10_000));
    return rows(raw.data).map(normalizeModel).filter(model => Boolean(model.id));
  }

  personas(): SpeechPersona[] {
    const rolesRoot = this.dependencies.rolesRoot();
    if (!fs.existsSync(rolesRoot)) return [];
    return fs.readdirSync(rolesRoot, { withFileTypes: true })
      .filter(entry => entry.isDirectory() && Boolean(sanitizeRoleId(entry.name)))
      .map(entry => {
        const roleDir = roleFolderPath(rolesRoot, entry.name);
        const voiceRoot = path.join(roleDir, "voice");
        const profilePath = path.join(voiceRoot, "voice-profile.json");
        let profile: Record<string, unknown> = {};
        if (fs.existsSync(profilePath)) {
          try {
            const parsed = JSON.parse(fs.readFileSync(profilePath, "utf8").replace(/^\uFEFF/, ""));
            profile = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
          } catch { /* malformed private persona profile stays unavailable */ }
        }
        const speed = Number(profile.speed);
        const avatar = personaAvatarPresentation(entry.name, roleDir);
        return {
          id: entry.name,
          voiceReady: fs.existsSync(profilePath) || fs.existsSync(path.join(voiceRoot, "voice-index.json")),
          avatarUrl: avatar.avatarUrl,
          defaultModel: optionalString(profile.default_model ?? profile.defaultModel),
          language: optionalString(profile.language),
          instructions: optionalString(profile.instructions),
          speed: Number.isFinite(speed) ? speed : undefined,
          voiceStyleSummary: optionalString(profile.voice_style_summary ?? profile.voiceStyleSummary)
        };
      })
      .sort((left, right) => left.id.localeCompare(right.id));
  }

  async playbackStatus(): Promise<SpeechPlaybackStatus> {
    const raw = assertSuccess(await this.localSpeech.requestJson(this.dependencies.serviceUrl(), "/v1/playback/status", {}, 10_000));
    return normalizePlaybackStatus(raw);
  }

  async audioStreams(): Promise<SpeechAudioStreamStatus> {
    const raw = assertSuccess(await this.localSpeech.requestJson(this.dependencies.serviceUrl(), "/v1/audio-streams", {}, 10_000));
    return normalizeAudioStreamStatus(raw);
  }

  async audioStreamToken(): Promise<string> {
    const raw = assertSuccess(await this.localSpeech.requestJson(
      this.dependencies.serviceUrl(),
      "/v1/audio-streams/token",
      { method: "POST" },
      10_000
    ));
    const token = stringValue(raw.token).trim();
    if (!token) throw new SpeechControlError("RabiSpeech returned no audio stream token.", 502);
    return token;
  }

  async selectAudioStream(command: SpeechAudioStreamSelectionCommand): Promise<SpeechAudioStreamStatus> {
    const source = command?.source === "remote" ? "remote" : "local";
    const clientId = source === "remote" ? stringValue(command?.clientId).trim() : "";
    if (source === "remote" && !clientId) {
      throw new SpeechControlError("A remote audio client id is required.", 400);
    }
    const raw = assertSuccess(await this.localSpeech.requestJson(
      this.dependencies.serviceUrl(),
      "/v1/audio-streams/selection",
      {
        method: "PUT",
        headers: { "content-type": "application/json; charset=utf-8" },
        body: JSON.stringify({ source, client_id: clientId || null })
      },
      30_000
    ));
    return normalizeAudioStreamStatus(raw);
  }

  async setPlaybackVolume(command: SpeechPlaybackVolumeCommand): Promise<SpeechPlaybackStatus> {
    const volume = command?.volume;
    if (typeof volume !== "number" || !Number.isInteger(volume) || volume < 0 || volume > 100) {
      throw new SpeechControlError("Playback volume must be an integer between 0 and 100.", 400);
    }
    const raw = assertSuccess(await this.localSpeech.requestJson(
      this.dependencies.serviceUrl(),
      "/v1/playback/settings",
      {
        method: "PUT",
        headers: { "content-type": "application/json; charset=utf-8" },
        body: JSON.stringify({ volume })
      },
      10_000
    ));
    return normalizePlaybackStatus(raw);
  }

  async records(query: {
    limit?: number;
    kind?: string;
    sessionId?: string;
    routeId?: string;
    since?: number;
    until?: number;
  } = {}): Promise<SpeechRecord[]> {
    const search = new URLSearchParams();
    search.set("limit", String(Math.min(1000, Math.max(1, query.limit ?? 200))));
    if (query.kind) search.set("kind", query.kind);
    if (query.sessionId) search.set("session_id", query.sessionId);
    if (query.routeId) search.set("route_id", query.routeId);
    if (query.since != null) search.set("since", String(query.since));
    if (query.until != null) search.set("until", String(query.until));
    const raw = assertSuccess(await this.localSpeech.requestJson(
      this.dependencies.serviceUrl(),
      `/v1/records?${search.toString()}`,
      {},
      10_000
    ));
    return rows(raw.data).map(normalizeSpeechRecord).filter(item => Boolean(item.id));
  }

  async speakerRegistry(sessionId?: string): Promise<SpeechSpeakerRegistry> {
    const search = new URLSearchParams();
    const normalizedSessionId = stringValue(sessionId).trim().slice(0, 200);
    if (normalizedSessionId) search.set("session_id", normalizedSessionId);
    const suffix = search.size > 0 ? `?${search.toString()}` : "";
    const raw = assertSuccess(await this.localSpeech.requestJson(
      this.dependencies.serviceUrl(),
      `/v1/speaker-profiles${suffix}`,
      {},
      10_000
    ));
    return normalizeSpeakerRegistry(raw);
  }

  async createSpeakerProfile(command: SpeechSpeakerProfileCreateCommand): Promise<SpeechSpeakerProfile> {
    const displayName = stringValue(command?.displayName).trim();
    if (!displayName) throw new SpeechControlError("Missing speaker display name.", 400);
    const raw = assertSuccess(await this.localSpeech.requestJson(
      this.dependencies.serviceUrl(),
      "/v1/speaker-profiles",
      {
        method: "POST",
        headers: { "content-type": "application/json; charset=utf-8" },
        body: JSON.stringify({ display_name: displayName, aliases: stringArray(command?.aliases) })
      },
      10_000
    ));
    return normalizeSpeakerProfile(raw);
  }

  async updateSpeakerProfile(
    speakerId: string,
    command: SpeechSpeakerProfileUpdateCommand
  ): Promise<SpeechSpeakerProfile> {
    const normalizedId = this.speakerProfileId(speakerId);
    const payload: Record<string, unknown> = {};
    if (command?.displayName != null) payload.display_name = stringValue(command.displayName).trim();
    if (command?.aliases != null) payload.aliases = stringArray(command.aliases);
    if (Object.keys(payload).length === 0) throw new SpeechControlError("No speaker profile changes were provided.", 400);
    const raw = assertSuccess(await this.localSpeech.requestJson(
      this.dependencies.serviceUrl(),
      `/v1/speaker-profiles/${encodeURIComponent(normalizedId)}`,
      {
        method: "PATCH",
        headers: { "content-type": "application/json; charset=utf-8" },
        body: JSON.stringify(payload)
      },
      10_000
    ));
    return normalizeSpeakerProfile(raw);
  }

  async deleteSpeakerProfile(speakerId: string): Promise<SpeechSpeakerProfileDeleteResult> {
    const normalizedId = this.speakerProfileId(speakerId);
    const raw = assertSuccess(await this.localSpeech.requestJson(
      this.dependencies.serviceUrl(),
      `/v1/speaker-profiles/${encodeURIComponent(normalizedId)}`,
      { method: "DELETE" },
      10_000
    ));
    return {
      deleted: normalizeSpeakerProfile(asRecord(raw.deleted)),
      removedBindings: numberValue(raw.removed_bindings ?? raw.removedBindings)
    };
  }

  async bindSpeaker(command: SpeechSpeakerBindingCommand): Promise<SpeechSpeakerBinding> {
    const sessionId = stringValue(command?.sessionId).trim();
    const recordId = stringValue(command?.recordId).trim();
    const speakerLabel = stringValue(command?.speakerLabel).trim();
    const speakerId = this.speakerProfileId(command?.speakerId);
    if (!sessionId) throw new SpeechControlError("Missing speaker session id.", 400);
    if (!recordId) throw new SpeechControlError("Missing speech record id.", 400);
    if (!speakerLabel) throw new SpeechControlError("Missing diarization speaker label.", 400);
    const raw = assertSuccess(await this.localSpeech.requestJson(
      this.dependencies.serviceUrl(),
      "/v1/speaker-bindings",
      {
        method: "PUT",
        headers: { "content-type": "application/json; charset=utf-8" },
        body: JSON.stringify({
          session_id: sessionId,
          record_id: recordId,
          speaker_label: speakerLabel,
          speaker_id: speakerId
        })
      },
      10_000
    ));
    return normalizeSpeakerBinding(raw);
  }

  async identifySpeaker(command: SpeechSpeakerIdentityCommand): Promise<SpeechSpeakerIdentityResult> {
    const sessionId = stringValue(command?.sessionId).trim();
    const recordId = stringValue(command?.recordId).trim();
    const speakerLabel = stringValue(command?.speakerLabel).trim();
    const displayName = optionalString(command?.displayName)?.trim() || null;
    const speakerId = command?.speakerId == null ? null : this.speakerProfileId(command.speakerId);
    if (!sessionId) throw new SpeechControlError("Missing speaker session id.", 400);
    if (!recordId) throw new SpeechControlError("Missing speech record id.", 400);
    if (!speakerLabel) throw new SpeechControlError("Missing diarization speaker label.", 400);
    if (!speakerId && !displayName) {
      throw new SpeechControlError("A display name is required when no speaker profile id is provided.", 400);
    }
    const raw = assertSuccess(await this.localSpeech.requestJson(
      this.dependencies.serviceUrl(),
      "/v1/speaker-identities",
      {
        method: "PUT",
        headers: { "content-type": "application/json; charset=utf-8" },
        body: JSON.stringify({
          session_id: sessionId,
          record_id: recordId,
          speaker_label: speakerLabel,
          speaker_id: speakerId,
          display_name: displayName,
          aliases: stringArray(command?.aliases)
        })
      },
      10_000
    ));
    return normalizeSpeakerIdentityResult(raw);
  }

  async unbindSpeaker(sessionId: string, recordId: string, speakerLabel: string): Promise<SpeechSpeakerBinding> {
    const normalizedSessionId = stringValue(sessionId).trim();
    const normalizedRecordId = stringValue(recordId).trim();
    const normalizedLabel = stringValue(speakerLabel).trim();
    if (!normalizedSessionId || !normalizedRecordId || !normalizedLabel) {
      throw new SpeechControlError("Speaker session id, speech record id, and diarization label are required.", 400);
    }
    const search = new URLSearchParams({
      session_id: normalizedSessionId,
      record_id: normalizedRecordId,
      speaker_label: normalizedLabel
    });
    const raw = assertSuccess(await this.localSpeech.requestJson(
      this.dependencies.serviceUrl(),
      `/v1/speaker-bindings?${search.toString()}`,
      { method: "DELETE" },
      10_000
    ));
    return normalizeSpeakerBinding(raw);
  }

  async stopPlayback(): Promise<SpeechPlaybackStatus> {
    const raw = assertSuccess(await this.localSpeech.requestJson(
      this.dependencies.serviceUrl(),
      "/v1/playback/stop",
      { method: "POST" },
      10_000
    ));
    return normalizePlaybackStatus(raw);
  }

  async microphoneStatus(): Promise<SpeechMicrophoneStatus> {
    const raw = assertSuccess(await this.localSpeech.requestJson(this.dependencies.serviceUrl(), "/v1/microphone/status", {}, 10_000));
    return normalizeMicrophoneStatus(raw);
  }

  async microphoneDevices(): Promise<SpeechAudioInput[]> {
    const raw = assertSuccess(await this.localSpeech.requestJson(this.dependencies.serviceUrl(), "/v1/microphone/devices", {}, 15_000));
    return rows(raw.data).map(normalizeAudioInput);
  }

  async startMicrophone(command: SpeechMicrophoneStartCommand): Promise<SpeechMicrophoneStatus> {
    const raw = assertSuccess(await this.localSpeech.requestJson(
      this.dependencies.serviceUrl(),
      "/v1/microphone/start",
      {
        method: "POST",
        headers: { "content-type": "application/json; charset=utf-8" },
        body: JSON.stringify(microphoneStartPayload(command))
      },
      30_000
    ));
    return normalizeMicrophoneStatus(raw);
  }

  async updateMicrophoneSettings(command: SpeechMicrophoneSettingsCommand): Promise<SpeechMicrophoneStatus> {
    const raw = assertSuccess(await this.localSpeech.requestJson(
      this.dependencies.serviceUrl(),
      "/v1/microphone/settings",
      {
        method: "PUT",
        headers: { "content-type": "application/json; charset=utf-8" },
        body: JSON.stringify(microphoneStartPayload(command))
      },
      30_000
    ));
    return normalizeMicrophoneStatus(raw);
  }

  async reconcileMicrophone(): Promise<SpeechMicrophoneStatus> {
    const current = await this.microphoneStatus();
    const enabledRoutes = this.enabledSpeechRoutes();
    if (enabledRoutes.length === 0) {
      return current.running ? this.stopMicrophone() : current;
    }
    const settings = microphoneSettingsFromConfig(current.config);
    if (!current.running) return this.startMicrophone(settings);
    if (current.config.autoSubmit !== true || current.config.routeId) {
      return this.updateMicrophoneSettings(settings);
    }
    return current;
  }

  async stopMicrophone(): Promise<SpeechMicrophoneStatus> {
    const raw = assertSuccess(await this.localSpeech.requestJson(
      this.dependencies.serviceUrl(),
      "/v1/microphone/stop",
      { method: "POST" },
      15_000
    ));
    return normalizeMicrophoneStatus(raw);
  }

  synthesize(command: SpeechSynthesisCommand): Promise<LocalSpeechResponse> {
    const input = stringValue(command?.input).trim();
    if (!input) throw new SpeechControlError("Missing TTS input.", 400);
    if (input.length > 10_000) throw new SpeechControlError("TTS input exceeds 10000 characters.", 400);
    return this.localSpeech.requestBinary(
      this.dependencies.serviceUrl(),
      "/v1/audio/speech",
      {
        method: "POST",
        headers: { "content-type": "application/json; charset=utf-8" },
        body: JSON.stringify(synthesisPayload({
          ...command,
          input,
          instructions: command.instructions?.slice(0, 2_000) ?? null,
          sessionId: command.sessionId?.slice(0, 200) ?? null,
          routeId: command.routeId?.slice(0, 200) ?? null
        }))
      }
    );
  }

  transcribe(contentType: string, body: Buffer): Promise<LocalSpeechResponse> {
    if (!contentType.toLowerCase().startsWith("multipart/form-data;")) {
      throw new SpeechControlError("ASR requires multipart/form-data.", 415);
    }
    return this.localSpeech.requestBinary(this.dependencies.serviceUrl(), "/v1/audio/transcriptions", {
      method: "POST",
      headers: { "content-type": contentType },
      body: new Uint8Array(body)
    });
  }

  async acceptMessage(command: SpeechMessageCommand): Promise<SpeechMessageResult> {
    const text = stringValue(command?.text).trim();
    if (!text) throw new SpeechControlError("Missing speech transcript text.", 400);
    const sessionId = (stringValue(command?.sessionId) || `speech-${Date.now()}`).trim().slice(0, 200);
    const fallbackId = this.createMessageId();
    const ingress = this.dependencies.speechIngressStore
      ? this.dependencies.speechIngressStore.append({ ...command, text, sessionId }, fallbackId)
      : {
          record: normalizeSpeechIngressRecord({ ...command, text, sessionId }, fallbackId),
          appended: true
        };
    const record = ingress.record;
    const requestedRouteId = command?.routeId == null ? "" : sanitizeRoleId(command.routeId);
    if (command?.routeId != null && !requestedRouteId) {
      throw new SpeechControlError("Invalid speech Route id.", 400);
    }
    if (requestedRouteId) {
      const route = this.dependencies.route(requestedRouteId);
      if (!route) throw new SpeechControlError("The selected speech Route does not exist.", 400);
      if (!this.routeAcceptsRecord(route, record)) {
        throw new SpeechControlError(`The selected Route has no enabled ${record.messageAdapterType} message endpoint.`, 400);
      }
      const delivery = await this.deliverToRoute(route.id, record);
      return { ...delivery, sessionId: record.sessionId, deliveries: [delivery] };
    }

    const routes = this.enabledRoutesForRecord(record);
    if (routes.length === 0) {
      return {
        routeId: null,
        messageId: record.id,
        sessionId: record.sessionId,
        status: "recorded",
        reason: record.messageAdapterType === "rabilink" ? "no_enabled_rabilink_routes" : "no_enabled_speech_routes",
        detail: `The host speech ingress record was stored; no ${record.messageAdapterType} message endpoint is currently subscribed.`,
        deliveries: []
      };
    }

    const deliveries = await Promise.all(routes.map(async route => {
      try {
        return await this.deliverToRoute(route.id, record);
      } catch (error) {
        return {
          routeId: route.id,
          messageId: "",
          status: "failed" as const,
          detail: error instanceof Error ? error.message : String(error)
        };
      }
    }));
    const delivered = deliveries.filter(item => item.status === "delivered").length;
    const recorded = deliveries.filter(item => item.status === "recorded").length;
    const failed = deliveries.length - delivered - recorded;
    if (delivered === 0 && recorded === 0) {
      throw new SpeechControlError(`Speech broadcast failed for all ${failed} subscribed Routes.`, 502);
    }
    return {
      routeId: null,
      messageId: record.id,
      sessionId: record.sessionId,
      status: delivered > 0 ? "delivered" : "recorded",
      reason: failed > 0 ? "broadcast_partial_failure" : "broadcast_complete",
      detail: `Broadcast result: ${delivered} delivered, ${recorded} recorded, ${failed} failed.`,
      deliveries
    };
  }

  private enabledSpeechRoutes(): ManagerSpeechRoute[] {
    const unique = new Map<string, ManagerSpeechRoute>();
    for (const route of this.dependencies.routes()) {
      if (route.speechEnabled && route.id) unique.set(route.id, route);
    }
    return [...unique.values()];
  }

  private routeAcceptsRecord(route: ManagerSpeechRoute, record: SpeechIngressRecord): boolean {
    const endpointEnabled = record.messageAdapterType === "rabilink" ? route.rabiLinkEnabled === true : route.speechEnabled;
    if (!endpointEnabled) return false;
    return !record.routeProfileId || route.routeProfileIds?.includes(record.routeProfileId) === true;
  }

  private enabledRoutesForRecord(record: SpeechIngressRecord): ManagerSpeechRoute[] {
    const unique = new Map<string, ManagerSpeechRoute>();
    for (const route of this.dependencies.routes()) {
      if (route.id && this.routeAcceptsRecord(route, record)) unique.set(route.id, route);
    }
    return [...unique.values()];
  }

  private async deliverToRoute(routeId: string, record: SpeechIngressRecord): Promise<SpeechRouteDeliveryResult> {
    const receipt = this.dependencies.speechIngressStore?.readDeliveryReceipt?.(record.id, routeId);
    if (receipt) return {
      routeId,
      messageId: record.id,
      status: receipt.status,
      reason: receipt.reason,
      detail: receipt.detail
    };
    const flightKey = `${record.messageAdapterType}:${record.id}:${routeId}`;
    const existingFlight = this.deliveryFlights.get(flightKey);
    if (existingFlight) return existingFlight;
    const flight = this.deliverToRouteOnce(routeId, record).finally(() => {
      if (this.deliveryFlights.get(flightKey) === flight) this.deliveryFlights.delete(flightKey);
    });
    this.deliveryFlights.set(flightKey, flight);
    return flight;
  }

  private async deliverToRouteOnce(routeId: string, record: SpeechIngressRecord): Promise<SpeechRouteDeliveryResult> {
    const messageId = record.id;
    try {
      const outcome = await this.dependencies.deliverTranscript({ routeId, record });
      if (outcome.status === "failed") {
        throw new SpeechControlError(outcome.detail || outcome.reason || "Speech delivery failed.", 502);
      }
      const endpointLabel = record.messageAdapterType === "rabilink" ? "rabilink ASR message" : "speech message";
      this.dependencies.appendRouteLog(routeId, `${endpointLabel} ${outcome.status}: ${messageId}${outcome.reason ? `; ${outcome.reason}` : ""}`);
      const result = { routeId, messageId, ...outcome };
      if (outcome.status === "delivered" || outcome.status === "recorded") {
        this.dependencies.speechIngressStore?.appendDeliveryReceipt?.({
          schemaVersion: 1,
          recordId: record.id,
          routeId,
          messageAdapterType: record.messageAdapterType,
          status: outcome.status,
          reason: outcome.reason,
          detail: outcome.detail,
          completedAt: new Date().toISOString()
        });
      }
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.dependencies.appendRouteLog(routeId, `speech message failed: ${messageId}; ${message}`);
      throw error;
    }
  }

  private speakerProfileId(value: unknown): string {
    const normalized = stringValue(value).trim();
    if (!/^speaker-[a-f0-9]{32}$/i.test(normalized)) {
      throw new SpeechControlError("Invalid speaker profile id.", 400);
    }
    return normalized;
  }
}

export function speechControlErrorStatus(error: unknown, fallback = 502): number {
  return error instanceof SpeechControlError ? error.status : fallback;
}

export function speechControlErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
