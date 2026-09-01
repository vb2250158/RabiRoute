import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type {
  XiaomiHomeRuntimeSettings,
  XiaomiHomeSettingsSnapshot
} from "../../shared/xiaomiHomeSettingsContract.js";
import { atomicWriteFileSync, withFileLockSync } from "../../shared/filePersistence.js";
import { XiaomiHomeArtifactAccess } from "./artifactAccess.js";
import { XiaomiHomeArtifactStore } from "./artifactStore.js";
import { XiaomiHomeClipCaptureWorker } from "./clipCapture.js";
import { XiaomiHomeEventMonitor } from "./eventMonitor.js";
import {
  XiaomiHomeManagerApiClient,
  XiaomiHomeManagerApiError,
  resolveXiaomiHomeManagerConfig,
  type XiaomiHomeManagerConfigInput
} from "./managerApi.js";
import type { XiaomiHomeEvent, XiaomiHomeEventDeliveryContext } from "../../xiaomiHomeEventDelivery.js";

export type XiaomiHomeRuntimeConfigInput = XiaomiHomeManagerConfigInput & Partial<XiaomiHomeRuntimeSettings>;

type RuntimeFile = Readonly<{
  schemaVersion: 1;
  settings: XiaomiHomeRuntimeSettings;
}>;

type RuntimeDependencies = Readonly<{
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
  deliverEvent: (event: XiaomiHomeEvent, context: XiaomiHomeEventDeliveryContext) => Promise<unknown>;
}>;

const settingKeys = new Set<keyof XiaomiHomeRuntimeSettings>([
  "baseUrl", "tokenEnv", "requestTimeoutMs", "writeEnabled", "allowPublicBaseUrl",
  "agentRoleId", "eventMonitorEnabled", "eventDeliveryMode", "cameraMotionEntityIds",
  "cameraClipCaptureEnabled", "cameraClipAllowedHosts", "ffmpegPath", "ffprobePath",
  "artifactReadTokenEnv", "cameraClipRequestTimeoutMs", "cameraClipMaxSegments",
  "cameraClipMaxSegmentBytes"
]);

function boundedInteger(value: unknown, fallback: number, minimum: number, maximum: number, field: string): number {
  const number = Number(value ?? fallback);
  if (!Number.isInteger(number) || number < minimum || number > maximum) {
    throw new XiaomiHomeManagerApiError(400, "xiaomi_home_settings_invalid", `${field} must be between ${minimum} and ${maximum}.`);
  }
  return number;
}

function controlledText(value: unknown, fallback: string, field: string, maximum = 1024): string {
  const text = String(value ?? fallback).trim();
  if (!text || text.length > maximum || /[\u0000-\u001f\u007f]/.test(text)) {
    throw new XiaomiHomeManagerApiError(400, "xiaomi_home_settings_invalid", `${field} is invalid.`);
  }
  return text;
}

function uniqueStrings(value: unknown, field: string, pattern?: RegExp): readonly string[] {
  if (value === undefined) return Object.freeze([]);
  if (!Array.isArray(value)) throw new XiaomiHomeManagerApiError(400, "xiaomi_home_settings_invalid", `${field} must be an array.`);
  const entries = value.map((item, index) => controlledText(item, "", `${field}[${index}]`, 512));
  if (entries.length > 512 || new Set(entries).size !== entries.length || (pattern && entries.some(item => !pattern.test(item)))) {
    throw new XiaomiHomeManagerApiError(400, "xiaomi_home_settings_invalid", `${field} is invalid.`);
  }
  return Object.freeze(entries);
}

function assertKnownKeys(value: unknown): asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new XiaomiHomeManagerApiError(400, "xiaomi_home_settings_invalid", "settings must be an object.");
  }
  const unknown = Object.keys(value).filter(key => !settingKeys.has(key as keyof XiaomiHomeRuntimeSettings));
  if (unknown.length) throw new XiaomiHomeManagerApiError(400, "xiaomi_home_settings_invalid", `Unknown Xiaomi Home setting: ${unknown[0]}.`);
}

