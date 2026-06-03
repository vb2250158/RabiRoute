import path from "node:path";
import { notifyCodex } from "./codexApp.js";
import { notifyCodexDesktop } from "./codexDesktopIpc.js";
import { config, rolePathsFor, type NotificationRule } from "./config.js";
import { appendCodexNotificationToDir, appendGroupMessageToDir, appendPrivateMessageToDir, type GroupMessageRecord, type PrivateMessageRecord } from "./history.js";

export type ForwardRouteKind = "private" | "group_message" | "direct_at" | "direct_reply" | "indirect_reply";
type ForwardLogKind = "private" | "group_mention";
type ForwardTarget = "codexDesktop" | "codexApp";

export type ForwardTemplateValues = Record<string, string | number | undefined>;

function formatTime(epochSeconds: number): string {
  return new Date(epochSeconds * 1000).toLocaleString("zh-CN", { hour12: false });
}

function renderTemplate(template: string, values: ForwardTemplateValues): string {
  return template.replace(/\{([a-zA-Z0-9_]+)\}/g, (match, key: string) => {
    const value = values[key];
    return value == null ? match : String(value);
  });
}

function appendAgentRoleReference(message: string, rolePath: string): string {
  if (!rolePath) {
    return message;
  }

  return `${message.trimEnd()}\n\n请遵循角色文件：${rolePath} 进行回复。`;
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function expandRouteVariables(pattern: string, variables: Record<string, string>): string {
  let expanded = pattern;
  const entries = Object.entries(variables)
    .sort(([left], [right]) => right.length - left.length);

  for (const [key, value] of entries) {
    const escapedKey = escapeRegex(key);
    expanded = expanded
      .replace(new RegExp(`\\{${escapedKey}\\}`, "g"), escapeRegex(value))
      .replace(new RegExp(`\\b${escapedKey}\\b`, "g"), escapeRegex(value));
  }

  return expanded;
}

function routeVariablesFor(record: GroupMessageRecord | PrivateMessageRecord, extraValues: ForwardTemplateValues): Record<string, string> {
  const isGroup = "groupId" in record;
  const variables: Record<string, string> = {
    ...config.routeVariables,
    SenderQQId: String(record.userId),
    GroupId: isGroup ? String(record.groupId) : "",
    ReplyMessageId: extraValues.repliedMessageId == null ? "" : String(extraValues.repliedMessageId)
  };

  if (extraValues.selfId != null) {
    variables.RobotQQId = String(extraValues.selfId);
  }

  return variables;
}

function routeTextFromRawMessage(rawMessage: string, variables: Record<string, string>): string {
  return rawMessage
    .replace(/\[CQ:reply,id=([^\],]+)[^\]]*\]/g, (_match, id: string) => `[Reply:${id}]`)
    .replace(/\[CQ:at,qq=([^\],]+)[^\]]*\]/g, (_match, qq: string) => {
      return `@${qq}`;
    });
}

function routeMatchText(record: GroupMessageRecord | PrivateMessageRecord, variables: Record<string, string>, extraValues: ForwardTemplateValues): string {
  const parts = [routeTextFromRawMessage(record.rawMessage, variables)];
  if (typeof extraValues.repliedMessage === "string" && extraValues.repliedMessage.trim()) {
    parts.push(routeTextFromRawMessage(extraValues.repliedMessage, variables));
  }
  return parts.join("\n");
}

function configuredForwardTargets(): ForwardTarget[] {
  if (config.forwardTargets.length > 0) {
    return config.forwardTargets;
  }
  if (config.codexDesktopIpcNotify) {
    return ["codexDesktop"];
  }
  if (config.codexDirectNotify) {
    return ["codexApp"];
  }
  return [];
}

