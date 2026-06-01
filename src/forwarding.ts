import path from "node:path";
import { notifyCodex } from "./codexApp.js";
import { notifyCodexDesktop } from "./codexDesktopIpc.js";
import { config } from "./config.js";
import { appendCodexNotification, type GroupMessageRecord, type PrivateMessageRecord } from "./history.js";

export type ForwardRouteKind = "private" | "direct_at" | "direct_reply" | "indirect_reply";
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

function templateForRoute(routeKind: ForwardRouteKind): string {
  if (routeKind === "private") {
    return config.privateNotificationTemplate;
  }
  if (routeKind === "direct_reply") {
    return config.groupDirectReplyNotificationTemplate;
  }
  if (routeKind === "indirect_reply") {
    return config.groupIndirectReplyNotificationTemplate;
  }
  return config.groupAtNotificationTemplate;
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

function commonTemplateValues(record: GroupMessageRecord | PrivateMessageRecord): ForwardTemplateValues {
  const sender = record.senderName || record.userId;
  const isGroup = "groupId" in record;
  const targetId = isGroup ? record.groupId : record.userId;
  const targetType = isGroup ? "group" : "private";
  return {
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
    messageId: record.messageId,
    botNickname: config.botNickname,
    dataDir: config.dataDir,
    groupLogPath: path.join(config.dataDir, "group-messages.jsonl"),
    privateLogPath: path.join(config.dataDir, "private-messages.jsonl")
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
  const message = renderTemplate(templateForRoute(routeKind), {
    ...commonTemplateValues(record),
    ...extraValues,
    routeKind
  });

  appendCodexNotification({
    id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
    time: Math.floor(Date.now() / 1000),
    kind: logKindForRoute(routeKind),
    text: message
  });

  for (const target of configuredForwardTargets()) {
    dispatchToTarget(target, message);
  }
}
