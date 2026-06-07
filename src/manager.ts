import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { fileURLToPath } from "node:url";
import { normalizeAgentAdapters, type AgentAdapterType } from "./agentAdapters/types.js";
import type { MessageAdapterType } from "./adapters/messageAdapter.js";
import type { ForwardRouteKind } from "./forwarding.js";
import { normalizePipelineDefinition, type PipelineDefinition } from "./pipelines.js";

type GatewayDefinition = {
  id: string;
  name?: string;
  enabled?: boolean;
  messageAdapterType?: MessageAdapterType;
  messageAdapters?: MessageAdapterType[];
  messageAdaptersDisabled?: MessageAdapterType[];
  messageInputsDisabled?: boolean;
  gatewayPort: number;
  webhookPort?: number;
  webhookPath?: string;
  heartbeatIntervalSeconds?: number;
  heartbeatMessage?: string;
  napcatHttpUrl?: string;
  napcatAccessToken?: string;
  targetGroupId?: string;
  pipelinePreset?: string;
  pipeline?: PipelineDefinition;
  routeVariables?: Record<string, string>;
  routeName?: string;
  codexThreadName?: string;
  codexCwd?: string;
  copilotCwd?: string;
  copilotCliBin?: string;
  marvisAppId?: string;
  rolesDir?: string;
  routesDir?: string;
  configName?: string;
  agentRoleId?: string;
  agentRoleFile?: string;
  agentAdapters?: AgentAdapterType[];
  routeProfiles?: RouteProfileDefinition[];
  dataDir?: string;
  groupNotificationTemplate?: string;
  groupAtNotificationTemplate?: string;
  groupDirectReplyNotificationTemplate?: string;
  groupIndirectReplyNotificationTemplate?: string;
  groupReplyNotificationTemplate?: string;
  groupNicknameNotificationTemplate?: string;
  privateNotificationTemplate?: string;
  heartbeatNotificationTemplate?: string;
  voiceTranscriptNotificationTemplate?: string;
  notificationRules?: NotificationRuleDefinition[];
  roleNotificationRules?: Record<string, NotificationRuleDefinition[]>;
  roleRouteNames?: Record<string, string>;
};

type RouteProfileDefinition = {
  id: string;
  name?: string;
  enabled?: boolean;
  pipelinePreset?: string;
  pipeline?: PipelineDefinition;
  agentRoleId?: string;
  agentRoleFile?: string;
  rolesDir?: string;
  dataDir?: string;
  routeVariables?: Record<string, string>;
  notificationRules?: NotificationRuleDefinition[];
};

type NotificationRuleDefinition = {
  id: string;
  name?: string;
  enabled?: boolean;
  routeKinds?: string[];
  targetGroupId?: string;
  regex?: string;
  template: string;
};

type GatewayConfigFile = {
  gateways: GatewayDefinition[];
};

type GatewayRuntime = {
  definition: GatewayDefinition;
  process: ChildProcessWithoutNullStreams | null;
  needsRestart: boolean;
  startedAt: string | null;
  stoppedAt: string | null;
  lastExit: {
    code: number | null;
    signal: NodeJS.Signals | null;
    at: string;
  } | null;
  log: string[];
};

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const managerConfigPath = path.join(rootDir, "data", "manager.json");

type ManagerConfig = { routeDir?: string; rolesDir?: string };

function readManagerConfig(): ManagerConfig {
  if (!fs.existsSync(managerConfigPath)) return {};
  try { return JSON.parse(fs.readFileSync(managerConfigPath, "utf8")) as ManagerConfig; } catch { return {}; }
}

function writeManagerConfig(cfg: ManagerConfig): void {
  fs.mkdirSync(path.dirname(managerConfigPath), { recursive: true });
  fs.writeFileSync(managerConfigPath, JSON.stringify(cfg, null, 2), "utf8");
}

const _managerCfg = readManagerConfig();
let rolesRoot = path.resolve(rootDir, _managerCfg.rolesDir ?? process.env.ROLES_DIR ?? path.join("data", "roles"));
let routeRoot = path.resolve(rootDir, _managerCfg.routeDir ?? process.env.ROUTE_DIR ?? path.join("data", "route"));
const managerPort = Number(process.env.GATEWAY_MANAGER_PORT ?? "8790");
const fenneNotePlaybackUrl = process.env.FENNOTE_PLAYBACK_URL ?? "http://127.0.0.1:8793/api/fennenote/playback";
const fenneNoteReplyUrl = process.env.FENNOTE_REPLY_URL ?? "http://127.0.0.1:8793/api/fennenote/reply";
const fenneNotePlaybackToken = process.env.FENNOTE_PLAYBACK_TOKEN ?? "";
const fenneNoteReplyToken = process.env.FENNOTE_REPLY_TOKEN ?? fenneNotePlaybackToken;
const packageJsonPath = path.join(rootDir, "package.json");
const webuiDistPath = path.join(rootDir, "ribiwebgui", "dist");
const runtimes = new Map<string, GatewayRuntime>();
let watchedConfigSnapshot = "";

function definitionFingerprint(definition: GatewayDefinition): string {
  return JSON.stringify(definition);
}

function routeRuntimeId(roleId: string, configName: string): string {
  return configName;
}

function routeRuntimeParts(id: string): { roleId: string; configName: string } {
  const [roleId, ...rest] = id.split("__");
  if (rest.length === 0) {
    return {
      roleId: "",
      configName: sanitizeRoleId(id) || "default"
    };
  }
  return {
    roleId: sanitizeRoleId(roleId) || id,
    configName: sanitizeRoleId(rest.join("__")) || "default"
  };
}

function ensureDataDirs(): void {
  const exampleDataDir = path.join(rootDir, "examples", "data");
  if (!fs.existsSync(rolesRoot) && fs.existsSync(path.join(exampleDataDir, "roles"))) {
    fs.mkdirSync(path.dirname(rolesRoot), { recursive: true });
    fs.cpSync(path.join(exampleDataDir, "roles"), rolesRoot, {
      recursive: true,
      force: false,
      errorOnExist: false
    });
  }
  if (!fs.existsSync(routeRoot) && fs.existsSync(path.join(exampleDataDir, "route"))) {
    fs.mkdirSync(path.dirname(routeRoot), { recursive: true });
    fs.cpSync(path.join(exampleDataDir, "route"), routeRoot, {
      recursive: true,
      force: false,
      errorOnExist: false
    });
  }
  fs.mkdirSync(rolesRoot, { recursive: true });
  fs.mkdirSync(routeRoot, { recursive: true });
}

function readConfig(): GatewayConfigFile {
  ensureDataDirs();
  const gateways: GatewayDefinition[] = [];
  for (const routeEntry of fs.readdirSync(routeRoot, { withFileTypes: true })) {
    if (!routeEntry.isDirectory() || !sanitizeRoleId(routeEntry.name)) {
      continue;
    }
    const configName = sanitizeRoleId(routeEntry.name);
    const configPath = routeConfigPath(configName);
    if (!fs.existsSync(configPath)) {
      continue;
    }
    const raw = JSON.parse(fs.readFileSync(configPath, "utf8")) as Partial<GatewayDefinition>;
    // routeConfig.json is the single source of truth; roleMessageConfig.json is no longer read.
    gateways.push({
      ...raw,
      id: configName,
      configName,
      agentRoleId: raw.agentRoleId,
      rolesDir: raw.rolesDir,
      agentRoleFile: raw.agentRoleFile
    } as GatewayDefinition & { configName: string });
  }
  return { gateways };
}

function writeConfig(config: GatewayConfigFile): GatewayConfigFile {
  if (!Array.isArray(config.gateways)) {
    throw new Error("routes must be an array");
  }

  const normalized = { gateways: config.gateways.map(normalizeDefinition) };
  const grouped = new Map<string, GatewayDefinition[]>();
  for (let i = 0; i < normalized.gateways.length; i++) {
    const item = normalized.gateways[i];
    const rawItem = config.gateways[i];
    const roleId = sanitizeRoleId(item.agentRoleId) || routeRuntimeParts(item.id).roleId;
    grouped.set(roleId, [...(grouped.get(roleId) ?? []), item]);
    // Rename data dir if configName changed (look up existing runtime by original/raw id)
    const existingRuntime = runtimes.get(rawItem.id) ?? runtimes.get(item.id);
    if (existingRuntime) {
      const oldDataDir = dataDirFor(existingRuntime.definition);
      const newDataDir = dataDirFor(item);
      if (oldDataDir !== newDataDir && fs.existsSync(oldDataDir)) {
        try {
          fs.mkdirSync(path.dirname(newDataDir), { recursive: true });
          fs.renameSync(oldDataDir, newDataDir);
        } catch {
          // Non-fatal: folder rename failed (e.g. cross-drive), data stays at old location
        }
      }
      // Remove old config file if id (configName) changed
      const oldConfigName = routeRuntimeParts(existingRuntime.definition.id).configName;
      const newConfigName = routeRuntimeParts(item.id).configName;
      if (oldConfigName !== newConfigName) {
        const oldConfigPath = routeConfigPath(oldConfigName);
        if (fs.existsSync(oldConfigPath)) {
          try { fs.unlinkSync(oldConfigPath); } catch { /* non-fatal */ }
        }
      }
    }
    writeRouteConfigFile(item);
  }
  // roleMessageConfig.json is no longer written; routeConfig.json is the single source of truth.
  return normalized;
}

