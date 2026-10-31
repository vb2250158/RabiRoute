import { configureTimeouts, validateTimeoutOverrides, type TimeoutOverrides } from "../shared/timeoutSettings.js";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  defaultWebguiLanAccessConfig,
  normalizeWebguiLanAccessConfig,
  type WebguiLanAccessConfig
} from "./webguiLanAccess.js";
import {
  defaultPerformanceMonitoringConfig,
  normalizePerformanceMonitoringConfig,
  type PerformanceMonitoringConfig
} from "../shared/performanceContract.js";
import { recordDataMutationAudit } from "../observability/dataMutationAudit.js";
import { deviceIdentityConfigField } from "./deviceIdentity.js";
import { atomicWriteFileSync } from "../shared/filePersistence.js";

export type RabiGlobalConfig = {
  rabiGuid: string;
  rabiName: string;
  rabiLinkRelay: RabiLinkRelayGlobalConfig;
  webguiLan: WebguiLanAccessConfig;
  performance: PerformanceMonitoringConfig;
  agentUploads: { maxFileMiB: number };
  timeoutOverrides: TimeoutOverrides;
  createdAt: string;
  updatedAt: string;
};

export type RabiLinkRelayGlobalConfig = {
  enabled: boolean;
  url: string;
  token: string;
  deviceId: string;
  claimWaitMs: number;
  replyIdleTimeoutMs: number;
  speechServiceUrl: string;
};

export class RabiGlobalConfigStore {
  readonly rootDir: string;
  readonly configPath: string;
  private current: RabiGlobalConfig;
  private deviceIdentityBinding: unknown;
  // Request-scoped fence: requests never survive a Manager process restart.
  private lanAgentAdmissionIncarnation = randomUUID();
  private lanAgentAdmissionAvailable = true;
  private lanAgentDeliveryPolicy!: { enabled: boolean; incarnation: string };

  /** Durable business-delivery fence, separate from the process-scoped HTTP admission. */
  getLanAgentDeliveryPolicy(): Readonly<{ enabled: boolean; incarnation: string }> {
    return { ...this.lanAgentDeliveryPolicy,
      enabled: this.lanAgentAdmissionAvailable && this.current.webguiLan.enabled && this.lanAgentDeliveryPolicy.enabled };
  }

  private publishDeliveryPolicy(enabled: boolean, forceRotation = false): void {
    if (!forceRotation && this.lanAgentDeliveryPolicy?.enabled === enabled) return;
    const policy = { enabled, incarnation: randomUUID() };
    fs.mkdirSync(path.join(this.rootDir, "data", ".runtime"), { recursive: true });
    // A failed atomic rename must remain visible after process restart. Leave
    // this intent marker until both the fence and Config publication succeed.
    this.markDeliveryPublicationPending();
    atomicWriteFileSync(path.join(this.rootDir, "data", ".runtime", "lan-agent-delivery-policy.json"), `${JSON.stringify(policy)}\n`);
    this.lanAgentDeliveryPolicy = policy;
  }

  getLanAgentAdmissionPolicy(): Readonly<{ enabled: boolean; incarnation: string }> {
    return { enabled: this.lanAgentAdmissionAvailable && this.current.webguiLan.enabled,
      incarnation: this.lanAgentAdmissionIncarnation };
  }

  private publish(config: RabiGlobalConfig | null, persistConfig?: () => void): void {
    const available = config !== null;
    try {
      // Publish the durable revocation fence before committing Config. Recovery
      // from any failed publication must not reuse the pre-failure incarnation.
      this.publishDeliveryPolicy(available && Boolean(config?.webguiLan.enabled), !this.lanAgentAdmissionAvailable);
      if (persistConfig) {
        this.markDeliveryPublicationPending();
        persistConfig();
      }
      if (fs.existsSync(this.deliveryIntentPath())) fs.unlinkSync(this.deliveryIntentPath());
    } catch (error) {
      this.lanAgentAdmissionAvailable = false;
      this.lanAgentAdmissionIncarnation = randomUUID();
      throw error;
    }
    if (available !== this.lanAgentAdmissionAvailable
      || (config && config.webguiLan.enabled !== this.current.webguiLan.enabled)) {
      this.lanAgentAdmissionIncarnation = randomUUID();
    }
    this.lanAgentAdmissionAvailable = available;
    if (config) {
      this.current = freezeGlobalConfig(config);
      configureTimeouts(config.timeoutOverrides);
    }
  }

