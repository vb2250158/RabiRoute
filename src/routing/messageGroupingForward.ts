import { createHash } from "node:crypto";
import type { ForwardRecord, ForwardRouteKind, ForwardTemplateValues } from "./types.js";
import { messageContextScopeForForward } from "./messageContextScope.js";
import type {
  EnqueueMessageGroupInput,
  PendingMessageGroup
} from "../messageGrouping.js";
import type { MessageGroupingPolicy } from "../shared/gatewayConfigModel.js";

const conversationalRouteKinds = new Set<ForwardRouteKind>([
  "private",
  "group_message",
  "direct_at",
  "direct_reply",
  "indirect_reply",
  "role_panel_message",
  "voice_transcript",
  "rabilink",
  "wecom_message",
  "weixin_message",
  "feishu_message"
]);

const routePriority: Partial<Record<ForwardRouteKind, number>> = {
  direct_at: 100,
  direct_reply: 90,
  indirect_reply: 80,
  group_message: 70,
  private: 70,
  wecom_message: 70,
  weixin_message: 70,
  feishu_message: 70,
  role_panel_message: 70,
  voice_transcript: 60,
  rabilink: 60
};

export function isConversationalRouteKind(routeKind: ForwardRouteKind): boolean {
  return conversationalRouteKinds.has(routeKind);
}

function stableIdentity(endpoint: string, conversationKey: string, record: ForwardRecord): string {
  const messageId = String(record.messageId ?? "").trim();
  if (messageId) return `${endpoint}|${conversationKey}|message:${messageId}`;
  return `${endpoint}|${conversationKey}|content:${createHash("sha256")
    .update(`${record.time}|${record.rawMessage}`)
    .digest("hex")
    .slice(0, 24)}`;
}

export function messageGroupEnqueueInputForForward(
  routeKind: ForwardRouteKind,
  record: ForwardRecord,
  extraValues: ForwardTemplateValues,
  policy: Required<MessageGroupingPolicy>,
  gatewayId?: string
): EnqueueMessageGroupInput | undefined {
  if (!policy.enabled || !isConversationalRouteKind(routeKind)) return undefined;
  const scope = messageContextScopeForForward(routeKind, record, { gatewayId });
  if (!scope?.endpoint || !scope.record.conversationKey) return undefined;
  const endpoint = scope.endpoint;
  const conversationKey = scope.record.conversationKey;
  const sender = String(scope.record.sender || "unknown").trim() || "unknown";
  const replyToMessageId = scope.record.replyToMessageId == null
    ? undefined
    : String(scope.record.replyToMessageId).trim() || undefined;
  const baseKey = `${endpoint}|${conversationKey}|sender:${sender}`;
  return {
    key: `${baseKey}|reply:${replyToMessageId || "none"}`,
    baseKey,
    endpoint,
    conversationKey,
    sender,
    replyToMessageId,
    identity: stableIdentity(endpoint, conversationKey, record),
    text: record.rawMessage,
    policy,
    payload: {
      routeKind,
      record: record as unknown as Record<string, unknown>,
      extraValues
    }
  };
}

function combinedArray(records: Array<Record<string, unknown>>, field: "attachments" | "segments"): unknown[] | undefined {
  const values = records.flatMap((record) => Array.isArray(record[field]) ? record[field] as unknown[] : []);
  return values.length > 0 ? values : undefined;
}

function strongestRouteKind(items: PendingMessageGroup["items"]): ForwardRouteKind {
  return items
    .map((item) => item.payload.routeKind as ForwardRouteKind)
    .reduce((best, current) => (routePriority[current] ?? 0) > (routePriority[best] ?? 0) ? current : best);
}

export function mergePendingMessageGroup(group: PendingMessageGroup): {
  routeKind: ForwardRouteKind;
  record: ForwardRecord;
  extraValues: ForwardTemplateValues;
} {
  const items = [...group.items].sort((left, right) => left.receivedAt - right.receivedAt);
  if (items.length === 0) throw new Error(`Message group ${group.groupId} has no items.`);
  const records = items.map((item) => item.payload.record);
  const last = records.at(-1)!;
  const rawMessage = records.map((record) => String(record.rawMessage ?? "").trim()).filter(Boolean).join("\n");
  const attachments = combinedArray(records, "attachments");
  const segments = combinedArray(records, "segments");
  const replySource = [...records].reverse().find((record) => record.repliedMessageId != null || record.replyToMessageId != null);
  const record: Record<string, unknown> = {
    ...last,
    rawMessage,
    originalRawMessage: rawMessage,
    messageId: last.messageId,
    messageGroupId: group.groupId,
    messageGroupMessageIds: items
      .map((item) => String(item.payload.record.messageId ?? "").trim())
      .filter(Boolean),
    ...(replySource?.repliedMessageId != null ? { repliedMessageId: replySource.repliedMessageId } : {}),
    ...(replySource?.replyToMessageId != null ? { replyToMessageId: replySource.replyToMessageId } : {}),
    ...(attachments ? { attachments } : {}),
    ...(segments ? { segments } : {})
  };
  const extraValues = Object.assign({}, ...items.map((item) => item.payload.extraValues)) as ForwardTemplateValues;
  extraValues.messageGroupId = group.groupId;
  extraValues.messageGroupMessageCount = items.length;
  extraValues.messageGroupMessageIds = items
    .map((item) => String(item.payload.record.messageId ?? "").trim())
    .filter(Boolean)
    .join(",");
  return {
    routeKind: strongestRouteKind(items),
    record: record as unknown as ForwardRecord,
    extraValues
  };
}
