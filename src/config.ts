import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import type { MessageAdapterType } from "./adapters/messageAdapter.js";

dotenv.config();

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export const defaultGroupNotificationTemplate = [
  "QQ 消息更新提醒：群聊里有人 @ 了机器人。",
  "时间：{time}",
  "目标：{messageTarget}",
  "群号：{groupId}",
  "发送者：{sender}",
  "消息：{message}",
  "",
  "请在需要时读取 {groupLogPath} 查看上下文。"
].join("\n");

export const defaultGroupAtNotificationTemplate = defaultGroupNotificationTemplate;
export const defaultGroupDirectReplyNotificationTemplate = defaultGroupNotificationTemplate.replace("群聊里有人 @ 了机器人", "群聊里有人直接回复机器人");
export const defaultGroupIndirectReplyNotificationTemplate = defaultGroupNotificationTemplate.replace("群聊里有人 @ 了机器人", "群聊里有人回复了一条提到机器人的消息");

export const defaultPrivateNotificationTemplate = [
  "QQ 消息更新提醒：收到一条私聊消息。",
  "时间：{time}",
  "目标：{messageTarget}",
  "发送者：{sender}",
  "QQ：{userId}",
  "消息：{message}",
  "",
  "请在需要时读取 {privateLogPath} 查看上下文。"
].join("\n");

export type NotificationRouteKind = "private" | "group_message" | "direct_at" | "direct_reply" | "indirect_reply";

export type NotificationRule = {
  id: string;
  name: string;
  enabled: boolean;
  routeKinds: NotificationRouteKind[];
  targetGroupId?: string;
  regex?: string;
  template: string;
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
  return raw === "webhook" || raw === "disabled" || raw === "napcat" ? raw : "napcat";
}

function normalizeNotificationRule(item: unknown, index: number): NotificationRule | null {
  if (!item || typeof item !== "object") {
    return null;
  }

  const raw = item as Partial<NotificationRule>;
  if (typeof raw.template !== "string" || !raw.template.trim()) {
    return null;
  }

  const routeKinds = Array.isArray(raw.routeKinds)
    ? raw.routeKinds.filter((kind): kind is NotificationRouteKind => {
      return kind === "private" || kind === "group_message" || kind === "direct_at" || kind === "direct_reply" || kind === "indirect_reply";
    })
    : [];

  return {
    id: raw.id || `rule-${index + 1}`,
    name: raw.name || raw.id || `规则 ${index + 1}`,
    enabled: raw.enabled !== false,
    routeKinds,
    targetGroupId: typeof raw.targetGroupId === "string" ? raw.targetGroupId.trim() : "",
    regex: typeof raw.regex === "string" ? raw.regex : "",
    template: raw.template
  };
}

function sanitizeRoleId(raw: string | undefined): string {
  const value = raw?.trim() ?? "";
  return /^[a-zA-Z0-9_-]+$/.test(value) ? value : "";
}

function defaultNotificationRules(): NotificationRule[] {
  return [
    {
      id: "group-direct-at",
      name: "直接 @ 模板",
      enabled: true,
      routeKinds: ["direct_at"],
      targetGroupId: "",
      regex: "",
      template: process.env.GROUP_AT_NOTIFICATION_TEMPLATE || process.env.GROUP_NOTIFICATION_TEMPLATE || defaultGroupAtNotificationTemplate
    },
    {
      id: "group-direct-reply",
      name: "直接回复模板",
      enabled: true,
      routeKinds: ["direct_reply"],
      targetGroupId: "",
      regex: "",
      template: process.env.GROUP_DIRECT_REPLY_NOTIFICATION_TEMPLATE || process.env.GROUP_REPLY_NOTIFICATION_TEMPLATE || process.env.GROUP_NOTIFICATION_TEMPLATE || defaultGroupDirectReplyNotificationTemplate
    },
    {
      id: "group-indirect-reply",
      name: "间接回复模板",
      enabled: true,
      routeKinds: ["indirect_reply"],
      targetGroupId: "",
      regex: "",
      template: process.env.GROUP_INDIRECT_REPLY_NOTIFICATION_TEMPLATE || process.env.GROUP_NICKNAME_NOTIFICATION_TEMPLATE || process.env.GROUP_NOTIFICATION_TEMPLATE || defaultGroupIndirectReplyNotificationTemplate
    },
    {
      id: "private-message",
      name: "私聊消息模板",
      enabled: true,
      routeKinds: ["private"],
      targetGroupId: "",
      regex: "",
      template: process.env.PRIVATE_NOTIFICATION_TEMPLATE || defaultPrivateNotificationTemplate
    }
  ];
}

