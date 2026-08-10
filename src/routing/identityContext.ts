import type { ForwardRecord, ForwardRouteKind } from "./types.js";
import { messageContextScopeForForward } from "./messageContextScope.js";
import {
  resolveIdentityRelationContext,
  type IdentityEndpointLookup,
  type IdentityRelationContext
} from "../identityRelations.js";

function text(value: unknown): string | undefined {
  const normalized = String(value ?? "").trim();
  return normalized || undefined;
}

function field(record: ForwardRecord, key: string): unknown {
  return key in record ? (record as unknown as Record<string, unknown>)[key] : undefined;
}

export function identityEndpointForForward(
  routeKind: ForwardRouteKind,
  record: ForwardRecord,
  options: { gatewayId?: string; routeProfileId?: string } = {}
): IdentityEndpointLookup | undefined {
  const scope = messageContextScopeForForward(routeKind, record, options);
  const conversationKey = scope?.record.conversationKey;
  const adapterType = text(field(record, "adapterType"));
  const displayName = text(field(record, "senderName"));
  const identityNamespace = text(field(record, "identityNamespace"));
  if (adapterType === "wecom") {
    const senderStableId = text(field(record, "senderId") ?? field(record, "userId"));
    return senderStableId && identityNamespace ? { platform: "wecom", endpointIdentityNamespace: identityNamespace, senderStableId, displayName, conversationKey } : undefined;
  }
  if (adapterType === "feishu") {
    const senderStableId = text(field(record, "userId"));
    return senderStableId && identityNamespace ? { platform: "feishu", endpointIdentityNamespace: identityNamespace, senderStableId, displayName, conversationKey } : undefined;
  }
  if (adapterType === "weixin") {
    const senderStableId = text(field(record, "userId"));
    return senderStableId && identityNamespace ? { platform: "weixin", endpointIdentityNamespace: identityNamespace, senderStableId, displayName, conversationKey } : undefined;
  }
  if ("userId" in record) {
    const senderStableId = text(field(record, "userId"));
    if (!senderStableId) return undefined;
    const platform = adapterType || "napcat";
    const botUserId = text(field(record, "botUserId"));
    const instanceId = text(field(record, "instanceId")) || "default";
    return {
      platform,
      endpointIdentityNamespace: botUserId ? `bot:${botUserId}` : `instance:${instanceId}`,
      senderStableId,
      displayName,
      conversationKey
    };
  }
  return undefined;
}

export function identityContextForForward(
  roleDir: string,
  routeKind: ForwardRouteKind,
  record: ForwardRecord,
  options: { gatewayId?: string; routeProfileId?: string } = {}
): IdentityRelationContext | undefined {
  const endpoint = identityEndpointForForward(routeKind, record, options);
  return endpoint ? resolveIdentityRelationContext(roleDir, endpoint) : undefined;
}

export function identityContextLines(context: IdentityRelationContext | undefined): string[] {
  if (!context) return [
    "当前消息没有可供身份关系记忆精确查询的稳定发送者标识；不要按显示名、群权限或项目关键词猜测身份。"
  ];
  const participant = context.confirmedParticipant;
  const candidates = context.candidateParticipants.map(({ participant: item, link }) =>
    `- 候选参与者：${item.displayName || item.id}（${item.kind}，置信度=${link.confidence ?? "未填写"}）`
  );
  const relations = context.relevantRelations.map(item =>
    `- ${item.status === "confirmed" ? "已确认" : "候选"}关系：${item.relationship}（${item.targetKind}:${item.targetId}）`
  );
  return [
    `当前账号：${context.endpoint.platform} / ${context.endpoint.endpointIdentityNamespace} / ${context.endpoint.senderStableId}`,
    context.endpoint.displayName ? `消息显示名：${context.endpoint.displayName}` : "",
    context.endpoint.isSelf ? "该账号被标记为当前人格自身账号；不要把回显当成新的外部发言。" : "",
    participant ? `已确认参与者：${participant.displayName || participant.id}（${participant.kind}）` : "",
    ...candidates,
    ...relations,
    ...context.unresolved,
    "身份关系只回答谁在说话及其已确认关系；它不能单独证明项目归属、委托、决策权或执行授权。"
  ].filter(Boolean);
}
