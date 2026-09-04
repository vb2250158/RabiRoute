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

export type RabiGlobalConfig = {
  rabiGuid: string;
  rabiName: string;
  rabiLinkRelay: RabiLinkRelayGlobalConfig;
  webguiLan: WebguiLanAccessConfig;
  performance: PerformanceMonitoringConfig;
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
  speechProxyEnabled: boolean;
  speechServiceUrl: string;
};

export class RabiGlobalConfigStore {
  readonly rootDir: string;
  readonly configPath: string;
  private current: RabiGlobalConfig;

  constructor(rootDir: string) {
    this.rootDir = rootDir;
    this.configPath = path.join(rootDir, "data", "Config.json");
    this.current = this.loadOrCreate();
  }

  read(): RabiGlobalConfig {
    return cloneGlobalConfig(this.current);
  }

  reload(): RabiGlobalConfig {
    const reloaded = this.readExisting();
    if (reloaded) {
      this.current = freezeGlobalConfig(reloaded);
    }
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
  }): RabiGlobalConfig {
    const current = this.current;
    const next: RabiGlobalConfig = {
      ...current,
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
      updatedAt: new Date().toISOString()
    };
    const changedFields = [
      current.rabiName !== next.rabiName ? "rabiName" : "",
      JSON.stringify(current.rabiLinkRelay) !== JSON.stringify(next.rabiLinkRelay) ? "rabiLinkRelay" : "",
      JSON.stringify(current.webguiLan) !== JSON.stringify(next.webguiLan) ? "webguiLan" : "",
      JSON.stringify(current.performance) !== JSON.stringify(next.performance) ? "performance" : ""
    ].filter(Boolean);
    this.persist(next, changedFields.length ? "patch" : "normalize", current.updatedAt, next.updatedAt, changedFields);
    this.current = freezeGlobalConfig(next);
    return this.read();
  }

  private readExisting(): RabiGlobalConfig | null {
    if (!fs.existsSync(this.configPath)) return null;
    try {
      const parsed = JSON.parse(fs.readFileSync(this.configPath, "utf8")) as Partial<RabiGlobalConfig>;
      const now = new Date().toISOString();
      const normalized: RabiGlobalConfig = {
        rabiGuid: typeof parsed.rabiGuid === "string" && parsed.rabiGuid.trim() ? parsed.rabiGuid.trim() : randomUUID(),
        rabiName: typeof parsed.rabiName === "string" && parsed.rabiName.trim() ? parsed.rabiName.trim() : os.hostname() || "RabiRoute",
        rabiLinkRelay: normalizeRabiLinkRelayConfig(parsed.rabiLinkRelay),
        webguiLan: normalizeWebguiLanAccessConfig(parsed.webguiLan),
        performance: normalizePerformanceMonitoringConfig(parsed.performance),
        createdAt: typeof parsed.createdAt === "string" && parsed.createdAt.trim() ? parsed.createdAt.trim() : now,
        updatedAt: typeof parsed.updatedAt === "string" && parsed.updatedAt.trim() ? parsed.updatedAt.trim() : now
      };
      if (
        normalized.rabiGuid !== parsed.rabiGuid
        || normalized.rabiName !== parsed.rabiName
        || JSON.stringify(normalized.rabiLinkRelay) !== JSON.stringify(parsed.rabiLinkRelay)
        || JSON.stringify(normalized.webguiLan) !== JSON.stringify(parsed.webguiLan)
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
      fs.writeFileSync(this.configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
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
    performance: { ...config.performance }
  };
}

function freezeGlobalConfig(config: RabiGlobalConfig): RabiGlobalConfig {
  const snapshot = cloneGlobalConfig(config);
  Object.freeze(snapshot.rabiLinkRelay);
  Object.freeze(snapshot.webguiLan);
  Object.freeze(snapshot.performance);
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
    speechProxyEnabled: false,
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
    speechProxyEnabled: source.speechProxyEnabled === true,
    speechServiceUrl: typeof source.speechServiceUrl === "string" && source.speechServiceUrl.trim()
      ? source.speechServiceUrl.trim()
      : defaults.speechServiceUrl
  };
}