const botNickname = process.env.BOT_NICKNAME ?? "QQ小助手";
const baseDataDir = path.resolve(rootDir, process.env.DATA_DIR ?? "./data");
const rolesDir = path.resolve(rootDir, process.env.ROLES_DIR ?? path.join(baseDataDir, "roles"));
const agentRoleId = sanitizeRoleId(process.env.AGENT_ROLE_ID);
const agentRoleFile = process.env.AGENT_ROLE_FILE?.trim() || "persona.md";
const agentRoleDir = agentRoleId ? path.join(rolesDir, agentRoleId) : "";
const agentRolePath = agentRoleDir ? path.join(agentRoleDir, agentRoleFile) : "";

export const config = {
  messageAdapterType: parseMessageAdapterType(process.env.MESSAGE_ADAPTER_TYPE),
  napcatHttpUrl: process.env.NAPCAT_HTTP_URL ?? "http://127.0.0.1:3000",
  napcatAccessToken: process.env.NAPCAT_ACCESS_TOKEN ?? "",
  gatewayPort: Number(process.env.GATEWAY_PORT ?? "8789"),
  codexAppServerUrl: process.env.CODEX_APP_SERVER_URL ?? "ws://127.0.0.1:4500",
  codexDirectNotify: process.env.CODEX_DIRECT_NOTIFY === "1",
  codexDesktopIpcNotify: process.env.CODEX_DESKTOP_IPC_NOTIFY !== "0",
  forwardTargets: (process.env.FORWARD_TARGETS ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter((item): item is "codexDesktop" | "codexApp" => item === "codexDesktop" || item === "codexApp"),
  codexThreadName: process.env.CODEX_THREAD_NAME ?? "QQ 消息监听",
  codexCwd: process.env.CODEX_CWD ?? process.cwd(),
  targetGroupId: process.env.TARGET_GROUP_ID ?? "",
  botNickname,
  botUserId: "",
  routeVariables: parseRouteVariables(process.env.ROUTE_VARIABLES),
  baseDataDir,
  rolesDir,
  agentRoleId,
  agentRoleFile,
  agentRoleDir,
  agentRolePath,
  dataDir: agentRoleDir || baseDataDir,
  groupNotificationTemplate: process.env.GROUP_NOTIFICATION_TEMPLATE || defaultGroupNotificationTemplate,
  groupAtNotificationTemplate: process.env.GROUP_AT_NOTIFICATION_TEMPLATE || process.env.GROUP_NOTIFICATION_TEMPLATE || defaultGroupAtNotificationTemplate,
  groupDirectReplyNotificationTemplate: process.env.GROUP_DIRECT_REPLY_NOTIFICATION_TEMPLATE || process.env.GROUP_REPLY_NOTIFICATION_TEMPLATE || process.env.GROUP_NOTIFICATION_TEMPLATE || defaultGroupDirectReplyNotificationTemplate,
  groupIndirectReplyNotificationTemplate: process.env.GROUP_INDIRECT_REPLY_NOTIFICATION_TEMPLATE || process.env.GROUP_NICKNAME_NOTIFICATION_TEMPLATE || process.env.GROUP_NOTIFICATION_TEMPLATE || defaultGroupIndirectReplyNotificationTemplate,
  privateNotificationTemplate: process.env.PRIVATE_NOTIFICATION_TEMPLATE || defaultPrivateNotificationTemplate,
  notificationRules: parseNotificationRules(process.env.NOTIFICATION_RULES) ?? defaultNotificationRules()
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
  const roleId = sanitizeRoleId(agentRoleId) || config.agentRoleId;
  const roleDir = roleId ? path.join(config.rolesDir, roleId) : "";
  return {
    roleId,
    roleDir,
    rolePath: roleDir ? path.join(roleDir, config.agentRoleFile) : "",
    dataDir: roleDir || config.baseDataDir
  };
}

export function isTargetGroup(groupId: number | string | undefined): boolean {
  if (!groupId) {
    return false;
  }

  return !config.targetGroupId || String(groupId) === config.targetGroupId;
}
