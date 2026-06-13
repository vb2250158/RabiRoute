import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import { normalizeAgentAdapters, type AgentAdapterType } from "./agentAdapters/types.js";
import type { MessageAdapterType } from "./adapters/messageAdapter.js";
import { normalizePipelineDefinition, resolvePipeline, type PipelineDefinition, type ResolvedPipeline } from "./pipelines.js";
import { normalizeScheduleDefinitions, type NotificationScheduleDefinition } from "./shared/gatewayConfigModel.js";
import { resolveRouteIdentity, sanitizeRoleId } from "./shared/routeIdentity.js";
import { resolveRolePaths, roleFilePath, roleFolderPath } from "./shared/routePaths.js";

dotenv.config();

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export const defaultGroupNotificationTemplate = "";
export const defaultGroupAtNotificationTemplate = "";
export const defaultGroupDirectReplyNotificationTemplate = "";
export const defaultGroupIndirectReplyNotificationTemplate = "";
export const defaultPrivateNotificationTemplate = "";
export const defaultHeartbeatNotificationTemplate = "";
export const defaultVoiceTranscriptNotificationTemplate = "";

export type NotificationRouteKind = "private" | "group_message" | "direct_at" | "direct_reply" | "indirect_reply" | "heartbeat" | "manual_trigger" | "role_panel_message" | "voice_transcript";

export type NotificationRule = {
  id: string;
  name: string;
  enabled: boolean;
  routeKinds: NotificationRouteKind[];
  targetGroupId?: string;
  regex?: string;
  schedules?: NotificationScheduleDefinition[];
  template: string;
};

export type RouteProfile = {
  id: string;
  name: string;
  enabled: boolean;
  pipelinePreset?: string;
  pipeline?: PipelineDefinition;
  resolvedPipeline: ResolvedPipeline;
  agentRoleId?: string;
  agentRoleFile: string;
  rolesDir: string;
  dataDir?: string;
  routeVariables: Record<string, string>;
  notificationRules: NotificationRule[];
};

function normalizeOptionalString(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

export type NapCatInstanceConfig = {
  id: string;
  name: string;
  enabled: boolean;
  gatewayPort: number;
  httpUrl: string;
  webuiUrl: string;
  accessToken: string;
  webuiToken?: string;
  launchCommand?: string;
  workingDir?: string;
};

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function parseRouteVariables(raw: string | undefined): Record<string, string> {
  if (!raw) {
    return {};
  }

  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {};
    }

    const variables: Record<string, string> = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(key) && value != null) {
        variables[key] = String(value);
      }
    }
    return variables;
  } catch (error) {
    console.error("Failed to parse ROUTE_VARIABLES", error);
    return {};
  }
}

function parseNotificationRules(raw: string | undefined): NotificationRule[] | null {
  if (!raw) {
    return null;
  }

  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) {
      return null;
    }

    return parsed
      .map((item, index) => normalizeNotificationRule(item, index))
      .filter((item): item is NotificationRule => Boolean(item));
  } catch (error) {
    console.error("Failed to parse NOTIFICATION_RULES", error);
    return null;
  }
}

function parseMessageAdapterType(raw: string | undefined): MessageAdapterType {
  return raw === "webhook" || raw === "remoteAgent" || raw === "fennenote" || raw === "xiaoai" || raw === "heartbeat" || raw === "rolePanel" || raw === "disabled" || raw === "napcat" ? raw : "napcat";
}

function isNotificationRouteKind(kind: unknown): kind is NotificationRouteKind {
  return kind === "private"
    || kind === "group_message"
    || kind === "direct_at"
    || kind === "direct_reply"
    || kind === "indirect_reply"
    || kind === "heartbeat"
    || kind === "manual_trigger"
    || kind === "role_panel_message"
    || kind === "voice_transcript";
}

