import type { AgentThreadRequest, AgentThreadRequestResult } from "../agentThreads.js";
import path from "node:path";
import { GrokBotClient, GrokBotError, decodeGrokBotSessionId, isGrokBotRoom } from "../agentAdapters/grokBotClient.js";
import { deliverWithTransportReceipt } from "../agentAdapters/grokBotAdapter.js";
import { discoverGrokBotAgent, grokBotActionableError } from "../agentAdapters/grokBotDiscovery.js";
import { readGrokBotNativeOwner, type GrokBotEndpointConfiguration, type GrokBotNativeOwner } from "./grokBotEndpointBridge.js";

function nativeUpdatedAt(owner: GrokBotNativeOwner): string | undefined {
  const time = Number(owner.session.lastActivityAtMs ?? owner.session.updatedAtMs ?? owner.session.createdAtMs);
  return Number.isSafeInteger(time) && time >= 0 && time <= 8.64e15 ? new Date(time).toISOString() : undefined;
}
function summary(owner: GrokBotNativeOwner) {
  return { id: owner.id, title: owner.bot.name, updatedAt: nativeUpdatedAt(owner), archived: false, status: "available",
    owner: "grok_bot_cloud", nativeAgentId: owner.agentId, nativeAgentName: owner.bot.name, nativeSessionId: owner.sessionId,
    kind: owner.bot.kind, memberAgentIds: owner.bot.memberAgentIds,
    ...(owner.defaultMain ? { defaultMain: true } : {}) };
}
function unsupported(action: string): AgentThreadRequestResult {
  return { statusCode: 422, data: { action, agentAdapter: "grokBot", status: "unsupported", ok: false,
    error: { code: "GROK_BOT_ACTION_UNSUPPORTED", stage: "validation", field: "action", retryable: false,
      message: `Grok Bot native owner does not expose ${action}; no alternate owner or session was created.` } } };
}