function normalizeDefinition(definition: GatewayDefinition): GatewayDefinition {
  if (!definition.id || !/^[a-zA-Z0-9_-]+$/.test(definition.id)) {
    throw new Error(`Invalid gateway id: ${definition.id}`);
  }
  if (!Number.isInteger(definition.gatewayPort) || definition.gatewayPort <= 0) {
    throw new Error(`Invalid gateway port for ${definition.id}: ${definition.gatewayPort}`);
  }
  if (definition.webhookPort != null && (!Number.isInteger(definition.webhookPort) || definition.webhookPort <= 0)) {
    throw new Error(`Invalid webhook port for ${definition.id}: ${definition.webhookPort}`);
  }

  const parts = routeRuntimeParts(definition.id);
  const agentRoleId = sanitizeRoleId(definition.agentRoleId) || parts.roleId;
  const configName = sanitizeRoleId(definition.configName) || parts.configName;
  const runtimeId = routeRuntimeId(agentRoleId, configName);
  const dataDir = path.relative(rootDir, path.join(routeRoot, configName)).replace(/\\/g, "/");
  const rolesDir = path.relative(rootDir, rolesRoot).replace(/\\/g, "/");
  const routeName = definition.routeName?.trim() || definition.name?.trim() || configName;
  const notificationRules = normalizeRuleDefinitions(definition.notificationRules) ?? [];
  const { botNickname: _legacyBotNickname, ...cleanDefinition } = definition as GatewayDefinition & { botNickname?: string };
  const rawMessageAdapters = definition.messageAdapters ?? [definition.messageAdapterType ?? "napcat"];
  const messageInputsDisabled = definition.messageInputsDisabled === true || rawMessageAdapters.includes("disabled");
  const messageAdapters = normalizeMessageAdapters(rawMessageAdapters);
  const agentAdapters = normalizeAgentAdapters(definition.agentAdapters ?? ["codexDesktop"]);
  const pipelinePreset = typeof definition.pipelinePreset === "string" && definition.pipelinePreset.trim()
    ? definition.pipelinePreset.trim()
    : undefined;
  const pipeline = normalizePipelineDefinition(definition.pipeline);
  return {
    ...cleanDefinition,
    id: runtimeId,
    name: definition.name ?? routeName,
    configName,
    enabled: definition.enabled !== false,
    messageAdapterType: messageAdapters[0] ?? "napcat",
    messageAdapters,
    messageInputsDisabled,
    agentAdapters,
    pipelinePreset,
    pipeline,
    routeName,
    heartbeatIntervalSeconds: normalizePositiveNumber(definition.heartbeatIntervalSeconds, 900),
    heartbeatMessage: definition.heartbeatMessage ?? "定时心跳巡检：请检查最近消息和角色相关上下文。",
    codexCwd: normalizeCodexCwd(definition.codexCwd),
    groupNotificationTemplate: normalizeOptionalTemplate(definition.groupNotificationTemplate),
    groupAtNotificationTemplate: normalizeOptionalTemplate(definition.groupAtNotificationTemplate),
    groupDirectReplyNotificationTemplate: normalizeOptionalTemplate(definition.groupDirectReplyNotificationTemplate),
    groupIndirectReplyNotificationTemplate: normalizeOptionalTemplate(definition.groupIndirectReplyNotificationTemplate),
    groupReplyNotificationTemplate: normalizeOptionalTemplate(definition.groupReplyNotificationTemplate),
    groupNicknameNotificationTemplate: normalizeOptionalTemplate(definition.groupNicknameNotificationTemplate),
    privateNotificationTemplate: normalizeOptionalTemplate(definition.privateNotificationTemplate),
    heartbeatNotificationTemplate: normalizeOptionalTemplate(definition.heartbeatNotificationTemplate),
    voiceTranscriptNotificationTemplate: normalizeOptionalTemplate(definition.voiceTranscriptNotificationTemplate),
    notificationRules,
    dataDir,
    rolesDir,
    agentRoleId,
    agentRoleFile: definition.agentRoleFile ?? "persona.md",
    roleNotificationRules: { [runtimeId]: notificationRules },
    roleRouteNames: { [runtimeId]: routeName },
    routeProfiles: [normalizeRouteProfile({
      id: runtimeId,
      name: routeName,
      enabled: definition.enabled !== false,
      agentRoleId,
      agentRoleFile: definition.agentRoleFile ?? "persona.md",
      rolesDir,
      dataDir,
      pipelinePreset,
      pipeline,
      routeVariables: definition.routeVariables,
      notificationRules
    }, 0, definition, dataDir, rolesDir)].filter((profile): profile is RouteProfileDefinition => Boolean(profile))
  };
}

function normalizeRouteProfile(
  profile: RouteProfileDefinition,
  index: number,
  definition: GatewayDefinition,
  dataDir: string,
  rolesDir: string
): RouteProfileDefinition | null {
  const roleId = sanitizeRoleId(profile.agentRoleId);
  const id = sanitizeRoleId(profile.id) || roleId || `route-${index + 1}`;
  const rules = normalizeRuleDefinitions(profile.notificationRules) ?? [];
  if (rules.length === 0) {
    return null;
  }

  return {
    id,
    name: profile.name?.trim() || id,
    enabled: profile.enabled !== false,
    pipelinePreset: typeof profile.pipelinePreset === "string" && profile.pipelinePreset.trim()
      ? profile.pipelinePreset.trim()
      : definition.pipelinePreset,
    pipeline: normalizePipelineDefinition(profile.pipeline) ?? normalizePipelineDefinition(definition.pipeline),
    agentRoleId: roleId,
    agentRoleFile: profile.agentRoleFile?.trim() || definition.agentRoleFile || "persona.md",
    rolesDir: profile.rolesDir?.trim() || rolesDir,
    dataDir: profile.dataDir?.trim() || dataDir,
    routeVariables: profile.routeVariables ?? definition.routeVariables ?? {},
    notificationRules: rules
  };
}

function normalizeMessageAdapters(items: unknown[]): MessageAdapterType[] {
  const adapters = items
    .map((item) => item == null ? "" : String(item))
    .filter((item): item is MessageAdapterType => item === "napcat" || item === "webhook" || item === "heartbeat" || item === "disabled");
  const unique = [...new Set(adapters)].filter((item) => item !== "disabled");
  return unique.length > 0 ? unique : ["napcat"];
}

function normalizePositiveNumber(value: unknown, fallback: number): number {
  const numberValue = Number(value);
  return Number.isFinite(numberValue) && numberValue > 0 ? numberValue : fallback;
}

function normalizeCodexCwd(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const trimmed = value.trim();
  const compact = trimmed.replace(/\\/g, "/").replace(/\/+/g, "/").toLowerCase();
  if (!trimmed || compact === "c:/path/to/your/project") {
    return undefined;
  }

  return trimmed;
}

function normalizeTemplateText(value: string): string {
  return value
    .replace(/\\r\\n/g, "\n")
    .replace(/\\n/g, "\n");
}

function normalizeOptionalTemplate(value: unknown): string | undefined {
  return typeof value === "string" ? normalizeTemplateText(value) : undefined;
}

function normalizeRuleDefinitions(rules: unknown): NotificationRuleDefinition[] | undefined {
  if (!Array.isArray(rules)) {
    return undefined;
  }

  return rules.map((rule, index) => {
    const raw = rule && typeof rule === "object" ? rule as Partial<NotificationRuleDefinition> : {};
    return {
      id: typeof raw.id === "string" && raw.id.trim() ? raw.id : `rule-${index + 1}`,
      name: raw.name,
      enabled: raw.enabled !== false,
      routeKinds: Array.isArray(raw.routeKinds) ? raw.routeKinds.map(String) : [],
      targetGroupId: typeof raw.targetGroupId === "string" ? raw.targetGroupId : "",
      regex: typeof raw.regex === "string" ? raw.regex : "",
      template: normalizeTemplateText(typeof raw.template === "string" && raw.template.trim() ? raw.template : "")
    };
  }).filter((rule) => rule.template.trim());
}

function roleMessageConfigPath(roleId: string): string {
  const safeRoleId = sanitizeRoleId(roleId);
  if (!safeRoleId) {
    throw new Error("Missing role folder name");
  }
  return path.join(rolesRoot, safeRoleId, "roleMessageConfig.json");
}

function routeConfigPath(configName: string): string {
  const safeConfigName = sanitizeRoleId(configName);
  if (!safeConfigName) {
    throw new Error("Missing route folder name");
  }
  return path.join(routeRoot, safeConfigName, "routeConfig.json");
}

function routeConfigItem(definition: GatewayDefinition): Record<string, unknown> {
  return {
    configName: sanitizeRoleId(definition.configName) || routeRuntimeParts(definition.id).configName,
    name: definition.name,
    routeName: definition.routeName,
    enabled: definition.enabled !== false,
    messageAdapters: definition.messageAdapters ?? [definition.messageAdapterType ?? "napcat"],
    messageAdaptersDisabled: definition.messageAdaptersDisabled,
    pipelinePreset: definition.pipelinePreset,
    pipeline: definition.pipeline,
    gatewayPort: definition.gatewayPort,
    webhookPort: definition.webhookPort,
    webhookPath: definition.webhookPath,
    napcatHttpUrl: definition.napcatHttpUrl,
    napcatAccessToken: definition.napcatAccessToken,
    heartbeatIntervalSeconds: definition.heartbeatIntervalSeconds,
    heartbeatMessage: definition.heartbeatMessage,
    codexThreadName: definition.codexThreadName,
    codexCwd: definition.codexCwd,
    copilotCwd: definition.copilotCwd,
    copilotCliBin: definition.copilotCliBin,
    marvisAppId: definition.marvisAppId,
    rolesDir: definition.rolesDir,
    agentRoleId: definition.agentRoleId,
    agentRoleFile: definition.agentRoleFile,
    agentAdapters: definition.agentAdapters,
    routeVariables: definition.routeVariables,
    notificationRules: definition.notificationRules ?? []
  };
}

