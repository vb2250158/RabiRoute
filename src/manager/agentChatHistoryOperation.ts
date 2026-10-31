import type { AgentSendRequest } from "../agentSend.js";
import type { AgentCommunicationRoutesContext } from "./agentCommunicationRoutes.js";
import type { ApiOperationDefinition, ApiOperationResult } from "./apiOperationContract.js";
import { assertTrustedLanAgentPrincipal } from "./lanAgentRequestAccess.js";

export function projectAgentChatHistory<T extends { entries: { text: string }[] }>(history: T) {
  return { ...history, entries: history.entries.map(record => ({ ...record,
    text: record.text.replace(/\[CQ:(image|video|record|file)[^\]]*\]/gi, "[$1]") })) };
}

export const AGENT_CHAT_HISTORY_LIMITS = Object.freeze({ default: 50, max: 200 });
/** Existing request semantics, including Number/fallback/clamping, owned in one place. */
export function parseAgentChatHistoryQuery(url: URL) {
  const bounds = ["afterSequence", "beforeSequence"].map(field => url.searchParams.get(field));
  if (bounds.some(value => value !== null && (!value.trim() || !Number.isSafeInteger(Number(value)) || Number(value) < 0))
    || (bounds[0] !== null && bounds[1] !== null && Number(bounds[0]) > Number(bounds[1]))) {
    throw new Error("Sequence bounds must be non-negative safe integers in ascending order.");
  }
  const send: AgentSendRequest = { deliveryId: "chat-history-read", sender: { agentType: "history_reader", sessionId: "read-only" },
    routeId: url.searchParams.get("routeId"), channel: url.searchParams.get("channel"), params: JSON.parse(url.searchParams.get("params") || "{}"),
    payload: { type: "text", text: "history-read" } };
  return { send, query: { afterSequence: bounds[0] === null ? undefined : Number(bounds[0]), beforeSequence: bounds[1] === null ? undefined : Number(bounds[1]),
    query: url.searchParams.get("query") || undefined,
    limit: Math.min(AGENT_CHAT_HISTORY_LIMITS.max, Math.max(1, Number(url.searchParams.get("limit")) || AGENT_CHAT_HISTORY_LIMITS.default)) } };
}
type Context = Pick<AgentCommunicationRoutesContext, "readChatHistory">;
export async function readAgentChatHistoryResult(request: Parameters<typeof assertTrustedLanAgentPrincipal>[0], url: URL, context: Context): Promise<ApiOperationResult> {
  if (!context.readChatHistory) return { status: 503, body: { code: -1, message: "Chat history reader is unavailable." } };
  try {
    assertTrustedLanAgentPrincipal(request);
    const data = await context.readChatHistory(url);
    assertTrustedLanAgentPrincipal(request);
    return { status: 200, body: { code: 0, data } };
  } catch (error) { return { status: 400, body: { code: -1, message: error instanceof Error ? error.message : String(error) } }; }
}
const text = { type: "string" } as const;
const record = { type: "object", required: ["time", "direction", "adapter", "text"], additionalProperties: true,
  properties: { time: { type: "number" }, direction: { enum: ["inbound", "outbound", "system"] }, adapter: text, text,
    sequence: { type: "integer", minimum: 1 }, messageId: { anyOf: [text, { type: "number" }] }, replyToMessageId: { anyOf: [text, { type: "number" }] },
    attachments: { type: "array", items: { type: "object", properties: { id: text, kind: text, name: text, mimeType: text, size: { type: "number" } }, additionalProperties: false } } } };
const error = { mediaType: "application/json", schema: { type: "object", required: ["code", "message"],
  properties: { code: { const: -1 }, message: text }, additionalProperties: false } };
export function createAgentChatHistoryOperation(context: Context): ApiOperationDefinition {
  return { contract: { operationId: "agent.chat-history.read", aliases: ["agent:GET:/api/agent/chat-history"], contractVersion: "1.0.0",
    method: "GET", pathTemplate: "/api/agent/chat-history", exposure: "public", transport: "http",
    description: "Read the selected send target's saved conversation window, including omitted-index bounds; not complete platform history.",
    request: { path: { type: "object", properties: {}, additionalProperties: false },
      query: { type: "object", properties: Object.fromEntries("routeId channel params afterSequence beforeSequence query limit".split(" ").map(name => [name, text])), additionalProperties: false },
      headers: { type: "object" }, body: { kind: "none" } },
    responses: { "200": { mediaType: "application/json", schema: { type: "object", required: ["code", "data"], additionalProperties: false,
      properties: { code: { const: 0 }, data: { type: "object", required: ["latestSequence", "totalCount", "omittedCount", "entries"], additionalProperties: false,
        properties: { latestSequence: { type: "integer", minimum: 0 }, totalCount: { type: "integer", minimum: 0 }, omittedCount: { type: "integer", minimum: 0 },
          entries: { type: "array", maxItems: AGENT_CHAT_HISTORY_LIMITS.max, items: record } } } } } }, "400": error, "503": error },
    effects: { mode: "owner-read", description: "Reads the existing selected Route/target's saved conversation window, using its existing lock/index owner. Does not send, approve, confirm reading or switch targets." },
    recovery: { strategy: "repeatable-read", description: "Retain the original target, params and sequence bounds. Missing/unreadable archives remain errors; no platform or account fallback. Counts describe the owner's selected window, not platform-wide completeness." },
    validators: [{ id: "agent.chat-history.selection", description: "params is a JSON-encoded existing send-channel target. The send parser and conversation owner select the exact enabled Route/account/channel; non-chat channels and ambiguous targets remain errors." },
      { id: "agent.chat-history.bounds", description: `Sequence bounds use Number(value), must be nonempty non-negative safe integers and ascending. Limit retains existing Number(value)/fallback/clamping to 1..${AGENT_CHAT_HISTORY_LIMITS.max}, default ${AGENT_CHAT_HISTORY_LIMITS.default}; query retains existing term matching. Owner output replaces native CQ media references with type markers.` }] },
    handler: input => readAgentChatHistoryResult(input.request, input.url, context) };
}
