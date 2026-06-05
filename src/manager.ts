import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { fileURLToPath } from "node:url";
import { normalizeAgentAdapters, type AgentAdapterType } from "./agentAdapters/types.js";
import type { MessageAdapterType } from "./adapters/messageAdapter.js";

type GatewayDefinition = {
  id: string;
  name?: string;
  enabled?: boolean;
  messageAdapterType?: MessageAdapterType;
  messageAdapters?: MessageAdapterType[];
  gatewayPort: number;
  webhookPort?: number;
  webhookPath?: string;
  heartbeatIntervalSeconds?: number;
  heartbeatMessage?: string;
  napcatHttpUrl?: string;
  napcatAccessToken?: string;
  targetGroupId?: string;
  routeVariables?: Record<string, string>;
  routeName?: string;
  codexThreadName?: string;
  codexCwd?: string;
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
const rolesRoot = path.resolve(rootDir, process.env.ROLES_DIR ?? path.join("data", "roles"));
const routeRoot = path.resolve(rootDir, process.env.ROUTE_DIR ?? path.join("data", "route"));
const managerPort = Number(process.env.GATEWAY_MANAGER_PORT ?? "8790");
const packageJsonPath = path.join(rootDir, "package.json");
const webuiDistPath = path.join(rootDir, "ribiwebgui", "dist");
const standaloneWebuiPath = path.join(rootDir, "ribiwebgui", "gateways.legacy.html");
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
    const roleMessageConfig = readRoleMessageConfigItem(raw.agentRoleId, configName);
    gateways.push({
      ...raw,
      ...roleMessageConfig,
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
  for (const item of normalized.gateways) {
    const roleId = sanitizeRoleId(item.agentRoleId) || routeRuntimeParts(item.id).roleId;
    grouped.set(roleId, [...(grouped.get(roleId) ?? []), item]);
    writeRouteConfigFile(item);
  }
  for (const [roleId, items] of grouped.entries()) {
    if (roleId) {
      writeRoleMessageConfigFile(roleId, items);
    }
  }
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
  const dataDir = definition.dataDir ?? path.relative(rootDir, path.join(routeRoot, configName)).replace(/\\/g, "/");
  const rolesDir = definition.rolesDir ?? path.relative(rootDir, rolesRoot).replace(/\\/g, "/");
  const routeName = definition.routeName?.trim() || definition.name?.trim() || configName;
  const notificationRules = normalizeRuleDefinitions(definition.notificationRules) ?? [];
  const { botNickname: _legacyBotNickname, ...cleanDefinition } = definition as GatewayDefinition & { botNickname?: string };
  const messageAdapters = normalizeMessageAdapters(definition.messageAdapters ?? [definition.messageAdapterType ?? "napcat"]);
  const agentAdapters = normalizeAgentAdapters(definition.agentAdapters ?? ["codexDesktop"]);
  return {
    ...cleanDefinition,
    id: runtimeId,
    name: definition.name ?? routeName,
    configName,
    enabled: definition.enabled !== false,
    messageAdapterType: messageAdapters[0] ?? "napcat",
    messageAdapters,
    agentAdapters,
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
  if (adapters.includes("disabled")) {
    return ["disabled"];
  }
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
    enabled: definition.enabled !== false,
    messageAdapters: definition.messageAdapters ?? [definition.messageAdapterType ?? "napcat"],
    gatewayPort: definition.gatewayPort,
    webhookPort: definition.webhookPort,
    webhookPath: definition.webhookPath,
    napcatHttpUrl: definition.napcatHttpUrl,
    napcatAccessToken: definition.napcatAccessToken,
    heartbeatIntervalSeconds: definition.heartbeatIntervalSeconds,
    heartbeatMessage: definition.heartbeatMessage,
    codexThreadName: definition.codexThreadName,
    codexCwd: definition.codexCwd,
    rolesDir: definition.rolesDir,
    agentRoleId: definition.agentRoleId,
    agentRoleFile: definition.agentRoleFile,
    agentAdapters: definition.agentAdapters,
    dataDir: definition.dataDir
  };
}

function writeRouteConfigFile(definition: GatewayDefinition): void {
  const configName = sanitizeRoleId(definition.configName) || routeRuntimeParts(definition.id).configName;
  const configPath = routeConfigPath(configName);
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, JSON.stringify(routeConfigItem(definition), null, 2), "utf8");
}

function roleMessageConfigItem(definition: GatewayDefinition): Record<string, unknown> {
  const parts = routeRuntimeParts(definition.id);
  return {
    configName: sanitizeRoleId(definition.configName) || parts.configName,
    routeVariables: definition.routeVariables ?? {},
    notificationRules: definition.notificationRules ?? []
  };
}

function readRoleMessageConfigItem(roleId: string | undefined, configName: string): Partial<GatewayDefinition> {
  const safeRoleId = sanitizeRoleId(roleId);
  if (!safeRoleId) {
    return {};
  }
  const configPath = roleMessageConfigPath(safeRoleId);
  if (!fs.existsSync(configPath)) {
    return {};
  }
  const parsed = JSON.parse(fs.readFileSync(configPath, "utf8")) as { configs?: unknown } | unknown[];
  const configs = Array.isArray(parsed) ? parsed : Array.isArray(parsed.configs) ? parsed.configs : [];
  const item = configs.find((entry) => {
    if (!entry || typeof entry !== "object") return false;
    const raw = entry as Partial<GatewayDefinition>;
    return (sanitizeRoleId(raw.configName) || sanitizeRoleId(raw.id)) === configName;
  });
  if (!item || typeof item !== "object") {
    return {};
  }
  const raw = item as Partial<GatewayDefinition>;
  return {
    routeVariables: raw.routeVariables,
    notificationRules: raw.notificationRules
  };
}

function writeRoleMessageConfigFile(roleId: string, items: GatewayDefinition[]): void {
  const configPath = roleMessageConfigPath(roleId);
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, JSON.stringify({
    configs: items.map(roleMessageConfigItem)
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
  const command = platform === "win32" ? "cmd" : platform === "darwin" ? "open" : "xdg-open";
  const args = platform === "win32" ? ["/c", "start", "", target] : [target];
  const child = spawn(command, args, {
    detached: true,
    stdio: "ignore"
  });
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
    throw new Error("Missing gateway id");
  }

  const runtime = runtimes.get(gatewayId);
  if (!runtime) {
    throw new Error(`Gateway not found: ${gatewayId}`);
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

function childCommand(): { command: string; args: string[]; shell: boolean } {
  const distEntry = path.join(rootDir, "dist", "index.js");
  if (fs.existsSync(distEntry)) {
    return { command: process.execPath, args: [distEntry], shell: false };
  }

  return { command: "npm", args: ["run", "dev"], shell: true };
}

function envFor(definition: GatewayDefinition): NodeJS.ProcessEnv {
  return {
    ...process.env,
    MESSAGE_ADAPTER_TYPE: definition.messageAdapterType ?? definition.messageAdapters?.[0] ?? "napcat",
    MESSAGE_ADAPTER_TYPES: JSON.stringify(definition.messageAdapters ?? [definition.messageAdapterType ?? "napcat"]),
    HEARTBEAT_INTERVAL_SECONDS: String(definition.heartbeatIntervalSeconds ?? 900),
    HEARTBEAT_MESSAGE: definition.heartbeatMessage ?? "定时心跳巡检：请检查最近消息和角色相关上下文。",
    NAPCAT_HTTP_URL: definition.napcatHttpUrl ?? process.env.NAPCAT_HTTP_URL ?? "http://127.0.0.1:3000",
    NAPCAT_ACCESS_TOKEN: definition.napcatAccessToken ?? process.env.NAPCAT_ACCESS_TOKEN ?? "",
    GATEWAY_PORT: String(definition.gatewayPort),
    WEBHOOK_PORT: String(definition.webhookPort ?? definition.gatewayPort),
    WEBHOOK_PATH: definition.webhookPath ?? "/webhook",
    CODEX_THREAD_NAME: definition.codexThreadName ?? definition.name ?? definition.id,
    CODEX_CWD: normalizeCodexCwd(definition.codexCwd) ?? process.env.CODEX_CWD ?? rootDir,
    ROLES_DIR: definition.rolesDir ?? path.join(definition.dataDir ?? `./data/${definition.id}`, "roles"),
    AGENT_ROLE_ID: sanitizeRoleId(definition.agentRoleId),
    AGENT_ROLE_FILE: definition.agentRoleFile ?? "persona.md",
    AGENT_ADAPTERS: Array.isArray(definition.agentAdapters) ? definition.agentAdapters.join(",") : process.env.AGENT_ADAPTERS ?? "",
    TARGET_GROUP_ID: "",
    BOT_NICKNAME: process.env.BOT_NICKNAME ?? "QQ小助手",
    ROUTE_VARIABLES: definition.routeVariables ? JSON.stringify(definition.routeVariables) : "",
    ROUTE_PROFILES: Array.isArray(definition.routeProfiles) ? JSON.stringify(definition.routeProfiles) : "",
    DATA_DIR: definition.dataDir ?? `./data/${definition.id}`,
    GROUP_NOTIFICATION_TEMPLATE: definition.groupNotificationTemplate ?? "",
    GROUP_AT_NOTIFICATION_TEMPLATE: definition.groupAtNotificationTemplate ?? "",
    GROUP_DIRECT_REPLY_NOTIFICATION_TEMPLATE: definition.groupDirectReplyNotificationTemplate ?? definition.groupReplyNotificationTemplate ?? "",
    GROUP_INDIRECT_REPLY_NOTIFICATION_TEMPLATE: definition.groupIndirectReplyNotificationTemplate ?? definition.groupNicknameNotificationTemplate ?? "",
    PRIVATE_NOTIFICATION_TEMPLATE: definition.privateNotificationTemplate ?? "",
    VOICE_TRANSCRIPT_NOTIFICATION_TEMPLATE: definition.voiceTranscriptNotificationTemplate ?? "",
    NOTIFICATION_RULES: "",
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

function dataDirFor(definition: GatewayDefinition): string {
  const parts = routeRuntimeParts(definition.id);
  const roleId = sanitizeRoleId(definition.agentRoleId) || parts.roleId;
  const configName = sanitizeRoleId(definition.configName) || parts.configName;
  return path.resolve(rootDir, definition.dataDir ?? path.join("data", "roles", roleId, "roleMessageConfig", configName));
}

function roleInfoFor(definition: GatewayDefinition): Record<string, unknown> {
  const baseDataDir = path.resolve(rootDir, definition.dataDir ?? `./data/${definition.id}`);
  const rolesDir = path.resolve(rootDir, definition.rolesDir ?? path.join(baseDataDir, "roles"));
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
    const state = JSON.parse(fs.readFileSync(statePath, "utf8")) as Record<string, unknown>;
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

function sessionIndexPath(): string {
  return path.join(os.homedir(), ".codex", "session_index.jsonl");
}

function ensureCodexStateBinding(definition: GatewayDefinition, statePath: string): void {
  const targetName = definition.codexThreadName ?? definition.name ?? definition.id;
  let existingState: Record<string, unknown> | null = null;

  if (fs.existsSync(statePath)) {
    try {
      existingState = JSON.parse(fs.readFileSync(statePath, "utf8")) as Record<string, unknown>;
      if (existingState.monitorThreadId && existingState.monitorThreadName === targetName) {
        return;
      }
    } catch {
      // Rewrite below if the state file is unreadable.
    }
  }

  const indexPath = sessionIndexPath();
  if (!fs.existsSync(indexPath)) {
    return;
  }

  const latestById = new Map<string, { id: string; threadName: string; updatedAt: string }>();
  let best: { id: string; threadName: string; updatedAt: string } | null = null;
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

  for (const record of latestById.values()) {
    if (record.threadName === targetName && (!best || Date.parse(record.updatedAt) > Date.parse(best.updatedAt))) {
      best = record;
    }
  }

  if (!best) {
    if (existingState?.monitorThreadId && existingState.monitorThreadName !== targetName) {
      fs.mkdirSync(path.dirname(statePath), { recursive: true });
      fs.writeFileSync(statePath, JSON.stringify({
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
    enabled: runtime.definition.enabled,
    messageAdapterType: runtime.definition.messageAdapterType ?? "napcat",
    messageAdapters: runtime.definition.messageAdapters ?? [runtime.definition.messageAdapterType ?? "napcat"],
    agentAdapters: runtime.definition.agentAdapters ?? ["codexDesktop"],
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

function standaloneGatewayPayload(): Record<string, unknown> {
  return {
    code: 0,
    data: {
      config: {
        gateways: [...runtimes.values()].map((runtime) => runtime.definition)
      },
      configFiles: {
        manager: routeRoot,
        routeRoot,
        rolesRoot
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

  if (fs.existsSync(standaloneWebuiPath)) {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(fs.readFileSync(standaloneWebuiPath, "utf8"));
    return;
  }

  const gateways = [...runtimes.values()].map(runtimeStatus);
  const cards = gateways.map((gateway) => {
    const running = gateway.running ? "running" : "stopped";
    const log = (gateway.log as string[]).map((line) => `<div>${escapeHtml(line)}</div>`).join("");
    return `
      <section class="card">
        <div class="row">
          <h2>${escapeHtml(String(gateway.name))}</h2>
          <span class="pill ${running}">${running}</span>
        </div>
        <div class="meta">id=${escapeHtml(String(gateway.id))} port=${gateway.gatewayPort} pid=${gateway.pid ?? "-"}</div>
        <div class="meta">thread=${escapeHtml(String(gateway.codexThreadName))}</div>
        <div class="actions">
          <form method="post" action="/gateways/${gateway.id}/start"><button>Start</button></form>
          <form method="post" action="/gateways/${gateway.id}/stop"><button>Stop</button></form>
          <form method="post" action="/gateways/${gateway.id}/restart"><button>Restart</button></form>
        </div>
        <pre>${log}</pre>
      </section>
    `;
  }).join("");

  response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  response.end(`<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Gateway Manager</title>
  <style>
    body { margin: 0; font-family: "Segoe UI", Arial, sans-serif; background: #f6f7fb; color: #1f2328; }
    header { padding: 20px 28px; background: #ffffff; border-bottom: 1px solid #dde1e7; }
    h1 { margin: 0; font-size: 22px; }
    main { display: grid; grid-template-columns: repeat(auto-fill, minmax(360px, 1fr)); gap: 16px; padding: 18px; }
    .card { background: #ffffff; border: 1px solid #dde1e7; border-radius: 8px; padding: 16px; box-shadow: 0 8px 24px rgba(31, 35, 40, 0.06); }
    .row { display: flex; justify-content: space-between; gap: 12px; align-items: center; }
    h2 { margin: 0; font-size: 18px; }
    .pill { border-radius: 999px; padding: 4px 10px; font-size: 12px; font-weight: 700; }
    .running { background: #ddf4e4; color: #1a7f37; }
    .stopped { background: #ffebe9; color: #cf222e; }
    .meta { margin-top: 8px; color: #57606a; font-size: 13px; overflow-wrap: anywhere; }
    .actions { display: flex; gap: 8px; margin: 14px 0; }
    button { border: 1px solid #afb8c1; border-radius: 6px; background: #f6f8fa; padding: 6px 12px; cursor: pointer; }
    pre { min-height: 140px; max-height: 260px; overflow: auto; margin: 0; padding: 10px; background: #0d1117; color: #c9d1d9; border-radius: 6px; font-size: 12px; white-space: pre-wrap; }
  </style>
</head>
<body>
  <header><h1>Gateway Manager</h1></header>
  <main>${cards}</main>
</body>
</html>`);
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

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
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
      if (request.method === "GET" && requestUrl.pathname === "/meta") {
        jsonResponse(response, 200, metaPayload());
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
      if (requestUrl.pathname === "/api/gateways") {
        jsonResponse(response, 200, [...runtimes.values()].map(runtimeStatus));
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

  process.on("SIGINT", () => {
    clearInterval(configWatcher);
    for (const runtime of runtimes.values()) {
      runtime.process?.kill();
    }
    process.exit(0);
  });
}

startManager();
