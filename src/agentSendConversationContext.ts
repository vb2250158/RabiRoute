import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { conversationScope } from "./conversationMessageCursor.js";
import { prepareAgentSendRequest, type AgentSendRequest } from "./agentSend.js";
import { resolveAgentSendRoute } from "./agentSendRoute.js";
import { conversationDataDirForRoute, type AgentReplyOptions } from "./outbox.js";
import { type MessageContextRecord } from "./messageContextStore.js";
import { normalizeMessageAdapterPolicy, type MessageEndpointType } from "./shared/gatewayConfigModel.js";

export type AgentSendConversationContext = {
  latestMessageIndex: string;
  reason: "initial_context" | "new_messages" | "invalid_index" | "confirmation_invalid" | "current";
  confirmationRequired: boolean;
  confirmationToken?: string;
  expiresAt?: string;
  messages: Array<Pick<MessageContextRecord, "sequence" | "time" | "direction" | "sender" | "text" | "messageId" | "replyToMessageId" | "conversationKey" | "attachments"> & { textTruncated?: boolean }>;
  totalCount: number;
  omittedCount: number;
  omittedRange?: { afterSequence: number; beforeSequence: number };
  search: { path: string; adapter: string; routeId: string; channel: string; params: unknown;
    afterSequence?: number; beforeSequence: number; conversationKeys: string[] };
  instruction?: string;
};

import { readConversationWindow, type ConversationWindowReader } from "./conversationMessageQuery.js";

const TOKEN_LIFETIME_MS = 10 * 60 * 1000;

function conversationIdentity(request: AgentSendRequest, options: AgentReplyOptions) {
  const send = prepareAgentSendRequest(request);
  if (send.channel === "plan_feedback" || (send.channel === "fennenote" && send.target.mode === "playback")) return undefined;
  const route = resolveAgentSendRoute(options.runtimes, send.routeId);
  if (!route) throw new Error("Conversation review requires an available, unambiguous send Route.");
  const dataDir = conversationDataDirForRoute(options, route);
  const adapter = send.channel === "role_panel" ? "rolePanel" : send.channel;
  const target = send.target;
  let instanceId = String(target.instanceId || "");
  if (send.channel === "napcat" && !instanceId) {
    const instances = (route.runtime.napcatInstances ?? []).filter(item => item.enabled !== false);
    if (instances.length > 1) throw new Error("Conversation review requires an explicit NapCat instanceId.");
    instanceId = String(instances[0]?.id || "");
  }
  const identity = send.channel === "napcat" ? { target: target.target, groupId: target.groupId, userId: target.userId, instanceId }
    : send.channel === "rabilink" ? { deviceIds: [...(target.targetDeviceIds as string[])].sort(), deviceKinds: [...(target.targetDeviceKinds as string[])].sort() }
    : { chatId: target.chatId, sessionId: target.sessionId, roleId: target.roleId };
  const { key, scope } = conversationScope(dataDir, route.runtime.id, adapter, identity);
  return { send, route, dataDir, adapter, target, instanceId, key, scope };
}


/** One common check for all public chat send channels, using the existing persona ledger owner. */
export class AgentSendConversationContextGuard {
  private readonly secret = randomBytes(32);
  private readonly pending = new Map<string, { expires: number; index: string }>();
  private readonly readIndexes = new Map<string, { index: string; expires: number }>();

  constructor(private readonly readWindow: ConversationWindowReader = async (dataDir, filter, query) => readConversationWindow(dataDir, filter, query)) {}

  serializationKey(request: AgentSendRequest, options: AgentReplyOptions): string | undefined {
    return conversationIdentity(request, options)?.key;
  }

  async searchHistory(request: AgentSendRequest, options: AgentReplyOptions, query: { afterSequence?: number; beforeSequence?: number; query?: string; limit: number }) {
    const conversation = conversationIdentity(request, options);
    if (!conversation) throw new Error("Only chat channels support conversation history.");
    const { send, route, adapter, target, instanceId } = conversation;
    return this.readWindow(conversation.dataDir, { gatewayId: route.runtime.id, channel: send.channel, adapter, target, instanceId,
      beforeSequence: query.beforeSequence, query: query.query }, { afterSequence: query.afterSequence, limit: query.limit });
  }

  rememberReturnedIndex(request: AgentSendRequest, options: AgentReplyOptions, index: string, now = Date.now()): void {
    const conversation = conversationIdentity(request, options);
    if (!conversation) return;
    const key = JSON.stringify({ sender: conversation.send.sender, scope: conversation.scope });
    for (const [cachedKey, item] of this.readIndexes) if (item.expires <= now) this.readIndexes.delete(cachedKey);
    if (!this.readIndexes.has(key) && this.readIndexes.size >= 5000) this.readIndexes.delete(this.readIndexes.keys().next().value!);
    this.readIndexes.set(key, { index, expires: now + 24 * 60 * 60 * 1000 });
    this.pending.delete(JSON.stringify({ deliveryId: conversation.send.deliveryId, sender: conversation.send.sender, scope: conversation.scope }));
  }