function writeRouteConfigFile(definition: GatewayDefinition): void {
  const configName = sanitizeRoleId(definition.configName) || routeRuntimeParts(definition.id).configName;
  const configPath = routeConfigPath(configName);
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, JSON.stringify(routeConfigItem(definition), null, 2), "utf8");
}

function readRoleMessageConfigShared(roleId: string | undefined): Partial<GatewayDefinition> {
  const safeRoleId = sanitizeRoleId(roleId);
  if (!safeRoleId) return {};
  const configPath = roleMessageConfigPath(safeRoleId);
  if (!fs.existsSync(configPath)) return {};
  const parsed = JSON.parse(fs.readFileSync(configPath, "utf8")) as Record<string, unknown>;

  // New flat format: { notificationRules: [...], routeVariables: {} }
  if (Array.isArray(parsed.notificationRules)) {
    return { notificationRules: parsed.notificationRules as GatewayDefinition["notificationRules"] };
  }

  // Legacy per-configName format: pick the entry with the most rules as the shared source
  const configs: unknown[] = Array.isArray(parsed) ? parsed : Array.isArray(parsed.configs) ? parsed.configs as unknown[] : [];
  const best = configs
    .filter((e): e is Record<string, unknown> => !!e && typeof e === "object")
    .sort((a, b) => ((b.notificationRules as unknown[])?.length ?? 0) - ((a.notificationRules as unknown[])?.length ?? 0))[0];
  if (!best) return {};
  return { notificationRules: best.notificationRules as GatewayDefinition["notificationRules"] };
}

function readRoleMessageConfigItem(roleId: string | undefined, _configName: string): Partial<GatewayDefinition> {
  return readRoleMessageConfigShared(roleId);
}

function writeRoleMessageConfigFile(roleId: string, items: GatewayDefinition[]): void {
  const configPath = roleMessageConfigPath(roleId);
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  // All gateways sharing this persona use the same rules; pick the first with rules, or fallback to first item
  const source = items.find(item => Array.isArray(item.notificationRules) && item.notificationRules.length > 0) ?? items[0];
  fs.writeFileSync(configPath, JSON.stringify({
    notificationRules: source?.notificationRules ?? []
  }, null, 2), "utf8");
}

function ensureRoleMessageConfigFile(roleId: string): string {
  const configPath = roleMessageConfigPath(roleId);
  if (!fs.existsSync(configPath)) {
    const safeRoleId = sanitizeRoleId(roleId);
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, JSON.stringify({
      configs: [
        {
          configName: "default",
          routeVariables: {},
          notificationRules: []
        }
      ]
    }, null, 2), "utf8");
  }

  return configPath;
}

function openFileWithDefaultApp(filePath: string): void {
  const target = path.resolve(filePath);
  const platform = process.platform;
  let command: string;
  let args: string[];
  if (platform === "win32") {
    command = "cmd";
    args = ["/c", "explorer", target];
  } else if (platform === "darwin") {
    command = "open";
    args = [target];
  } else {
    command = "xdg-open";
    args = [target];
  }
  const child = spawn(command, args, { detached: true, stdio: "ignore" });
  child.unref();
}

function openConfigFilePayload(type: string | null, gatewayId: string | null, roleId: string | null): Record<string, unknown> {
  if (type === "manager") {
    ensureDataDirs();
    openFileWithDefaultApp(routeRoot);
    return { code: 0, data: { path: routeRoot } };
  }

  if (type === "role" || type === "persona") {
    const runtime = gatewayId ? runtimes.get(gatewayId) : null;
    const safeRoleId = sanitizeRoleId(roleId ?? runtime?.definition.agentRoleId);
    if (!safeRoleId) {
      throw new Error("请先选择一个路由人格，再打开 persona.md。");
    }
    const roleFileName = runtime?.definition.agentRoleFile ?? "persona.md";
    const rolePath = path.join(rolesRoot, safeRoleId, roleFileName);
    if (!fs.existsSync(rolePath)) {
      fs.mkdirSync(path.dirname(rolePath), { recursive: true });
      fs.writeFileSync(rolePath, "", "utf8");
    }
    openFileWithDefaultApp(rolePath);
    return { code: 0, data: { path: rolePath } };
  }

  if (type === "role-message-config") {
    const runtime = gatewayId ? runtimes.get(gatewayId) : null;
    const safeRoleId = sanitizeRoleId(roleId ?? runtime?.definition.agentRoleId);
    if (!safeRoleId) {
      throw new Error("请先选择一个路由人格，再打开 roleMessageConfig.json。");
    }
    const configPath = ensureRoleMessageConfigFile(safeRoleId);
    openFileWithDefaultApp(configPath);
    return { code: 0, data: { path: configPath } };
  }

  if (type !== "routes" && type !== "route-folder") {
    throw new Error(`Unsupported config file type: ${type || ""}`);
  }

  if (!gatewayId) {
    openFileWithDefaultApp(routeRoot);
    return { code: 0, data: { path: routeRoot } };
  }

  const runtime = runtimes.get(gatewayId);
  if (!runtime) {
    // fallback: open routeRoot if runtime not found (e.g. unsaved configName change)
    openFileWithDefaultApp(routeRoot);
    return { code: 0, data: { path: routeRoot } };
  }

  const configName = sanitizeRoleId(runtime.definition.configName) || routeRuntimeParts(runtime.definition.id).configName;
  const configPath = routeConfigPath(configName);
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  if (!fs.existsSync(configPath)) {
    writeRouteConfigFile(runtime.definition);
  }
  const targetPath = type === "route-folder" ? path.dirname(configPath) : configPath;
  openFileWithDefaultApp(targetPath);
  return { code: 0, data: { path: targetPath } };
}

function sanitizeRoleId(raw: string | undefined): string {
  const value = raw?.trim() ?? "";
  return /^[a-zA-Z0-9_-]+$/.test(value) ? value : "";
}

function loadRuntimes(): void {
  const config = readConfig();
  const seen = new Set<string>();

  for (const rawDefinition of config.gateways) {
    const definition = normalizeDefinition(rawDefinition);
    seen.add(definition.id);
    const existing = runtimes.get(definition.id);
    if (existing) {
      if (definitionFingerprint(existing.definition) !== definitionFingerprint(definition)) {
        existing.needsRestart = true;
      }
      existing.definition = definition;
      continue;
    }

    runtimes.set(definition.id, {
      definition,
      process: null,
      needsRestart: false,
      startedAt: null,
      stoppedAt: null,
      lastExit: null,
      log: []
    });
  }

  for (const id of [...runtimes.keys()]) {
    if (!seen.has(id)) {
      const runtime = runtimes.get(id);
      if (runtime?.process) {
        runtime.process.kill();
      }
      runtimes.delete(id);
    }
  }
}

function syncRunningGateways(): void {
  for (const runtime of runtimes.values()) {
    if (runtime.definition.enabled && runtime.process && runtime.needsRestart) {
      appendLog(runtime, "restarting because gateway config changed");
      runtime.process.kill();
      continue;
    }
    if (runtime.definition.enabled && !runtime.process) {
      startGateway(runtime.definition.id);
    }
    if (!runtime.definition.enabled && runtime.process) {
      stopGateway(runtime.definition.id);
    }
  }
}

function watchedRouteFiles(): string[] {
  ensureDataDirs();
  const files = new Set<string>();
  for (const entry of fs.readdirSync(routeRoot, { withFileTypes: true })) {
    if (!entry.isDirectory() || !sanitizeRoleId(entry.name)) {
      continue;
    }
    files.add(routeConfigPath(entry.name));
  }
  for (const entry of fs.readdirSync(rolesRoot, { withFileTypes: true })) {
    if (!entry.isDirectory() || !sanitizeRoleId(entry.name)) {
      continue;
    }
    const roleConfig = roleMessageConfigPath(entry.name);
    if (fs.existsSync(roleConfig)) {
      files.add(roleConfig);
    }
  }

  return [...files].sort((left, right) => left.localeCompare(right));
}

function configSnapshot(): string {
  return watchedRouteFiles().map((file) => {
    try {
      const stat = fs.statSync(file);
      return `${file}|${stat.mtimeMs}|${stat.size}`;
    } catch {
      return `${file}|missing`;
    }
  }).join("\n");
}

function reloadChangedConfig(reason: string): void {
  try {
    loadRuntimes();
    syncRunningGateways();
    console.log(`gateway-manager reloaded ${reason}`);
  } catch (error) {
    console.error(`Failed to reload gateway config ${reason}`, error);
  }
}

function startConfigWatcher(): NodeJS.Timeout {
  watchedConfigSnapshot = configSnapshot();
  return setInterval(() => {
    const nextSnapshot = configSnapshot();
    if (nextSnapshot === watchedConfigSnapshot) {
      return;
    }
    watchedConfigSnapshot = nextSnapshot;
    reloadChangedConfig("after config file change");
  }, 2000);
}

function appendLog(runtime: GatewayRuntime, line: string): void {
  const stamped = `[${new Date().toLocaleString("zh-CN", { hour12: false })}] ${line}`;
  runtime.log.push(stamped);
  if (runtime.log.length > 200) {
    runtime.log.splice(0, runtime.log.length - 200);
  }
  console.log(`[${runtime.definition.id}] ${line}`);
}

function childCommand(extraArgs: string[] = []): { command: string; args: string[]; shell: boolean } {
  const distEntry = path.join(rootDir, "dist", "index.js");
  if (fs.existsSync(distEntry)) {
    return { command: process.execPath, args: [distEntry, ...extraArgs], shell: false };
  }

  return { command: "npm", args: ["run", "dev", "--", ...extraArgs], shell: true };
}

