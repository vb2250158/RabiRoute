import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import {
  DEFAULT_SPEECH_ROUTE_PROFILE,
  type SpeechAudioInput,
  type SpeechHistoryItem,
  type SpeechMessageAccepted,
  type SpeechMessageCommand,
  type SpeechMicrophoneConfig,
  type SpeechMicrophoneStartCommand,
  type SpeechMicrophoneStats,
  type SpeechMicrophoneStatus,
  type SpeechModel,
  type SpeechPersona,
  type SpeechPlaybackJob,
  type SpeechPlaybackStatus,
  type SpeechRuntimeStatus,
  type SpeechSynthesisCommand
} from "../shared/speechControlContract.js";
import { roleFolderPath } from "../shared/routePaths.js";
import { sanitizeRoleId } from "../shared/routeIdentity.js";
import {
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
};

export type ManagerSpeechControlDependencies = {
  serviceUrl(): string;
  rolesRoot(): string;
  route(routeId: string): ManagerSpeechRoute | undefined;
  deliverTranscript(command: SpeechMessageCommand & { messageId: string }): Promise<void>;
  appendRouteLog(routeId: string, message: string): void;
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
  return {
    captured: numberValue(stats.captured),
    recognized: numberValue(stats.recognized),
    empty: numberValue(stats.empty),
    submitted: numberValue(stats.submitted),
    submitFailed: numberValue(stats.submit_failed ?? stats.submitFailed),
    dropped: numberValue(stats.dropped)
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
    submitError: optionalString(value.submit_error ?? value.submitError)
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
    auto_submit: command.autoSubmit,
    route_id: command.routeId,
    session_id: command.sessionId,
    suppress_during_playback: command.suppressDuringPlayback
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

  constructor(private readonly dependencies: ManagerSpeechControlDependencies) {
    this.localSpeech = dependencies.localSpeech ?? defaultLocalSpeechAdapter;
    this.createMessageId = dependencies.createMessageId ?? (() => `speech-user-${randomUUID()}`);
  }

  status(): Promise<SpeechRuntimeStatus> {
    return this.localSpeech.inspect(this.dependencies.serviceUrl());
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
      .map(entry => ({
        id: entry.name,
        voiceReady: fs.existsSync(path.join(roleFolderPath(rolesRoot, entry.name), "voice", "voice-profile.json"))
          || fs.existsSync(path.join(roleFolderPath(rolesRoot, entry.name), "voice", "voice-index.json"))
      }))
      .sort((left, right) => left.id.localeCompare(right.id));
  }

  async playbackStatus(): Promise<SpeechPlaybackStatus> {
    const raw = assertSuccess(await this.localSpeech.requestJson(this.dependencies.serviceUrl(), "/v1/playback/status", {}, 10_000));
    return normalizePlaybackStatus(raw);
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
    const routeId = sanitizeRoleId(command?.routeId);
    const route = routeId ? this.dependencies.route(routeId) : undefined;
    if (command.autoSubmit) {
      if (!route) throw new SpeechControlError("Select a configured speech Route before enabling automatic submission.", 400);
      if (!route.speechEnabled) throw new SpeechControlError("The selected Route has no speech message endpoint.", 400);
    } else if (routeId && !route) {
      throw new SpeechControlError("The selected speech Route does not exist.", 400);
    }
    const raw = assertSuccess(await this.localSpeech.requestJson(
      this.dependencies.serviceUrl(),
      "/v1/microphone/start",
      {
        method: "POST",
        headers: { "content-type": "application/json; charset=utf-8" },
        body: JSON.stringify(microphoneStartPayload({ ...command, routeId: routeId || null }))
      },
      30_000
    ));
    return normalizeMicrophoneStatus(raw);
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

  acceptMessage(command: SpeechMessageCommand): SpeechMessageAccepted {
    const routeId = sanitizeRoleId(command?.routeId);
    const route = routeId ? this.dependencies.route(routeId) : undefined;
    if (!route) throw new SpeechControlError("Select a configured speech Route first.", 400);
    if (!route.speechEnabled) throw new SpeechControlError("The selected Route has no speech message endpoint.", 400);
    const text = stringValue(command?.text).trim();
    if (!text) throw new SpeechControlError("Missing speech transcript text.", 400);
    const sessionId = (stringValue(command?.sessionId) || `speech-${Date.now()}`).trim().slice(0, 200);
    const messageId = this.createMessageId();
    void this.dependencies.deliverTranscript({ routeId, text, sessionId, messageId }).catch(error => {
      const message = error instanceof Error ? error.message : String(error);
      this.dependencies.appendRouteLog(routeId, `speech message failed after acceptance: ${messageId}; ${message}`);
    });
    return { routeId, messageId, sessionId, status: "accepted" };
  }
}

export function speechControlErrorStatus(error: unknown, fallback = 502): number {
  return error instanceof SpeechControlError ? error.status : fallback;
}

export function speechControlErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
