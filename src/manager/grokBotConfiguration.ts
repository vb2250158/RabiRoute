import { GrokBotError, decodeGrokBotSessionId, type GrokBotClientOptions } from "../agentAdapters/grokBotClient.js";

export type GrokBotRouteOwnerConfiguration = {
  agentAdapters?: readonly string[];
  grokBotSessionId?: string;
  grokBotAgentId?: string;
  grokBotProfilePath?: string;
  grokBotBackendUrl?: string;
};

/** Resolve a configured native account by the complete canonical session, never by a display name. */
export function grokBotEndpointConfiguration(definitions: Iterable<GrokBotRouteOwnerConfiguration>, sessionId?: string): GrokBotClientOptions {
  if (!sessionId) return {};
  const native = decodeGrokBotSessionId(sessionId);
  const matches = [...definitions].filter(definition => definition.agentAdapters?.includes("grokBot") && definition.grokBotSessionId === sessionId);
  for (const definition of matches) {
    if (definition.grokBotAgentId !== native.agentId) throw new GrokBotError("GROK_BOT_SESSION_OWNER_MISMATCH");
  }
  // Grok Bot owns authentication; route data stores only the selected identity.
  return {};
}