function normalizeMessageAdapterTypes(items: unknown[]): MessageAdapterType[] {
  const adapters = items
    .map((item) => parseMessageAdapterType(item == null ? undefined : String(item)))
    .filter((item): item is MessageAdapterType => item === "napcat" || item === "remoteAgent" || item === "fennenote" || item === "xiaoai" || item === "webhook" || item === "heartbeat" || item === "rolePanel" || item === "disabled");
  if (adapters.includes("disabled")) {
    return ["disabled"];
  }
  return [...new Set(adapters)].filter((item) => item !== "disabled");
}

function parseMessageAdapterTypes(rawTypes: string | undefined, rawType: string | undefined): MessageAdapterType[] {
  if (rawTypes?.trim()) {
    try {
      const parsed = JSON.parse(rawTypes) as unknown;
      if (Array.isArray(parsed)) {
        const adapters = normalizeMessageAdapterTypes(parsed);
        return adapters.length > 0 ? adapters : ["napcat"];
      }
    } catch {
      const adapters = normalizeMessageAdapterTypes(rawTypes.split(",").map((item) => item.trim()));
      return adapters.length > 0 ? adapters : ["napcat"];
    }
  }

  return [parseMessageAdapterType(rawType)];
}

function parseAgentAdapters(rawTypes: string | undefined): AgentAdapterType[] {
  if (!rawTypes?.trim()) {
    return [];
  }

  try {
    const parsed = JSON.parse(rawTypes) as unknown;
    if (Array.isArray(parsed)) {
      return normalizeAgentAdapters(parsed);
    }
  } catch {
    return normalizeAgentAdapters(rawTypes.split(",").map((item) => item.trim()));
  }

  return [];
}

function sanitizeInstanceId(value: unknown, fallback: string): string {
  const raw = String(value || "").trim();
  return raw.replace(/[^\p{L}\p{N}_-]+/gu, "-").replace(/-+/g, "-").replace(/^[-_]+|[-_]+$/g, "") || fallback;
}

function normalizeNapCatInstance(item: unknown, index: number): NapCatInstanceConfig | null {
  if (!item || typeof item !== "object" || Array.isArray(item)) {
    return null;
  }
  const source = item as Record<string, unknown>;
  const gatewayPort = Number(source.gatewayPort ?? source.wsPort ?? source.port);
  if (!Number.isInteger(gatewayPort) || gatewayPort <= 0) {
    return null;
  }
  const id = sanitizeInstanceId(source.id, `napcat-${index + 1}`);
  return {
    id,
    name: String(source.name || source.label || id),
    enabled: source.enabled !== false,
    gatewayPort,
    httpUrl: String(source.httpUrl || source.napcatHttpUrl || "http://127.0.0.1:3000"),
    webuiUrl: String(source.webuiUrl || source.napcatWebuiUrl || "http://127.0.0.1:6099/webui"),
    accessToken: String(source.accessToken || source.napcatAccessToken || ""),
    webuiToken: String(source.webuiToken || source.napcatWebuiToken || ""),
    launchCommand: typeof source.launchCommand === "string" ? source.launchCommand : undefined,
    workingDir: typeof source.workingDir === "string" ? source.workingDir : undefined
  };
}

function parseNapCatInstances(raw: string | undefined, fallback: NapCatInstanceConfig): NapCatInstanceConfig[] {
  if (raw?.trim()) {
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (Array.isArray(parsed)) {
        const instances = parsed
          .map((item, index) => normalizeNapCatInstance(item, index))
          .filter((item): item is NapCatInstanceConfig => Boolean(item));
        if (instances.length > 0) {
          return instances;
        }
      }
    } catch (error) {
      console.error("Failed to parse NAPCAT_INSTANCES", error);
    }
  }

  return [fallback];
}

function parseRouteProfiles(raw: string | undefined): RouteProfile[] {
  if (!raw?.trim()) {
    return [];
  }

  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed
      .map((item, index) => normalizeRouteProfile(item, index))
      .filter((item): item is RouteProfile => Boolean(item));
  } catch (error) {
    console.error("Failed to parse ROUTE_PROFILES", error);
    return [];
  }
}

function parsePipelineDefinition(raw: string | undefined): PipelineDefinition | undefined {
  if (!raw?.trim()) {
    return undefined;
  }

  try {
    return normalizePipelineDefinition(JSON.parse(raw));
  } catch (error) {
    console.error("Failed to parse PIPELINE", error);
    return undefined;
  }
}

