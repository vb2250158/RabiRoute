import { config, type NotificationRule, type RouteProfile } from "../config.js";
import type {
  ForwardRecord,
  ForwardRouteKind,
  ForwardTemplateValues
} from "./types.js";
import type {
  GroupMessageRecord,
  HeartbeatEventRecord,
  ManualTriggerRecord,
  VoiceTranscriptEventRecord
} from "../history.js";

export type RouteDecision = {
  route: RouteProfile;
  routeKind: ForwardRouteKind;
  record: ForwardRecord;
  extraValues: ForwardTemplateValues;
  matchedRules: NotificationRule[];
  routeVariables: Record<string, string>;
  routeText: string;
  repliedRouteText?: string;
};

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

export function isGroupRecord(record: ForwardRecord): record is GroupMessageRecord {
  return "groupId" in record;
}

export function isHeartbeatRecord(record: ForwardRecord): record is HeartbeatEventRecord {
  return ("intervalSeconds" in record || !("userId" in record)) && !("source" in record) && !("triggerId" in record) && !("triggerName" in record);
}

export function isManualTriggerRecord(record: ForwardRecord): record is ManualTriggerRecord {
  return "triggerId" in record || "triggerName" in record;
}

export function isVoiceTranscriptRecord(record: ForwardRecord): record is VoiceTranscriptEventRecord {
  return "source" in record || "durationSeconds" in record || "peak" in record;
}

export function routeVariablesFor(record: ForwardRecord, extraValues: ForwardTemplateValues, route?: RouteProfile): Record<string, string> {
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

export function routeTextFromRawMessage(rawMessage: string, variables: Record<string, string>): string {
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

function ruleMatches(
  rule: NotificationRule,
  routeKind: ForwardRouteKind,
  record: ForwardRecord,
  extraValues: ForwardTemplateValues,
  route: RouteProfile
): boolean {
  if (!rule.enabled) {
    return false;
  }

  if (rule.routeKinds.length > 0 && !rule.routeKinds.includes(routeKind)) {
    return false;
  }

  if (typeof extraValues.triggerRuleId === "string" && extraValues.triggerRuleId.trim() && rule.id !== extraValues.triggerRuleId.trim()) {
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

export function createRouteDecision(
  route: RouteProfile,
  routeKind: ForwardRouteKind,
  record: ForwardRecord,
  extraValues: ForwardTemplateValues = {}
): RouteDecision | null {
  const matchedRules = route.notificationRules.filter((item) => ruleMatches(item, routeKind, record, extraValues, route));
  if (matchedRules.length === 0) {
    return null;
  }

  const routeVariables = routeVariablesFor(record, extraValues, route);
  return {
    route,
    routeKind,
    record,
    extraValues,
    matchedRules,
    routeVariables,
    routeText: routeTextFromRawMessage(record.rawMessage, routeVariables),
    repliedRouteText: typeof extraValues.repliedMessage === "string"
      ? routeTextFromRawMessage(extraValues.repliedMessage, routeVariables)
      : undefined
  };
}