  async evaluate(request: AgentSendRequest, options: AgentReplyOptions, now = Date.now(), snapshotOnly = false): Promise<{
    blocked: boolean; context?: AgentSendConversationContext;
  }> {
    const conversation = conversationIdentity(request, options);
    if (!conversation) return { blocked: false };
    const { send, route, dataDir, adapter, target, instanceId, scope } = conversation;
    const filter = { gatewayId: route.runtime.id, channel: send.channel, adapter, target, instanceId };
    const policy = normalizeMessageAdapterPolicy(route.runtime.messageAdapterPolicies?.[adapter as MessageEndpointType], adapter as MessageEndpointType).conversationReview;
    const pendingKey = JSON.stringify({ deliveryId: send.deliveryId, sender: send.sender, scope });
    const cacheKey = JSON.stringify({ sender: send.sender, scope });
    for (const [key, item] of this.pending) if (item.expires <= now) this.pending.delete(key);
    const cached = this.readIndexes.get(cacheKey);
    if (cached && cached.expires <= now) this.readIndexes.delete(cacheKey);
    const supplied = send.conversationContext?.lastReadMessageIndex
      || (send.conversationContext?.confirmationToken ? this.pending.get(pendingKey)?.index : undefined)
      || (cached && cached.expires > now ? cached.index : undefined);
    const parsed = supplied?.match(/^c1\.([a-f0-9]{24})\.(\d+)$/);
    const after = parsed && parsed[1] === scope && Number.isSafeInteger(Number(parsed[2])) ? Number(parsed[2]) : undefined;
    const latest = await this.readWindow(dataDir, filter, { limit: 1 });
    let latestMessageIndex = `c1.${scope}.${latest.latestSequence}`;
    const validIndex = after !== undefined && after <= latest.latestSequence;
    const token = send.conversationContext?.confirmationToken;
    // Tokens also bind the exact send. Length/style tokens stay independent, and do not change message identity.
    const fingerprint = () => JSON.stringify({ deliveryId: send.deliveryId, sender: send.sender, routeId: send.routeId,
      channel: send.channel, internal: send.internal, latestMessageIndex, policy });
    const sign = (expiry: number) => createHmac("sha256", this.secret).update(`${expiry}:${fingerprint()}`).digest();
    let confirmed = false;
    if (token) {
      const parts = token.match(/^(\d{13})\.([a-f0-9]{64})$/);
      if (parts) {
        const expiry = Number(parts[1]);
        confirmed = expiry > now && expiry <= now + TOKEN_LIFETIME_MS && timingSafeEqual(Buffer.from(parts[2], "hex"), sign(expiry));
      }
    }
    const current = validIndex && after === latest.latestSequence;
    const proofRequired = !snapshotOnly && (Boolean(token) || this.pending.has(pendingKey));
    const blocked = !current || (proofRequired && !confirmed);
    const window = blocked ? await this.readWindow(dataDir, filter, {
      afterSequence: validIndex ? after : undefined,
      limit: validIndex ? policy.maxIncrementalMessages! : policy.initialMessageCount! }) : { ...latest, entries: [], totalCount: 0, omittedCount: 0 };
    latestMessageIndex = `c1.${scope}.${Math.max(latest.latestSequence, window.latestSequence)}`;
    const reason = !supplied ? "initial_context" : !validIndex ? "invalid_index" : !current ? "new_messages" : proofRequired && !confirmed ? "confirmation_invalid" : "current";
    // A bad/expired proof still returns the recent window, making reconfirmation reviewable.
    const entries = reason === "confirmation_invalid" ? (await this.readWindow(dataDir, filter, { limit: policy.initialMessageCount! })).entries : window.entries;
    const context: AgentSendConversationContext = {
      latestMessageIndex, reason, confirmationRequired: blocked,
      confirmationToken: undefined, expiresAt: undefined,
      totalCount: reason === "confirmation_invalid" ? entries.length : window.totalCount, omittedCount: window.omittedCount,
      ...(window.omittedCount ? { omittedRange: { afterSequence: entries[Math.ceil(entries.length / 2) - 1].sequence!, beforeSequence: entries[Math.ceil(entries.length / 2)].sequence! - 1 } } : {}),
      search: { path: "/api/agent/chat-history", adapter, routeId: send.routeId, channel: send.channel, params: request.params,
        afterSequence: validIndex ? after : undefined, beforeSequence: Math.max(latest.latestSequence, window.latestSequence),
        conversationKeys: [...new Set(entries.map(item => item.conversationKey).filter((key): key is string => Boolean(key)))] },
      instruction: undefined,
      messages: entries.map(record => ({ sequence: record.sequence, time: record.time, direction: record.direction,
        sender: record.sender, text: record.text.replace(/\[CQ:(image|video|record|file)[^\]]*\]/gi, "[$1]").slice(0, 6000),
        ...(record.text.length > 6000 ? { textTruncated: true } : {}), messageId: record.messageId,
        replyToMessageId: record.replyToMessageId, conversationKey: record.conversationKey, attachments: record.attachments }))
    };
    if (blocked && !snapshotOnly) {
      const expiry = now + TOKEN_LIFETIME_MS;
      if (!this.pending.has(pendingKey) && this.pending.size >= 5000) throw new Error("Conversation review queue is full; retry after existing confirmations expire.");
      this.pending.set(pendingKey, { expires: expiry, index: latestMessageIndex });
      context.confirmationToken = `${expiry}.${sign(expiry).toString("hex")}`;
      context.expiresAt = new Date(expiry).toISOString();
      context.instruction = `尚未发送。先读返回消息，重新判断当前正文是否合适；${window.omittedCount ? `聊天信息过多，中间省略 ${window.omittedCount} 条，请按会话、索引范围和关键词搜索相关消息；` : ""}需要改正文时重新审核。确认后保留 deliveryId，在 conversationContext 同时传 latestMessageIndex 作为 lastReadMessageIndex 和 confirmationToken 再次调用；再次出现新消息仍需重新确认。`;
    }
    return { blocked, context };
  }
}
