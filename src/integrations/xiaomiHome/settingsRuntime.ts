import { createHash, randomUUID } from "node:crypto";
import { recordDataMutationAudit } from "../../observability/dataMutationAudit.js";
import { normalizeHomeSpeechBindings } from "../../shared/homeMediaContract.js";
import type { XiaomiHomeRequestAuthority } from "./requestAuthority.js";
import fs from "node:fs";
import path from "node:path";
import type {
  XiaomiHomeAuthorizationSnapshot,
  XiaomiHomeAuthorizationState
} from "../../shared/xiaomiHomeAuthContract.js";
import type {
  XiaomiHomeRuntimeSettings,
  XiaomiHomeSettingsSnapshot
} from "../../shared/xiaomiHomeSettingsContract.js";
import { atomicWriteFileSync, withFileLockSync } from "../../shared/filePersistence.js";
import { XiaomiHomeArtifactAccess } from "./artifactAccess.js";
import { HomeAssistantDeployment } from "./homeAssistantDeployment.js";
import { XiaomiHomeArtifactStore } from "./artifactStore.js";
import { XiaomiHomeClipCaptureWorker } from "./clipCapture.js";
import { HomeAssistantActivityMonitor } from "./activityMonitor.js";
import type { HomeAssistantActivityPort } from "../../shared/homeAssistantActivity.js";
import { XiaomiHomeEventMonitor } from "./eventMonitor.js";
import { XiaomiVacuumCloud } from "./vacuumCloud.js";
import { VacuumRemoteController } from "./vacuumRemote.js";
import { XiaomiHomeCredentialStore, type XiaomiHomeCredentialResolution } from "./credentials.js";
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
  /** Explicit Manager acceptance mode: suppress persistence and autonomous background work. */
  readOnly?: boolean;
  roleDirectory?: (roleId: string) => string;
  activity?: HomeAssistantActivityPort;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
  deliverEvent: (event: XiaomiHomeEvent, context: XiaomiHomeEventDeliveryContext) => Promise<unknown>;
}>;

