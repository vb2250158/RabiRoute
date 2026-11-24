import { requiresExplicitEventRule, VOICE_RECEIVED_ROUTE_KIND } from "./personaEventTypes.js";
import type { NotificationRuleDefinition } from "./gatewayConfigModel.js";

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

export function routeTextFromRawMessage(rawMessage: string, _variables?: Record<string, string>): string {
  return rawMessage
    .replace(/\[CQ:reply,id=([^\],]+)[^\]]*\]/g, (_match, id: string) => `[Reply:${id}]`)
    .replace(/\[CQ:at,qq=([^\],]+)[^\]]*\]/g, (_match, qq: string) => {
      return `@${qq}`;
    });
}

export type MessageRuleSample = {
  sourceRouteId: string;
  routeKind: string;
  text: string;
  groupId?: string;
  userId?: string;
  speakerName?: string;
  triggerId?: string;
  routeId?: string;
  selectedRouteId?: string;
  selectedRuleId?: string;
  variables: Record<string, string>;
};

export function notificationRuleMismatch(rule: NotificationRuleDefinition, sample: MessageRuleSample): string | undefined {
  if (!rule.enabled) return "规则已停用";
  if (rule.sourceRouteIds?.length && !rule.sourceRouteIds.includes(sample.sourceRouteId)) return "来源路线不匹配";
  if (rule.triggerIds?.length && (!sample.triggerId || !rule.triggerIds.includes(sample.triggerId))) return "触发器不匹配";
  if (rule.routeKinds?.length && !rule.routeKinds.includes(sample.routeKind)) return "触发场景不匹配";
  if (!rule.routeKinds?.length && requiresExplicitEventRule(sample.routeKind)) return "此事件需要显式选择场景";
  if (sample.routeKind === VOICE_RECEIVED_ROUTE_KIND && (rule.regex?.trim() || rule.allowedSpeakerNames?.length)) return "收到语音时尚无转写和说话人";
  if (sample.selectedRouteId && sample.routeId !== sample.selectedRouteId) return "本次未指定此路线";
  if (sample.selectedRuleId && rule.id !== sample.selectedRuleId) return "本次未指定此规则";
  if (rule.targetGroupId?.trim() && sample.groupId !== rule.targetGroupId.trim()) return "群聊或频道不匹配";
  if ((sample.routeKind === "private" || sample.routeKind === "qqbot_private") && rule.targetUserId?.trim()
      && sample.userId !== rule.targetUserId.trim()) return "私聊对象不匹配";
  if (rule.allowedSpeakerNames?.length && (!sample.speakerName || !rule.allowedSpeakerNames.includes(sample.speakerName))) return "说话人不匹配";
  if (!rule.regex?.trim()) return;
  try {
    if (!new RegExp(expandRouteVariables(rule.regex, sample.variables)).test(sample.text)) return "内容不匹配";
  } catch {
    return "内容匹配表达式无效";
  }
}