export function normalizeXiaomiHomeRuntimeSettings(input: unknown): XiaomiHomeRuntimeSettings {
  assertKnownKeys(input);
  const manager = resolveXiaomiHomeManagerConfig(input);
  const eventDeliveryMode = input.eventDeliveryMode ?? "significant";
  if (eventDeliveryMode !== "significant" && eventDeliveryMode !== "all") {
    throw new XiaomiHomeManagerApiError(400, "xiaomi_home_settings_invalid", "eventDeliveryMode is invalid.");
  }
  const artifactReadTokenEnv = controlledText(input.artifactReadTokenEnv, "RABIROUTE_XIAOMI_HOME_ARTIFACT_TOKEN", "artifactReadTokenEnv", 128);
  if (!/^[A-Z][A-Z0-9_]{2,127}$/.test(artifactReadTokenEnv)) {
    throw new XiaomiHomeManagerApiError(400, "xiaomi_home_settings_invalid", "artifactReadTokenEnv must be an uppercase environment variable name.");
  }
  return Object.freeze({
    ...manager,
    allowPublicBaseUrl: input.allowPublicBaseUrl === true,
    agentRoleId: controlledText(input.agentRoleId, "YeYu", "agentRoleId", 80),
    eventMonitorEnabled: input.eventMonitorEnabled !== false,
    eventDeliveryMode,
    cameraMotionEntityIds: uniqueStrings(input.cameraMotionEntityIds, "cameraMotionEntityIds", /^[a-z0-9_]+\.[a-z0-9_]+$/i),
    cameraClipCaptureEnabled: input.cameraClipCaptureEnabled === true,
    cameraClipAllowedHosts: uniqueStrings(input.cameraClipAllowedHosts, "cameraClipAllowedHosts", /^(\*\.)?[A-Za-z0-9.-]+$/),
    ffmpegPath: controlledText(input.ffmpegPath, "ffmpeg", "ffmpegPath"),
    ffprobePath: controlledText(input.ffprobePath, "ffprobe", "ffprobePath"),
    artifactReadTokenEnv,
    cameraClipRequestTimeoutMs: boundedInteger(input.cameraClipRequestTimeoutMs, 10000, 1000, 30000, "cameraClipRequestTimeoutMs"),
    cameraClipMaxSegments: boundedInteger(input.cameraClipMaxSegments, 120, 1, 500, "cameraClipMaxSegments"),
    cameraClipMaxSegmentBytes: boundedInteger(input.cameraClipMaxSegmentBytes, 33554432, 1024, 134217728, "cameraClipMaxSegmentBytes")
  });
}

function settingsRevision(source: XiaomiHomeSettingsSnapshot["source"], settings: XiaomiHomeRuntimeSettings): string {
  return `xiaomi-settings:${createHash("sha256").update(`${source}\n${JSON.stringify(settings)}`).digest("hex").slice(0, 32)}`;
}

export class XiaomiHomeSettingsStore {
  readonly settingsPath: string;
  private readonly lockPath: string;
  private readonly profileSettings: XiaomiHomeRuntimeSettings;

  constructor(runtimeDir: string, profileConfig: XiaomiHomeRuntimeConfigInput) {
    this.settingsPath = path.join(runtimeDir, "settings.json");
    this.lockPath = `${this.settingsPath}.lock`;
    const { runtimeDir: _bootstrapRuntimeDir, ...runtimeSettings } = profileConfig;
    this.profileSettings = normalizeXiaomiHomeRuntimeSettings(runtimeSettings);
  }

  read(): XiaomiHomeSettingsSnapshot {
    if (!fs.existsSync(this.settingsPath)) return this.snapshot("profile", this.profileSettings);
    let file: RuntimeFile;
    try {
      file = JSON.parse(fs.readFileSync(this.settingsPath, "utf8")) as RuntimeFile;
    } catch {
      throw new XiaomiHomeManagerApiError(500, "xiaomi_home_settings_corrupt", "The local Xiaomi Home settings file is invalid JSON.");
    }
    if (file?.schemaVersion !== 1) {
      throw new XiaomiHomeManagerApiError(500, "xiaomi_home_settings_corrupt", "The local Xiaomi Home settings schema is unsupported.");
    }
    return this.snapshot("runtime", normalizeXiaomiHomeRuntimeSettings(file.settings));
  }

