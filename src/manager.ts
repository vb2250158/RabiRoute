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
  fenneNoteWebhookPort?: number;
  fenneNoteWebhookPath?: string;
  xiaoaiWebhookPort?: number;
  xiaoaiWebhookPath?: string;
  heartbeatIntervalSeconds?: number;
  heartbeatMessage?: string;
  napcatHttpUrl?: string;
  napcatWebuiUrl?: string;
  napcatAccessToken?: string;
  napcatInstances?: NapCatInstanceDefinition[];
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
  astrbotUrl?: string;
  astrbotUsername?: string;
  astrbotPassword?: string;
  astrbotProjectId?: string;
  astrbotSessionId?: string;
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

type NapCatInstanceDefinition = {
  id: string;
  name?: string;
  enabled?: boolean;
  gatewayPort: number;
  httpUrl: string;
  webuiUrl?: string;
  accessToken?: string;
  launchCommand?: string;
  workingDir?: string;
};

type AgentMaturity = "verified" | "experimental" | "stub";

type AgentScanSession = {
  id?: string;
  name: string;
  projectPath?: string;
  projectId?: string;
  updatedAt?: string;
  userNamed?: boolean;
};

type AgentScanProject = {
  id?: string;
  label: string;
  path: string;
  exists: boolean;
};

type AgentScanResult = {
  type: AgentAdapterType;
  label: string;
  maturity: AgentMaturity;
  installed: boolean;
  installCandidates?: Array<{ label: string; path?: string; url?: string }>;
  auth?: { required: boolean; loggedIn?: boolean; loginUrl?: string; message?: string };
  endpoints?: Array<{ label: string; url: string; healthy?: boolean }>;
  projects?: AgentScanProject[];
  sessions?: AgentScanSession[];
  plugins?: Array<{ id: string; name: string; installed: boolean; version?: string; healthy?: boolean }>;
  warnings?: string[];
};

type AdapterRequirement = {
  id: string;
  label: string;
  required?: boolean;
  ok?: boolean;
  detail?: string;
  actionLabel?: string;
  url?: string;
  path?: string;
};

type AdapterEndpoint = {
  label: string;
  url: string;
  healthy?: boolean;
};

type MessageAdapterScanResult = {
  type: Exclude<MessageAdapterType, "disabled">;
  label: string;
  maturity: AgentMaturity;
  installed: boolean;
  installCandidates?: Array<{ label: string; path?: string; url?: string }>;
  endpoints?: AdapterEndpoint[];
  requirements?: AdapterRequirement[];
  warnings?: string[];
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
    const configPath = adapterConfigPath(configName);
    if (!fs.existsSync(configPath)) {
      continue;
    }
    const raw = JSON.parse(fs.readFileSync(configPath, "utf8")) as Partial<GatewayDefinition>;
    // adapterConfig.json is primary; fall back to personaConfig.json only when notificationRules is absent.
    const personaConfig = (Array.isArray(raw.notificationRules) && raw.notificationRules.length > 0)
      ? {}
      : readRoleMessageConfigItem(raw.agentRoleId, configName);
    gateways.push({
      ...raw,
      ...personaConfig,
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
      const newConfigName = sanitizeRoleId(item.configName) || routeRuntimeParts(item.id).configName;
      if (oldConfigName !== newConfigName) {
        const oldConfigPath = adapterConfigPath(oldConfigName);
        if (fs.existsSync(oldConfigPath)) {
          try { fs.unlinkSync(oldConfigPath); } catch { /* non-fatal */ }
        }
      }
    }
    writeAdapterConfigFile(item);
  }
  for (const [roleId, items] of grouped.entries()) {
    if (roleId) {
      writePersonaConfigFile(roleId, items);
    }
  }
  return normalized;
}

function normalizeDefinition(definition: GatewayDefinition): GatewayDefinition {
  if (!definition.id || !sanitizeRoleId(definition.id)) {
    throw new Error(`Invalid gateway id: ${definition.id}`);
  }
  if (!Number.isInteger(definition.gatewayPort) || definition.gatewayPort <= 0) {
    throw new Error(`Invalid gateway port for ${definition.id}: ${definition.gatewayPort}`);
  }
  if (definition.webhookPort != null && (!Number.isInteger(definition.webhookPort) || definition.webhookPort <= 0)) {
    throw new Error(`Invalid webhook port for ${definition.id}: ${definition.webhookPort}`);
  }
  if (definition.fenneNoteWebhookPort != null && (!Number.isInteger(definition.fenneNoteWebhookPort) || definition.fenneNoteWebhookPort <= 0)) {
    throw new Error(`Invalid FenneNote webhook port for ${definition.id}: ${definition.fenneNoteWebhookPort}`);
  }
  if (definition.xiaoaiWebhookPort != null && (!Number.isInteger(definition.xiaoaiWebhookPort) || definition.xiaoaiWebhookPort <= 0)) {
    throw new Error(`Invalid XiaoAI webhook port for ${definition.id}: ${definition.xiaoaiWebhookPort}`);
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
  const napcatInstances = normalizeNapCatInstances(definition);
  const primaryNapcat = napcatInstances.find((item) => item.enabled) ?? napcatInstances[0];
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
    gatewayPort: primaryNapcat?.gatewayPort ?? definition.gatewayPort,
    napcatHttpUrl: primaryNapcat?.httpUrl ?? definition.napcatHttpUrl,
    napcatWebuiUrl: primaryNapcat?.webuiUrl ?? definition.napcatWebuiUrl,
    napcatAccessToken: primaryNapcat?.accessToken ?? definition.napcatAccessToken,
    napcatInstances,
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
    .filter((item): item is MessageAdapterType => item === "napcat" || item === "fennenote" || item === "xiaoai" || item === "webhook" || item === "heartbeat" || item === "disabled");
  const unique = [...new Set(adapters)].filter((item) => item !== "disabled");
  return unique.length > 0 ? unique : ["napcat"];
}

function sanitizeInstanceId(value: unknown, fallback: string): string {
  const raw = String(value || "").trim();
  return raw.replace(/[^\p{L}\p{N}_-]+/gu, "-").replace(/-+/g, "-").replace(/^[-_]+|[-_]+$/g, "") || fallback;
}

function normalizeNapCatInstances(definition: GatewayDefinition): NapCatInstanceDefinition[] {
  const raw = Array.isArray(definition.napcatInstances) ? definition.napcatInstances : [];
  const source = raw.length > 0
    ? raw
    : [{
        id: "default",
        name: "默认 NapCat",
        enabled: true,
        gatewayPort: definition.gatewayPort,
        httpUrl: definition.napcatHttpUrl ?? "http://127.0.0.1:3000",
        webuiUrl: definition.napcatWebuiUrl ?? "http://127.0.0.1:6099/webui",
        accessToken: definition.napcatAccessToken
      }];

  const used = new Set<string>();
  return source.map((item, index) => {
    const baseId = sanitizeInstanceId(item.id, `napcat-${index + 1}`);
    let id = baseId;
    let suffix = 2;
    while (used.has(id)) {
      id = `${baseId}-${suffix++}`;
    }
    used.add(id);
    const gatewayPort = Number(item.gatewayPort || definition.gatewayPort || 8790 + index);
    if (!Number.isInteger(gatewayPort) || gatewayPort <= 0) {
      throw new Error(`Invalid NapCat instance port for ${definition.id}/${id}: ${gatewayPort}`);
    }
    return {
      id,
      name: item.name?.trim() || id,
      enabled: item.enabled !== false,
      gatewayPort,
      httpUrl: item.httpUrl?.trim() || definition.napcatHttpUrl || "http://127.0.0.1:3000",
      webuiUrl: item.webuiUrl?.trim() || definition.napcatWebuiUrl || "http://127.0.0.1:6099/webui",
      accessToken: item.accessToken ?? definition.napcatAccessToken ?? "",
      launchCommand: item.launchCommand?.trim() || undefined,
      workingDir: item.workingDir?.trim() || undefined
    };
  });
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

function personaConfigPath(roleId: string): string {
  const safeRoleId = sanitizeRoleId(roleId);
  if (!safeRoleId) {
    throw new Error("Missing role folder name");
  }
  return path.join(rolesRoot, safeRoleId, "personaConfig.json");
}

function adapterConfigPath(configName: string): string {
  const safeConfigName = sanitizeRoleId(configName);
  if (!safeConfigName) {
    throw new Error("Missing route folder name");
  }
  return path.join(routeRoot, safeConfigName, "adapterConfig.json");
}

function adapterConfigItem(definition: GatewayDefinition): Record<string, unknown> {
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
    fenneNoteWebhookPort: definition.fenneNoteWebhookPort,
    fenneNoteWebhookPath: definition.fenneNoteWebhookPath,
    xiaoaiWebhookPort: definition.xiaoaiWebhookPort,
    xiaoaiWebhookPath: definition.xiaoaiWebhookPath,
    napcatHttpUrl: definition.napcatHttpUrl,
    napcatWebuiUrl: definition.napcatWebuiUrl,
    napcatAccessToken: definition.napcatAccessToken,
    napcatInstances: definition.napcatInstances,
    heartbeatIntervalSeconds: definition.heartbeatIntervalSeconds,
    heartbeatMessage: definition.heartbeatMessage,
    codexThreadName: definition.codexThreadName,
    codexCwd: definition.codexCwd,
    copilotCwd: definition.copilotCwd,
    copilotCliBin: definition.copilotCliBin,
    marvisAppId: definition.marvisAppId,
    astrbotUrl: definition.astrbotUrl,
    astrbotUsername: definition.astrbotUsername,
    astrbotPassword: definition.astrbotPassword,
    astrbotProjectId: definition.astrbotProjectId,
    astrbotSessionId: definition.astrbotSessionId,
    rolesDir: definition.rolesDir,
    agentRoleId: definition.agentRoleId,
    agentRoleFile: definition.agentRoleFile,
    agentAdapters: definition.agentAdapters,
    routeVariables: definition.routeVariables
  };
}

function writeAdapterConfigFile(definition: GatewayDefinition): void {
  const configName = sanitizeRoleId(definition.configName) || routeRuntimeParts(definition.id).configName;
  const configPath = adapterConfigPath(configName);
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, JSON.stringify(adapterConfigItem(definition), null, 2), "utf8");
}

