import type { AgentThreadRequest, AgentThreadRequestResult } from "../agentThreads.js";
import { GrokBotClient, GrokBotError, decodeGrokBotSessionId } from "../agentAdapters/grokBotClient.js";
import { discoverGrokBotAgent, grokBotActionableError } from "../agentAdapters/grokBotDiscovery.js";
import { readGrokBotNativeOwner, type GrokBotEndpointConfiguration, type GrokBotNativeOwner } from "./grokBotEndpointBridge.js";

function nativeUpdatedAt(owner: GrokBotNativeOwner): string | undefined {
  const time = Number(owner.session.lastActivityAtMs ?? owner.session.updatedAtMs ?? owner.session.createdAtMs);
  return Number.isSafeInteger(time) && time >= 0 && time <= 8.64e15 ? new Date(time).toISOString() : undefined;
}
function summary(owner: GrokBotNativeOwner) {
  return { id: owner.id, title: owner.bot.name, updatedAt: nativeUpdatedAt(owner), archived: false, status: "available",
    owner: "grok_bot_cloud", nativeAgentId: owner.agentId, nativeSessionId: owner.sessionId,
    ...(owner.defaultMain ? { defaultMain: true } : {}) };
}
function unsupported(action: string): AgentThreadRequestResult {
  return { statusCode: 422, data: { action, agentAdapter: "grokBot", status: "unsupported", ok: false,
    error: { code: "GROK_BOT_ACTION_UNSUPPORTED", stage: "validation", field: "action", retryable: false,
      message: `Grok Bot native owner does not expose ${action}; no alternate owner or session was created.` } } };
}

/** Discovery/read stay on the native cloud owner. All sends use the shared endpoint ledger. */
export async function handleGrokBotThreadRequest(request: AgentThreadRequest, configuration: GrokBotEndpointConfiguration = {},
  client?: GrokBotClient): Promise<AgentThreadRequestResult | undefined> {
  if (request.agentAdapter !== "grokBot" || request.action === "send" || request.action === "reconcile_delivery") return undefined;
  const action = request.action ?? "list";
  if (["open", "create", "rename"].includes(action)) return unsupported(action);
  try {
    client ??= new GrokBotClient(configuration);
    if (action === "list") {
      const limit = request.limit ?? 100, offset = request.offset ?? 0;
      if (!Number.isInteger(limit) || limit < 1 || limit > 200 || !Number.isInteger(offset) || offset < 0) throw new GrokBotError("GROK_BOT_PAGE_INVALID");
      const before = await client.profileStatus();
      const discovery = await discoverGrokBotAgent({ ...configuration, client, limit, offset, query: request.query });
      if (!discovery.healthy) throw new GrokBotError(discovery.errorCode ?? "GROK_BOT_DISCOVERY_FAILED");
      if ((await client.profileStatus()).accountScope !== before.accountScope) throw new GrokBotError("GROK_BOT_ACCOUNT_CHANGED");
      return { statusCode: 200, data: { action, agentAdapter: "grokBot", ok: true, status: "listed",
        threads: discovery.sessions.map(row => ({ id: row.id, title: row.name, updatedAt: row.updatedAt, archived: false,
          status: "available", owner: "grok_bot_cloud", nativeAgentId: row.agentId, nativeSessionId: row.sessionId,
          ...(row.defaultMain ? { defaultMain: true } : {}) })),
        pagination: discovery.sessionPage, warnings: discovery.warnings } };
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
    return { statusCode: code === "GROK_BOT_SESSION_NOT_FOUND" ? 404 : 400, data: { action, agentAdapter: "grokBot", ok: false, status: "failed",
      error: { code, stage: "validation", retryable: false, field: action === "list" ? "query" : "threadId", message: grokBotActionableError(error) } } };
  }
}