function parsePositiveNumber(raw: string | undefined, fallback: number): number {
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function normalizeNotificationRule(item: unknown, index: number): NotificationRule | null {
  if (!item || typeof item !== "object") {
    return null;
  }

  const raw = item as Partial<NotificationRule>;
  const routeKinds = Array.isArray(raw.routeKinds) ? raw.routeKinds.filter(isNotificationRouteKind) : [];

  return {
    id: raw.id || `rule-${index + 1}`,
    name: raw.name || raw.id || `规则 ${index + 1}`,
    enabled: raw.enabled !== false,
    routeKinds,
    targetGroupId: typeof raw.targetGroupId === "string" ? raw.targetGroupId.trim() : "",
    regex: typeof raw.regex === "string" ? raw.regex : "",
    schedules: normalizeScheduleDefinitions(raw.schedules),
    template: normalizeTemplateText(typeof raw.template === "string" ? raw.template : "")
  };
}

function normalizeRouteProfile(item: unknown, index: number): RouteProfile | null {
  if (!item || typeof item !== "object") {
    return null;
  }

  const raw = item as Partial<RouteProfile>;
  const identity = resolveRouteIdentity({
    id: raw.id,
    agentRoleId: raw.agentRoleId,
    fallbackConfigName: `route-${index + 1}`
  });
  const roleId = identity.roleId;
  const id = identity.runtimeId;
  const rules = parseNotificationRules(JSON.stringify(raw.notificationRules ?? [])) ?? [];
  const pipelinePreset = typeof raw.pipelinePreset === "string" && raw.pipelinePreset.trim() ? raw.pipelinePreset.trim() : undefined;
  const pipeline = normalizePipelineDefinition(raw.pipeline);
  if (rules.length === 0) {
    return null;
  }

  return {
    id,
    name: typeof raw.name === "string" && raw.name.trim() ? raw.name.trim() : id,
    enabled: raw.enabled !== false,
    pipelinePreset,
    pipeline,
    resolvedPipeline: resolvePipeline(pipelinePreset, pipeline),
    agentRoleId: roleId,
    agentRoleFile: typeof raw.agentRoleFile === "string" && raw.agentRoleFile.trim() ? raw.agentRoleFile.trim() : "persona.md",
    rolesDir: typeof raw.rolesDir === "string" && raw.rolesDir.trim() ? path.resolve(rootDir, raw.rolesDir) : rolesDir,
    dataDir: typeof raw.dataDir === "string" && raw.dataDir.trim() ? path.resolve(rootDir, raw.dataDir) : undefined,
    routeVariables: raw.routeVariables && typeof raw.routeVariables === "object" && !Array.isArray(raw.routeVariables)
      ? Object.fromEntries(Object.entries(raw.routeVariables).map(([key, value]) => [key, String(value)]))
      : {},
    notificationRules: rules
  };
}

function normalizeTemplateText(value: string): string {
  return value
    .replace(/\\r\\n/g, "\n")
    .replace(/\\n/g, "\n");
}

function normalizeCodexCwd(value: string | undefined): string | undefined {
  const trimmed = value?.trim() ?? "";
  const compact = trimmed.replace(/\\/g, "/").replace(/\/+/g, "/").toLowerCase();
  if (!trimmed || compact === "c:/path/to/your/project") {
    return undefined;
  }

  return trimmed;
}

const botNickname = process.env.BOT_NICKNAME ?? "QQ小助手";
const baseDataDir = path.resolve(rootDir, process.env.DATA_DIR ?? path.join("data", "route", "default"));
const rolesDir = path.resolve(rootDir, process.env.ROLES_DIR ?? path.join("data", "roles"));
const agentRoleId = sanitizeRoleId(process.env.AGENT_ROLE_ID);
const agentRoleFile = process.env.AGENT_ROLE_FILE?.trim() || "persona.md";
const agentRoleDir = agentRoleId ? roleFolderPath(rolesDir, agentRoleId) : "";
const agentRolePath = agentRoleId ? roleFilePath(rolesDir, agentRoleId, agentRoleFile) : "";
const notificationRules = parseNotificationRules(process.env.NOTIFICATION_RULES) ?? [];
const routeProfiles = parseRouteProfiles(process.env.ROUTE_PROFILES);
const pipelinePreset = process.env.PIPELINE_PRESET?.trim() || undefined;
const pipeline = parsePipelineDefinition(process.env.PIPELINE);
const agentModel = normalizeOptionalString(process.env.AGENT_MODEL);
const defaultNapCatInstance: NapCatInstanceConfig = {
  id: "default",
  name: "默认 NapCat",
  enabled: true,
  gatewayPort: Number(process.env.GATEWAY_PORT ?? "8789"),
  httpUrl: process.env.NAPCAT_HTTP_URL ?? "http://127.0.0.1:3000",
  webuiUrl: process.env.NAPCAT_WEBUI_URL ?? "http://127.0.0.1:6099/webui",
  accessToken: process.env.NAPCAT_ACCESS_TOKEN ?? "",
  webuiToken: process.env.NAPCAT_WEBUI_TOKEN ?? "",
  launchCommand: process.env.NAPCAT_LAUNCH_COMMAND,
  workingDir: process.env.NAPCAT_WORKING_DIR
};
const napcatInstances = parseNapCatInstances(process.env.NAPCAT_INSTANCES, defaultNapCatInstance);
const primaryNapcatInstance = napcatInstances.find((item) => item.enabled) ?? napcatInstances[0] ?? defaultNapCatInstance;

export const config = {
  messageAdapterType: parseMessageAdapterType(process.env.MESSAGE_ADAPTER_TYPE),
  messageAdapterTypes: parseMessageAdapterTypes(process.env.MESSAGE_ADAPTER_TYPES, process.env.MESSAGE_ADAPTER_TYPE),
  heartbeatIntervalSeconds: parsePositiveNumber(process.env.HEARTBEAT_INTERVAL_SECONDS, 900),
  heartbeatMessage: process.env.HEARTBEAT_MESSAGE || "定时心跳巡检：请检查最近消息和角色相关上下文。",
  remoteAgentDefaultDeviceId: process.env.REMOTE_AGENT_DEFAULT_DEVICE_ID?.trim() || "",
  remoteAgentDefaultCwd: process.env.REMOTE_AGENT_DEFAULT_CWD?.trim() || "",
  remoteAgentDefaultThreadName: process.env.REMOTE_AGENT_DEFAULT_THREAD_NAME?.trim() || "",
  napcatInstances,
  napcatHttpUrl: primaryNapcatInstance.httpUrl,
  napcatWebuiUrl: primaryNapcatInstance.webuiUrl,
  napcatAccessToken: primaryNapcatInstance.accessToken,
  napcatWebuiToken: primaryNapcatInstance.webuiToken ?? "",
  webhookPath: process.env.WEBHOOK_PATH ?? "/webhook",
  gatewayPort: primaryNapcatInstance.gatewayPort,
  webhookPort: Number(process.env.WEBHOOK_PORT ?? process.env.GATEWAY_PORT ?? "8789"),
  fenneNoteWebhookPath: process.env.FENNENOTE_WEBHOOK_PATH ?? process.env.FENNOTE_WEBHOOK_PATH ?? "/fennenote",
  fenneNoteWebhookPort: Number(process.env.FENNENOTE_WEBHOOK_PORT ?? process.env.FENNOTE_WEBHOOK_PORT ?? process.env.WEBHOOK_PORT ?? process.env.GATEWAY_PORT ?? "8789"),
  xiaoaiWebhookPath: process.env.XIAOAI_WEBHOOK_PATH ?? "/xiaoai",
  xiaoaiWebhookPort: Number(process.env.XIAOAI_WEBHOOK_PORT ?? process.env.WEBHOOK_PORT ?? process.env.GATEWAY_PORT ?? "8789"),
  codexAppServerUrl: process.env.CODEX_APP_SERVER_URL ?? "ws://127.0.0.1:4500",
  codexDirectNotify: process.env.CODEX_DIRECT_NOTIFY === "1",
  codexDesktopIpcNotify: process.env.CODEX_DESKTOP_IPC_NOTIFY !== "0",
  agentAdapters: parseAgentAdapters(process.env.AGENT_ADAPTERS),
  agentModel,
  codexThreadName: process.env.CODEX_THREAD_NAME ?? "QQ 消息监听",
  codexCwd: normalizeCodexCwd(process.env.CODEX_CWD) ?? process.cwd(),
  targetGroupId: process.env.TARGET_GROUP_ID ?? "",
  botNickname,
  botUserId: "",
  routeVariables: parseRouteVariables(process.env.ROUTE_VARIABLES),
  pipelinePreset,
  pipeline,
  resolvedPipeline: resolvePipeline(pipelinePreset, pipeline),
  baseDataDir,
  rolesDir,
  agentRoleId,
  agentRoleFile,
  agentRoleDir,
  agentRolePath,
  memoryDataDir: agentRoleDir || baseDataDir,
  dataDir: baseDataDir,
  groupNotificationTemplate: process.env.GROUP_NOTIFICATION_TEMPLATE || defaultGroupNotificationTemplate,
  groupAtNotificationTemplate: process.env.GROUP_AT_NOTIFICATION_TEMPLATE || process.env.GROUP_NOTIFICATION_TEMPLATE || defaultGroupAtNotificationTemplate,
  groupDirectReplyNotificationTemplate: process.env.GROUP_DIRECT_REPLY_NOTIFICATION_TEMPLATE || process.env.GROUP_REPLY_NOTIFICATION_TEMPLATE || process.env.GROUP_NOTIFICATION_TEMPLATE || defaultGroupDirectReplyNotificationTemplate,
  groupIndirectReplyNotificationTemplate: process.env.GROUP_INDIRECT_REPLY_NOTIFICATION_TEMPLATE || process.env.GROUP_NICKNAME_NOTIFICATION_TEMPLATE || process.env.GROUP_NOTIFICATION_TEMPLATE || defaultGroupIndirectReplyNotificationTemplate,
  privateNotificationTemplate: process.env.PRIVATE_NOTIFICATION_TEMPLATE || defaultPrivateNotificationTemplate,
  heartbeatNotificationTemplate: process.env.HEARTBEAT_NOTIFICATION_TEMPLATE || defaultHeartbeatNotificationTemplate,
  voiceTranscriptNotificationTemplate: process.env.VOICE_TRANSCRIPT_NOTIFICATION_TEMPLATE || defaultVoiceTranscriptNotificationTemplate,
  notificationRules,
  routeProfiles
};

export function setBotProfile(profile: { nickname?: string; userId?: string | number }): void {
  if (profile.nickname?.trim()) {
    config.botNickname = profile.nickname.trim();
  }
  if (profile.userId != null && String(profile.userId).trim()) {
    config.botUserId = String(profile.userId).trim();
  }
}

export function rolePathsFor(agentRoleId: string | undefined): { roleId: string; roleDir: string; rolePath: string; dataDir: string } {
  return rolePathsForRoute({
    agentRoleId,
    agentRoleFile: config.agentRoleFile,
    rolesDir: config.rolesDir,
    dataDir: undefined
  });
}

export function rolePathsForRoute(route: Pick<RouteProfile, "agentRoleId" | "agentRoleFile" | "rolesDir" | "dataDir">): { roleId: string; roleDir: string; rolePath: string; dataDir: string } {
  return resolveRolePaths({
    agentRoleId: route.agentRoleId,
    agentRoleFile: route.agentRoleFile,
    rolesDir: route.rolesDir || config.rolesDir,
    dataDir: route.dataDir,
    fallbackRoleId: config.agentRoleId,
    fallbackAgentRoleFile: config.agentRoleFile,
    fallbackDataDir: config.memoryDataDir
  });
}

export function isTargetGroup(groupId: number | string | undefined): boolean {
  if (!groupId) {
    return false;
  }

  return !config.targetGroupId || String(groupId) === config.targetGroupId;
}