  private markDeliveryPublicationPending(): void {
    fs.mkdirSync(path.dirname(this.deliveryIntentPath()), { recursive: true });
    const descriptor = fs.openSync(this.deliveryIntentPath(), "w");
    try { fs.writeFileSync(descriptor, "pending\n"); fs.fsyncSync(descriptor); }
    finally { fs.closeSync(descriptor); }
  }

  private deliveryIntentPath(): string {
    return path.join(this.rootDir, "data", ".runtime", "lan-agent-delivery-policy.pending");
  }

  constructor(rootDir: string) {
    this.rootDir = rootDir;
    this.configPath = path.join(rootDir, "data", "Config.json");
    const policyPath = path.join(rootDir, "data", ".runtime", "lan-agent-delivery-policy.json");
    try {
      const policy = JSON.parse(fs.readFileSync(policyPath, "utf8"));
      if (typeof policy.enabled !== "boolean" || typeof policy.incarnation !== "string" || !policy.incarnation) throw new Error("Invalid delivery policy fence.");
      this.lanAgentDeliveryPolicy = policy;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    this.current = this.loadOrCreate();
    configureTimeouts(this.current.timeoutOverrides);
    this.publishDeliveryPolicy(this.current.webguiLan.enabled, fs.existsSync(this.deliveryIntentPath()));
    if (fs.existsSync(this.deliveryIntentPath())) fs.unlinkSync(this.deliveryIntentPath());
  }

  read(): RabiGlobalConfig {
    return cloneGlobalConfig(this.current);
  }

  reload(): RabiGlobalConfig {
    const reloaded = this.readExisting();
    this.publish(reloaded);
    return this.read();
  }

  private loadOrCreate(): RabiGlobalConfig {
    const current = this.readExisting();
    if (current) return freezeGlobalConfig(current);

    const now = new Date().toISOString();
    const created: RabiGlobalConfig = {
      rabiGuid: randomUUID(),
      rabiName: os.hostname() || "RabiRoute",
      rabiLinkRelay: defaultRabiLinkRelayConfig(),
      webguiLan: defaultWebguiLanAccessConfig(),
      performance: defaultPerformanceMonitoringConfig(),
      agentUploads: { maxFileMiB: 2048 },
      timeoutOverrides: {},
      createdAt: now,
      updatedAt: now
    };
    this.persist(created, "create", undefined, created.updatedAt);
    return freezeGlobalConfig(created);
  }

  patch(patch: Partial<Pick<RabiGlobalConfig, "rabiName">> & {
    rabiLinkRelay?: Partial<RabiLinkRelayGlobalConfig>;
    webguiLan?: Partial<WebguiLanAccessConfig>;
    performance?: Partial<PerformanceMonitoringConfig>;
    agentUploads?: { maxFileMiB: number };
    timeoutOverrides?: TimeoutOverrides;
  }): RabiGlobalConfig {
    if (patch.agentUploads !== undefined && (!patch.agentUploads || !Number.isInteger(patch.agentUploads.maxFileMiB) || patch.agentUploads.maxFileMiB < 1 || patch.agentUploads.maxFileMiB > Math.floor(Number.MAX_SAFE_INTEGER / 1024 ** 2))) {
      throw new Error(`agentUploads.maxFileMiB must be an integer between 1 and ${Math.floor(Number.MAX_SAFE_INTEGER / 1024 ** 2)} (exact byte-count capacity).`);
    }
    const timeoutOverrides = patch.timeoutOverrides === undefined ? this.current.timeoutOverrides : validateTimeoutOverrides(patch.timeoutOverrides);
    const current = this.current;
    const next: RabiGlobalConfig = {
      ...current,
      timeoutOverrides,
      rabiName: typeof patch.rabiName === "string" && patch.rabiName.trim()
        ? patch.rabiName.trim()
        : current.rabiName,
      rabiLinkRelay: patch.rabiLinkRelay
        ? normalizeRabiLinkRelayConfig({ ...current.rabiLinkRelay, ...patch.rabiLinkRelay })
        : current.rabiLinkRelay,
      webguiLan: patch.webguiLan
        ? normalizeWebguiLanAccessConfig({ ...current.webguiLan, ...patch.webguiLan })
        : current.webguiLan,
      performance: patch.performance
        ? normalizePerformanceMonitoringConfig({ ...current.performance, ...patch.performance })
        : current.performance,
      agentUploads: patch.agentUploads ? { maxFileMiB: patch.agentUploads.maxFileMiB } : current.agentUploads,
      updatedAt: new Date().toISOString()
    };
    const changedFields = [
      JSON.stringify(current.timeoutOverrides) !== JSON.stringify(next.timeoutOverrides) ? "timeoutOverrides" : "",
      current.rabiName !== next.rabiName ? "rabiName" : "",
      JSON.stringify(current.rabiLinkRelay) !== JSON.stringify(next.rabiLinkRelay) ? "rabiLinkRelay" : "",
      JSON.stringify(current.webguiLan) !== JSON.stringify(next.webguiLan) ? "webguiLan" : "",
      current.agentUploads.maxFileMiB !== next.agentUploads.maxFileMiB ? "agentUploads" : "",
      JSON.stringify(current.performance) !== JSON.stringify(next.performance) ? "performance" : ""
    ].filter(Boolean);
    if (patch.timeoutOverrides !== undefined && changedFields.includes("timeoutOverrides") && fs.existsSync(this.configPath)) {
      const backupDir = path.join(this.rootDir, "data", ".runtime", "timeout-settings-backups");
      fs.mkdirSync(backupDir, { recursive: true });
      fs.copyFileSync(this.configPath, path.join(backupDir, `${Date.now()}-${randomUUID()}.json`), fs.constants.COPYFILE_EXCL);
    }
    this.publish(next, () => this.persist(next, changedFields.length ? "patch" : "normalize", current.updatedAt, next.updatedAt, changedFields));
    return this.read();
  }

  private readExisting(): RabiGlobalConfig | null {
    if (!fs.existsSync(this.configPath)) return null;
    try {
      const parsed = JSON.parse(fs.readFileSync(this.configPath, "utf8")) as Partial<RabiGlobalConfig> & Record<string, unknown>;
      // The local owner is intentionally absent from read/patch/public DTO types.
      this.deviceIdentityBinding = parsed[deviceIdentityConfigField];
      const now = new Date().toISOString();
      const normalized: RabiGlobalConfig = {
        rabiGuid: typeof parsed.rabiGuid === "string" && parsed.rabiGuid.trim() ? parsed.rabiGuid.trim() : randomUUID(),
        rabiName: typeof parsed.rabiName === "string" && parsed.rabiName.trim() ? parsed.rabiName.trim() : os.hostname() || "RabiRoute",
        rabiLinkRelay: normalizeRabiLinkRelayConfig(parsed.rabiLinkRelay),
        webguiLan: normalizeWebguiLanAccessConfig(parsed.webguiLan),
        performance: normalizePerformanceMonitoringConfig(parsed.performance),
        timeoutOverrides: readSavedTimeoutOverrides(parsed.timeoutOverrides),
        agentUploads: { maxFileMiB: Number.isInteger(parsed.agentUploads?.maxFileMiB) && parsed.agentUploads!.maxFileMiB >= 1 && parsed.agentUploads!.maxFileMiB <= Math.floor(Number.MAX_SAFE_INTEGER / 1024 ** 2) ? parsed.agentUploads!.maxFileMiB : 2048 },
        createdAt: typeof parsed.createdAt === "string" && parsed.createdAt.trim() ? parsed.createdAt.trim() : now,
        updatedAt: typeof parsed.updatedAt === "string" && parsed.updatedAt.trim() ? parsed.updatedAt.trim() : now
      };
      if (
        normalized.rabiGuid !== parsed.rabiGuid
        || normalized.rabiName !== parsed.rabiName
        || JSON.stringify(normalized.rabiLinkRelay) !== JSON.stringify(parsed.rabiLinkRelay)
        || JSON.stringify(normalized.webguiLan) !== JSON.stringify(parsed.webguiLan)
        || JSON.stringify(normalized.agentUploads) !== JSON.stringify(parsed.agentUploads)
        || JSON.stringify(normalized.performance) !== JSON.stringify(parsed.performance)
        || normalized.createdAt !== parsed.createdAt
        || normalized.updatedAt !== parsed.updatedAt
      ) {
        this.persist(normalized, "normalize", typeof parsed.updatedAt === "string" ? parsed.updatedAt : undefined, normalized.updatedAt);
      }
      return normalized;
    } catch {
      return null;
    }
  }

  private persist(
    config: RabiGlobalConfig,
    action: "create" | "patch" | "normalize",
    beforeRevision?: string,
    afterRevision?: string,
    changedFields: string[] = []
  ): void {
    try {
      fs.mkdirSync(path.dirname(this.configPath), { recursive: true });
      const persisted = { ...config, ...(this.deviceIdentityBinding === undefined ? {} : { [deviceIdentityConfigField]: this.deviceIdentityBinding }) };
      atomicWriteFileSync(this.configPath, `${JSON.stringify(persisted, null, 2)}\n`);
      recordDataMutationAudit({
        group: "config.global",
        event: `global_config_${action}`,
        owner: "RabiGlobalConfigStore",
        action,
        target: { type: "global_config", id: "Config.json" },
        dataSource: { kind: "file", id: "data/Config.json" },
        outcome: changedFields.length === 0 && action === "patch" ? "no_change" : "committed",
        before: beforeRevision ? { revision: beforeRevision } : undefined,
        after: afterRevision ? { revision: afterRevision } : undefined,
        changes: changedFields.map(field => ({ field }))
      });
    } catch (error) {
      recordDataMutationAudit({
        level: "error",
        group: "config.global",
        event: `global_config_${action}_failed`,
        owner: "RabiGlobalConfigStore",
        action,
        target: { type: "global_config", id: "Config.json" },
        dataSource: { kind: "file", id: "data/Config.json" },
        outcome: "failed",
        before: beforeRevision ? { revision: beforeRevision } : undefined,
        error
      });
      throw error;
    }
  }
}

function cloneGlobalConfig(config: RabiGlobalConfig): RabiGlobalConfig {
  return {
    ...config,
    rabiLinkRelay: { ...config.rabiLinkRelay },
    webguiLan: { ...config.webguiLan },
    agentUploads: { ...config.agentUploads },
    timeoutOverrides: { ...config.timeoutOverrides },
    performance: { ...config.performance }
  };
}

function freezeGlobalConfig(config: RabiGlobalConfig): RabiGlobalConfig {
  const snapshot = cloneGlobalConfig(config);
  Object.freeze(snapshot.rabiLinkRelay);
  Object.freeze(snapshot.webguiLan);
  Object.freeze(snapshot.performance);
  Object.freeze(snapshot.agentUploads);
  Object.freeze(snapshot.timeoutOverrides);
  return Object.freeze(snapshot);
}

function normalizeNumber(value: unknown, fallback: number, min: number, max: number): number {
  const numberValue = Number(value);
  if (!Number.isFinite(numberValue)) return fallback;
  return Math.min(max, Math.max(min, numberValue));
}

function defaultRabiLinkRelayConfig(): RabiLinkRelayGlobalConfig {
  return {
    enabled: false,
    url: "",
    token: "",
    deviceId: os.hostname() || "rabilink-pc",
    claimWaitMs: 60000,
    replyIdleTimeoutMs: 60000,
    speechServiceUrl: "http://127.0.0.1:8781"
  };
}

function normalizeRabiLinkRelayConfig(raw: unknown): RabiLinkRelayGlobalConfig {
  const source = raw && typeof raw === "object" && !Array.isArray(raw)
    ? raw as Partial<RabiLinkRelayGlobalConfig>
    : {};
  const defaults = defaultRabiLinkRelayConfig();
  const url = typeof source.url === "string" ? source.url.trim() : "";
  const token = typeof source.token === "string" ? source.token.trim() : "";
  return {
    enabled: typeof source.enabled === "boolean" ? source.enabled : Boolean(url && token),
    url,
    token,
    deviceId: typeof source.deviceId === "string" && source.deviceId.trim() ? source.deviceId.trim() : defaults.deviceId,
    claimWaitMs: normalizeNumber(source.claimWaitMs, defaults.claimWaitMs, 0, 60000),
    replyIdleTimeoutMs: normalizeNumber(source.replyIdleTimeoutMs, defaults.replyIdleTimeoutMs, 1000, 120000),
    speechServiceUrl: typeof source.speechServiceUrl === "string" && source.speechServiceUrl.trim()
      ? source.speechServiceUrl.trim()
      : defaults.speechServiceUrl
  };
}

function readSavedTimeoutOverrides(raw: unknown): TimeoutOverrides {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const result: TimeoutOverrides = {};
  for (const [key, value] of Object.entries(raw)) {
    try {
      const validated = validateTimeoutOverrides({ [key]: value });
      Object.defineProperty(result, key, { value: validated[key], enumerable: true, configurable: true, writable: true });
    }
    catch { /* Ignore only the malformed timeout; preserve the rest of the saved configuration. */ }
  }
  return result;
}