function ruleMatches(
  rule: NotificationRule,
  routeKind: ForwardRouteKind,
  record: GroupMessageRecord | PrivateMessageRecord,
  extraValues: ForwardTemplateValues
): boolean {
  if (!rule.enabled) {
    return false;
  }

  if (rule.routeKinds.length > 0 && !rule.routeKinds.includes(routeKind)) {
    return false;
  }

  if (rule.targetGroupId?.trim()) {
    if (!("groupId" in record) || String(record.groupId) !== rule.targetGroupId.trim()) {
      return false;
    }
  }

  if (!rule.regex?.trim()) {
    return true;
  }

  try {
    const variables = routeVariablesFor(record, extraValues);
    return new RegExp(expandRouteVariables(rule.regex, variables)).test(routeMatchText(record, variables, extraValues));
  } catch (error) {
    console.error(`Invalid notification rule regex: ${rule.id}`, error);
    return false;
  }
}

function ruleForRoute(
  routeKind: ForwardRouteKind,
  record: GroupMessageRecord | PrivateMessageRecord,
  extraValues: ForwardTemplateValues
): NotificationRule | null {
  return config.notificationRules.find((item) => ruleMatches(item, routeKind, record, extraValues)) ?? null;
}

function commonTemplateValues(
  record: GroupMessageRecord | PrivateMessageRecord,
  extraValues: ForwardTemplateValues,
  roleContext = rolePathsFor(config.agentRoleId)
): ForwardTemplateValues {
  const sender = record.senderName || record.userId;
  const isGroup = "groupId" in record;
  const targetId = isGroup ? record.groupId : record.userId;
  const targetType = isGroup ? "group" : "private";
  const routeVariables = routeVariablesFor(record, extraValues);
  const routeText = routeTextFromRawMessage(record.rawMessage, routeVariables);
  const repliedRouteText = typeof extraValues.repliedMessage === "string"
    ? routeTextFromRawMessage(extraValues.repliedMessage, routeVariables)
    : undefined;
  return {
    ...routeVariables,
    time: formatTime(record.time),
    sender,
    senderName: record.senderName,
    userId: record.userId,
    groupId: isGroup ? record.groupId : undefined,
    targetType,
    targetId,
    messageTarget: isGroup ? `群 ${targetId}` : `私聊 ${targetId}`,
    message: record.rawMessage,
    rawMessage: record.rawMessage,
    routeText,
    repliedRouteText,
    messageId: record.messageId,
    botNickname: config.botNickname,
    agentRoleId: roleContext.roleId,
    agentRolePath: roleContext.rolePath,
    agentRoleDir: roleContext.roleDir,
    dataDir: roleContext.dataDir,
    groupLogPath: path.join(roleContext.dataDir, "group-messages.jsonl"),
    privateLogPath: path.join(roleContext.dataDir, "private-messages.jsonl")
  };
}

function logKindForRoute(routeKind: ForwardRouteKind): ForwardLogKind {
  return routeKind === "private" ? "private" : "group_mention";
}

function dispatchToTarget(target: ForwardTarget, message: string): void {
  if (target === "codexDesktop") {
    void notifyCodexDesktop(message).catch((error) => console.error("Failed to forward message to Codex Desktop", error));
    return;
  }

  void notifyCodex(message).catch((error) => console.error("Failed to forward message to Codex app-server", error));
}

export function forwardMessage(
  routeKind: ForwardRouteKind,
  record: GroupMessageRecord | PrivateMessageRecord,
  extraValues: ForwardTemplateValues = {}
): void {
  const rule = ruleForRoute(routeKind, record, extraValues);
  if (!rule) {
    return;
  }
  const roleContext = rolePathsFor(config.agentRoleId);

  if (path.resolve(roleContext.dataDir) !== path.resolve(config.dataDir)) {
    if ("groupId" in record) {
      appendGroupMessageToDir(record, roleContext.dataDir);
    } else {
      appendPrivateMessageToDir(record, roleContext.dataDir);
    }
  }

  const message = appendAgentRoleReference(renderTemplate(rule.template, {
    ...commonTemplateValues(record, extraValues, roleContext),
    ...extraValues,
    routeKind
  }), roleContext.rolePath);

  appendCodexNotificationToDir({
    id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
    time: Math.floor(Date.now() / 1000),
    kind: logKindForRoute(routeKind),
    text: message
  }, roleContext.dataDir);

  for (const target of configuredForwardTargets()) {
    dispatchToTarget(target, message);
  }
}