/** Discovery/read stay on the native cloud owner. Explicit native delivery reuses the adapter transport journal. */
export async function handleGrokBotThreadRequest(request: AgentThreadRequest, configuration: GrokBotEndpointConfiguration & { dataDir?: string } = {},
  client?: GrokBotClient): Promise<AgentThreadRequestResult | undefined> {
  if (request.agentAdapter !== "grokBot" || (!request.grokBotDelivery && (request.action === "send" || request.action === "reconcile_delivery"))) return undefined;
  const action = request.action ?? "list";
  if (["open", "create", "rename"].includes(action)) return unsupported(action);
  try {
    client ??= new GrokBotClient(configuration);
    if (action === "send" || action === "reconcile_delivery") {
      if (!request.threadId) throw new GrokBotError("GROK_BOT_SESSION_REQUIRED");
      if (!request.deliveryId) throw new GrokBotError("GROK_BOT_DELIVERY_ID_REQUIRED");
      if (request.imagePaths?.length) throw new GrokBotError("GROK_BOT_IMAGES_UNSUPPORTED");
      const bound = { ...decodeGrokBotSessionId(request.threadId), id: request.threadId };
      const receipt = await deliverWithTransportReceipt(client, configuration.dataDir || process.env.DATA_DIR || path.join(process.cwd(), "data"),
        bound, request.deliveryId, request.prompt, { grokBotDelivery: request.grokBotDelivery, reconcileOnly: action === "reconcile_delivery" });
      return { statusCode: 200, data: { action, agentAdapter: "grokBot", ok: true, status: "delivered", threadId: request.threadId, targetThreadId: request.threadId,
        delivery: { status: "delivered", deliveryId: request.deliveryId, targetThreadId: request.threadId,
          messageId: receipt.messageId, recovered: receipt.recovered, duplicate: receipt.duplicate } } };
    }
    if (action === "list") {
      const limit = request.limit ?? 100, offset = request.offset ?? 0;
      if (!Number.isInteger(limit) || limit < 1 || limit > 200 || !Number.isInteger(offset) || offset < 0) throw new GrokBotError("GROK_BOT_PAGE_INVALID");
      const before = await client.profileStatus();
      const discovery = await discoverGrokBotAgent({ ...configuration, client, limit, offset, query: request.query });
      if (!discovery.healthy) throw new GrokBotError(discovery.errorCode ?? "GROK_BOT_DISCOVERY_FAILED");
      let aliasRoomId: string | undefined;
      if (request.threadId) {
        const saved = decodeGrokBotSessionId(request.threadId);
        if (!saved.defaultMain) {
          const room = discovery.bots.find(bot => bot.agentId === saved.sessionId && isGrokBotRoom(bot));
          if (room) {
            const sender = discovery.bots.find(bot => bot.agentId === saved.agentId);
            if (!sender || !["1", "AGENT", "GROK_BOT_AGENT_KIND_AGENT"].includes(String(sender.kind))) throw new GrokBotError("GROK_BOT_SENDER_NOT_FOUND");
            if (!room.memberAgentIds?.includes(saved.agentId)) throw new GrokBotError("GROK_BOT_SENDER_NOT_MEMBER");
            aliasRoomId = room.agentId;
          }
        }
      }
      if ((await client.profileStatus()).accountScope !== before.accountScope) throw new GrokBotError("GROK_BOT_ACCOUNT_CHANGED");
      return { statusCode: 200, data: { action, agentAdapter: "grokBot", ok: true, status: "listed",
        threads: discovery.sessions.map(row => ({ id: row.agentId === aliasRoomId && row.defaultMain ? request.threadId! : row.id, title: row.name, updatedAt: row.updatedAt, archived: false,
          status: "available", owner: "grok_bot_cloud", nativeAgentId: row.agentId, nativeSessionId: row.sessionId,
          nativeAgentName: discovery.bots.find(bot => bot.agentId === row.agentId)?.name,
          kind: row.kind, memberAgentIds: row.memberAgentIds,
          ...(row.defaultMain && row.agentId !== aliasRoomId ? { defaultMain: true } : {}) })),
        nextOffset: discovery.sessionPage.nextOffset, pagination: discovery.sessionPage, warnings: discovery.warnings } };
    }
    if (action !== "read" && action !== "resolve") return unsupported(action);
    if (!request.threadId) throw new GrokBotError("GROK_BOT_SESSION_REQUIRED");
    decodeGrokBotSessionId(request.threadId);
    const owner = await readGrokBotNativeOwner(request.threadId, configuration, client);
    const thread = summary(owner);
    if (action === "resolve") return { statusCode: 200, data: { action, agentAdapter: "grokBot", ok: true, status: "resolved", threadId: owner.id, thread } };
    const transcript = await client.readTranscript(owner.agentId, owner.sessionId,
      { limit: request.limit ?? 50, accountScope: owner.accountScope, ...(owner.defaultMain ? { defaultMain: true as const } : {}) });
    if ((await client.profileStatus()).accountScope !== owner.accountScope) throw new GrokBotError("GROK_BOT_ACCOUNT_CHANGED");
    return { statusCode: 200, data: { action, agentAdapter: "grokBot", ok: true, status: "read", thread: { ...thread, transcript } } };
  } catch (error) {
    const code = error instanceof GrokBotError ? error.code : "GROK_BOT_OWNER_UNAVAILABLE";
    const uncertain = error instanceof GrokBotError && error.uncertain;
    return { statusCode: uncertain ? 202 : code === "GROK_BOT_SESSION_NOT_FOUND" || code === "GROK_BOT_DELIVERY_NOT_FOUND" ? 404 : 400, data: { action, agentAdapter: "grokBot", ok: false, status: uncertain ? "delivery_unconfirmed" : "failed",
      error: { code, stage: "validation", retryable: false, field: action === "list" ? "query" : "threadId", message: grokBotActionableError(error) } } };
  }
}
