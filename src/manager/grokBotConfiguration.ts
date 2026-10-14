import path from "node:path";
import { GrokBotError, decodeGrokBotSessionId, grokBotProfilePath, normalizeGrokBotBackendUrl, type GrokBotClientOptions } from "../agentAdapters/grokBotClient.js";

export type GrokBotRouteOwnerConfiguration = {
  agentAdapters?: readonly string[];
  grokBotSessionId?: string;
  grokBotAgentId?: string;
  grokBotProfilePath?: string;
  grokBotBackendUrl?: string;
};

/** Resolve a configured native account by the complete canonical session, never by a display name. */
export function grokBotEndpointConfiguration(definitions: Iterable<GrokBotRouteOwnerConfiguration>, sessionId?: string): GrokBotClientOptions {
  const defaults = { profilePath: process.env.GROK_BOT_PROFILE_PATH || undefined, backendUrl: process.env.GROK_BOT_BACKEND_URL || undefined };
  if (!sessionId) return defaults;
  const native = decodeGrokBotSessionId(sessionId);
  const matches = [...definitions].filter(definition => definition.agentAdapters?.includes("grokBot") && definition.grokBotSessionId === sessionId);
  const configurations = new Map<string, GrokBotClientOptions>();
  for (const definition of matches) {
    if (definition.grokBotAgentId !== native.agentId) throw new GrokBotError("GROK_BOT_SESSION_OWNER_MISMATCH");
    const config = { profilePath: definition.grokBotProfilePath || defaults.profilePath, backendUrl: definition.grokBotBackendUrl || defaults.backendUrl };
    const profile = path.normalize(grokBotProfilePath(config.profilePath));
    configurations.set(JSON.stringify([process.platform === "win32" ? profile.toLowerCase() : profile, normalizeGrokBotBackendUrl(config.backendUrl)]), config);
  }
  if (configurations.size > 1) throw new GrokBotError("GROK_BOT_PROFILE_CONFIGURATION_CONFLICT");
  return configurations.values().next().value ?? defaults;
}