function readRoleMessageConfigShared(roleId: string | undefined): Partial<GatewayDefinition> {
  const safeRoleId = sanitizeRoleId(roleId);
  if (!safeRoleId) return {};
  const configPath = personaConfigPath(safeRoleId);
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

function writePersonaConfigFile(roleId: string, items: GatewayDefinition[]): void {
  const configPath = personaConfigPath(roleId);
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  // All gateways sharing this persona use the same rules; pick the first with rules, or fallback to first item
  const source = items.find(item => Array.isArray(item.notificationRules) && item.notificationRules.length > 0) ?? items[0];
  fs.writeFileSync(configPath, JSON.stringify({
    notificationRules: source?.notificationRules ?? []
  }, null, 2), "utf8");
}

function ensurePersonaConfigFile(roleId: string): string {
  const configPath = personaConfigPath(roleId);
  if (!fs.existsSync(configPath)) {
    const safeRoleId = sanitizeRoleId(roleId);
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, JSON.stringify({
      notificationRules: []
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

function spawnDetached(command: string, args: string[]): void {
  const child = spawn(command, args, {
    detached: true,
    stdio: "ignore",
    windowsHide: true
  });
  child.unref();
}

function openUrlWithDefaultApp(url: string): void {
  if (process.platform === "win32") {
    spawnDetached("cmd", ["/c", "start", "", url]);
    return;
  }
  if (process.platform === "darwin") {
    spawnDetached("open", [url]);
    return;
  }
  spawnDetached("xdg-open", [url]);
}

function openMarvisPayload(request: MarvisOpenRequest): Record<string, unknown> {
  const appId = request.appId?.trim() || process.env.MARVIS_APP_ID?.trim() || "Tencent.Marvis";
  const url = request.url?.trim() || process.env.MARVIS_URL?.trim() || "https://marvis.qq.com/";
  if (process.platform === "win32") {
    spawnDetached("explorer.exe", [`shell:AppsFolder\\${appId}`]);
    return { ok: true, mode: "desktop", target: appId, message: `已尝试打开 Marvis 应用：${appId}` };
  }

  openUrlWithDefaultApp(url);
  return { ok: true, mode: "url", target: url, message: `已尝试打开 Marvis 页面：${url}` };
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
      throw new Error("请先选择一个路由人格，再打开 personaConfig.json。");
    }
    const configPath = ensurePersonaConfigFile(safeRoleId);
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
  const configPath = adapterConfigPath(configName);
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  if (!fs.existsSync(configPath)) {
    writeAdapterConfigFile(runtime.definition);
  }
  const targetPath = type === "route-folder" ? path.dirname(configPath) : configPath;
  openFileWithDefaultApp(targetPath);
  return { code: 0, data: { path: targetPath } };
}

function sanitizeRoleId(raw: string | undefined): string {
  const value = raw?.trim() ?? "";
  return /^[\p{L}\p{N}_-]+$/u.test(value) ? value : "";
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
    files.add(adapterConfigPath(entry.name));
  }
  for (const entry of fs.readdirSync(rolesRoot, { withFileTypes: true })) {
    if (!entry.isDirectory() || !sanitizeRoleId(entry.name)) {
      continue;
    }
    const roleConfig = personaConfigPath(entry.name);
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
    NAPCAT_WEBUI_URL: definition.napcatWebuiUrl ?? process.env.NAPCAT_WEBUI_URL ?? "http://127.0.0.1:6099/webui",
    NAPCAT_ACCESS_TOKEN: definition.napcatAccessToken ?? process.env.NAPCAT_ACCESS_TOKEN ?? "",
    NAPCAT_INSTANCES: JSON.stringify(definition.napcatInstances ?? normalizeNapCatInstances(definition)),
    GATEWAY_PORT: String(definition.gatewayPort),
    WEBHOOK_PORT: String(definition.webhookPort ?? definition.gatewayPort),
    WEBHOOK_PATH: definition.webhookPath ?? "/webhook",
    FENNENOTE_WEBHOOK_PORT: String(definition.fenneNoteWebhookPort ?? definition.webhookPort ?? definition.gatewayPort),
    FENNENOTE_WEBHOOK_PATH: definition.fenneNoteWebhookPath ?? "/fennenote",
    FENNOTE_WEBHOOK_PORT: String(definition.fenneNoteWebhookPort ?? definition.webhookPort ?? definition.gatewayPort),
    FENNOTE_WEBHOOK_PATH: definition.fenneNoteWebhookPath ?? "/fennenote",
    XIAOAI_WEBHOOK_PORT: String(definition.xiaoaiWebhookPort ?? definition.webhookPort ?? definition.gatewayPort),
    XIAOAI_WEBHOOK_PATH: definition.xiaoaiWebhookPath ?? "/xiaoai",
    CODEX_THREAD_NAME: definition.codexThreadName ?? definition.name ?? definition.id,
    CODEX_CWD: normalizeCodexCwd(definition.codexCwd) ?? process.env.CODEX_CWD ?? rootDir,
    COPILOT_CLI_BIN: definition.copilotCliBin?.trim() || process.env.COPILOT_CLI_BIN || resolveWingetCopilot() || (process.env.APPDATA ? path.join(process.env.APPDATA, "npm", "copilot.cmd") : "") || "copilot",
    COPILOT_CWD: definition.copilotCwd?.trim() || process.env.COPILOT_CWD || rootDir,
    MARVIS_APP_ID: definition.marvisAppId?.trim() || process.env.MARVIS_APP_ID || "Tencent.Marvis",
    ASTRBOT_URL: definition.astrbotUrl?.trim() || process.env.ASTRBOT_URL || "http://127.0.0.1:6185",
    ASTRBOT_USERNAME: definition.astrbotUsername?.trim() || process.env.ASTRBOT_USERNAME || "",
    ASTRBOT_PASSWORD: definition.astrbotPassword?.trim() || process.env.ASTRBOT_PASSWORD || "",
    ASTRBOT_PROJECT_ID: definition.astrbotProjectId?.trim() || process.env.ASTRBOT_PROJECT_ID || "",
    ASTRBOT_SESSION_ID: definition.astrbotSessionId?.trim() || process.env.ASTRBOT_SESSION_ID || "",
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

  return readCodexBindingState(definition);
}

function readAgentStates(definition: GatewayDefinition): Record<string, unknown> {
  const adapters = definition.agentAdapters ?? ["codexDesktop"];
  const states: Record<string, unknown> = {};
  for (const adapter of adapters) {
    if (adapter === "codexDesktop" || adapter === "codexApp") {
      states[adapter] = {
        ...readCodexBindingState(definition),
        agentAdapterType: adapter
      };
    } else if (adapter === "copilotCli") {
      states[adapter] = readCopilotState(definition);
    } else if (adapter === "marvis") {
      states[adapter] = readMarvisState(definition);
    } else if (adapter === "astrbot") {
      states[adapter] = readAstrbotState(definition);
    }
  }
  return states;
}

function readCodexBindingState(definition: GatewayDefinition): Record<string, unknown> {
  const statePath = path.join(dataDirFor(definition), "codex-state.json");
  ensureCodexStateBinding(definition, statePath);
  if (!fs.existsSync(statePath)) {
    return {
      agentAdapterType: "codexDesktop",
      statePath,
      bound: false,
      message: "未找到 codex-state.json，还没有绑定 Agent 会话。"
    };
  }

  try {
    const state = JSON.parse(fs.readFileSync(statePath, "utf8").replace(/^\uFEFF/, "")) as Record<string, unknown>;
    return {
      ...state,
      agentAdapterType: String(state.agentAdapterType || "codexDesktop"),
      statePath,
      bound: Boolean(state.monitorThreadId)
    };
  } catch (error) {
    return {
      agentAdapterType: "codexDesktop",
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
      bound: false,
      monitorThreadName: definition.codexThreadName || "Copilot CLI",
      monitorThreadSource: definition.copilotCliBin || process.env.COPILOT_CLI_BIN || "copilot",
      message: "Copilot CLI 已配置，但还没有成功投递记录；需要完成同一会话连续两次注入烟测后才能视为已验证。"
    };
  }

  try {
    const state = JSON.parse(fs.readFileSync(statePath, "utf8").replace(/^\uFEFF/, "")) as Record<string, unknown>;
    return {
      ...state,
      statePath,
      bound: Boolean(state.lastNotificationAt && !state.lastNotificationError)
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
  const marvisTarget = definition.marvisAppId?.trim() || process.env.MARVIS_APP_ID || "Tencent.Marvis";
  if (!fs.existsSync(statePath)) {
    return {
      agentAdapterType: "marvis",
      statePath,
      bound: false,
      handoffOnly: true,
      monitorThreadName: "Marvis",
      monitorThreadSource: marvisTarget,
      message: "Marvis 当前是打开桌面端并复制 prompt 的人工接力，不能证明线程已绑定。"
    };
  }

  try {
    const state = JSON.parse(fs.readFileSync(statePath, "utf8").replace(/^\uFEFF/, "")) as Record<string, unknown>;
    return {
      ...state,
      statePath,
      bound: false,
      handoffOnly: true
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
  const astrbotUrl = definition.astrbotUrl?.trim() || process.env.ASTRBOT_URL || "http://127.0.0.1:6185";
  if (!fs.existsSync(statePath)) {
    return {
      agentAdapterType: "astrbot",
      statePath,
      bound: false,
      monitorThreadName: "AstrBot Agent",
      monitorThreadSource: astrbotUrl,
      message: "AstrBot 已配置，但还没有成功投递记录；插件 API 尚未提供可选会话。"
    };
  }

  try {
    const state = JSON.parse(fs.readFileSync(statePath, "utf8").replace(/^\uFEFF/, "")) as Record<string, unknown>;
    const sessionId = definition.astrbotSessionId?.trim();
    const hasSuccessfulDelivery = Boolean(state.lastNotificationAt && !state.lastNotificationError);
    return {
      ...state,
      statePath,
      bound: hasSuccessfulDelivery,
      monitorThreadId: state.monitorThreadId ?? (hasSuccessfulDelivery ? (sessionId ? `astrbot-chatui:${sessionId}` : "astrbot-plugin:rabiroute_agent") : undefined),
      monitorThreadName: state.monitorThreadName ?? (sessionId ? `AstrBot ChatUI ${sessionId}` : "AstrBot rabiroute_agent"),
      monitorThreadSource: state.monitorThreadSource ?? astrbotUrl
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

function normalizeComparablePath(value: string | undefined): string {
  if (!value) return "";
  const normalized = path.resolve(value).replace(/\\/g, "/").replace(/\/+$/, "");
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function projectOptionsFromPaths(paths: string[]): Array<{ label: string; path: string; exists: boolean }> {
  const byNormalized = new Map<string, { label: string; path: string; exists: boolean }>();
  for (const item of paths) {
    const trimmed = item.trim();
    if (!trimmed) continue;
    const normalized = normalizeComparablePath(trimmed);
    if (!normalized || byNormalized.has(normalized)) continue;
    byNormalized.set(normalized, {
      label: path.basename(trimmed) || trimmed,
      path: trimmed,
      exists: fs.existsSync(trimmed)
    });
  }
  return [...byNormalized.values()];
}

async function checkHttpEndpoint(url: string, timeoutMs = 1200): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      method: "GET",
      signal: controller.signal
    });
    return response.status < 500;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

function runtimeAdapterTypes(definition: GatewayDefinition): MessageAdapterType[] {
  if (definition.messageInputsDisabled) return ["disabled"];
  return definition.messageAdapters ?? [definition.messageAdapterType ?? "napcat"];
}

function adapterRuntimes(type: MessageAdapterType): GatewayRuntime[] {
  return [...runtimes.values()].filter((runtime) => runtimeAdapterTypes(runtime.definition).includes(type));
}

function routeCallbackEndpoint(runtime: GatewayRuntime, type: MessageAdapterType): AdapterEndpoint | null {
  if (type !== "webhook" && type !== "fennenote" && type !== "xiaoai") return null;
  const definition = runtime.definition;
  const status = readGatewayStatus(definition) as Record<string, any>;
  const callback = status.httpCallbacks?.[type];
  const port = type === "fennenote"
    ? definition.fenneNoteWebhookPort ?? definition.webhookPort ?? definition.gatewayPort
    : type === "xiaoai"
      ? definition.xiaoaiWebhookPort ?? definition.webhookPort ?? definition.gatewayPort
      : definition.webhookPort ?? definition.gatewayPort;
  const pathValue = type === "fennenote"
    ? definition.fenneNoteWebhookPath ?? "/fennenote"
    : type === "xiaoai"
      ? definition.xiaoaiWebhookPath ?? "/xiaoai"
      : definition.webhookPath ?? "/webhook";
  const normalized = pathValue.startsWith("/") ? pathValue : `/${pathValue}`;
  const url = String(callback?.url || `http://127.0.0.1:${port}${normalized}`);
  return {
    label: `${sanitizeRoleId(definition.configName) || routeRuntimeParts(definition.id).configName} 回调入口`,
    url,
    healthy: Boolean(runtime.process && callback)
  };
}

function routeHasRecentMessages(runtime: GatewayRuntime, type: MessageAdapterType): boolean {
  try {
    const files = readMessageFiles(runtime.definition) as Record<string, { entries?: unknown[] }>;
    return Boolean(files[type]?.entries?.length);
  } catch {
    return false;
  }
}

async function messageAdapterScanPayload(): Promise<Record<Exclude<MessageAdapterType, "disabled">, MessageAdapterScanResult>> {
  const napcatProcesses = await detectNapcatProcesses();
  const napcatRuntimes = adapterRuntimes("napcat");
  const napcatInstances = napcatRuntimes.flatMap((runtime) => runtime.definition.napcatInstances ?? normalizeNapCatInstances(runtime.definition));
  const napcatWebuiEndpointRows = await Promise.all(napcatInstances.map(async (instance) => ({
    label: `${instance.name || instance.id} WebUI`,
    url: instance.webuiUrl || "http://127.0.0.1:6099/webui",
    healthy: await checkHttpEndpoint(instance.webuiUrl || "http://127.0.0.1:6099/webui", 1200)
  })));
  const napcatWebuiEndpoints = [...napcatWebuiEndpointRows.reduce((byUrl, endpoint) => {
    const existing = byUrl.get(endpoint.url);
    if (!existing || endpoint.healthy) byUrl.set(endpoint.url, endpoint);
    return byUrl;
  }, new Map<string, AdapterEndpoint>()).values()];
  const napcatWebuiToken = readNapcatWebuiToken(napcatWebuiEndpoints[0]?.url || "http://127.0.0.1:6099/webui");
  const napcatConnected = napcatRuntimes.some((runtime) => {
    const status = readGatewayStatus(runtime.definition) as Record<string, any>;
    const instances = status.napcatInstances;
    if (instances && typeof instances === "object") {
      return Object.values(instances).some((item: any) => Boolean(item?.connected || item?.botUserId));
    }
    return Boolean(status.napcat?.connected || status.napcat?.botUserId);
  });

  const fenneRuntimes = adapterRuntimes("fennenote");
  const fenneCallbacks = fenneRuntimes.map((runtime) => routeCallbackEndpoint(runtime, "fennenote")).filter(Boolean) as AdapterEndpoint[];
  const fenneCallbackReady = fenneCallbacks.some((endpoint) => endpoint.healthy);
  const fennePlaybackHealthy = await checkHttpEndpoint(fenneNotePlaybackUrl, 1200);
  const fenneRecent = fenneRuntimes.some((runtime) => routeHasRecentMessages(runtime, "fennenote"));

  const xiaoaiRuntimes = adapterRuntimes("xiaoai");
  const xiaoaiCallbacks = xiaoaiRuntimes.map((runtime) => routeCallbackEndpoint(runtime, "xiaoai")).filter(Boolean) as AdapterEndpoint[];
  const xiaoaiCallbackReady = xiaoaiCallbacks.some((endpoint) => endpoint.healthy);
  const xiaoaiBridgeDir = path.join(rootDir, "plugin-adapters", "xiaoai-rabiroute");
  const xiaoaiBridgePackage = path.join(xiaoaiBridgeDir, "package.json");
  const xiaoaiBridgeUrl = process.env.XIAOAI_BRIDGE_URL
    || `http://127.0.0.1:${process.env.XIAOAI_BRIDGE_PORT || "8798"}`;
  const xiaoaiBridgeHealthUrl = `${xiaoaiBridgeUrl.replace(/\/+$/, "")}/health`;
  const xiaoaiBridgeHealthy = await checkHttpEndpoint(xiaoaiBridgeHealthUrl, 1200);
  const xiaoaiRecent = xiaoaiRuntimes.some((runtime) => routeHasRecentMessages(runtime, "xiaoai"));
  const xiaoaiLocalConfig = path.join(xiaoaiBridgeDir, "xiaoai-local.config.json");
  const openXiaoAiDir = path.join(xiaoaiBridgeDir, "vendor", "open-xiaoai");

  const webhookRuntimes = adapterRuntimes("webhook");
  const webhookCallbacks = webhookRuntimes.map((runtime) => routeCallbackEndpoint(runtime, "webhook")).filter(Boolean) as AdapterEndpoint[];
  const webhookCallbackReady = webhookCallbacks.some((endpoint) => endpoint.healthy);

  return {
    napcat: {
      type: "napcat",
      label: "NapCat / OneBot",
      maturity: "verified",
      installed: napcatProcesses.length > 0 || napcatWebuiEndpoints.some((endpoint) => endpoint.healthy),
      installCandidates: [
        { label: "NapCatQQ Shell / Windows 安装文档", url: "https://www.napcat.wiki/guide/boot/Shell" },
        { label: "NapCatQQ Releases", url: "https://github.com/NapNeko/NapCatQQ/releases" }
      ],
      endpoints: napcatWebuiEndpoints,
      requirements: [
        { id: "process", label: "NapCat 或 QQNT 后台进程", required: true, ok: napcatProcesses.length > 0, detail: napcatProcesses.length ? napcatProcesses.slice(0, 3).map(item => `${item.name}(${item.pid})`).join(", ") : "未发现本机 NapCat/QQNT 进程。" },
        { id: "route", label: "RabiRoute NapCat WS 入口", required: true, ok: napcatRuntimes.some((runtime) => Boolean(runtime.process)), detail: napcatRuntimes.length ? "已配置 NapCat 消息端。" : "还没有路由启用 NapCat。" },
        { id: "login", label: "OneBot 登录资料", required: true, ok: napcatConnected, detail: napcatConnected ? "已读取到连接或登录资料。" : "尚未看到 WS 连接或 get_login_info 成功。" },
        { id: "webui", label: "NapCat WebUI 可访问", required: false, ok: napcatWebuiEndpoints.some((endpoint) => endpoint.healthy), detail: "用于配置 WebSocket Client、HTTP Server 和多账号实例。" },
        { id: "webui-token", label: "NapCat WebUI 登录 Token", required: true, ok: napcatWebuiToken.found, detail: napcatWebuiToken.found ? `已从 ${napcatWebuiToken.configPath} 读取到 ${napcatWebuiToken.tokenLength} 位登录密钥。` : napcatWebuiToken.message }
      ],
      warnings: [
        ...(napcatConnected ? [] : ["NapCat 要在 WebUI 中把 WebSocket Client 连到 RabiRoute 对应 WS 地址。"]),
        "多 QQ 需要多个 NapCat instance；每个实例单独配置 WS 端口、HTTP 地址、WebUI 和启动命令。"
      ]
    },
    heartbeat: {
      type: "heartbeat",
      label: "定时触发",
      maturity: "verified",
      installed: true,
      requirements: [
        { id: "route", label: "RabiRoute 内部定时器", required: true, ok: true, detail: "无需额外安装。" },
        { id: "agent", label: "Agent 端可接收消息", required: true, ok: undefined, detail: "保存后用“立即触发”或日志页验证投递。" }
      ],
      warnings: ["定时触发不会证明外部平台可用，只能验证路由到 Agent 的链路。"]
    },
    fennenote: {
      type: "fennenote",
      label: "FenneNote / 芬妮笔记",
      maturity: "experimental",
      installed: fenneCallbackReady || fennePlaybackHealthy,
      installCandidates: [
        { label: "语音交互工作站接线说明", url: "https://github.com/vb2250158/RabiRoute/blob/main/docs/voice-interaction-workstation.md" },
        { label: "本地说明：docs/voice-interaction-workstation.md", path: path.join(rootDir, "docs", "voice-interaction-workstation.md") }
      ],
      endpoints: [
        ...fenneCallbacks,
        { label: "FenneNote 播放/回复端", url: fenneNotePlaybackUrl, healthy: fennePlaybackHealthy }
      ],
      requirements: [
        { id: "callback", label: "RabiRoute FenneNote 回调入口", required: true, ok: fenneCallbackReady, detail: fenneCallbacks[0]?.url || "添加 FenneNote 消息端并重启 route 后生成。" },
        { id: "app", label: "FenneNote 桌面端/语音转写端", required: true, ok: fennePlaybackHealthy || undefined, detail: fennePlaybackHealthy ? "检测到 FenneNote 本地播放/回复端可达。" : "此仓库不内置 FenneNote，需要按你的实际分发渠道安装并运行。" },
        { id: "webhook-config", label: "FenneNote 已配置转写 webhook", required: true, ok: fenneRecent, detail: fenneRecent ? "已收到过 FenneNote 语音转写事件。" : "尚未收到 FenneNote 请求；请把回调地址填到 FenneNote 的转写/事件配置里。" },
        { id: "tts", label: "OumuQ / TTS worker", required: false, ok: undefined, detail: "只做语音输入时可先不配；需要播报回复时再配置。" }
      ],
      warnings: [
        "RabiRoute 只能检测自己的回调入口和可选播放端；FenneNote 是否真正录音/转写，需要 FenneNote 端或最近请求日志确认。",
        "不要把 FenneNote 叫成 Webhook；日志和消息文件会按 FenneNote 独立分组。"
      ]
    },
    xiaoai: {
      type: "xiaoai",
      label: "小米音箱 / 小爱",
      maturity: "experimental",
      installed: fs.existsSync(xiaoaiBridgePackage),
      installCandidates: [
        { label: "RabiRoute 小爱桥接适配器", path: xiaoaiBridgeDir },
        { label: "小爱接入 Runbook", path: path.join(xiaoaiBridgeDir, "RUNBOOK.md") },
        { label: "open-xiaoai 参考项目", url: "https://github.com/idootop/open-xiaoai" },
        { label: "xiaogpt 参考项目", url: "https://github.com/yihong0618/xiaogpt" },
        { label: "小爱音箱接入 RabiRoute 技术路线", url: "https://github.com/vb2250158/RabiRoute/blob/main/docs/xiaoai-integration/xiaoai-rabiroute-intercept-route.md" }
      ],
      endpoints: [
        ...xiaoaiCallbacks,
        { label: "小爱桥服务", url: xiaoaiBridgeHealthUrl, healthy: xiaoaiBridgeHealthy }
      ],
      requirements: [
        { id: "bridge-package", label: "PC 侧小爱桥适配器", required: true, ok: fs.existsSync(xiaoaiBridgePackage), detail: fs.existsSync(xiaoaiBridgePackage) ? xiaoaiBridgeDir : "缺少 plugin-adapters/xiaoai-rabiroute。" },
        { id: "bridge-running", label: "小爱桥服务已启动", required: true, ok: xiaoaiBridgeHealthy, detail: xiaoaiBridgeHealthy ? xiaoaiBridgeHealthUrl : `未访问到 ${xiaoaiBridgeHealthUrl}；在小爱桥目录运行 npm start。` },
        { id: "speaker-client", label: "音箱侧 open-xiaoai / xiaogpt / 自定义桥", required: true, ok: undefined, detail: fs.existsSync(openXiaoAiDir) ? "已发现 vendor/open-xiaoai 参考代码；真机补丁/桥接仍需人工确认。" : "需要能从小爱音箱或桥服务把语音事件转发到 PC 侧。" },
        { id: "local-config", label: "本地小爱配置", required: false, ok: fs.existsSync(xiaoaiLocalConfig), detail: fs.existsSync(xiaoaiLocalConfig) ? xiaoaiLocalConfig : "可从 xiaoai-local.config.example.json 复制生成本地配置。" },
        { id: "callback", label: "RabiRoute 小爱回调入口", required: true, ok: xiaoaiCallbackReady, detail: xiaoaiCallbacks[0]?.url || "添加小米音箱消息端并重启 route 后生成。" },
        { id: "recent-event", label: "最近收到小爱事件", required: true, ok: xiaoaiRecent, detail: xiaoaiRecent ? "已收到过小爱语音转写事件。" : "尚未收到小爱桥转发的事件。" }
      ],
      warnings: [
        "小米音箱不是直接连 RabiRoute：需要 open-xiaoai/xiaogpt/自定义桥这类入口层，把语音文本 POST 到 RabiRoute。",
        "open-xiaoai 路线涉及机型、固件和刷机风险；只在确认型号和备份后操作。"
      ]
    },
    webhook: {
      type: "webhook",
      label: "通用 Webhook",
      maturity: "experimental",
      installed: webhookCallbackReady,
      endpoints: webhookCallbacks,
      requirements: [
        { id: "callback", label: "RabiRoute 通用回调入口", required: true, ok: webhookCallbackReady, detail: webhookCallbacks[0]?.url || "添加通用 Webhook 消息端并重启 route 后生成。" },
        { id: "sender", label: "外部系统已配置 POST", required: true, ok: webhookRuntimes.some((runtime) => routeHasRecentMessages(runtime, "webhook")), detail: "RabiRoute 无法自动知道外部系统是否已配置；以最近请求日志为准。" }
      ],
      warnings: ["只有真正不知道来源的外部 POST 才用通用 Webhook；FenneNote、小爱、Home Assistant 等应拆成具体消息端。"]
    }
  };
}

type AstrbotLoginTestRequest = {
  url?: string;
  username?: string;
  password?: string;
};

type AstrbotSessionScan = {
  authVerified: boolean;
  authMessage?: string;
  projects: AgentScanProject[];
  sessions: AgentScanSession[];
  source: "api" | "local-db" | "none";
};

type NapcatHealthRequest = {
  httpUrl?: string;
  webuiUrl?: string;
  accessToken?: string;
  gatewayPort?: number;
};

type NapcatWebuiTokenInfo = {
  found: boolean;
  token?: string;
  tokenLength?: number;
  configPath?: string;
  loginUrl?: string;
  message?: string;
};

type NapcatLaunchRequest = {
  gatewayId?: string;
  instanceId?: string;
};

type MarvisOpenRequest = {
  appId?: string;
  url?: string;
};

type NapcatOneBotResponse<T> = {
  status?: string;
  retcode?: number;
  message?: string;
  wording?: string;
  data?: T;
};

async function testAstrbotLogin(request: AstrbotLoginTestRequest): Promise<Record<string, unknown>> {
  const baseUrl = (request.url?.trim() || process.env.ASTRBOT_URL || "http://127.0.0.1:6185").replace(/\/+$/, "");
  const username = request.username?.trim() || process.env.ASTRBOT_USERNAME || "";
  const password = request.password?.trim() || process.env.ASTRBOT_PASSWORD || "";
  if (!password) {
    return { ok: false, status: 400, message: "缺少 AstrBot 密码。" };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);
  try {
    const response = await fetch(`${baseUrl}/api/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username, password }),
      signal: controller.signal
    });
    const text = await response.text();
    let body: { status?: string; data?: { token?: string } | null; message?: string; error?: string; detail?: string } = {};
    try {
      body = text ? JSON.parse(text) : {};
    } catch {
      body = { detail: text };
    }

    if (!response.ok || body.status === "error" || body.error) {
      const rawMessage = body.message || body.error || body.detail || text || `HTTP ${response.status}`;
      const credentialHint = response.status === 401 || response.status === 403 || /password|credential|用户名|密码|登录|auth/i.test(rawMessage);
      return {
        ok: false,
        status: response.status,
        message: credentialHint ? `AstrBot 登录失败：账号或密码可能不正确。(${rawMessage})` : `AstrBot 登录失败：${rawMessage}`
      };
    }

    if (!body.data?.token) {
      return { ok: false, status: response.status, message: "AstrBot 登录响应里没有 token，可能 API 版本不匹配。" };
    }

    const token = body.data.token;
    const sessions = await scanAstrbotViaDashboardApi(baseUrl, username, token);
    const counts = sessions.source === "api"
      ? ` 已读取 ${sessions.projects.length} 个项目、${sessions.sessions.length} 个会话。`
      : "";
    return { ok: true, status: response.status, message: `AstrBot 登录验证成功。${counts}` };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, status: 0, message: message.includes("abort") ? "AstrBot 登录验证超时。" : `AstrBot 登录验证失败：${message}` };
  } finally {
    clearTimeout(timer);
  }
}

async function loginAstrbotDashboard(baseUrl: string, username: string, password: string): Promise<{ token?: string; message?: string }> {
  if (!password) {
    return { message: "缺少 AstrBot 密码。" };
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 4200);
  try {
    const response = await fetch(`${baseUrl}/api/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username, password }),
      signal: controller.signal
    });
    const text = await response.text();
    let body: { status?: string; data?: { token?: string } | null; message?: string; error?: string; detail?: string } = {};
    try {
      body = text ? JSON.parse(text) : {};
    } catch {
      body = { detail: text };
    }
    if (!response.ok || body.status === "error" || body.error) {
      return { message: body.message || body.error || body.detail || `HTTP ${response.status}` };
    }
    return { token: body.data?.token, message: body.data?.token ? undefined : "登录响应缺少 token。" };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { message: message.includes("abort") ? "登录请求超时。" : message };
  } finally {
    clearTimeout(timer);
  }
}

async function fetchAstrbotJson<T>(url: string, token: string): Promise<T | null> {
  try {
    const response = await fetch(url, {
      headers: { authorization: `Bearer ${token}` }
    });
    if (!response.ok) return null;
    const body = await response.json() as { status?: string; data?: T };
    if (body.status === "error") return null;
    return body.data ?? null;
  } catch {
    return null;
  }
}

async function scanAstrbotViaDashboardApi(baseUrl: string, username: string, token: string): Promise<AstrbotSessionScan> {
  type ProjectApiItem = { project_id?: string; title?: string; emoji?: string; updated_at?: string };
  type SessionApiItem = { session_id?: string; platform_id?: string; display_name?: string; updated_at?: string };
  const projectsRaw = await fetchAstrbotJson<ProjectApiItem[]>(`${baseUrl}/api/chatui_project/list`, token);
  const sessionsRaw = await fetchAstrbotJson<SessionApiItem[]>(`${baseUrl}/api/chat/sessions?platform_id=webchat`, token);
  if (!projectsRaw && !sessionsRaw) {
    return { authVerified: true, projects: [], sessions: [], source: "none", authMessage: "已登录，但未读取到项目/会话 API。" };
  }
  const projects: AgentScanProject[] = (projectsRaw ?? []).map((project) => {
    const label = [project.emoji, project.title].filter(Boolean).join(" ") || project.project_id || "未命名项目";
    const pathValue = project.title || label;
    return {
      id: project.project_id,
      label,
      path: pathValue,
      exists: pathValue ? fs.existsSync(pathValue) : false
    };
  });
  const sessions: AgentScanSession[] = (sessionsRaw ?? []).map((session) => ({
    id: session.session_id,
    name: session.display_name || session.session_id || "未命名会话",
    updatedAt: session.updated_at
  }));
  for (const project of projectsRaw ?? []) {
    if (!project.project_id) continue;
    const projectSessions = await fetchAstrbotJson<SessionApiItem[]>(`${baseUrl}/api/chatui_project/get_sessions?project_id=${encodeURIComponent(project.project_id)}`, token);
    for (const session of projectSessions ?? []) {
      const existing = sessions.find((item) => item.id === session.session_id);
      if (existing) {
        existing.projectId = project.project_id;
        existing.projectPath = project.title;
      } else {
        sessions.push({
          id: session.session_id,
          name: session.display_name || session.session_id || "未命名会话",
          projectId: project.project_id,
          projectPath: project.title,
          updatedAt: session.updated_at
        });
      }
    }
  }
  return { authVerified: true, projects, sessions, source: "api", authMessage: `已通过 Dashboard API 读取 ${projects.length} 个项目、${sessions.length} 个会话。` };
}

async function scanAstrbotLocalDb(): Promise<Pick<AstrbotSessionScan, "projects" | "sessions" | "source">> {
  const dbPath = path.join(os.homedir(), ".astrbot", "data", "data_v4.db");
  if (!fs.existsSync(dbPath)) {
    return { projects: [], sessions: [], source: "none" };
  }
  const pyCandidates = [
    "py",
    "python",
    path.join(process.env.LOCALAPPDATA ?? "", "AstrBot", "backend", "python", "python.exe")
  ].filter(Boolean);
  const script = `
import json, sqlite3, sys
db_path = sys.argv[1]
con = sqlite3.connect(db_path)
con.row_factory = sqlite3.Row
projects = [dict(r) for r in con.execute("select project_id, title, emoji, updated_at from chatui_projects order by updated_at desc limit 100")]
sessions = [dict(r) for r in con.execute("""select s.session_id, s.display_name, s.updated_at, p.project_id, p.title as project_title
from platform_sessions s
left join session_project_relations rel on rel.session_id=s.session_id
left join chatui_projects p on p.project_id=rel.project_id
where s.platform_id='webchat'
order by s.updated_at desc limit 200""")]
print(json.dumps({"projects": projects, "sessions": sessions}, ensure_ascii=False))
con.close()
`.trim();
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const execFileAsync = promisify(execFile);
  for (const py of pyCandidates) {
    try {
      const args = path.basename(py).toLowerCase() === "py"
        ? ["-3", "-c", script, dbPath]
        : ["-c", script, dbPath];
      const { stdout } = await execFileAsync(py, args, {
        timeout: 3000,
        windowsHide: true,
        encoding: "utf8",
        env: { ...process.env, PYTHONIOENCODING: "utf-8" }
      });
      const parsed = JSON.parse(stdout) as {
        projects?: Array<{ project_id?: string; title?: string; emoji?: string; updated_at?: string }>;
        sessions?: Array<{ session_id?: string; display_name?: string; updated_at?: string; project_id?: string; project_title?: string }>;
      };
      const projects: AgentScanProject[] = (parsed.projects ?? []).map((project) => {
        const label = [project.emoji, project.title].filter(Boolean).join(" ") || project.project_id || "未命名项目";
        const pathValue = project.title || label;
        return {
          id: project.project_id,
          label,
          path: pathValue,
          exists: pathValue ? fs.existsSync(pathValue) : false
        };
      });
      const sessions: AgentScanSession[] = (parsed.sessions ?? []).map((session) => ({
        id: session.session_id,
        name: session.display_name || session.session_id || "未命名会话",
        projectId: session.project_id,
        projectPath: session.project_title,
        updatedAt: session.updated_at
      }));
      return { projects, sessions, source: "local-db" };
    } catch {
      // try next interpreter
    }
  }
  return { projects: [], sessions: [], source: "none" };
}

async function detectNapcatProcesses(): Promise<Array<{ name: string; pid: string }>> {
  if (process.platform !== "win32") {
    return [];
  }
  try {
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const execFileAsync = promisify(execFile);
    const { stdout } = await execFileAsync("tasklist.exe", ["/FO", "CSV", "/NH"], { timeout: 2500 });
    return stdout.split(/\r?\n/)
      .map(line => line.trim())
      .filter(Boolean)
      .map(line => line.match(/^"([^"]+)","([^"]+)"/))
      .filter((match): match is RegExpMatchArray => Boolean(match))
      .map(match => ({ name: match[1], pid: match[2] }))
      .filter(item => /napcat|qqnt|^qq\.exe$/i.test(item.name));
  } catch {
    return [];
  }
}

function napcatWebuiLoginUrl(webuiUrl: string, token: string): string {
  try {
    const parsed = new URL(webuiUrl);
    parsed.searchParams.set("token", token);
    return parsed.toString();
  } catch {
    const separator = webuiUrl.includes("?") ? "&" : "?";
    return `${webuiUrl}${separator}token=${encodeURIComponent(token)}`;
  }
}

function addNapcatWebuiConfigCandidate(candidates: Set<string>, candidate: string | undefined): void {
  const value = candidate?.trim();
  if (!value) return;
  candidates.add(path.resolve(value));
}

function napcatWebuiConfigCandidates(): string[] {
  const candidates = new Set<string>();
  addNapcatWebuiConfigCandidate(candidates, process.env.NAPCAT_WEBUI_CONFIG);
  if (process.env.NAPCAT_CONFIG_DIR) {
    addNapcatWebuiConfigCandidate(candidates, path.join(process.env.NAPCAT_CONFIG_DIR, "webui.json"));
  }

  for (const runtime of runtimes.values()) {
    for (const instance of runtime.definition.napcatInstances ?? normalizeNapCatInstances(runtime.definition)) {
      const workingDir = instance.workingDir?.trim();
      if (workingDir) {
        addNapcatWebuiConfigCandidate(candidates, path.join(workingDir, "napcat", "config", "webui.json"));
        addNapcatWebuiConfigCandidate(candidates, path.join(workingDir, "config", "webui.json"));
        addNapcatWebuiConfigCandidate(candidates, path.join(workingDir, "webui.json"));
      }
      const launchCommand = instance.launchCommand?.trim();
      if (launchCommand) {
        const commandPath = launchCommand.match(/^"([^"]+)"/)?.[1] || launchCommand.split(/\s+/)[0];
        if (commandPath && (commandPath.includes("\\") || commandPath.includes("/"))) {
          const commandDir = path.dirname(path.resolve(workingDir || rootDir, commandPath));
          addNapcatWebuiConfigCandidate(candidates, path.join(commandDir, "napcat", "config", "webui.json"));
          addNapcatWebuiConfigCandidate(candidates, path.join(commandDir, "config", "webui.json"));
        }
      }
    }
  }

  const searchRoots = [
    path.resolve(rootDir, "..", "tools", "NapCat"),
    path.resolve(rootDir, "tools", "NapCat"),
    path.resolve(os.homedir(), "NapCat"),
    path.resolve(os.homedir(), "AppData", "Local", "NapCat")
  ];
  for (const base of searchRoots) {
    try {
      if (!fs.existsSync(base)) continue;
      addNapcatWebuiConfigCandidate(candidates, path.join(base, "napcat", "config", "webui.json"));
      addNapcatWebuiConfigCandidate(candidates, path.join(base, "config", "webui.json"));
      for (const entry of fs.readdirSync(base, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const dir = path.join(base, entry.name);
        addNapcatWebuiConfigCandidate(candidates, path.join(dir, "napcat", "config", "webui.json"));
        addNapcatWebuiConfigCandidate(candidates, path.join(dir, "config", "webui.json"));
      }
    } catch {
      // Ignore inaccessible candidate roots.
    }
  }

  return [...candidates].filter((candidate) => fs.existsSync(candidate));
}

function readNapcatWebuiToken(webuiUrl: string): NapcatWebuiTokenInfo {
  let expectedPort = 0;
  try {
    expectedPort = Number(new URL(webuiUrl).port || 6099);
  } catch {
    expectedPort = 0;
  }

  const candidates = napcatWebuiConfigCandidates();
  let fallback: NapcatWebuiTokenInfo | null = null;
  for (const configPath of candidates) {
    try {
      const parsed = JSON.parse(fs.readFileSync(configPath, "utf8").replace(/^\uFEFF/, "")) as { token?: unknown; port?: unknown; disableWebUI?: unknown };
      const token = String(parsed.token || "").trim();
      if (!token || parsed.disableWebUI === true) continue;
      const info: NapcatWebuiTokenInfo = {
        found: true,
        token,
        tokenLength: token.length,
        configPath,
        loginUrl: napcatWebuiLoginUrl(webuiUrl, token)
      };
      const port = Number(parsed.port || 0);
      if (!fallback) fallback = info;
      if (!expectedPort || !port || port === expectedPort) {
        return info;
      }
    } catch {
      // Try the next candidate.
    }
  }

  return fallback ?? {
    found: false,
    message: candidates.length
      ? "已找到 NapCat webui.json，但没有读到可用 token。"
      : "未找到 NapCat config/webui.json；可在 NapCat 启动日志里查看 WebUI token。"
  };
}

async function testNapcatHealth(request: NapcatHealthRequest): Promise<Record<string, unknown>> {
  const httpUrl = (request.httpUrl?.trim() || "http://127.0.0.1:3000").replace(/\/+$/, "");
  const webuiUrl = request.webuiUrl?.trim() || "http://127.0.0.1:6099/webui";
  const token = request.accessToken?.trim() || "";
  const gatewayPort = Number(request.gatewayPort || 0);
  const headers: Record<string, string> = { "content-type": "application/json; charset=utf-8" };
  if (token) headers.authorization = `Bearer ${token}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);
  let http: Record<string, unknown>;
  try {
    const response = await fetch(`${httpUrl}/get_login_info`, {
      method: "POST",
      headers,
      body: "{}",
      signal: controller.signal
    });
    const text = await response.text();
    let body: NapcatOneBotResponse<{ user_id?: number | string; nickname?: string }> = {};
    try {
      body = text ? JSON.parse(text) : {};
    } catch {
      body = { message: text };
    }
    const failed = !response.ok
      || (body.retcode != null && body.retcode !== 0)
      || body.status === "failed";
    if (failed) {
      http = {
        ok: false,
        status: response.status,
        message: body.wording || body.message || text || `HTTP ${response.status}`
      };
    } else {
      http = {
        ok: true,
        status: response.status,
        userId: body.data?.user_id,
        nickname: body.data?.nickname
      };
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    http = { ok: false, status: 0, message: message.includes("abort") ? "NapCat HTTP 检查超时。" : message };
  } finally {
    clearTimeout(timer);
  }

  const webui = {
    url: webuiUrl,
    reachable: await checkHttpEndpoint(webuiUrl, 1600),
    ...readNapcatWebuiToken(webuiUrl)
  };
  const processes = await detectNapcatProcesses();
  return {
    ok: Boolean(http.ok),
    http,
    webui,
    gatewayPort,
    wsUrl: gatewayPort > 0 ? `ws://127.0.0.1:${gatewayPort}` : "",
    process: {
      found: processes.length > 0,
      candidates: processes.slice(0, 8)
    }
  };
}

function launchNapcatInstance(request: NapcatLaunchRequest): Record<string, unknown> {
  const gatewayId = request.gatewayId?.trim();
  const instanceId = request.instanceId?.trim();
  if (!gatewayId || !instanceId) {
    throw new Error("缺少 gatewayId 或 instanceId。");
  }
  const runtime = runtimes.get(gatewayId);
  if (!runtime) {
    throw new Error(`未找到路由：${gatewayId}`);
  }
  const instance = (runtime.definition.napcatInstances ?? normalizeNapCatInstances(runtime.definition))
    .find((item) => item.id === instanceId);
  if (!instance) {
    throw new Error(`未找到 NapCat 实例：${instanceId}`);
  }
  const command = instance.launchCommand?.trim();
  if (!command) {
    throw new Error("这个 NapCat 实例还没有填写启动命令。");
  }
  const cwd = instance.workingDir?.trim() || rootDir;
  if (process.platform === "win32") {
    const child = spawn("cmd", ["/c", "start", "", "/D", cwd, "cmd", "/c", command], {
      detached: true,
      stdio: "ignore",
      windowsHide: true
    });
    child.unref();
  } else {
    const child = spawn(command, [], {
      cwd,
      detached: true,
      shell: true,
      stdio: "ignore"
    });
    child.unref();
  }
  appendLog(runtime, `launch NapCat instance ${instance.name || instance.id}: ${command}`);
  return {
    ok: true,
    message: `已尝试启动 NapCat 后台：${instance.name || instance.id}`,
    instance: {
      id: instance.id,
      name: instance.name,
      gatewayPort: instance.gatewayPort,
      httpUrl: instance.httpUrl,
      webuiUrl: instance.webuiUrl
    }
  };
}

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

function readJsonlTail(filePath: string, limit = 8): Array<Record<string, unknown>> {
  if (!fs.existsSync(filePath)) {
    return [];
  }

  try {
    return fs.readFileSync(filePath, "utf8")
      .split(/\r?\n/)
      .filter(Boolean)
      .slice(-limit)
      .map((line) => {
        try {
          return JSON.parse(line) as Record<string, unknown>;
        } catch {
          return { rawLine: line };
        }
      });
  } catch (error) {
    return [{
      error: error instanceof Error ? error.message : String(error),
      path: filePath
    }];
  }
}

function messageFileCandidateDirs(definition: GatewayDefinition): string[] {
  const dirs = new Set<string>();
  dirs.add(dataDirFor(definition));
  const roleId = sanitizeRoleId(definition.agentRoleId);
  const rolesDir = path.resolve(rootDir, definition.rolesDir ?? path.join("data", "roles"));
  if (roleId) {
    dirs.add(path.join(rolesDir, roleId));
  }
  for (const profile of definition.routeProfiles ?? []) {
    if (profile.dataDir) {
      dirs.add(path.resolve(rootDir, profile.dataDir));
    }
    const profileRole = sanitizeRoleId(profile.agentRoleId);
    if (profileRole) {
      dirs.add(path.join(rolesDir, profileRole));
    }
  }
  return [...dirs];
}

function recordTimeMs(record: Record<string, unknown>): number {
  const time = record.time;
  if (typeof time === "number") {
    return time < 10_000_000_000 ? time * 1000 : time;
  }
  for (const key of ["createdAt", "lastEventAt", "startedAt", "endedAt"]) {
    const value = record[key];
    if (typeof value === "string") {
      const parsed = Date.parse(value);
      if (Number.isFinite(parsed)) return parsed;
    }
  }
  return 0;
}

function messageFileEntry(source: string, filePath: string, record: Record<string, unknown>): Record<string, unknown> {
  const groupId = record.groupId ?? record.group_id;
  const userId = record.userId ?? record.user_id;
  const text = record.rawMessage ?? record.message ?? record.text ?? record.content ?? record.rawLine ?? "";
  return {
    source,
    path: filePath,
    time: record.time,
    timeMs: recordTimeMs(record),
    messageId: record.messageId ?? record.message_id,
    instanceId: record.instanceId,
    adapterType: record.adapterType,
    sender: record.senderName ?? record.sender ?? record.source,
    target: groupId ? `群 ${String(groupId)}` : userId ? `私聊 ${String(userId)}` : record.source ?? source,
    text: typeof text === "string" ? text : JSON.stringify(text),
    raw: record
  };
}

function adapterLogEntry(filePath: string, record: Record<string, unknown>): Record<string, unknown> {
  const data = record.data && typeof record.data === "object" ? record.data as Record<string, unknown> : {};
  const text = record.message ?? data.text ?? data.rawMessage ?? data.eventType ?? record.rawLine ?? "";
  return {
    adapter: record.adapter,
    event: record.event ?? "log",
    level: record.level ?? "info",
    instanceId: record.instanceId,
    path: filePath,
    time: record.time,
    timeMs: recordTimeMs(record),
    messageId: data.messageId ?? data.message_id,
    sender: data.senderName ?? data.sender ?? data.source,
    target: data.groupId ? `群 ${String(data.groupId)}` : data.userId ? `私聊 ${String(data.userId)}` : data.path ?? data.name,
    text: typeof text === "string" ? text : JSON.stringify(text),
    raw: record
  };
}

function readMessageFiles(definition: GatewayDefinition): Record<string, unknown> {
  const dirs = messageFileCandidateDirs(definition);
  const readEntries = (source: string, fileName: string) => dirs.flatMap((dir) => {
    const filePath = path.join(dir, fileName);
    return readJsonlTail(filePath, 8).map((record) => messageFileEntry(source, filePath, record));
  });
  const sortTail = (items: Array<Record<string, unknown>>) => items
    .sort((left, right) => Number(left.timeMs || 0) - Number(right.timeMs || 0))
    .slice(-8)
    .reverse();

  const napcatEntries = sortTail([
    ...readEntries("群聊", "group-messages.jsonl"),
    ...readEntries("私聊", "private-messages.jsonl")
  ]);
  const heartbeatEntries = sortTail(readEntries("定时触发", "heartbeat-events.jsonl"));
  const fenneNoteEntries = sortTail([
    ...readEntries("FenneNote / 芬妮笔记", "fennenote-voice-transcripts.jsonl"),
    ...readEntries("FenneNote / 芬妮笔记", "voice-transcripts.jsonl").filter((entry) => String((entry.raw as Record<string, unknown>)?.adapterType ?? "").toLowerCase() === "fennenote")
  ]);
  const xiaoaiEntries = sortTail([
    ...readEntries("小米音箱 / 小爱", "xiaoai-voice-transcripts.jsonl"),
    ...readEntries("小米音箱 / 小爱", "voice-transcripts.jsonl").filter((entry) => String((entry.raw as Record<string, unknown>)?.adapterType ?? "").toLowerCase() === "xiaoai")
  ]);
  const webhookEntries = sortTail(readEntries("通用 Webhook", "voice-transcripts.jsonl")
    .filter((entry) => {
      const adapterType = String((entry.raw as Record<string, unknown>)?.adapterType ?? "").toLowerCase();
      return !adapterType || adapterType === "webhook";
    }));

  return {
    napcat: {
      paths: dirs.flatMap((dir) => [
        path.join(dir, "group-messages.jsonl"),
        path.join(dir, "private-messages.jsonl")
      ]),
      entries: napcatEntries
    },
    heartbeat: {
      paths: dirs.map((dir) => path.join(dir, "heartbeat-events.jsonl")),
      entries: heartbeatEntries
    },
    fennenote: {
      paths: dirs.flatMap((dir) => [
        path.join(dir, "fennenote-voice-transcripts.jsonl"),
        path.join(dir, "voice-transcripts.jsonl")
      ]),
      entries: fenneNoteEntries
    },
    xiaoai: {
      paths: dirs.flatMap((dir) => [
        path.join(dir, "xiaoai-voice-transcripts.jsonl"),
        path.join(dir, "voice-transcripts.jsonl")
      ]),
      entries: xiaoaiEntries
    },
    webhook: {
      paths: dirs.map((dir) => path.join(dir, "voice-transcripts.jsonl")),
      entries: webhookEntries
    }
  };
}

function readAdapterLogs(definition: GatewayDefinition): Record<string, unknown> {
  const dir = dataDirFor(definition);
  const readEntries = (adapter: MessageAdapterType) => {
    const filePath = path.join(dir, `${adapter}-adapter.log.jsonl`);
    return readJsonlTail(filePath, 12)
      .map((record) => adapterLogEntry(filePath, record))
      .sort((left, right) => Number(left.timeMs || 0) - Number(right.timeMs || 0))
      .reverse();
  };

  return {
    napcat: {
      paths: [path.join(dir, "napcat-adapter.log.jsonl")],
      entries: readEntries("napcat")
    },
    heartbeat: {
      paths: [path.join(dir, "heartbeat-adapter.log.jsonl")],
      entries: readEntries("heartbeat")
    },
    fennenote: {
      paths: [path.join(dir, "fennenote-adapter.log.jsonl")],
      entries: readEntries("fennenote")
    },
    xiaoai: {
      paths: [path.join(dir, "xiaoai-adapter.log.jsonl")],
      entries: readEntries("xiaoai")
    },
    webhook: {
      paths: [path.join(dir, "webhook-adapter.log.jsonl")],
      entries: readEntries("webhook")
    }
  };
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
    fenneNoteWebhookPort: runtime.definition.fenneNoteWebhookPort,
    fenneNoteWebhookPath: runtime.definition.fenneNoteWebhookPath,
    xiaoaiWebhookPort: runtime.definition.xiaoaiWebhookPort,
    xiaoaiWebhookPath: runtime.definition.xiaoaiWebhookPath,
    heartbeatIntervalSeconds: runtime.definition.heartbeatIntervalSeconds ?? 900,
    heartbeatMessage: runtime.definition.heartbeatMessage ?? "",
    napcatHttpUrl: runtime.definition.napcatHttpUrl ?? "http://127.0.0.1:3000",
    napcatWebuiUrl: runtime.definition.napcatWebuiUrl ?? "http://127.0.0.1:6099/webui",
    napcatAccessToken: runtime.definition.napcatAccessToken ?? "",
    napcatInstances: runtime.definition.napcatInstances ?? normalizeNapCatInstances(runtime.definition),
    targetGroupId: runtime.definition.targetGroupId ?? "",
    routeVariables: runtime.definition.routeVariables,
    routeName: runtime.definition.routeName,
    routeProfiles: runtime.definition.routeProfiles ?? [],
    codexThreadName: runtime.definition.codexThreadName ?? runtime.definition.name ?? runtime.definition.id,
    codexCwd: runtime.definition.codexCwd,
    copilotCwd: runtime.definition.copilotCwd,
    copilotCliBin: runtime.definition.copilotCliBin,
    marvisAppId: runtime.definition.marvisAppId,
    astrbotUrl: runtime.definition.astrbotUrl,
    astrbotUsername: runtime.definition.astrbotUsername,
    astrbotPassword: runtime.definition.astrbotPassword,
    astrbotProjectId: runtime.definition.astrbotProjectId,
    astrbotSessionId: runtime.definition.astrbotSessionId,
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
    adapterLogs: readAdapterLogs(runtime.definition),
    messageFiles: readMessageFiles(runtime.definition),
    agentStates: readAgentStates(runtime.definition),
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

  const [, encodedId, action] = match;
  const id = decodeURIComponent(encodedId);
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
      if (request.method === "GET" && requestUrl.pathname === "/api/scan/message-adapters") {
        void messageAdapterScanPayload()
          .then((adapters) => {
            jsonResponse(response, 200, { adapters });
          })
          .catch((error) => {
            jsonResponse(response, 500, { code: -1, message: error instanceof Error ? error.message : String(error) });
          });
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
          for (const bin of ["copilot"]) {
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

          const projects = projectOptionsFromPaths(cwdOptions);
          const codexSessions: AgentScanSession[] = legacySessionThreads.map((record) => ({
            id: record.id,
            name: record.threadName,
            updatedAt: record.updatedAt
          }));
          const copilotScanSessions: AgentScanSession[] = copilotSessions.map((session) => ({
            id: session.id,
            name: session.name,
            projectPath: session.cwd,
            updatedAt: session.updatedAt,
            userNamed: session.userNamed
          }));
          const copilotHome = process.env.COPILOT_HOME ?? path.join(os.homedir(), ".copilot");
          let copilotLoggedIn = false;
          try {
            const configPath = path.join(copilotHome, "config.json");
            if (fs.existsSync(configPath)) {
              const raw = fs.readFileSync(configPath, "utf8").replace(/^\s*\/\/[^\n]*\n/gm, "");
              const cfg = JSON.parse(raw) as { loggedInUsers?: unknown[] };
              copilotLoggedIn = Array.isArray(cfg.loggedInUsers) && cfg.loggedInUsers.length > 0;
            }
          } catch { /* ignore */ }

          const configuredAstrbotUrls = [...runtimes.values()]
            .map((runtime) => runtime.definition.astrbotUrl?.trim())
            .filter(Boolean) as string[];
          const configuredAstrbotPasswords = [...runtimes.values()]
            .map((runtime) => runtime.definition.astrbotPassword?.trim())
            .filter(Boolean) as string[];
          const configuredAstrbotUsernames = [...runtimes.values()]
            .map((runtime) => runtime.definition.astrbotUsername?.trim())
            .filter(Boolean) as string[];
          const astrbotUrls = [...new Set([
            ...configuredAstrbotUrls,
            process.env.ASTRBOT_URL,
            "http://127.0.0.1:6185"
          ].filter(Boolean) as string[])];
          const astrbotEndpoints = await Promise.all(astrbotUrls.map(async (url) => ({
            label: url.includes("127.0.0.1") || url.includes("localhost") ? "本机 AstrBot" : "AstrBot",
            url,
            healthy: await checkHttpEndpoint(url)
          })));
          const astrbotPluginDir = path.join(os.homedir(), ".astrbot", "data", "plugins", "rabiroute_agent");
          const astrbotPluginInstalled = fs.existsSync(path.join(astrbotPluginDir, "main.py"))
            && fs.existsSync(path.join(astrbotPluginDir, "metadata.yaml"));
          const astrbotPluginSourceReady = fs.existsSync(path.join(rootDir, "scripts", "rabiroute_agent", "main.py"))
            && fs.existsSync(path.join(rootDir, "scripts", "rabiroute_agent", "metadata.yaml"));
          const astrbotPasswordPresent = Boolean(process.env.ASTRBOT_PASSWORD?.trim() || configuredAstrbotPasswords.length > 0);
          const astrbotBaseUrl = (configuredAstrbotUrls[0] || process.env.ASTRBOT_URL || "http://127.0.0.1:6185").replace(/\/+$/, "");
          const astrbotUsername = configuredAstrbotUsernames[0] || process.env.ASTRBOT_USERNAME || "";
          const astrbotPassword = configuredAstrbotPasswords[0] || process.env.ASTRBOT_PASSWORD || "";
          let astrbotSessionScan: AstrbotSessionScan = {
            authVerified: false,
            authMessage: astrbotPasswordPresent ? "已填写 AstrBot 凭据，尚未验证 Dashboard 登录。" : "缺少 AstrBot 密码；请填写本地配置或设置 ASTRBOT_PASSWORD。",
            projects: [],
            sessions: [],
            source: "none"
          };
          if (astrbotPasswordPresent && astrbotEndpoints.some((endpoint) => endpoint.healthy)) {
            const login = await loginAstrbotDashboard(astrbotBaseUrl, astrbotUsername, astrbotPassword);
            if (login.token) {
              astrbotSessionScan = await scanAstrbotViaDashboardApi(astrbotBaseUrl, astrbotUsername, login.token);
            } else {
              astrbotSessionScan.authMessage = `已填写 AstrBot 凭据，但 Dashboard 登录未通过：${login.message || "未知错误"}`;
            }
          }
          if (astrbotSessionScan.sessions.length === 0 || astrbotSessionScan.projects.length === 0) {
            const localScan = await scanAstrbotLocalDb();
            astrbotSessionScan = {
              ...astrbotSessionScan,
              projects: astrbotSessionScan.projects.length ? astrbotSessionScan.projects : localScan.projects,
              sessions: astrbotSessionScan.sessions.length ? astrbotSessionScan.sessions : localScan.sessions,
              source: astrbotSessionScan.source === "api" ? "api" : localScan.source
            };
          }

          const agents: Record<AgentAdapterType, AgentScanResult> = {
            codexDesktop: {
              type: "codexDesktop",
              label: "Codex Desktop",
              maturity: "verified",
              installed: fs.existsSync(sessionIndexPath()),
              projects,
              sessions: codexSessions,
              warnings: [
                ...(codexSessions.length === 0 ? [`未在 ${sessionIndexPath()} 发现 Codex 会话索引。`] : []),
                "本页不会自动向现有 Codex 会话发送烟测消息；同会话重复注入需要人工确认后再测。"
              ]
            },
            codexApp: {
              type: "codexApp",
              label: "Codex App",
              maturity: "verified",
              installed: fs.existsSync(sessionIndexPath()),
              projects,
              sessions: codexSessions,
              warnings: [
                ...(codexSessions.length === 0 ? [`未在 ${sessionIndexPath()} 发现 Codex 会话索引。`] : []),
                "复用 Codex 会话/项目模型；真实消息注入仍以绑定线程状态为准。"
              ]
            },
            copilotCli: {
              type: "copilotCli",
              label: "Copilot CLI",
              maturity: "experimental",
              installed: copilotBins.length > 0,
              installCandidates: copilotBins.map((binPath) => ({ label: path.basename(binPath), path: binPath })),
              auth: {
                required: true,
                loggedIn: copilotLoggedIn,
                loginUrl: "https://github.com/login/device",
                message: copilotLoggedIn ? "已发现 Copilot 登录状态。" : `未在 ${copilotHome} 发现登录状态。`
              },
              projects,
              sessions: copilotScanSessions,
              warnings: [
                "尚未完成真实端到端烟测：需确认 --name 会复用同一会话，且连续两次注入不会新开线程。",
                ...(copilotScanSessions.length === 0 ? ["未发现 Copilot session-state；会话下拉需要先运行过 Copilot CLI。"] : [])
              ]
            },
            marvis: {
              type: "marvis",
              label: "Marvis",
              maturity: "stub",
              installed: marvisAppIds.length > 0,
              installCandidates: marvisAppIds.map((id) => ({ label: id })),
              warnings: [
                "当前 Marvis 适配更像打开 App/复制 prompt 的人工接力，不是可靠的线程消息注入。",
                "不能列会话、不能创建会话，也不能验证同会话重复注入；不要标为 verified。"
              ]
            },
            astrbot: {
              type: "astrbot",
              label: "AstrBot",
              maturity: "experimental",
              installed: astrbotEndpoints.some((endpoint) => endpoint.healthy),
              auth: {
                required: true,
                loggedIn: astrbotSessionScan.authVerified,
                message: astrbotSessionScan.authMessage
              },
              endpoints: astrbotEndpoints,
              projects: astrbotSessionScan.projects,
              sessions: astrbotSessionScan.sessions,
              plugins: [{
                id: "rabiroute_agent",
                name: "RabiRoute Agent 插件",
                installed: astrbotPluginInstalled,
                healthy: astrbotPluginInstalled,
                version: astrbotPluginSourceReady ? "source-ready" : undefined
              }],
              warnings: [
                ...(astrbotSessionScan.source === "local-db" ? ["已从本机 AstrBot 数据库读取项目/会话；发送前仍需 Dashboard 登录或 API Key 验证。"] : []),
                ...(astrbotSessionScan.sessions.length === 0 ? ["未读取到 AstrBot WebChat 会话；可以在 AstrBot ChatUI 创建对话后重新扫描。"] : []),
                "尚未自动执行真实消息注入烟测；同会话连续两次发送需用户确认后再测。",
                ...(astrbotPluginInstalled ? [] : [`插件未安装到 ${astrbotPluginDir}。`])
              ]
            }
          };

          jsonResponse(response, 200, {
            agents,
            legacy: {
              threadNames,
              cwdOptions,
              copilotSessions: copilotSessions.map(s => ({ name: s.name, cwd: s.cwd, userNamed: s.userNamed })),
              copilotBins: [...new Set(copilotBins)],
              marvisAppIds: [...new Set(marvisAppIds)],
            },
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

      if (requestUrl.pathname === "/api/agent/astrbot-login-test" && request.method === "POST") {
        void readJsonBody<AstrbotLoginTestRequest>(request)
          .then((body) => testAstrbotLogin(body))
          .then((result) => {
            jsonResponse(response, result.ok ? 200 : 400, result);
          })
          .catch((error) => {
            jsonResponse(response, 400, { ok: false, message: error instanceof Error ? error.message : String(error) });
          });
        return;
      }

      if (requestUrl.pathname === "/api/message/napcat-health" && request.method === "POST") {
        void readJsonBody<NapcatHealthRequest>(request)
          .then((body) => testNapcatHealth(body))
          .then((result) => {
            jsonResponse(response, result.ok ? 200 : 400, result);
          })
          .catch((error) => {
            jsonResponse(response, 400, { ok: false, message: error instanceof Error ? error.message : String(error) });
          });
        return;
      }

      if (requestUrl.pathname === "/api/message/napcat-launch" && request.method === "POST") {
        void readJsonBody<NapcatLaunchRequest>(request)
          .then((body) => {
            jsonResponse(response, 200, launchNapcatInstance(body));
          })
          .catch((error) => {
            jsonResponse(response, 400, { ok: false, message: error instanceof Error ? error.message : String(error) });
          });
        return;
      }

      if (requestUrl.pathname === "/api/agent/marvis-open" && request.method === "POST") {
        void readJsonBody<MarvisOpenRequest>(request)
          .then((body) => {
            jsonResponse(response, 200, openMarvisPayload(body));
          })
          .catch((error) => {
            jsonResponse(response, 400, { ok: false, message: error instanceof Error ? error.message : String(error) });
          });
        return;
      }

      if (requestUrl.pathname === "/api/deploy-astrbot-adapter" && request.method === "POST") {
        void (async () => {
          try {
            const scriptPath = path.resolve(rootDir, "scripts", "deploy-astrbot-adapter.cmd");
            if (!fs.existsSync(scriptPath)) {
              jsonResponse(response, 404, { ok: false, error: `部署脚本未找到: ${scriptPath}` });
              return;
            }
            const { spawn } = await import("node:child_process");
            const child = spawn(scriptPath, [], {
              cwd: rootDir,
              shell: true,
              windowsHide: true,
              stdio: ["ignore", "pipe", "pipe"],
            });
            let stdout = "";
            let stderr = "";
            child.stdout?.on("data", (d: Buffer) => { stdout += d.toString(); });
            child.stderr?.on("data", (d: Buffer) => { stderr += d.toString(); });
            child.on("exit", (code) => {
              if (code === 0) {
                jsonResponse(response, 200, { ok: true, message: "AstrBot Adapter 部署成功", stdout: stdout.slice(0, 2000) });
              } else {
                jsonResponse(response, 500, { ok: false, error: `部署失败 (exit ${code})`, stderr: stderr.slice(0, 2000) });
              }
            });
          } catch (err: unknown) {
            jsonResponse(response, 500, { ok: false, error: String(err) });
          }
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
