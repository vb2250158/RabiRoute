import path from "node:path";
import { createAgentAdapter } from "./agentAdapters/agentAdapter.js";
import type { AgentAdapterType } from "./agentAdapters/types.js";
import { config, rolePathsFor, rolePathsForRoute, type NotificationRule, type RouteProfile } from "./config.js";
import { appendCodexNotificationToDir, appendGroupMessageToDir, appendHeartbeatEventToDir, appendPrivateMessageToDir, appendVoiceTranscriptEventToDir, type GroupMessageRecord, type HeartbeatEventRecord, type PrivateMessageRecord, type VoiceTranscriptEventRecord } from "./history.js";

export type ForwardRouteKind = "private" | "group_message" | "direct_at" | "direct_reply" | "indirect_reply" | "heartbeat" | "voice_transcript";
type ForwardLogKind = "private" | "group_mention" | "heartbeat" | "voice_transcript";
type ForwardRecord = GroupMessageRecord | PrivateMessageRecord | HeartbeatEventRecord | VoiceTranscriptEventRecord;

export type ForwardTemplateValues = Record<string, string | number | undefined>;

function formatTime(epochSeconds: number): string {
  return new Date(epochSeconds * 1000).toLocaleString("zh-CN", { hour12: false });
}

function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

function currentTimeValues(now = new Date()): ForwardTemplateValues {
  const year = now.getFullYear();
  const month = pad2(now.getMonth() + 1);
  const day = pad2(now.getDate());
  const hour = pad2(now.getHours());
  const minute = pad2(now.getMinutes());
  const second = pad2(now.getSeconds());
  const weekdays = ["星期日", "星期一", "星期二", "星期三", "星期四", "星期五", "星期六"];

  return {
    now: now.toLocaleString("zh-CN", { hour12: false }),
    currentTime: now.toLocaleString("zh-CN", { hour12: false }),
    currentDate: `${year}-${month}-${day}`,
    currentClock: `${hour}:${minute}:${second}`,
    currentIsoTime: now.toISOString(),
    currentTimestamp: Math.floor(now.getTime() / 1000),
    currentYear: year,
    currentMonth: month,
    currentDay: day,
    currentWeekday: weekdays[now.getDay()],
    currentHour: hour,
    currentMinute: minute,
    currentSecond: second
  };
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

function isGroupRecord(record: ForwardRecord): record is GroupMessageRecord {
  return "groupId" in record;
}

function isHeartbeatRecord(record: ForwardRecord): record is HeartbeatEventRecord {
  return ("intervalSeconds" in record || !("userId" in record)) && !("source" in record);
}

function isVoiceTranscriptRecord(record: ForwardRecord): record is VoiceTranscriptEventRecord {
  return "source" in record || "durationSeconds" in record || "peak" in record;
}

function routeVariablesFor(record: ForwardRecord, extraValues: ForwardTemplateValues, route?: RouteProfile): Record<string, string> {
  const isGroup = "groupId" in record;
  const variables: Record<string, string> = {
    ...config.routeVariables,
    ...(route?.routeVariables ?? {}),
    SenderQQId: "userId" in record ? String(record.userId) : "",
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

function routeMatchText(record: ForwardRecord, variables: Record<string, string>, extraValues: ForwardTemplateValues): string {
  const parts = [routeTextFromRawMessage(record.rawMessage, variables)];
  if (typeof extraValues.repliedMessage === "string" && extraValues.repliedMessage.trim()) {
    parts.push(routeTextFromRawMessage(extraValues.repliedMessage, variables));
  }
  return parts.join("\n");
}

function configuredAgentAdapters(): AgentAdapterType[] {
  if (config.agentAdapters.length > 0) {
    return config.agentAdapters;
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
  record: ForwardRecord,
  extraValues: ForwardTemplateValues,
  route?: RouteProfile
): boolean {
  if (!rule.enabled) {
    return false;
  }

  if (rule.routeKinds.length > 0 && !rule.routeKinds.includes(routeKind)) {
    return false;
  }

  if (rule.targetGroupId?.trim()) {
    if (!isGroupRecord(record) || String(record.groupId) !== rule.targetGroupId.trim()) {
      return false;
    }
  }

  if (!rule.regex?.trim()) {
    return true;
  }

  try {
    const variables = routeVariablesFor(record, extraValues, route);
    return new RegExp(expandRouteVariables(rule.regex, variables)).test(routeMatchText(record, variables, extraValues));
  } catch (error) {
    console.error(`Invalid notification rule regex: ${rule.id}`, error);
    return false;
  }
}

function ruleForRoute(
  routeKind: ForwardRouteKind,
  record: ForwardRecord,
  extraValues: ForwardTemplateValues,
  route?: RouteProfile
): NotificationRule | null {
  const rules = route?.notificationRules ?? config.notificationRules;
  return rules.find((item) => ruleMatches(item, routeKind, record, extraValues, route)) ?? null;
}

function commonTemplateValues(
  record: ForwardRecord,
  extraValues: ForwardTemplateValues,
  roleContext = rolePathsFor(config.agentRoleId),
  route?: RouteProfile
): ForwardTemplateValues {
  const sender = record.senderName || ("userId" in record ? record.userId : "RabiRoute");
  const isGroup = isGroupRecord(record);
  const isHeartbeat = isHeartbeatRecord(record);
  const isVoiceTranscript = isVoiceTranscriptRecord(record);
  const targetId = isGroup ? record.groupId : "userId" in record ? record.userId : isVoiceTranscript ? record.source ?? "webhook" : "heartbeat";
  const targetType = isGroup ? "group" : isHeartbeat ? "heartbeat" : isVoiceTranscript ? "voice_transcript" : "private";
  const routeVariables = routeVariablesFor(record, extraValues, route);
  const routeText = routeTextFromRawMessage(record.rawMessage, routeVariables);
  const repliedRouteText = typeof extraValues.repliedMessage === "string"
    ? routeTextFromRawMessage(extraValues.repliedMessage, routeVariables)
    : undefined;
  return {
    ...routeVariables,
    ...currentTimeValues(),
    time: formatTime(record.time),
    sender,
    senderName: record.senderName,
    userId: "userId" in record ? record.userId : undefined,
    groupId: isGroup ? record.groupId : undefined,
    targetType,
    targetId,
    messageTarget: isGroup ? `群 ${targetId}` : isHeartbeat ? "RabiRoute 心跳" : isVoiceTranscript ? `语音转写 ${targetId}` : `私聊 ${targetId}`,
    message: record.rawMessage,
    rawMessage: record.rawMessage,
    routeText,
    repliedRouteText,
    messageId: record.messageId,
    botNickname: config.botNickname,
    agentRoleId: roleContext.roleId,
    routeProfileId: route?.id,
    routeProfileName: route?.name,
    agentRolePath: roleContext.rolePath,
    agentRoleDir: roleContext.roleDir,
    dataDir: roleContext.dataDir,
    groupLogPath: path.join(roleContext.dataDir, "group-messages.jsonl"),
    privateLogPath: path.join(roleContext.dataDir, "private-messages.jsonl"),
    heartbeatLogPath: path.join(roleContext.dataDir, "heartbeat-events.jsonl"),
    voiceTranscriptLogPath: path.join(roleContext.dataDir, "voice-transcripts.jsonl"),
    heartbeatIntervalSeconds: "intervalSeconds" in record ? record.intervalSeconds : undefined,
    voiceSource: isVoiceTranscript ? record.source : undefined,
    voiceStartedAt: isVoiceTranscript ? record.startedAt : undefined,
    voiceEndedAt: isVoiceTranscript ? record.endedAt : undefined,
    voiceDurationSeconds: isVoiceTranscript ? record.durationSeconds : undefined,
    voicePeak: isVoiceTranscript ? record.peak : undefined
  };
}

function logKindForRoute(routeKind: ForwardRouteKind): ForwardLogKind {
  if (routeKind === "heartbeat") {
    return "heartbeat";
  }
  if (routeKind === "voice_transcript") {
    return "voice_transcript";
  }
  return routeKind === "private" ? "private" : "group_mention";
}

function dispatchToAgentAdapter(type: AgentAdapterType, message: string): void {
  const adapter = createAgentAdapter(type);
  void adapter.deliver(message).catch((error) => console.error(`Failed to deliver message through ${adapter.type} agent adapter`, error));
}

function fallbackRouteProfile(): RouteProfile {
  return {
    id: config.agentRoleId || "default",
    name: config.agentRoleId || "默认路由",
    enabled: true,
    agentRoleId: config.agentRoleId,
    agentRoleFile: config.agentRoleFile,
    rolesDir: config.rolesDir,
    dataDir: undefined,
    routeVariables: {},
    notificationRules: config.notificationRules
  };
}

function activeRouteProfiles(): RouteProfile[] {
  const routes = config.routeProfiles.length > 0 ? config.routeProfiles : [fallbackRouteProfile()];
  return routes.filter((route) => route.enabled !== false);
}

function forwardMessageToRoute(
  route: RouteProfile,
  routeKind: ForwardRouteKind,
  record: ForwardRecord,
  extraValues: ForwardTemplateValues = {}
): void {
  const rule = ruleForRoute(routeKind, record, extraValues, route);
  if (!rule) {
    return;
  }
  const roleContext = rolePathsForRoute(route);

  if (path.resolve(roleContext.dataDir) !== path.resolve(config.dataDir)) {
    if (isGroupRecord(record)) {
      appendGroupMessageToDir(record, roleContext.dataDir);
    } else if (isHeartbeatRecord(record)) {
      appendHeartbeatEventToDir(record, roleContext.dataDir);
    } else if (isVoiceTranscriptRecord(record)) {
      appendVoiceTranscriptEventToDir(record, roleContext.dataDir);
    } else {
      appendPrivateMessageToDir(record, roleContext.dataDir);
    }
  }

  const message = appendAgentRoleReference(renderTemplate(rule.template, {
    ...commonTemplateValues(record, extraValues, roleContext, route),
    ...extraValues,
    routeKind
  }), roleContext.rolePath);

  appendCodexNotificationToDir({
    id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
    time: Math.floor(Date.now() / 1000),
    kind: logKindForRoute(routeKind),
    text: message
  }, roleContext.dataDir);

  for (const adapter of configuredAgentAdapters()) {
    dispatchToAgentAdapter(adapter, message);
  }
}

export function forwardMessage(
  routeKind: ForwardRouteKind,
  record: ForwardRecord,
  extraValues: ForwardTemplateValues = {}
): void {
  for (const route of activeRouteProfiles()) {
    forwardMessageToRoute(route, routeKind, record, extraValues);
  }
}
