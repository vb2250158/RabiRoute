import type { KnowledgeRuntimeConfig } from "./rabiLinkKnowledgeRuntime.js";
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
  agentUploads: { maxFileMiB: number };
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
  knowledgeBridge?: KnowledgeRuntimeConfig;
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
      agentUploads: { maxFileMiB: 2048 },
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
  }): RabiGlobalConfig {
    if (patch.agentUploads !== undefined && (!patch.agentUploads || !Number.isInteger(patch.agentUploads.maxFileMiB) || patch.agentUploads.maxFileMiB < 1 || patch.agentUploads.maxFileMiB > 2048)) {
      throw new Error("agentUploads.maxFileMiB must be an integer between 1 and 2048.");
    }
    const current = this.current;
    const next: RabiGlobalConfig = {
      ...current,
      rabiName: typeof patch.rabiName === "string" && patch.rabiName.trim()
        ? patch.rabiName.trim()
        : current.rabiName,
      rabiLinkRelay: patch.rabiLinkRelay
        ? normalizeRabiLinkRelayConfig({ ...current.rabiLinkRelay, ...patch.rabiLinkRelay,
            ...(patch.rabiLinkRelay.knowledgeBridge !== undefined ? { knowledgeBridge: mergeKnowledgeBridge(current.rabiLinkRelay.knowledgeBridge, patch.rabiLinkRelay.knowledgeBridge) } : {}) })
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
      current.rabiName !== next.rabiName ? "rabiName" : "",
      JSON.stringify(current.rabiLinkRelay) !== JSON.stringify(next.rabiLinkRelay) ? "rabiLinkRelay" : "",
      JSON.stringify(current.webguiLan) !== JSON.stringify(next.webguiLan) ? "webguiLan" : "",
      current.agentUploads.maxFileMiB !== next.agentUploads.maxFileMiB ? "agentUploads" : "",
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
        agentUploads: { maxFileMiB: Number.isInteger(parsed.agentUploads?.maxFileMiB) && parsed.agentUploads!.maxFileMiB >= 1 && parsed.agentUploads!.maxFileMiB <= 2048 ? parsed.agentUploads!.maxFileMiB : 2048 },
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
    } catch (error) {
      if (error instanceof KnowledgeBridgeConfigError) throw error;
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
    rabiLinkRelay: { ...config.rabiLinkRelay, ...(config.rabiLinkRelay.knowledgeBridge ? { knowledgeBridge: structuredClone(config.rabiLinkRelay.knowledgeBridge) } : {}) },
    webguiLan: { ...config.webguiLan },
    agentUploads: { ...config.agentUploads },
    performance: { ...config.performance }
  };
}

function freezeGlobalConfig(config: RabiGlobalConfig): RabiGlobalConfig {
  const snapshot = cloneGlobalConfig(config);
  if (snapshot.rabiLinkRelay.knowledgeBridge) {
    const bridge = snapshot.rabiLinkRelay.knowledgeBridge;
    bridge.grants?.forEach(Object.freeze);
    Object.freeze(bridge.grants);
    Object.freeze(bridge.allowedRoles);
    Object.freeze(bridge.allowedTools);
    Object.freeze(bridge);
  }
  Object.freeze(snapshot.rabiLinkRelay);
  Object.freeze(snapshot.webguiLan);
  Object.freeze(snapshot.performance);
  Object.freeze(snapshot.agentUploads);
  return Object.freeze(snapshot);
}

function normalizeNumber(value: unknown, fallback: number, min: number, max: number): number {
  const numberValue = Number(value);
  if (!Number.isFinite(numberValue)) return fallback;
  return Math.min(max, Math.max(min, numberValue));
}

class KnowledgeBridgeConfigError extends Error {
  constructor() { super("Invalid knowledgeBridge configuration."); }
}
function mergeKnowledgeBridge(current: KnowledgeRuntimeConfig | undefined, patch: unknown): unknown {
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) throw new KnowledgeBridgeConfigError();
  const value = patch as Record<string, unknown>;
  if (value.token === "" || value.token === "********") throw new KnowledgeBridgeConfigError();
  return { ...current, ...value };
}
export function normalizeKnowledgeBridgeConfig(raw: unknown): KnowledgeRuntimeConfig {
  const fail = (): never => { throw new KnowledgeBridgeConfigError(); };
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return fail();
  const value = raw as Record<string, unknown>;
  const fields = ["enabled", "url", "token", "allowedRoles", "allowedTools", "allowWrites", "grants"];
  if (Object.keys(value).some(key => !fields.includes(key))) return fail();
  if (value.enabled !== undefined && typeof value.enabled !== "boolean") return fail();
  if (value.allowWrites !== undefined && typeof value.allowWrites !== "boolean") return fail();
  if (typeof value.url !== "string" || !/^http:\/\/127\.0\.0\.1:[1-9][0-9]{0,4}\/mcp$/.test(value.url)) return fail();
  try { if (Number(new URL(value.url).port || 80) > 65535) return fail(); } catch { return fail(); }
  if (typeof value.token !== "string" || !/^[\x21-\x7e]{32,4096}$/.test(value.token) || /^\*+$/.test(value.token)) return fail();
  const identifiers = (input: unknown): string[] => {
    if (!Array.isArray(input) || input.length > 256 || input.some(item => typeof item !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(item)) || new Set(input).size !== input.length) return fail();
    return [...input] as string[];
  };
  const allowedRoles = identifiers(value.allowedRoles), allowedTools = identifiers(value.allowedTools);
  if (!Array.isArray(value.grants) || value.grants.length > 256) return fail();
  const grants = value.grants.map(item => {
    if (!item || typeof item !== "object" || Array.isArray(item) || Object.keys(item).some(key => !["appId", "deviceBindingId", "ownerAccountId"].includes(key))) return fail();
    for (const key of ["appId", "deviceBindingId", "ownerAccountId"]) identifiers([item[key]]);
    return { appId: item.appId as string, deviceBindingId: item.deviceBindingId as string, ownerAccountId: item.ownerAccountId as string };
  });
  if (new Set(grants.map(item => JSON.stringify(item))).size !== grants.length) return fail();
  return { enabled: value.enabled === true, url: value.url, token: value.token, allowedRoles, allowedTools, allowWrites: value.allowWrites === true, grants };
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
      : defaults.speechServiceUrl,
    ...(source.knowledgeBridge !== undefined ? { knowledgeBridge: normalizeKnowledgeBridgeConfig(source.knowledgeBridge) } : {})
  };
}
