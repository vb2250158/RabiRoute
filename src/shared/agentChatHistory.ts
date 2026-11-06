import type { AgentSendRequest } from "../agentSend.js";

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