function resolveWingetCopilot(): string | null {
  if (!process.env.LOCALAPPDATA) return null;
  const wingetBase = path.join(process.env.LOCALAPPDATA, "Microsoft", "WinGet", "Packages");
  try {
    for (const entry of fs.readdirSync(wingetBase)) {
      if (entry.startsWith("GitHub.Copilot")) {
        const exe = path.join(wingetBase, entry, "copilot.exe");
        if (fs.existsSync(exe)) return exe;
      }
    }
  } catch { /* skip */ }
  return null;
}

function envFor(definition: GatewayDefinition): NodeJS.ProcessEnv {
  const parts = routeRuntimeParts(definition.id);
  const configName = sanitizeRoleId(definition.configName) || parts.configName;
  const routeDataDir = path.relative(rootDir, path.join(routeRoot, configName)).replace(/\\/g, "/");
  const routeRolesDir = path.relative(rootDir, rolesRoot).replace(/\\/g, "/");
  const configuredAdapters = definition.messageAdapters ?? [definition.messageAdapterType ?? "napcat"];
  const disabledAdapters = new Set(definition.messageAdaptersDisabled ?? []);
  const activeAdapters = configuredAdapters.filter(t => !disabledAdapters.has(t));
  const runtimeAdapters = definition.messageInputsDisabled ? ["disabled" as MessageAdapterType] : activeAdapters;
  return {
    ...process.env,
    MESSAGE_ADAPTER_TYPE: runtimeAdapters[0] ?? "napcat",
    MESSAGE_ADAPTER_TYPES: JSON.stringify(runtimeAdapters),
    PIPELINE_PRESET: definition.pipelinePreset ?? "",
    PIPELINE: definition.pipeline ? JSON.stringify(definition.pipeline) : "",
    HEARTBEAT_INTERVAL_SECONDS: String(definition.heartbeatIntervalSeconds ?? 900),
    HEARTBEAT_MESSAGE: definition.heartbeatMessage ?? "定时心跳巡检：请检查最近消息和角色相关上下文。",
    NAPCAT_HTTP_URL: definition.napcatHttpUrl ?? process.env.NAPCAT_HTTP_URL ?? "http://127.0.0.1:3000",
    NAPCAT_ACCESS_TOKEN: definition.napcatAccessToken ?? process.env.NAPCAT_ACCESS_TOKEN ?? "",
    GATEWAY_PORT: String(definition.gatewayPort),
    WEBHOOK_PORT: String(definition.webhookPort ?? definition.gatewayPort),
    WEBHOOK_PATH: definition.webhookPath ?? "/webhook",
    CODEX_THREAD_NAME: definition.codexThreadName ?? definition.name ?? definition.id,
    CODEX_CWD: normalizeCodexCwd(definition.codexCwd) ?? process.env.CODEX_CWD ?? rootDir,
    COPILOT_CLI_BIN: definition.copilotCliBin?.trim() || process.env.COPILOT_CLI_BIN || resolveWingetCopilot() || (process.env.APPDATA ? path.join(process.env.APPDATA, "npm", "copilot.cmd") : "") || "copilot",
    COPILOT_CWD: definition.copilotCwd?.trim() || process.env.COPILOT_CWD || rootDir,
    ROLES_DIR: routeRolesDir,
    AGENT_ROLE_ID: sanitizeRoleId(definition.agentRoleId),
    AGENT_ROLE_FILE: definition.agentRoleFile ?? "persona.md",
    AGENT_ADAPTERS: Array.isArray(definition.agentAdapters) ? definition.agentAdapters.join(",") : process.env.AGENT_ADAPTERS ?? "",
    TARGET_GROUP_ID: "",
    BOT_NICKNAME: process.env.BOT_NICKNAME ?? "QQ小助手",
    ROUTE_VARIABLES: definition.routeVariables ? JSON.stringify(definition.routeVariables) : "",
    ROUTE_PROFILES: Array.isArray(definition.routeProfiles) ? JSON.stringify(definition.routeProfiles) : "",
    DATA_DIR: routeDataDir,
    GROUP_NOTIFICATION_TEMPLATE: definition.groupNotificationTemplate ?? "",
    GROUP_AT_NOTIFICATION_TEMPLATE: definition.groupAtNotificationTemplate ?? "",
    GROUP_DIRECT_REPLY_NOTIFICATION_TEMPLATE: definition.groupDirectReplyNotificationTemplate ?? definition.groupReplyNotificationTemplate ?? "",
    GROUP_INDIRECT_REPLY_NOTIFICATION_TEMPLATE: definition.groupIndirectReplyNotificationTemplate ?? definition.groupNicknameNotificationTemplate ?? "",
    PRIVATE_NOTIFICATION_TEMPLATE: definition.privateNotificationTemplate ?? "",
    VOICE_TRANSCRIPT_NOTIFICATION_TEMPLATE: definition.voiceTranscriptNotificationTemplate ?? "",
    NOTIFICATION_RULES: Array.isArray(definition.notificationRules) ? JSON.stringify(definition.notificationRules) : "",
  };
}

function startGateway(id: string): void {
  const runtime = runtimes.get(id);
  if (!runtime) {
    throw new Error(`Gateway not found: ${id}`);
  }
  if (!runtime.definition.enabled) {
    appendLog(runtime, "skip start because gateway is disabled");
    return;
  }
  if (runtime.process && !runtime.process.killed) {
    return;
  }

  const command = childCommand();
  const child = spawn(command.command, command.args, {
    cwd: rootDir,
    env: envFor(runtime.definition),
    shell: command.shell,
    windowsHide: true
  });

  runtime.log = [];
  runtime.process = child;
  runtime.needsRestart = false;
  runtime.startedAt = new Date().toISOString();
  runtime.stoppedAt = null;
  appendLog(runtime, `started pid=${child.pid ?? "unknown"} port=${runtime.definition.gatewayPort}`);

  child.stdout.on("data", (data) => {
    for (const line of data.toString().split(/\r?\n/).filter(Boolean)) {
      appendLog(runtime, line);
    }
  });

  child.stderr.on("data", (data) => {
    for (const line of data.toString().split(/\r?\n/).filter(Boolean)) {
      appendLog(runtime, `ERR ${line}`);
    }
  });

  child.on("exit", (code, signal) => {
    runtime.process = null;
    runtime.stoppedAt = new Date().toISOString();
    runtime.lastExit = {
      code,
      signal,
      at: runtime.stoppedAt
    };
    appendLog(runtime, `exited code=${code ?? ""} signal=${signal ?? ""}`);
    if (runtime.needsRestart && runtime.definition.enabled) {
      startGateway(runtime.definition.id);
    }
  });
}

function stopGateway(id: string): void {
  const runtime = runtimes.get(id);
  if (!runtime) {
    throw new Error(`Gateway not found: ${id}`);
  }
  if (!runtime.process) {
    return;
  }

  appendLog(runtime, "stopping");
  runtime.process.kill();
}

function stopAllGateways(): void {
  for (const runtime of runtimes.values()) {
    runtime.needsRestart = false;
    if (runtime.process) {
      appendLog(runtime, "stopping because manager is shutting down");
      runtime.process.kill();
    }
  }
}

function dataDirFor(definition: GatewayDefinition): string {
  const parts = routeRuntimeParts(definition.id);
  const configName = sanitizeRoleId(definition.configName) || parts.configName;
  return path.resolve(routeRoot, configName);
}

function roleInfoFor(definition: GatewayDefinition): Record<string, unknown> {
  const rolesDir = path.resolve(rootDir, definition.rolesDir ?? path.join("data", "roles"));
  const roleFileName = definition.agentRoleFile ?? "persona.md";
  const selectedRoleId = sanitizeRoleId(definition.agentRoleId);
  const options: Array<Record<string, string>> = [];

  if (fs.existsSync(rolesDir)) {
    for (const entry of fs.readdirSync(rolesDir, { withFileTypes: true })) {
      if (!entry.isDirectory() || !sanitizeRoleId(entry.name)) {
        continue;
      }

      const roleDir = path.join(rolesDir, entry.name);
      const markdownFiles = fs.readdirSync(roleDir)
        .filter((file) => file.toLowerCase().endsWith(".md"))
        .sort((left, right) => left.localeCompare(right));
      const preferredFile = markdownFiles.includes(roleFileName) ? roleFileName : markdownFiles[0] ?? roleFileName;
      const rolePath = path.join(roleDir, preferredFile);
      let roleContent = "";
      let roleError = "";
      try {
        roleContent = fs.readFileSync(rolePath, "utf8");
      } catch (error) {
        roleError = error instanceof Error ? error.message : String(error);
      }
      options.push({
        label: entry.name,
        value: entry.name,
        rolePath,
        roleContent,
        roleError,
        dataDir: roleDir
      });
    }
  }

  const selectedDir = selectedRoleId ? path.join(rolesDir, selectedRoleId) : "";
  const selectedRolePath = selectedDir ? path.join(selectedDir, roleFileName) : "";
  let selectedRoleContent = "";
  let selectedRoleError = "";
  if (selectedRolePath) {
    try {
      selectedRoleContent = fs.readFileSync(selectedRolePath, "utf8");
    } catch (error) {
      selectedRoleError = error instanceof Error ? error.message : String(error);
    }
  }

  return {
    rolesDir,
    selectedRoleId,
    selectedRolePath,
    selectedRoleContent,
    selectedRoleError,
    selectedRoleDataDir: selectedDir,
    options
  };
}

