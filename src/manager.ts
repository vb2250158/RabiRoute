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

type RoleRouteFiles = {
  roleNotificationRules: Record<string, NotificationRuleDefinition[]>;
  roleRouteNames: Record<string, string>;
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
const configPath = path.resolve(rootDir, process.env.GATEWAY_MANAGER_CONFIG ?? path.join("data", "gateways.json"));
const managerPort = Number(process.env.GATEWAY_MANAGER_PORT ?? "8790");
const standaloneWebuiPath = path.join(rootDir, "ribiwebgui", "gateways.html");
const runtimes = new Map<string, GatewayRuntime>();

function definitionFingerprint(definition: GatewayDefinition): string {
  return JSON.stringify(definition);
}

function defaultGatewayConfig(): GatewayConfigFile {
  return {
    gateways: [
      {
        id: "default-main",
        name: "默认 QQ 网关",
        enabled: true,
        messageAdapters: ["napcat", "heartbeat"],
        gatewayPort: 8789,
        napcatHttpUrl: "http://127.0.0.1:3000",
        napcatAccessToken: "",
        heartbeatIntervalSeconds: 900,
        heartbeatMessage: "定时心跳巡检：请检查最近消息和角色相关上下文。",
        codexThreadName: "QQ 消息监听",
        codexCwd: "",
        rolesDir: "./data/default-main/roles",
        agentRoleId: "",
        agentRoleFile: "persona.md",
        agentAdapters: ["codexDesktop"],
        dataDir: "./data/default-main",
        routeVariables: {},
        messageAdapterType: "napcat",
        routeName: "默认路由",
        roleRouteNames: {}
      }
    ]
  };
}

function ensureConfigFile(): void {
  if (fs.existsSync(configPath)) {
    return;
  }

  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  const exampleDataDir = path.join(rootDir, "examples", "data");
  if (fs.existsSync(path.join(exampleDataDir, "gateways.json"))) {
    fs.cpSync(exampleDataDir, path.dirname(configPath), {
      recursive: true,
      force: false,
      errorOnExist: false
    });
    return;
  }

  fs.writeFileSync(configPath, JSON.stringify(defaultGatewayConfig(), null, 2), "utf8");
}

function readConfig(): GatewayConfigFile {
  ensureConfigFile();
  const parsed = JSON.parse(fs.readFileSync(configPath, "utf8")) as GatewayConfigFile;
  if (!Array.isArray(parsed.gateways)) {
    throw new Error(`Invalid gateway config: ${configPath}`);
  }

  return parsed;
}

function writeConfig(config: GatewayConfigFile): GatewayConfigFile {
  if (!Array.isArray(config.gateways)) {
    throw new Error("gateways must be an array");
  }

  const normalized = {
    gateways: config.gateways.map(normalizeDefinition)
  };
  writeRoleRuleFiles(normalized.gateways);
  fs.writeFileSync(configPath, JSON.stringify(normalized, null, 2), "utf8");
  return normalized;
}

function normalizeDefinition(definition: GatewayDefinition): GatewayDefinition {
  if (!definition.id || !/^[a-zA-Z0-9_-]+$/.test(definition.id)) {
    throw new Error(`Invalid gateway id: ${definition.id}`);
  }
  if (!Number.isInteger(definition.gatewayPort) || definition.gatewayPort <= 0) {
    throw new Error(`Invalid gateway port for ${definition.id}: ${definition.gatewayPort}`);
  }

  const dataDir = definition.dataDir ?? `./data/${definition.id}`;
  const rolesDir = definition.rolesDir ?? path.join(dataDir, "roles");
  const roleRouteFiles = readRoleRouteFiles(rolesDir);
  const { botNickname: _legacyBotNickname, ...cleanDefinition } = definition as GatewayDefinition & { botNickname?: string };
  const messageAdapters = normalizeMessageAdapters(definition.messageAdapters ?? [definition.messageAdapterType ?? "napcat"]);
  const agentAdapters = normalizeAgentAdapters(definition.agentAdapters ?? ["codexDesktop"]);
  return {
    ...cleanDefinition,
    name: definition.name ?? definition.id,
    enabled: definition.enabled !== false,
    messageAdapterType: messageAdapters[0] ?? "napcat",
    messageAdapters,
    agentAdapters,
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
    notificationRules: normalizeRuleDefinitions(definition.notificationRules),
    dataDir,
    rolesDir,
    agentRoleFile: definition.agentRoleFile ?? "persona.md",
    roleNotificationRules: normalizeRoleNotificationRules(definition.roleNotificationRules ?? roleRouteFiles.roleNotificationRules),
    roleRouteNames: definition.roleRouteNames ?? roleRouteFiles.roleRouteNames,
    routeProfiles: normalizeRouteProfiles(definition, roleRouteFiles, dataDir, rolesDir)
  };
}

function normalizeRouteProfiles(definition: GatewayDefinition, roleRouteFiles: RoleRouteFiles, dataDir: string, rolesDir: string): RouteProfileDefinition[] {
  if (Array.isArray(definition.routeProfiles) && definition.routeProfiles.length > 0) {
    const explicitProfiles = definition.routeProfiles
      .map((profile, index) => normalizeRouteProfile(profile, index, definition, dataDir, rolesDir))
      .filter((profile): profile is RouteProfileDefinition => Boolean(profile));
    if (explicitProfiles.length > 0) {
      return explicitProfiles;
    }
  }

  const roleRules = normalizeRoleNotificationRules(definition.roleNotificationRules ?? roleRouteFiles.roleNotificationRules);
  const roleNames = definition.roleRouteNames ?? roleRouteFiles.roleRouteNames;
  const roleProfiles = Object.entries(roleRules).map(([roleId, rules]) => normalizeRouteProfile({
    id: roleId,
    name: roleNames[roleId] || roleId,
    enabled: true,
    agentRoleId: roleId,
    agentRoleFile: definition.agentRoleFile ?? "persona.md",
    rolesDir,
    routeVariables: definition.routeVariables,
    notificationRules: rules
  }, 0, definition, dataDir, rolesDir)).filter((profile): profile is RouteProfileDefinition => Boolean(profile));

  if (roleProfiles.length > 0) {
    return roleProfiles;
  }

  const fallbackRules = normalizeRuleDefinitions(definition.notificationRules) ?? [];
  if (fallbackRules.length === 0) {
    return [];
  }

  return [normalizeRouteProfile({
    id: sanitizeRoleId(definition.agentRoleId) || "default",
    name: definition.routeName || definition.name || "默认路由",
    enabled: true,
    agentRoleId: definition.agentRoleId,
    agentRoleFile: definition.agentRoleFile ?? "persona.md",
    rolesDir,
    routeVariables: definition.routeVariables,
    notificationRules: fallbackRules
  }, 0, definition, dataDir, rolesDir)].filter((profile): profile is RouteProfileDefinition => Boolean(profile));
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

function normalizeRoleNotificationRules(rawRules: unknown): Record<string, NotificationRuleDefinition[]> {
  const result: Record<string, NotificationRuleDefinition[]> = {};
  if (!rawRules || typeof rawRules !== "object" || Array.isArray(rawRules)) {
    return result;
  }

  for (const [roleId, rules] of Object.entries(rawRules)) {
    const safeRoleId = sanitizeRoleId(roleId);
    const normalizedRules = normalizeRuleDefinitions(rules);
    if (safeRoleId && normalizedRules && normalizedRules.length > 0) {
      result[safeRoleId] = normalizedRules;
    }
  }

  return result;
}

function readRoleRouteFiles(rolesDir: string): RoleRouteFiles {
  const absoluteRolesDir = path.resolve(rootDir, rolesDir);
  const result: RoleRouteFiles = {
    roleNotificationRules: {},
    roleRouteNames: {}
  };
  if (!fs.existsSync(absoluteRolesDir)) {
    return result;
  }

  for (const entry of fs.readdirSync(absoluteRolesDir, { withFileTypes: true })) {
    if (!entry.isDirectory() || !sanitizeRoleId(entry.name)) {
      continue;
    }
    const routesPath = path.join(absoluteRolesDir, entry.name, "routes.json");
    if (!fs.existsSync(routesPath)) {
      continue;
    }
    try {
      const parsed = JSON.parse(fs.readFileSync(routesPath, "utf8")) as unknown;
      const rules = Array.isArray(parsed)
        ? parsed
        : parsed && typeof parsed === "object" && Array.isArray((parsed as { notificationRules?: unknown }).notificationRules)
          ? (parsed as { notificationRules: unknown[] }).notificationRules
          : [];
      result.roleNotificationRules[entry.name] = rules as NotificationRuleDefinition[];
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed) && typeof (parsed as { routeName?: unknown }).routeName === "string") {
        result.roleRouteNames[entry.name] = ((parsed as { routeName: string }).routeName).trim();
      }
    } catch (error) {
      console.warn(`Failed to read role routes: ${routesPath}`, error);
    }
  }
  return result;
}