  write(input: unknown, expectedRevision: string): XiaomiHomeSettingsSnapshot {
    const settings = normalizeXiaomiHomeRuntimeSettings(input);
    return withFileLockSync(this.lockPath, () => {
      const current = this.read();
      if (!expectedRevision || expectedRevision !== current.revision) {
        throw new XiaomiHomeManagerApiError(409, "xiaomi_home_settings_revision_changed", "Xiaomi Home settings changed; reload before saving.");
      }
      const file: RuntimeFile = { schemaVersion: 1, settings };
      atomicWriteFileSync(this.settingsPath, `${JSON.stringify(file, null, 2)}\n`);
      return this.snapshot("runtime", settings);
    });
  }

  private snapshot(source: XiaomiHomeSettingsSnapshot["source"], settings: XiaomiHomeRuntimeSettings): XiaomiHomeSettingsSnapshot {
    return Object.freeze({ schemaVersion: 1, source, revision: settingsRevision(source, settings), settings });
  }
}

export class XiaomiHomeRuntimeController {
  readonly artifacts: XiaomiHomeArtifactStore;
  private snapshotValue: XiaomiHomeSettingsSnapshot;
  private clientValue: XiaomiHomeManagerApiClient;
  private accessValue: XiaomiHomeArtifactAccess;
  private captureValue: XiaomiHomeClipCaptureWorker;
  private monitorValue: XiaomiHomeEventMonitor;
  private started = false;

  constructor(
    private readonly store: XiaomiHomeSettingsStore,
    artifacts: XiaomiHomeArtifactStore,
    private readonly dependencies: RuntimeDependencies
  ) {
    this.artifacts = artifacts;
    this.snapshotValue = store.read();
    const runtime = this.createRuntime(this.snapshotValue.settings);
    this.clientValue = runtime.client;
    this.accessValue = runtime.access;
    this.captureValue = runtime.capture;
    this.monitorValue = runtime.monitor;
  }

  get client(): XiaomiHomeManagerApiClient { return this.clientValue; }
  get artifactAccess(): XiaomiHomeArtifactAccess { return this.accessValue; }

  start(): void {
    this.started = true;
    this.monitorValue.start();
  }

  stop(): void {
    this.started = false;
    this.monitorValue.stop();
  }

  settings(): XiaomiHomeSettingsSnapshot {
    return this.snapshotValue;
  }

  update(settings: unknown, expectedRevision: string): XiaomiHomeSettingsSnapshot {
    const inFlight = Number(this.captureValue.status().inFlight || 0);
    if (inFlight > 0) {
      throw new XiaomiHomeManagerApiError(409, "xiaomi_home_capture_in_progress", "Wait for active camera capture to finish before changing settings.");
    }
    const normalized = normalizeXiaomiHomeRuntimeSettings(settings);
    const replacement = this.createRuntime(normalized);
    const saved = this.store.write(normalized, expectedRevision);
    this.monitorValue.stop();
    this.snapshotValue = saved;
    this.clientValue = replacement.client;
    this.accessValue = replacement.access;
    this.captureValue = replacement.capture;
    this.monitorValue = replacement.monitor;
    if (this.started) this.monitorValue.start();
    return saved;
  }

  async health(): Promise<Record<string, unknown>> {
    return {
      ...(await this.clientValue.getHealth()),
      settings: {
        schemaVersion: this.snapshotValue.schemaVersion,
        source: this.snapshotValue.source,
        revision: this.snapshotValue.revision
      },
      eventMonitor: this.monitorValue.status(),
      cameraCapture: this.captureValue.status()
    };
  }

  private createRuntime(settings: XiaomiHomeRuntimeSettings) {
    const env = this.dependencies.env ?? process.env;
    const fetchImpl = this.dependencies.fetchImpl ?? fetch;
    const client = new XiaomiHomeManagerApiClient({
      ...settings,
      runtimeDir: this.artifacts.runtimeDir
    }, fetchImpl, env);
    const access = new XiaomiHomeArtifactAccess(settings, this.artifacts, env);
    const capture = new XiaomiHomeClipCaptureWorker(settings, this.artifacts);
    const monitor = new XiaomiHomeEventMonitor(settings, {
      env,
      deliverEvent: this.dependencies.deliverEvent,
      captureMotionClip: capture.isEnabled() ? candidate => capture.capture(candidate) : undefined
    });
    return { client, access, capture, monitor };
  }
}