function readCodexState(definition: GatewayDefinition): Record<string, unknown> {
  const agentAdapters = definition.agentAdapters ?? ["codexDesktop"];
  const hasCodexAdapter = agentAdapters.some((adapter) => adapter === "codexDesktop" || adapter === "codexApp");
  if (agentAdapters.includes("copilotCli") && !agentAdapters.some((adapter) => adapter === "codexDesktop" || adapter === "codexApp")) {
    return readCopilotState(definition);
  }
  if (agentAdapters.includes("marvis") && !hasCodexAdapter) {
    return readMarvisState(definition);
  }
  if (agentAdapters.includes("astrbot") && !hasCodexAdapter) {
    return readAstrbotState(definition);
  }

  const statePath = path.join(dataDirFor(definition), "codex-state.json");
  ensureCodexStateBinding(definition, statePath);
  if (!fs.existsSync(statePath)) {
    return {
      statePath,
      bound: false,
      message: "未找到 codex-state.json，还没有绑定 Agent 会话。"
    };
  }

  try {
    const state = JSON.parse(fs.readFileSync(statePath, "utf8").replace(/^\uFEFF/, "")) as Record<string, unknown>;
    return {
      ...state,
      statePath,
      bound: Boolean(state.monitorThreadId)
    };
  } catch (error) {
    return {
      statePath,
      bound: false,
      lastNotificationError: error instanceof Error ? error.message : String(error),
      lastNotificationErrorAt: new Date().toISOString()
    };
  }
}

function readCopilotState(definition: GatewayDefinition): Record<string, unknown> {
  const statePath = path.join(dataDirFor(definition), "copilot-state.json");
  if (!fs.existsSync(statePath)) {
    return {
      agentAdapterType: "copilotCli",
      statePath,
      bound: true,
      monitorThreadId: "copilot-cli",
      monitorThreadName: "Copilot CLI",
      monitorThreadSource: process.env.COPILOT_CLI_BIN || "copilot",
      message: "Copilot CLI adapter is configured, but no prompt has been delivered yet."
    };
  }

  try {
    const state = JSON.parse(fs.readFileSync(statePath, "utf8").replace(/^\uFEFF/, "")) as Record<string, unknown>;
    return {
      ...state,
      statePath,
      bound: true
    };
  } catch (error) {
    return {
      agentAdapterType: "copilotCli",
      statePath,
      bound: false,
      lastNotificationError: error instanceof Error ? error.message : String(error),
      lastNotificationErrorAt: new Date().toISOString()
    };
  }
}

function readMarvisState(definition: GatewayDefinition): Record<string, unknown> {
  const statePath = path.join(dataDirFor(definition), "marvis-state.json");
  const marvisTarget = process.env.MARVIS_APP_ID || "Tencent.Marvis";
  if (!fs.existsSync(statePath)) {
    return {
      agentAdapterType: "marvis",
      statePath,
      bound: true,
      monitorThreadId: "marvis-desktop",
      monitorThreadName: "Marvis",
      monitorThreadSource: marvisTarget,
      message: "Marvis adapter is configured, but no prompt has been delivered yet."
    };
  }

  try {
    const state = JSON.parse(fs.readFileSync(statePath, "utf8").replace(/^\uFEFF/, "")) as Record<string, unknown>;
    return {
      ...state,
      statePath,
      bound: true
    };
  } catch (error) {
    return {
      agentAdapterType: "marvis",
      statePath,
      bound: false,
      lastNotificationError: error instanceof Error ? error.message : String(error),
      lastNotificationErrorAt: new Date().toISOString()
    };
  }
}

function readAstrbotState(definition: GatewayDefinition): Record<string, unknown> {
  const statePath = path.join(dataDirFor(definition), "astrbot-agent-state.json");
  const astrbotUrl = process.env.ASTRBOT_URL ?? "http://127.0.0.1:6185";
  if (!fs.existsSync(statePath)) {
    return {
      agentAdapterType: "astrbot",
      statePath,
      bound: true,
      monitorThreadId: "astrbot-agent",
      monitorThreadName: "AstrBot Agent",
      monitorThreadSource: astrbotUrl,
      message: "AstrBot adapter is configured, but no notification has been delivered yet."
    };
  }

  try {
    const state = JSON.parse(fs.readFileSync(statePath, "utf8").replace(/^\uFEFF/, "")) as Record<string, unknown>;
    return {
      ...state,
      statePath,
      bound: true
    };
  } catch (error) {
    return {
      agentAdapterType: "astrbot",
      statePath,
      bound: false,
      lastNotificationError: error instanceof Error ? error.message : String(error),
      lastNotificationErrorAt: new Date().toISOString()
    };
  }
}

function sessionIndexPath(): string {
  return path.join(os.homedir(), ".codex", "session_index.jsonl");
}

type SessionThreadRecord = {
  id: string;
  threadName: string;
  updatedAt: string;
};

function readLatestSessionThreads(indexPath: string): SessionThreadRecord[] {
  if (!fs.existsSync(indexPath)) {
    return [];
  }

  const latestById = new Map<string, SessionThreadRecord>();
  for (const line of fs.readFileSync(indexPath, "utf8").split(/\r?\n/)) {
    if (!line.trim()) {
      continue;
    }
    try {
      const parsed = JSON.parse(line) as { id?: unknown; thread_name?: unknown; updated_at?: unknown };
      if (typeof parsed.id !== "string" || typeof parsed.thread_name !== "string" || typeof parsed.updated_at !== "string") {
        continue;
      }
      const record = {
        id: parsed.id,
        threadName: parsed.thread_name,
        updatedAt: parsed.updated_at
      };
      const existing = latestById.get(record.id);
      if (!existing || Date.parse(record.updatedAt) > Date.parse(existing.updatedAt)) {
        latestById.set(record.id, record);
      }
    } catch {
      // Ignore malformed JSONL lines.
    }
  }

  return [...latestById.values()];
}

function ensureCodexStateBinding(definition: GatewayDefinition, statePath: string): void {
  const targetName = definition.codexThreadName ?? definition.name ?? definition.id;
  let existingState: Record<string, unknown> | null = null;
  const indexPath = sessionIndexPath();
  const sessionThreads = readLatestSessionThreads(indexPath);

  if (fs.existsSync(statePath)) {
    try {
      existingState = JSON.parse(fs.readFileSync(statePath, "utf8").replace(/^\uFEFF/, "")) as Record<string, unknown>;
      const currentRecord = typeof existingState.monitorThreadId === "string"
        ? sessionThreads.find((record) => record.id === existingState?.monitorThreadId)
        : null;
      const stateStillMatchesTarget = existingState.monitorThreadId
        && existingState.monitorThreadName === targetName
        && (!currentRecord || currentRecord.threadName === targetName);
      if (stateStillMatchesTarget) {
        return;
      }
    } catch {
      // Rewrite below if the state file is unreadable.
    }
  }

  if (sessionThreads.length === 0) {
    return;
  }

  let best: SessionThreadRecord | null = null;
  for (const record of sessionThreads) {
    if (record.threadName === targetName && (!best || Date.parse(record.updatedAt) > Date.parse(best.updatedAt))) {
      best = record;
    }
  }

  if (!best) {
    if (existingState?.monitorThreadId) {
      fs.mkdirSync(path.dirname(statePath), { recursive: true });
      fs.writeFileSync(statePath, JSON.stringify({
        ...existingState,
        monitorThreadId: undefined,
        monitorThreadUpdatedAt: undefined,
        monitorThreadName: targetName,
        monitorThreadSource: indexPath,
        lastAutoDiscoveryAt: new Date().toISOString(),
        lastNotificationError: `No Codex thread named "${targetName}" was found in ${indexPath}. Previous binding "${String(existingState.monitorThreadName ?? existingState.monitorThreadId)}" was cleared.`,
        lastNotificationErrorAt: new Date().toISOString()
      }, null, 2), "utf8");
    }
    return;
  }

  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  fs.writeFileSync(statePath, JSON.stringify({
    ...existingState,
    monitorThreadId: best.id,
    monitorThreadName: best.threadName,
    monitorThreadUpdatedAt: best.updatedAt,
    monitorThreadSource: indexPath,
    lastAutoDiscoveryAt: new Date().toISOString()
  }, null, 2), "utf8");
}

function readGatewayStatus(definition: GatewayDefinition): Record<string, unknown> {
  const statusPath = path.join(dataDirFor(definition), "gateway-status.json");
  if (!fs.existsSync(statusPath)) {
    return {
      statusPath,
      napcat: {
        connected: false
      }
    };
  }

  try {
    return {
      ...JSON.parse(fs.readFileSync(statusPath, "utf8")) as Record<string, unknown>,
      statusPath
    };
  } catch (error) {
    return {
      statusPath,
      napcat: {
        connected: false,
        error: error instanceof Error ? error.message : String(error)
      }
    };
  }
}

