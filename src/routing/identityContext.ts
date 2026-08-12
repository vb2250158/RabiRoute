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

function voiceIdentityEndpoints(record: ForwardRecord, conversationKey?: string): IdentityEndpointLookup[] {
  if (field(record, "voiceIdentityTrusted") !== true) return [];
  const sourceHostId = text(field(record, "sourceHostId"));
  if (!sourceHostId) return [];
  const names = new Map<string, string | undefined>();
  const topLevelVoiceprintId = text(field(record, "voiceprintId"));
  if (topLevelVoiceprintId) names.set(topLevelVoiceprintId, text(field(record, "speakerName") ?? field(record, "senderName")));
  const segments = field(record, "segments");
  if (Array.isArray(segments)) for (const segment of segments) {
    if (!segment || typeof segment !== "object" || Array.isArray(segment)) continue;
    const raw = segment as Record<string, unknown>;
    const voiceprintId = text(raw.voiceprintId ?? raw.speakerClusterId);
    if (voiceprintId && !names.has(voiceprintId)) names.set(voiceprintId, text(raw.speakerName));
  }
  return [...names.entries()].map(([senderStableId, displayName]) => ({
    platform: "voice",
    endpointIdentityNamespace: `host:${sourceHostId}`,
    senderStableId,
    displayName,
    conversationKey
  }));
}

export function identityEndpointsForForward(
  routeKind: ForwardRouteKind,
  record: ForwardRecord,
  options: { gatewayId?: string; routeProfileId?: string } = {}
): IdentityEndpointLookup[] {
  const scope = messageContextScopeForForward(routeKind, record, options);
  const conversationKey = scope?.record.conversationKey;
  const adapterType = text(field(record, "adapterType"));
  const displayName = text(field(record, "senderName"));
  const identityNamespace = text(field(record, "identityNamespace"));
  const voiceEndpoints = voiceIdentityEndpoints(record, conversationKey);
  let senderEndpoint: IdentityEndpointLookup | undefined;
  if (adapterType === "wecom") {
    const senderStableId = text(field(record, "senderId") ?? field(record, "userId"));
    if (senderStableId && identityNamespace) senderEndpoint = { platform: "wecom", endpointIdentityNamespace: identityNamespace, senderStableId, displayName, conversationKey };
  } else if (adapterType === "feishu") {
    const senderStableId = text(field(record, "userId"));
    if (senderStableId && identityNamespace) senderEndpoint = { platform: "feishu", endpointIdentityNamespace: identityNamespace, senderStableId, displayName, conversationKey };
  } else if (adapterType === "weixin") {
    const senderStableId = text(field(record, "userId"));
    if (senderStableId && identityNamespace) senderEndpoint = { platform: "weixin", endpointIdentityNamespace: identityNamespace, senderStableId, displayName, conversationKey };
  } else {
    const explicitSenderStableId = text(field(record, "senderStableId"));
    if (field(record, "senderIdentityTrusted") === true && explicitSenderStableId && identityNamespace) senderEndpoint = {
      platform: adapterType || routeKind,
      endpointIdentityNamespace: identityNamespace,
      senderStableId: explicitSenderStableId,
      displayName,
      conversationKey
    };
  }
  const usesNapCatIdentity = adapterType === "napcat"
    || (!adapterType && ["private", "group_message", "direct_at", "direct_reply", "indirect_reply"].includes(routeKind));
  if (!senderEndpoint && usesNapCatIdentity && "userId" in record) {
    const senderStableId = text(field(record, "userId"));
    if (senderStableId) {
      const platform = adapterType || "napcat";
      const botUserId = text(field(record, "botUserId"));
      const instanceId = text(field(record, "instanceId")) || "default";
      senderEndpoint = {
        platform,
        endpointIdentityNamespace: botUserId ? `bot:${botUserId}` : `instance:${instanceId}`,
        senderStableId,
        displayName,
        conversationKey
      };
    }
  }
  const unique = new Map<string, IdentityEndpointLookup>();
  for (const endpoint of [...voiceEndpoints, ...(senderEndpoint ? [senderEndpoint] : [])]) {
    unique.set(`${endpoint.platform}\0${endpoint.endpointIdentityNamespace}\0${endpoint.senderStableId}`, endpoint);
  }
  return [...unique.values()];
}

export function identityEndpointForForward(
  routeKind: ForwardRouteKind,
  record: ForwardRecord,
  options: { gatewayId?: string; routeProfileId?: string } = {}
): IdentityEndpointLookup | undefined {
  return identityEndpointsForForward(routeKind, record, options)[0];
}

export function identityContextForForward(
  roleDir: string,
  routeKind: ForwardRouteKind,
  record: ForwardRecord,
  options: { gatewayId?: string; routeProfileId?: string } = {}
): IdentityRelationContext | undefined {
  const contexts = identityContextsForForward(roleDir, routeKind, record, options);
  return contexts.length === 1 ? contexts[0] : undefined;
}

export function identityContextsForForward(
  roleDir: string,
  routeKind: ForwardRouteKind,
  record: ForwardRecord,
  options: { gatewayId?: string; routeProfileId?: string } = {}
): IdentityRelationContext[] {
  return identityEndpointsForForward(routeKind, record, options)
    .flatMap(endpoint => resolveIdentityRelationContext(roleDir, endpoint) ?? []);
}

export function identityContextLines(context: IdentityRelationContext | undefined): string[] {
  if (!context) return [
    "当前消息没有可供身份定位精确查询的稳定发送者标识；不要按显示名、群权限或项目关键词猜测身份。"
  ];
  const participant = context.confirmedParticipant;
  const habitLabels: Record<string, string> = {
    sentence_opening: "句首习惯", sentence_length: "句长节奏", stance_expression: "判断方式",
    emotion_threshold: "情绪阈值", analogy_source: "比喻来源", punctuation: "标点偏好",
    reader_relationship: "称呼方式", value_preference: "价值判断", information_order: "信息顺序",
    avoidance: "回避表达", imperfection: "自然错误", scene_boundary: "场景变化"
  };
  const possible = context.possibleParticipants.flatMap(({ participant: item, link }) => {
    const habits = (item.speakingHabits ?? []).slice(0, 6)
      .map(habit => `${habitLabels[habit.dimension] || habit.dimension}=${habit.description}`)
      .join("；");
    return [
      `- 可能使用者：${item.displayName || item.id}（${item.kind}，关联置信度=${link.confidence ?? "未填写"}）`,
      habits ? `  已确认样本提取的说话习惯：${habits}` : ""
    ].filter(Boolean);
  });
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
    ...possible,
    context.possibleParticipants.length > 1
      ? "这是共用账号。可以结合当前上下文、正在延续的事情、明确自称和说话习惯一致性，推断本条消息更可能由谁发出；必须保留置信度和依据，不能把情境推断改写成永久的一对一账号映射。"
      : context.possibleParticipants.length === 1
        ? "该账号与一个已识别身份存在可能关联，但仍不是唯一确认。可以结合上下文核对，不能仅凭文风直接确认。"
        : "",
    ...candidates,
    ...relations,
    ...context.unresolved,
    "身份定位只回答谁在说话及其已确认关系；它不能单独证明项目归属、委托、决策权或执行授权。"
  ].filter(Boolean);
}
