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
  PlanFeedbackMessageRecord,
  RolePanelMessageRecord,
  FeishuMessageRecord,
  QqBotMessageRecord,
  WeComMessageRecord,
  WeixinMessageRecord,
  VoiceTranscriptEventRecord
} from "../history.js";
import { systemEventRuleForRouteKind } from "./systemEventRules.js";
import { notificationRuleMismatch, routeTextFromRawMessage } from "../shared/messageRuleMatch.js";

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

export function isGroupRecord(record: ForwardRecord): record is GroupMessageRecord {
  return "groupId" in record && !isWeComRecord(record) && !isFeishuRecord(record) && !isQqBotRecord(record);
}

export function isQqBotRecord(record: ForwardRecord): record is QqBotMessageRecord {
  return "adapterType" in record && record.adapterType === "qqbot";
}

export function isWeComRecord(record: ForwardRecord): record is WeComMessageRecord {
  return "adapterType" in record && record.adapterType === "wecom";
}

export function isFeishuRecord(record: ForwardRecord): record is FeishuMessageRecord {
  return "adapterType" in record && record.adapterType === "feishu";
}

export function isWeixinRecord(record: ForwardRecord): record is WeixinMessageRecord {
  return "adapterType" in record && record.adapterType === "weixin";
}

export function isHeartbeatRecord(record: ForwardRecord): record is HeartbeatEventRecord {
  return ("intervalSeconds" in record || !("userId" in record)) && !("source" in record) && !("triggerId" in record) && !("triggerName" in record) && !isRolePanelRecord(record) && !isPlanFeedbackRecord(record) && !isWeixinRecord(record);
}

export function isManualTriggerRecord(record: ForwardRecord): record is ManualTriggerRecord {
  return "triggerId" in record || "triggerName" in record;
}

export function isRolePanelRecord(record: ForwardRecord): record is RolePanelMessageRecord {
  // routeProfileId is a generic routing selector shared by mobile speech and
  // other endpoint records. It is not evidence that the source is rolePanel.
  return ("adapterType" in record && record.adapterType === "rolePanel")
    || ("roleId" in record && !("adapterType" in record && record.adapterType === "planFeedback"));
}

export function isPlanFeedbackRecord(record: ForwardRecord): record is PlanFeedbackMessageRecord {
  return "adapterType" in record && record.adapterType === "planFeedback";
}

export function isVoiceTranscriptRecord(record: ForwardRecord): record is VoiceTranscriptEventRecord {
  return "source" in record || "durationSeconds" in record || "peak" in record;
}

export function routeVariablesFor(record: ForwardRecord, extraValues: ForwardTemplateValues, route?: RouteProfile): Record<string, string> {
  const isGroup = isGroupRecord(record);
  const groupId = isGroup || isWeComRecord(record) || isFeishuRecord(record) || isQqBotRecord(record) ? record.groupId : undefined;
  const variables: Record<string, string> = {
    ...config.routeVariables,
    ...(route?.routeVariables ?? {}),
    SenderQQId: "userId" in record ? String(record.userId) : "",
    GroupId: groupId == null ? "" : String(groupId),
    ReplyMessageId: extraValues.repliedMessageId == null ? "" : String(extraValues.repliedMessageId)
  };

  if (extraValues.selfId != null) {
    variables.RobotQQId = String(extraValues.selfId);
  }

  return variables;
}

export { routeTextFromRawMessage } from "../shared/messageRuleMatch.js";

function routeMatchText(record: ForwardRecord, variables: Record<string, string>, extraValues: ForwardTemplateValues): string {
  const parts = [routeTextFromRawMessage(record.rawMessage, variables)];
  if (typeof extraValues.repliedMessage === "string" && extraValues.repliedMessage.trim()) {
    parts.push(routeTextFromRawMessage(extraValues.repliedMessage, variables));
  }
  if ("sourceDeviceId" in record && record.sourceDeviceId) {
    const rawDeviceId = String(record.sourceDeviceId);
    parts.push(rawDeviceId);
    if (rawDeviceId.startsWith("home:")) {
      parts.push(rawDeviceId.slice("home:".length));
    }
  }
  return parts.join("\n");
}

export function notificationRuleMatches(
  rule: NotificationRule,
  routeKind: ForwardRouteKind,
  record: ForwardRecord,
  extraValues: ForwardTemplateValues,
  route: RouteProfile
): boolean {
  const groupId = isGroupRecord(record) || isWeComRecord(record) || isFeishuRecord(record) || isQqBotRecord(record) ? record.groupId : undefined;
  const variables = rule.regex?.trim() ? routeVariablesFor(record, extraValues, route) : {};
  const mismatch = notificationRuleMismatch(rule, {
    routeKind,
    sourceRouteId: process.env.GATEWAY_ID || route.id,
    text: rule.regex?.trim() ? routeMatchText(record, variables, extraValues) : "",
    groupId: groupId == null ? undefined : String(groupId),
    userId: "userId" in record ? String(record.userId) : undefined,
    speakerName: isVoiceTranscriptRecord(record) ? String(record.speakerName ?? "").trim() : undefined,
    triggerId: isManualTriggerRecord(record) ? String(record.triggerId) : undefined,
    routeId: route.id,
    selectedRouteId: typeof extraValues.triggerRouteId === "string" ? extraValues.triggerRouteId.trim() : undefined,
    selectedRuleId: typeof extraValues.triggerRuleId === "string" ? extraValues.triggerRuleId.trim() : undefined,
    variables
  });
  if (mismatch === "内容匹配表达式无效") console.error("Invalid notification rule regex: " + rule.id);
  return mismatch === undefined;
}

export function createRouteDecision(
  route: RouteProfile,
  routeKind: ForwardRouteKind,
  record: ForwardRecord,
  extraValues: ForwardTemplateValues = {}
): RouteDecision | null {
  const systemRule = systemEventRuleForRouteKind(
    routeKind,
    isManualTriggerRecord(record) ? record.triggerId : undefined,
    extraValues
  );
  const configured = route.notificationRules.filter(item => notificationRuleMatches(item, routeKind, record, extraValues, route)
    && (!(isManualTriggerRecord(record) && record.triggerId === "memory-consolidation") || item.triggerIds?.includes("memory-consolidation")));
  const scheduled = route.automationRules?.find(item => item.id === extraValues.automationRuleId);
  const matchedRules = scheduled
    ? scheduled.enabled !== false && scheduled.trigger.type === "schedule" && scheduled.trigger.schedule.enabled !== false
      && (!scheduled.sourceRouteIds?.length || scheduled.sourceRouteIds.includes(process.env.GATEWAY_ID || route.id))
      && scheduled.action.type === "deliver_agent" && systemRule
      ? [{ ...systemRule, id: scheduled.id, template: scheduled.action.template ?? "", agentTarget: scheduled.action.target }] : []
    : systemRule && routeKind === "plan_feedback" ? [{ ...systemRule }] : configured;
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