function runtimeStatus(runtime: GatewayRuntime): Record<string, unknown> {
  return {
    id: runtime.definition.id,
    name: runtime.definition.name,
    configName: sanitizeRoleId(runtime.definition.configName) || routeRuntimeParts(runtime.definition.id).configName,
    enabled: runtime.definition.enabled,
    messageAdapterType: runtime.definition.messageAdapterType ?? "napcat",
    messageAdapters: runtime.definition.messageAdapters ?? [runtime.definition.messageAdapterType ?? "napcat"],
    agentAdapters: runtime.definition.agentAdapters ?? ["codexDesktop"],
    pipelinePreset: runtime.definition.pipelinePreset,
    pipeline: runtime.definition.pipeline,
    gatewayPort: runtime.definition.gatewayPort,
    webhookPort: runtime.definition.webhookPort,
    webhookPath: runtime.definition.webhookPath,
    heartbeatIntervalSeconds: runtime.definition.heartbeatIntervalSeconds ?? 900,
    heartbeatMessage: runtime.definition.heartbeatMessage ?? "",
    napcatHttpUrl: runtime.definition.napcatHttpUrl ?? "http://127.0.0.1:3000",
    targetGroupId: runtime.definition.targetGroupId ?? "",
    routeVariables: runtime.definition.routeVariables,
    routeName: runtime.definition.routeName,
    routeProfiles: runtime.definition.routeProfiles ?? [],
    codexThreadName: runtime.definition.codexThreadName ?? runtime.definition.name ?? runtime.definition.id,
    rolesDir: runtime.definition.rolesDir,
    routesDir: runtime.definition.routesDir,
    agentRoleId: runtime.definition.agentRoleId,
    agentRoleFile: runtime.definition.agentRoleFile,
    roleInfo: roleInfoFor(runtime.definition),
    dataDir: runtime.definition.dataDir,
    groupNotificationTemplate: runtime.definition.groupNotificationTemplate,
    groupAtNotificationTemplate: runtime.definition.groupAtNotificationTemplate,
    groupDirectReplyNotificationTemplate: runtime.definition.groupDirectReplyNotificationTemplate,
    groupIndirectReplyNotificationTemplate: runtime.definition.groupIndirectReplyNotificationTemplate,
    groupReplyNotificationTemplate: runtime.definition.groupReplyNotificationTemplate,
    groupNicknameNotificationTemplate: runtime.definition.groupNicknameNotificationTemplate,
    privateNotificationTemplate: runtime.definition.privateNotificationTemplate,
    notificationRules: runtime.definition.notificationRules,
    roleNotificationRules: runtime.definition.roleNotificationRules,
    roleRouteNames: runtime.definition.roleRouteNames,
    running: Boolean(runtime.process),
    pid: runtime.process?.pid ?? null,
    startedAt: runtime.startedAt,
    stoppedAt: runtime.stoppedAt,
    lastExit: runtime.lastExit,
    gatewayStatus: readGatewayStatus(runtime.definition),
    codexState: readCodexState(runtime.definition),
    log: runtime.log.slice(-30)
  };
}

function jsonResponse(response: http.ServerResponse, statusCode: number, body: unknown): void {
  response.writeHead(statusCode, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(body, null, 2));
}

function readJsonBody<T>(request: http.IncomingMessage): Promise<T> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    request.on("end", () => {
      try {
        const text = Buffer.concat(chunks).toString("utf8");
        resolve((text ? JSON.parse(text) : {}) as T);
      } catch (error) {
        reject(error);
      }
    });
    request.on("error", reject);
  });
}

type ManualTriggerRequest = {
  triggerId?: string;
  triggerName?: string;
  message?: string;
  routeKind?: string;
  ruleId?: string;
};

function triggerGatewayManualRule(id: string, request: ManualTriggerRequest = {}): Promise<void> {
  const runtime = runtimes.get(id);
  if (!runtime) {
    throw new Error(`Gateway not found: ${id}`);
  }

  const triggerId = sanitizeRoleId(request.triggerId) || "manual";
  const triggerName = request.triggerName?.trim() || triggerId;
  const message = request.message?.trim() || triggerName;
  const routeKind = normalizeManualRouteKind(request.routeKind);
  const ruleId = sanitizeRoleId(request.ruleId) || triggerId;
  const command = childCommand([
    `--manual-trigger=${triggerId}`,
    `--manual-name=${encodeURIComponent(triggerName)}`,
    `--manual-message=${encodeURIComponent(message)}`,
    `--manual-route-kind=${routeKind}`,
    `--manual-rule=${ruleId}`
  ]);
  appendLog(runtime, `manual trigger requested: ${triggerName}`);
  return new Promise((resolve, reject) => {
    const child = spawn(command.command, command.args, {
      cwd: rootDir,
      env: envFor(runtime.definition),
      shell: command.shell,
      windowsHide: true
    });

    child.stdout.on("data", (data) => {
      for (const line of data.toString("utf8").split(/\r?\n/).filter(Boolean)) {
        appendLog(runtime, `manual trigger: ${line}`);
      }
    });
    child.stderr.on("data", (data) => {
      for (const line of data.toString("utf8").split(/\r?\n/).filter(Boolean)) {
        appendLog(runtime, `manual trigger error: ${line}`);
      }
    });
    child.on("error", reject);
    child.on("exit", (code, signal) => {
      if (code === 0) {
        appendLog(runtime, `manual trigger completed: ${triggerName}`);
        resolve();
        return;
      }
      reject(new Error(`manual trigger failed: code=${code ?? "null"} signal=${signal ?? "null"}`));
    });
  });
}

function normalizeManualRouteKind(value: unknown): ForwardRouteKind {
  return value === "heartbeat" ? "heartbeat" : "manual_trigger";
}

async function forwardFenneNoteRequest(
  body: unknown,
  targetUrl: string,
  token: string
): Promise<Record<string, unknown>> {
  const headers: Record<string, string> = {
    "content-type": "application/json; charset=utf-8",
    "user-agent": "RabiRoute"
  };
  if (token) {
    headers.authorization = `Bearer ${token}`;
  }
  const forwarded = await fetch(targetUrl, {
    method: "POST",
    headers,
    body: JSON.stringify(body ?? {})
  });
  const text = await forwarded.text();
  let data: unknown = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { raw: text };
  }
  return {
    ok: forwarded.ok,
    status: forwarded.status,
    target: targetUrl,
    response: data
  };
}

async function forwardPlaybackRequest(body: unknown): Promise<Record<string, unknown>> {
  return forwardFenneNoteRequest(body, fenneNotePlaybackUrl, fenneNotePlaybackToken);
}

async function forwardFenneNoteReply(body: unknown): Promise<Record<string, unknown>> {
  return forwardFenneNoteRequest(body, fenneNoteReplyUrl, fenneNoteReplyToken);
}

function standaloneGatewayPayload(): Record<string, unknown> {
  return {
    code: 0,
    data: {
      config: {
        gateways: [...runtimes.values()].map((runtime) => runtime.definition)
      },
      configFiles: {
        routeDir: path.relative(rootDir, routeRoot).replace(/\\/g, "/"),
        rolesDir: path.relative(rootDir, rolesRoot).replace(/\\/g, "/")
      },
      manager: [...runtimes.values()].map(runtimeStatus)
    }
  };
}

function networkOptionsPayload(): Record<string, unknown> {
  const adapters = {
    napcat: {
      httpServers: [],
      websocketClients: []
    },
    webhook: {
      listeners: []
    },
    heartbeat: {},
    disabled: {}
  };
  return {
    code: 0,
    data: {
      adapters,
      httpServers: [],
      websocketClients: []
    }
  };
}

function metaPayload(): Record<string, unknown> {
  let version = "0.1.0";
  try {
    const parsed = JSON.parse(fs.readFileSync(packageJsonPath, "utf8")) as { version?: unknown };
    if (typeof parsed.version === "string" && parsed.version.trim()) {
      version = parsed.version;
    }
  } catch {
    // Keep the baked fallback when package metadata is not readable.
  }
  return {
    version,
    githubUrl: "https://github.com/vb2250158/RabiRoute",
    managerPort
  };
}

function contentTypeFor(filePath: string): string {
  const extension = path.extname(filePath).toLowerCase();
  if (extension === ".html") return "text/html; charset=utf-8";
  if (extension === ".js" || extension === ".mjs") return "text/javascript; charset=utf-8";
  if (extension === ".css") return "text/css; charset=utf-8";
  if (extension === ".json") return "application/json; charset=utf-8";
  if (extension === ".png") return "image/png";
  if (extension === ".svg") return "image/svg+xml; charset=utf-8";
  if (extension === ".woff") return "font/woff";
  if (extension === ".woff2") return "font/woff2";
  return "application/octet-stream";
}

function staticWebuiResponse(pathname: string, response: http.ServerResponse): boolean {
  const indexPath = path.join(webuiDistPath, "index.html");
  if (!fs.existsSync(indexPath)) {
    return false;
  }

  const decoded = decodeURIComponent(pathname);
  const normalized = path.normalize(decoded === "/" ? "/index.html" : decoded).replace(/^[/\\]+/, "");
  const candidatePath = path.resolve(webuiDistPath, normalized);
  const relativeToDist = path.relative(webuiDistPath, candidatePath);
  if (relativeToDist.startsWith("..") || path.isAbsolute(relativeToDist)) {
    return false;
  }

  if (fs.existsSync(candidatePath) && fs.statSync(candidatePath).isFile()) {
    response.writeHead(200, { "content-type": contentTypeFor(candidatePath) });
    response.end(fs.readFileSync(candidatePath));
    return true;
  }

  if (path.extname(candidatePath)) {
    return false;
  }

  response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  response.end(fs.readFileSync(indexPath, "utf8"));
  return true;
}

function htmlResponse(pathname: string, response: http.ServerResponse): void {
  if (staticWebuiResponse(pathname, response)) {
    return;
  }

  response.writeHead(503, { "content-type": "text/plain; charset=utf-8" });
  response.end("RabiRoute WebGUI build is missing. Run `npm run webgui:build` or `npm run build`.");
}

function assetResponse(pathname: string, response: http.ServerResponse): boolean {
  const match = pathname.match(/^\/assets\/([a-zA-Z0-9_.-]+)$/);
  if (!match) {
    return false;
  }

  const assetPath = path.join(rootDir, "assets", match[1]);
  if (!fs.existsSync(assetPath)) {
    return false;
  }

  const extension = path.extname(assetPath).toLowerCase();
  const contentType = extension === ".png"
    ? "image/png"
    : extension === ".svg"
      ? "image/svg+xml; charset=utf-8"
      : "application/octet-stream";
  response.writeHead(200, { "content-type": contentType });
  response.end(fs.readFileSync(assetPath));
  return true;
}