function writeRoleRuleFiles(gateways: GatewayDefinition[]): void {
  for (const gateway of gateways) {
    if (!gateway.roleNotificationRules || !gateway.rolesDir) {
      continue;
    }
    const absoluteRolesDir = path.resolve(rootDir, gateway.rolesDir);
    for (const [roleId, rules] of Object.entries(gateway.roleNotificationRules)) {
      const safeRoleId = sanitizeRoleId(roleId);
      if (!safeRoleId || !Array.isArray(rules)) {
        continue;
      }
      const roleDir = path.join(absoluteRolesDir, safeRoleId);
      fs.mkdirSync(roleDir, { recursive: true });
      const routeName = gateway.roleRouteNames?.[safeRoleId] || (gateway.agentRoleId === safeRoleId ? gateway.routeName : "") || safeRoleId;
      fs.writeFileSync(path.join(roleDir, "routes.json"), JSON.stringify({
        routeName,
        notificationRules: rules
      }, null, 2), "utf8");
    }
  }
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
  const activeRoleRules = definition.agentRoleId && definition.roleNotificationRules?.[definition.agentRoleId]
    ? definition.roleNotificationRules[definition.agentRoleId]
    : definition.notificationRules;
  return {
    ...process.env,
    MESSAGE_ADAPTER_TYPE: definition.messageAdapterType ?? definition.messageAdapters?.[0] ?? "napcat",
    MESSAGE_ADAPTER_TYPES: JSON.stringify(definition.messageAdapters ?? [definition.messageAdapterType ?? "napcat"]),
    HEARTBEAT_INTERVAL_SECONDS: String(definition.heartbeatIntervalSeconds ?? 900),
    HEARTBEAT_MESSAGE: definition.heartbeatMessage ?? "定时心跳巡检：请检查最近消息和角色相关上下文。",
    NAPCAT_HTTP_URL: definition.napcatHttpUrl ?? process.env.NAPCAT_HTTP_URL ?? "http://127.0.0.1:3000",
    NAPCAT_ACCESS_TOKEN: definition.napcatAccessToken ?? process.env.NAPCAT_ACCESS_TOKEN ?? "",
    GATEWAY_PORT: String(definition.gatewayPort),
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
    NOTIFICATION_RULES: Array.isArray(activeRoleRules) ? JSON.stringify(activeRoleRules) : "",
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
  const baseDataDir = path.resolve(rootDir, definition.dataDir ?? `./data/${definition.id}`);
  const roleId = sanitizeRoleId(definition.agentRoleId);
  if (!roleId) {
    return baseDataDir;
  }

  return path.join(path.resolve(rootDir, definition.rolesDir ?? path.join(baseDataDir, "roles")), roleId);
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
  if (fs.existsSync(statePath)) {
    try {
      const state = JSON.parse(fs.readFileSync(statePath, "utf8")) as Record<string, unknown>;
      if (state.monitorThreadId) {
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

  const targetName = definition.codexThreadName ?? definition.name ?? definition.id;
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
      if (parsed.thread_name !== targetName) {
        continue;
      }
      if (!best || Date.parse(parsed.updated_at) > Date.parse(best.updatedAt)) {
        best = {
          id: parsed.id,
          threadName: parsed.thread_name,
          updatedAt: parsed.updated_at
        };
      }
    } catch {
      // Ignore malformed JSONL lines.
    }
  }

  if (!best) {
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
      config: readConfig(),
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

function htmlResponse(response: http.ServerResponse): void {
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
      htmlResponse(response);
    } catch (error) {
      jsonResponse(response, 500, { error: error instanceof Error ? error.message : String(error) });
    }
  });

  server.listen(managerPort, "127.0.0.1", () => {
    console.log(`gateway-manager listening on http://127.0.0.1:${managerPort}`);
    console.log(`config: ${configPath}`);
  });

  process.on("SIGINT", () => {
    for (const runtime of runtimes.values()) {
      runtime.process?.kill();
    }
    process.exit(0);
  });
}

startManager();