const settingKeys = new Set<keyof XiaomiHomeRuntimeSettings>([
  "baseUrl", "requestTimeoutMs", "writeEnabled", "speechBindings", "allowPublicBaseUrl", "allowInsecurePrivateHttp",
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
  let speechBindings;
  try { speechBindings = normalizeHomeSpeechBindings(input.speechBindings); }
  catch { throw new XiaomiHomeManagerApiError(400, "xiaomi_home_settings_invalid", "speechBindings requires unique media_player and notify entities and text/json-array encoding."); }
  const eventDeliveryMode = input.eventDeliveryMode ?? "significant";
  if (eventDeliveryMode !== "significant" && eventDeliveryMode !== "all") {
    throw new XiaomiHomeManagerApiError(400, "xiaomi_home_settings_invalid", "eventDeliveryMode is invalid.");
  }
  // Legacy input is accepted until 0.4.0. Media reads reuse connection authentication.
  const artifactReadTokenEnv = "RABIROUTE_XIAOMI_HOME_ARTIFACT_TOKEN";
  return Object.freeze({
    ...manager,
    speechBindings,
    allowPublicBaseUrl: input.allowPublicBaseUrl !== false,
    allowInsecurePrivateHttp: input.allowInsecurePrivateHttp !== false,
    agentRoleId: input.agentRoleId == null || input.agentRoleId === "" ? "" : controlledText(input.agentRoleId, "", "agentRoleId", 80),
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
  readonly vacuumCloud: XiaomiVacuumCloud;
  readonly vacuumRemote: VacuumRemoteController;
  readonly deployment: HomeAssistantDeployment;
  readonly artifacts: XiaomiHomeArtifactStore;
  private snapshotValue: XiaomiHomeSettingsSnapshot;
  private clientValue: XiaomiHomeManagerApiClient;
  private accessValue: XiaomiHomeArtifactAccess;
  private captureValue: XiaomiHomeClipCaptureWorker;
  private monitorValue: XiaomiHomeEventMonitor;
  private activityValue?: HomeAssistantActivityMonitor;
  private started = false;
  private activated = false;
  private stopping?: Promise<void>;
  private readonly retirements = new Set<Promise<void>>();
  private readonly retirementFailures: unknown[] = [];
  private stopHealthListener?: () => void;
  private healthDelivery: Promise<unknown> = Promise.resolve();
  private readonly credentialStore: XiaomiHomeCredentialStore;

  constructor(
    private readonly store: XiaomiHomeSettingsStore,
    artifacts: XiaomiHomeArtifactStore,
    private readonly dependencies: RuntimeDependencies,
    credentialStore = new XiaomiHomeCredentialStore(artifacts.runtimeDir)
  ) {
    this.artifacts = artifacts;
    this.vacuumCloud = new XiaomiVacuumCloud(artifacts.runtimeDir, dependencies.fetchImpl);
    this.credentialStore = credentialStore;
    this.snapshotValue = store.read();
    this.deployment = new HomeAssistantDeployment(artifacts.runtimeDir, () => this.snapshotValue.settings.baseUrl);
    const runtime = this.createRuntime(this.snapshotValue.settings);
    this.clientValue = runtime.client;
    this.accessValue = runtime.access;
    this.captureValue = runtime.capture;
    this.monitorValue = runtime.monitor;
    this.activityValue = runtime.activity;
    this.vacuumRemote = new VacuumRemoteController(artifacts.runtimeDir, () => this.clientValue);
  }

  get client(): XiaomiHomeManagerApiClient { return this.clientValue; }
  get artifactAccess(): XiaomiHomeArtifactAccess { return this.accessValue; }

  start(): void {
    if (this.started || this.dependencies.readOnly) return;
    if (this.stopping) throw new Error('Xiaomi Home runtime has retired.');
    this.started = true;
    this.stopHealthListener = this.deployment.onHealthChange(state => {
      const agentRoleId = this.snapshotValue.settings.agentRoleId;
      if (!agentRoleId) return;
      const event: XiaomiHomeEvent = {
        id: `home-assistant-health-${randomUUID()}`,
        kind: state === "ready" ? "device_state_changed" : state === "exhausted" ? "action_failed" : "device_offline",
        resourceId: "home:ha:connection", resourceName: "Home Assistant",
        occurredAt: new Date().toISOString(),
        summary: state === "ready" ? "Home Assistant 连接已恢复" : state === "exhausted"
          ? "Home Assistant 自动恢复次数已耗尽，需要人工检查虚拟机与 Core" : "Home Assistant 连接中断，正在检查恢复条件"
      };
      this.healthDelivery = this.healthDelivery.then(() => this.dependencies.deliverEvent(event, { agentRoleId })).catch(error => {
        recordDataMutationAudit({ group: "xiaomi-home", event: "home_assistant_health_delivery_failed",
          owner: "xiaomi-home-runtime", action: "deliver", target: { type: "event", id: event.id },
          dataSource: { kind: "runtime", id: "home-assistant-deployment" }, outcome: "failed", error });
      });
    });
    this.deployment.start();
    this.monitorValue.start();
    this.activityValue?.start();
  }

  /** Refresh the original files only after the published predecessor has actually retired. */
  async activate(signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    if (this.stopping) throw new Error('Xiaomi Home runtime has retired.');
    if (this.dependencies.readOnly) { this.activated = true; return; }
    this.snapshotValue = this.store.read();
    await this.replaceRuntime(this.createRuntime(this.snapshotValue.settings));
    signal?.throwIfAborted();
    if (this.stopping) throw new Error('Xiaomi Home runtime has retired.');
    this.artifacts.activate();
    signal?.throwIfAborted();
    this.start();
    this.activated = true;
  }

  assertAvailable(published = true): void {
    if (!published || !this.activated || this.stopping) throw new XiaomiHomeManagerApiError(503,
      'xiaomi_home_runtime_starting', 'Xiaomi Home is awaiting its published native owner.');
  }

  stop(): Promise<void> {
    this.started = false;
    this.stopHealthListener?.();
    this.stopHealthListener = undefined;
    this.activated = false;
    return this.stopping ??= (async () => {
      const results = await Promise.allSettled([
        this.monitorValue.stop(), this.activityValue?.stop(), this.captureValue.close(),
        this.vacuumRemote.shutdown(), this.vacuumCloud.video.shutdown(), this.deployment.stop(), this.healthDelivery, ...this.retirements
      ]);
      const failures = [...this.retirementFailures, ...results.flatMap(result => result.status === 'rejected' ? [result.reason] : [])];
      if (failures.length) throw new AggregateError(failures, 'Xiaomi Home runtime retirement was not confirmed.');
    })();
  }

  settings(): XiaomiHomeSettingsSnapshot {
    return this.snapshotValue;
  }

  update(settings: unknown, expectedRevision: string, authority?: XiaomiHomeRequestAuthority): XiaomiHomeSettingsSnapshot {
    authority?.assert();
    this.vacuumRemote.assertInactive();
    const inFlight = Number(this.captureValue.status().inFlight || 0);
    if (inFlight > 0) {
      throw new XiaomiHomeManagerApiError(409, "xiaomi_home_capture_in_progress", "Wait for active camera capture to finish before changing settings.");
    }
    const normalized = normalizeXiaomiHomeRuntimeSettings(settings);
    const replacement = this.createRuntime(normalized);
    authority?.dispatch();
    const saved = this.store.write(normalized, expectedRevision);
    this.snapshotValue = saved;
    this.replaceRuntime(replacement);
    return saved;
  }

  async authorization(authority?: XiaomiHomeRequestAuthority): Promise<XiaomiHomeAuthorizationSnapshot> {
    authority?.assert();
    const stored = this.resolveCredential();
    const resolution = stored.metadata?.boundBaseUrl === this.snapshotValue.settings.baseUrl
      ? stored
      : Object.freeze({ source: "none" as const, removable: stored.removable });
    const health = await this.clientValue.getHealth(authority);
    authority?.assert();
    const status = String(health.status || "unreachable") as XiaomiHomeAuthorizationState;
    return this.authorizationSnapshot(resolution, status, String(health.errorCode || "") || undefined);
  }

  async authorize(
    accessToken: unknown,
    baseUrl: unknown,
    expectedRevision: string,
    expectedAuthorizationRevision?: string,
    authority?: XiaomiHomeRequestAuthority
  ): Promise<XiaomiHomeAuthorizationSnapshot> {
    authority?.assert();
    const token = String(accessToken ?? "").trim();
    if (!token || token.length > 16384 || /[\u0000-\u001f\u007f]/.test(token)) {
      throw new XiaomiHomeManagerApiError(400, "xiaomi_home_credential_invalid", "Home Assistant access token is invalid.");
    }
    if (!expectedRevision || expectedRevision !== this.snapshotValue.revision) {
      throw new XiaomiHomeManagerApiError(409, "xiaomi_home_settings_revision_changed", "Xiaomi Home settings changed; reload before connecting.");
    }
    authority?.assert();
    this.requireAuthorizationRevision(expectedAuthorizationRevision);
    const candidateSettings = normalizeXiaomiHomeRuntimeSettings({
      ...this.snapshotValue.settings,
      baseUrl: String(baseUrl ?? "").trim()
    });
    const fetchImpl = this.dependencies.fetchImpl ?? fetch;
    const candidate = new XiaomiHomeManagerApiClient({
      ...candidateSettings,
      runtimeDir: this.artifacts.runtimeDir
    }, fetchImpl, token);
    const verification = await candidate.verifyAuthorization(authority);
    authority?.assert();
    this.requireAuthorizationRevision(expectedAuthorizationRevision);
    const preparedCredential = this.credentialStore.prepare(token, candidateSettings.baseUrl, verification);
    authority?.dispatch();
    this.vacuumRemote.assertInactive();
    const saved = this.commitAuthorizationLocally(candidateSettings, expectedRevision, preparedCredential);
    this.snapshotValue = saved;
    this.replaceRuntime(this.createRuntime(candidateSettings));
    return this.authorizationSnapshot(this.resolveCredential(), "ready");
  }

  async refreshAuthorization(expectedAuthorizationRevision?: string, authority?: XiaomiHomeRequestAuthority): Promise<XiaomiHomeAuthorizationSnapshot> {
    authority?.assert();
    this.requireAuthorizationRevision(expectedAuthorizationRevision);
    return this.authorization(authority);
  }

  async disconnect(expectedAuthorizationRevision?: string, authority?: XiaomiHomeRequestAuthority): Promise<XiaomiHomeAuthorizationSnapshot> {
    authority?.assert();
    this.vacuumRemote.assertInactive();
    this.requireAuthorizationRevision(expectedAuthorizationRevision);
    const settings = this.snapshotValue.settings;
    authority?.dispatch();
    this.credentialStore.clear();
    this.replaceRuntime(this.createRuntime(settings));
    const next = this.resolveCredential();
    return this.authorizationSnapshot(next, next.token ? "ready" : "authorization_required");
  }

  async health(authority?: XiaomiHomeRequestAuthority): Promise<Record<string, unknown>> {
    return {
      ...(await this.clientValue.getHealth(authority)),
      settings: {
        schemaVersion: this.snapshotValue.schemaVersion,
        source: this.snapshotValue.source,
        revision: this.snapshotValue.revision
      },
      eventMonitor: this.monitorValue.status(),
      activityMonitor: this.activityValue?.status() ?? { state: "unavailable", recording: false },
      cameraCapture: this.captureValue.status()
    };
  }

  private commitAuthorizationLocally(
    settings: XiaomiHomeRuntimeSettings,
    expectedSettingsRevision: string,
    preparedCredential: string
  ): XiaomiHomeSettingsSnapshot {
    const originalSettings = fs.existsSync(this.store.settingsPath) ? fs.readFileSync(this.store.settingsPath) : undefined;
    try {
      const saved = settings.baseUrl === this.snapshotValue.settings.baseUrl
        ? this.snapshotValue
        : this.store.write(settings, expectedSettingsRevision);
      this.credentialStore.writePrepared(preparedCredential);
      return saved;
    } catch (error) {
      if (settings.baseUrl !== this.snapshotValue.settings.baseUrl) {
        if (originalSettings) atomicWriteFileSync(this.store.settingsPath, originalSettings);
        else if (fs.existsSync(this.store.settingsPath)) fs.unlinkSync(this.store.settingsPath);
      }
      throw error;
    }
  }

  private createRuntime(settings: XiaomiHomeRuntimeSettings) {
    const env = this.dependencies.env ?? process.env;
    const fetchImpl = this.dependencies.fetchImpl ?? fetch;
    const credential = this.credentialStore.resolve();
    const credentialToken = credential.metadata?.boundBaseUrl === settings.baseUrl ? credential.token : undefined;
    const client = new XiaomiHomeManagerApiClient({
      ...settings,
      runtimeDir: this.artifacts.runtimeDir
    }, fetchImpl, credentialToken);
    const access = new XiaomiHomeArtifactAccess(this.artifacts);
    const roleDirectory = this.dependencies.roleDirectory;
    const capture = new XiaomiHomeClipCaptureWorker({ ...settings,
      cameraClipCaptureEnabled: settings.cameraClipCaptureEnabled && Boolean(roleDirectory && settings.agentRoleId)
    }, this.artifacts, this.dependencies.fetchImpl,
    roleDirectory && settings.agentRoleId ? () => roleDirectory(settings.agentRoleId) : undefined, settings.agentRoleId || undefined);
    const monitor = new XiaomiHomeEventMonitor(settings, {
      credentialToken,
      recoverConnection: () => this.deployment.recover(),
      deliverEvent: this.dependencies.deliverEvent,
      captureMotionClip: capture.isEnabled() ? candidate => capture.capture(candidate) : undefined
    });
    const activity = this.dependencies.activity ? new HomeAssistantActivityMonitor(settings.baseUrl, { port: this.dependencies.activity, credentialToken }) : undefined;
    return { client, access, capture, monitor, activity };
  }

  private resolveCredential(): XiaomiHomeCredentialResolution {
    return this.credentialStore.resolve();
  }

  private replaceRuntime(runtime: ReturnType<XiaomiHomeRuntimeController["createRuntime"]>): Promise<void> {
    const retiring = Promise.allSettled([this.monitorValue.stop(), this.activityValue?.stop(), this.captureValue.close()]).then(results => {
      const errors = results.flatMap(result => result.status === "rejected" ? [result.reason] : []);
      if (errors.length === 1) throw errors[0];
      if (errors.length) throw new AggregateError(errors, "Previous Xiaomi Home owner cleanup failed.");
    });
    this.clientValue = runtime.client;
    this.accessValue = runtime.access;
    this.captureValue = runtime.capture;
    this.monitorValue = runtime.monitor;
    this.activityValue = runtime.activity;
    const transition = retiring.then(() => {
      if (this.started && this.monitorValue === runtime.monitor) { this.monitorValue.start(); this.activityValue?.start(); }
    });
    const observed = transition.catch(error => { this.retirementFailures.push(error); }).finally(() => this.retirements.delete(observed));
    this.retirements.add(observed);
    return transition;
  }

  private authorizationRevision(credential: XiaomiHomeCredentialResolution): string {
    return `xiaomi-auth:${createHash("sha256").update(JSON.stringify({
      settingsRevision: this.snapshotValue.revision,
      endpointAccountId: credential.metadata?.endpointAccountId ?? "",
      boundBaseUrl: credential.metadata?.boundBaseUrl ?? "",
      updatedAt: credential.metadata?.updatedAt ?? "",
      configured: Boolean(credential.token)
    })).digest("hex").slice(0, 32)}`;
  }

  private requireAuthorizationRevision(expected: string | undefined): void {
    // Direct controller callers are used by local runtime tests. HTTP mutations
    // always carry this revision and therefore retain the stale-write fence.
    if (expected === undefined) return;
    const current = this.resolveCredential();
    if (expected !== this.authorizationRevision(current)) {
      throw new XiaomiHomeManagerApiError(409, "xiaomi_home_authorization_revision_changed", "Xiaomi Home authorization changed; reload before mutating credentials.");
    }
  }

  private authorizationSnapshot(
    credential: XiaomiHomeCredentialResolution,
    state: XiaomiHomeAuthorizationState,
    errorCode?: string
  ): XiaomiHomeAuthorizationSnapshot {
    const metadata = credential.metadata;
    return Object.freeze({
      schemaVersion: 1,
      state,
      configured: Boolean(credential.token),
      credentialSource: credential.source,
      removable: credential.removable,
      baseUrl: this.snapshotValue.settings.baseUrl,
      endpointAccountId: metadata?.endpointAccountId,
      providerName: metadata?.providerName,
      providerVersion: metadata?.providerVersion,
      verifiedAt: metadata?.verifiedAt,
      updatedAt: metadata?.updatedAt,
      errorCode,
      revision: this.authorizationRevision(credential)
    });
  }
}