function handleAction(pathname: string, response: http.ServerResponse): boolean {
  const match = pathname.match(/^\/gateways\/([^/]+)\/(start|stop|restart)$/);
  if (!match) {
    return false;
  }

  const [, id, action] = match;
  if (action === "start") {
    startGateway(id);
  } else if (action === "stop") {
    stopGateway(id);
  } else {
    stopGateway(id);
    setTimeout(() => startGateway(id), 1000);
  }

  jsonResponse(response, 200, { code: 0, message: `requested ${action}`, data: [...runtimes.values()].map(runtimeStatus) });
  return true;
}

function handleTriggerAction(request: http.IncomingMessage, pathname: string, response: http.ServerResponse): boolean {
  const match = pathname.match(/^\/gateways\/([^/]+)\/manual-trigger$/);
  if (!match) {
    return false;
  }

  const [, id] = match;
  void readJsonBody<ManualTriggerRequest>(request)
    .then((body) => triggerGatewayManualRule(decodeURIComponent(id), body))
    .then(() => {
      jsonResponse(response, 202, { code: 0, message: "manual trigger completed", data: [...runtimes.values()].map(runtimeStatus) });
    })
    .catch((error) => {
      jsonResponse(response, 500, { code: -1, message: error instanceof Error ? error.message : String(error) });
    });
  return true;
}

function startManager(): void {
  loadRuntimes();
  for (const runtime of runtimes.values()) {
    if (runtime.definition.enabled) {
      startGateway(runtime.definition.id);
    }
  }

  const server = http.createServer((request, response) => {
    try {
      const requestUrl = new URL(request.url ?? "/", `http://${request.headers.host ?? "127.0.0.1"}`);
      if (request.method === "GET" && assetResponse(requestUrl.pathname, response)) {
        return;
      }
      if (request.method === "POST" && handleAction(requestUrl.pathname, response)) {
        return;
      }
      if (request.method === "POST" && handleTriggerAction(request, requestUrl.pathname, response)) {
        return;
      }
      if (request.method === "GET" && requestUrl.pathname === "/gateways") {
        jsonResponse(response, 200, standaloneGatewayPayload());
        return;
      }
      if (request.method === "POST" && requestUrl.pathname === "/gateways") {
        void readJsonBody<GatewayConfigFile>(request)
          .then((body) => {
            writeConfig(body);
            loadRuntimes();
            syncRunningGateways();
            jsonResponse(response, 200, standaloneGatewayPayload());
          })
          .catch((error) => {
            jsonResponse(response, 400, { code: -1, message: error instanceof Error ? error.message : String(error) });
          });
        return;
      }
      if (request.method === "GET" && requestUrl.pathname === "/network-options") {
        jsonResponse(response, 200, networkOptionsPayload());
        return;
      }
      if (request.method === "GET" && requestUrl.pathname === "/manager-config") {
        jsonResponse(response, 200, {
          code: 0,
          routeDir: path.relative(rootDir, routeRoot).replace(/\\/g, "/"),
          rolesDir: path.relative(rootDir, rolesRoot).replace(/\\/g, "/")
        });
        return;
      }
      if (request.method === "POST" && requestUrl.pathname === "/manager-config") {
        void readJsonBody<ManagerConfig>(request)
          .then((body) => {
            const cfg = readManagerConfig();
            if (body.routeDir !== undefined) cfg.routeDir = body.routeDir || undefined;
            if (body.rolesDir !== undefined) cfg.rolesDir = body.rolesDir || undefined;
            writeManagerConfig(cfg);
            routeRoot = path.resolve(rootDir, cfg.routeDir ?? process.env.ROUTE_DIR ?? path.join("data", "route"));
            rolesRoot = path.resolve(rootDir, cfg.rolesDir ?? process.env.ROLES_DIR ?? path.join("data", "roles"));
            ensureDataDirs();
            jsonResponse(response, 200, { code: 0, routeDir: path.relative(rootDir, routeRoot).replace(/\\/g, "/"), rolesDir: path.relative(rootDir, rolesRoot).replace(/\\/g, "/") });
          })
          .catch((error) => {
            jsonResponse(response, 400, { code: -1, message: error instanceof Error ? error.message : String(error) });
          });
        return;
      }
      if (request.method === "GET" && requestUrl.pathname === "/meta") {
        jsonResponse(response, 200, metaPayload());
        return;
      }
      if (request.method === "POST" && (requestUrl.pathname === "/api/playback/request" || requestUrl.pathname === "/api/fennenote/playback")) {
        void readJsonBody<unknown>(request)
          .then((body) => forwardPlaybackRequest(body))
          .then((result) => {
            jsonResponse(response, result.ok ? 202 : 502, result);
          })
          .catch((error) => {
            jsonResponse(response, 502, { ok: false, error: error instanceof Error ? error.message : String(error), target: fenneNotePlaybackUrl });
        });
        return;
      }
      if (request.method === "POST" && requestUrl.pathname === "/api/fennenote/reply") {
        void readJsonBody<unknown>(request)
          .then((body) => forwardFenneNoteReply(body))
          .then((result) => {
            jsonResponse(response, result.ok ? 202 : 502, result);
          })
          .catch((error) => {
            jsonResponse(response, 502, { ok: false, error: error instanceof Error ? error.message : String(error), target: fenneNoteReplyUrl });
          });
        return;
      }
      if (request.method === "POST" && requestUrl.pathname === "/open-config-file") {
        jsonResponse(response, 200, openConfigFilePayload(
          requestUrl.searchParams.get("type"),
          requestUrl.searchParams.get("gatewayId"),
          requestUrl.searchParams.get("roleId")
        ));
        return;
      }
      if (request.method === "POST" && requestUrl.pathname === "/manager/start") {
        jsonResponse(response, 200, { code: 0, message: "manager is already running" });
        return;
      }
      if (request.method === "POST" && requestUrl.pathname === "/manager/shutdown") {
        jsonResponse(response, 200, { code: 0, message: "manager shutdown requested" });
        setTimeout(() => shutdownManager("api"), 20);
        return;
      }
      if (requestUrl.pathname === "/api/gateways") {
        jsonResponse(response, 200, [...runtimes.values()].map(runtimeStatus));
        return;
      }
      if (requestUrl.pathname === "/api/scan/agents" && request.method === "GET") {
        void (async () => {
          const { execFile } = await import("node:child_process");
          const { promisify } = await import("node:util");
          const execFileAsync = promisify(execFile);
          const whereCmd = process.platform === "win32" ? "where.exe" : "which";

          // thread names from copilot session-state workspace.yaml + codex session_index + existing configs
          const copilotSessionStateDir = path.join(os.homedir(), ".copilot", "session-state");
          type CopilotSessionEntry = { id: string; name: string; cwd?: string; userNamed?: boolean; updatedAt?: string };
          const copilotSessions: CopilotSessionEntry[] = [];
          try {
            for (const entry of fs.readdirSync(copilotSessionStateDir, { withFileTypes: true })) {
              if (!entry.isDirectory()) continue;
              const yamlPath = path.join(copilotSessionStateDir, entry.name, "workspace.yaml");
              if (!fs.existsSync(yamlPath)) continue;
              try {
                const yamlContent = fs.readFileSync(yamlPath, "utf8");
                const idMatch = yamlContent.match(/^id:\s*(.+)$/m);
                const nameMatch = yamlContent.match(/^name:\s*(.+)$/m);
                const cwdMatch = yamlContent.match(/^cwd:\s*(.+)$/m);
                const userNamedMatch = yamlContent.match(/^user_named:\s*(.+)$/m);
                const updatedMatch = yamlContent.match(/^updated_at:\s*(.+)$/m);
                if (idMatch && nameMatch) {
                  copilotSessions.push({
                    id: idMatch[1].trim(),
                    name: nameMatch[1].trim(),
                    cwd: cwdMatch?.[1].trim(),
                    userNamed: userNamedMatch?.[1].trim() === "true",
                    updatedAt: updatedMatch?.[1].trim()
                  });
                }
              } catch { /* skip malformed */ }
            }
          } catch { /* dir not found */ }
          const copilotSessionNames = [...new Set(copilotSessions.map(s => s.name))];

          const legacySessionThreads = readLatestSessionThreads(sessionIndexPath());
          const legacyThreadNames = [...new Set(legacySessionThreads.map(r => r.threadName))];
          const configThreadNames = [...runtimes.values()].map(r => r.definition.codexThreadName).filter(Boolean) as string[];
          const threadNames = [...new Set([...copilotSessionNames, ...legacyThreadNames, ...configThreadNames])];

          // cwd options from copilot sessions + existing configs + sibling dirs of rootDir
          const copilotCwds = [...new Set(copilotSessions.map(s => s.cwd).filter(Boolean) as string[])].filter(fs.existsSync);

          // cwd options: copilot sessions + existing configs + sibling dirs of rootDir
          const cwdSet = new Set<string>(copilotCwds);
          for (const rt of runtimes.values()) {
            if (rt.definition.codexCwd && fs.existsSync(rt.definition.codexCwd)) cwdSet.add(rt.definition.codexCwd);
            if (rt.definition.copilotCwd && fs.existsSync(rt.definition.copilotCwd)) cwdSet.add(rt.definition.copilotCwd);
          }
          try {
            const parentDir = path.dirname(rootDir);
            for (const entry of fs.readdirSync(parentDir, { withFileTypes: true })) {
              if (entry.isDirectory()) cwdSet.add(path.join(parentDir, entry.name));
            }
          } catch { /* skip */ }
          const cwdOptions = [...cwdSet];

          // copilot bin paths
          const copilotBins: string[] = [];
          for (const bin of ["copilot", "gh"]) {
            try {
              const { stdout } = await execFileAsync(whereCmd, [bin], { timeout: 2000 });
              copilotBins.push(...stdout.split(/\r?\n/).map(l => l.trim()).filter(Boolean));
            } catch { /* not found */ }
          }
          if (process.platform === "win32") {
            const localAppData = process.env.LOCALAPPDATA ?? "";
            const userProfile = process.env.USERPROFILE ?? "";
            // winget install GitHub.Copilot -> native .exe
            const wingetBase = path.join(localAppData, "Microsoft", "WinGet", "Packages");
            try {
              for (const entry of fs.readdirSync(wingetBase)) {
                if (entry.startsWith("GitHub.Copilot")) {
                  const exe = path.join(wingetBase, entry, "copilot.exe");
                  if (fs.existsSync(exe)) copilotBins.unshift(exe); // prefer winget
                }
              }
            } catch { /* skip */ }
            // VS Code extensions
            for (const root of [
              path.join(localAppData, "Programs", "Microsoft VS Code"),
              path.join(localAppData, "Programs", "Microsoft VS Code Insiders"),
              path.join(userProfile, ".vscode", "extensions"),
            ]) {
              try {
                const extDir = path.join(root, "resources", "app", "extensions");
                if (!fs.existsSync(extDir)) continue;
                for (const entry of fs.readdirSync(extDir)) {
                  if (!entry.startsWith("github.copilot-chat")) continue;
                  for (const binName of ["copilot.exe", "copilot", "cli/copilot.exe"]) {
                    const p = path.join(extDir, entry, "dist", binName);
                    if (fs.existsSync(p)) copilotBins.push(p);
                  }
                }
              } catch { /* skip */ }
            }
            // Visual Studio Copilot extension: %LOCALAPPDATA%\Microsoft\VisualStudio\*\Extensions\*\service\dist\copilot-agent*.exe
            try {
              const vsDir = path.join(localAppData, "Microsoft", "VisualStudio");
              if (fs.existsSync(vsDir)) {
                for (const vsVer of fs.readdirSync(vsDir, { withFileTypes: true })) {
                  if (!vsVer.isDirectory()) continue;
                  const extRoot = path.join(vsDir, vsVer.name, "Extensions");
                  if (!fs.existsSync(extRoot)) continue;
                  for (const extId of fs.readdirSync(extRoot, { withFileTypes: true })) {
                    if (!extId.isDirectory()) continue;
                    const distDir = path.join(extRoot, extId.name, "service", "dist");
                    if (!fs.existsSync(distDir)) continue;
                    for (const f of fs.readdirSync(distDir)) {
                      if (f.startsWith("copilot-agent") && f.endsWith(".exe")) {
                        copilotBins.push(path.join(distDir, f));
                      }
                    }
                  }
                }
              }
            } catch { /* skip */ }
          }

          // marvis app ids
          const marvisAppIds = ["Tencent.Marvis"];
          if (process.platform === "win32") {
            const appData = process.env.APPDATA ?? "";
            const localAppData = process.env.LOCALAPPDATA ?? "";
            for (const base of [appData, localAppData]) {
              try {
                for (const entry of fs.readdirSync(base, { withFileTypes: true })) {
                  if (entry.isDirectory() && entry.name.toLowerCase().includes("marvis")) {
                    marvisAppIds.push(entry.name);
                  }
                }
              } catch { /* skip */ }
            }
          }

          jsonResponse(response, 200, {
            threadNames,
            cwdOptions,
            copilotSessions: copilotSessions.map(s => ({ name: s.name, cwd: s.cwd, userNamed: s.userNamed })),
            copilotBins: [...new Set(copilotBins)],
            marvisAppIds: [...new Set(marvisAppIds)],
          });
        })();
        return;
      }
      if (requestUrl.pathname === "/api/agent/copilot-install" && request.method === "POST") {
        void (async () => {
          const { execFile } = await import("node:child_process");
          const { promisify } = await import("node:util");
          const execFileAsync = promisify(execFile);
          try {
            const { stdout, stderr } = await execFileAsync("npm", ["install", "-g", "@github/copilot"], {
              shell: true,
              timeout: 120_000,
              env: { ...process.env }
            });
            jsonResponse(response, 200, { ok: true, stdout: stdout.trim(), stderr: stderr.trim() });
          } catch (err: unknown) {
            const e = err as { message?: string; stdout?: string; stderr?: string };
            jsonResponse(response, 500, { ok: false, error: e.message, stderr: e.stderr });
          }
        })();
        return;
      }

      if (requestUrl.pathname === "/api/agent/copilot-login" && request.method === "POST") {
        void (async () => {
          const { spawn } = await import("node:child_process");
          try {
            // Find copilot bin
            const { execFile } = await import("node:child_process");
            const { promisify } = await import("node:util");
            const execFileAsync = promisify(execFile);
            let copilotBin = "copilot";
            try {
              const { stdout } = await execFileAsync(process.platform === "win32" ? "where.exe" : "which", ["copilot"], { timeout: 2000 });
              const first = stdout.split(/\r?\n/).map(l => l.trim()).filter(Boolean)[0];
              if (first) copilotBin = first;
            } catch { /* use default */ }

            // Spawn copilot login, capture device code from stdout
            const child = spawn(copilotBin, ["login"], {
              env: { ...process.env },
              shell: process.platform === "win32",
              windowsHide: true
            });

            let output = "";
            let code: string | null = null;
            let url: string | null = null;

            const codeTimer = setTimeout(() => {
              if (!code) {
                child.kill();
                jsonResponse(response, 408, { ok: false, error: "Timeout waiting for device code" });
              }
            }, 15_000);

            child.stdout?.on("data", (d: Buffer) => {
              output += d.toString();
              const codeMatch = output.match(/code\s+([A-Z0-9]{4}-[A-Z0-9]{4})/i);
              const urlMatch = output.match(/https:\/\/github\.com\/login\/device/);
              if (codeMatch && !code) {
                code = codeMatch[1];
                url = urlMatch ? "https://github.com/login/device" : null;
                clearTimeout(codeTimer);
                jsonResponse(response, 200, { ok: true, code, url, pid: child.pid });
              }
            });

            child.stderr?.on("data", (d: Buffer) => { output += d.toString(); });

            child.on("exit", (exitCode) => {
              clearTimeout(codeTimer);
              if (exitCode === 0 && !code) {
                jsonResponse(response, 200, { ok: true, done: true });
              } else if (exitCode !== 0 && !code) {
                jsonResponse(response, 500, { ok: false, error: output.trim() });
              }
            });
          } catch (err: unknown) {
            jsonResponse(response, 500, { ok: false, error: String(err) });
          }
        })();
        return;
      }

      if (requestUrl.pathname === "/api/agent/copilot-status" && request.method === "GET") {
        void (async () => {
          const { execFile } = await import("node:child_process");
          const { promisify } = await import("node:util");
          const execFileAsync = promisify(execFile);
          // Check if installed: prefer winget .exe, then where.exe
          let installed = false;
          let binPath = resolveWingetCopilot() ?? "";
          if (binPath) {
            installed = true;
          } else {
            const whereCmd = process.platform === "win32" ? "where.exe" : "which";
            try {
              const { stdout } = await execFileAsync(whereCmd, ["copilot"], { timeout: 2000 });
              const first = stdout.split(/\r?\n/).map(l => l.trim()).filter(Boolean)
                .find(p => !p.endsWith(".ps1")); // skip PowerShell wrappers
              if (first) { installed = true; binPath = first; }
            } catch { /* not installed */ }
          }
          // Check if logged in via ~/.copilot/config.json loggedInUsers
          let loggedIn = false;
          const copilotHome = process.env.COPILOT_HOME ?? path.join(os.homedir(), ".copilot");
          try {
            const configPath = path.join(copilotHome, "config.json");
            if (fs.existsSync(configPath)) {
              const raw = fs.readFileSync(configPath, "utf8").replace(/^\s*\/\/[^\n]*\n/gm, "");
              const cfg = JSON.parse(raw) as { loggedInUsers?: unknown[] };
              loggedIn = Array.isArray(cfg.loggedInUsers) && cfg.loggedInUsers.length > 0;
            }
          } catch { /* ignore */ }
          jsonResponse(response, 200, { installed, binPath, loggedIn, copilotHome });
        })();
        return;
      }

      if (requestUrl.pathname === "/reload") {
        loadRuntimes();
        syncRunningGateways();
        if (request.headers.accept?.includes("application/json")) {
          jsonResponse(response, 200, { ok: true, gateways: [...runtimes.values()].map(runtimeStatus) });
        } else {
          response.writeHead(303, { location: "/" });
          response.end();
        }
        return;
      }
      htmlResponse(requestUrl.pathname, response);
    } catch (error) {
      jsonResponse(response, 500, { error: error instanceof Error ? error.message : String(error) });
    }
  });

  server.listen(managerPort, "127.0.0.1", () => {
    console.log(`gateway-manager listening on http://127.0.0.1:${managerPort}`);
    console.log(`roles: ${rolesRoot}`);
    console.log(`route: ${routeRoot}`);
  });

  const configWatcher = startConfigWatcher();

  let shuttingDown = false;

  function shutdownManager(reason: string): void {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    console.log(`gateway-manager shutting down: ${reason}`);
    clearInterval(configWatcher);
    stopAllGateways();
    server.close(() => {
      process.exit(0);
    });
    setTimeout(() => process.exit(0), 2500).unref();
  }

  process.on("SIGINT", () => shutdownManager("SIGINT"));
  process.on("SIGTERM", () => shutdownManager("SIGTERM"));
}

startManager();
