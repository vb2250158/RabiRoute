import { agentAdapterManifest } from "../shared/agentAdapterCapabilities.js";
import type { AgentManagerApiContext, AgentScanResult } from "./managerApi.js";
import { discoverGrokBotAgent, grokBotActionableError, type GrokBotDiscoveryOptions } from "./grokBotDiscovery.js";
import { GrokBotClient, GrokBotError, type GrokBotClientOptions } from "./grokBotClient.js";

export type GrokBotScanOptions = GrokBotClientOptions & {
  client?: GrokBotClient;
  grokBotAgentId?: string;
  grokBotLimit?: number;
  grokBotOffset?: number;
  grokBotQuery?: string;
};
export type GrokBotManagerScanResult = AgentScanResult & { hasProject: false; hasSession: true; canListSessions: true;
  bots: Array<{ agentId: string; name: string; mainSessionId?: string; kind?: string | number }>;
  profilePath: string };
export async function scanGrokBotAgent(options: GrokBotScanOptions = {}): Promise<GrokBotManagerScanResult> {
  const manifest = agentAdapterManifest("grokBot");
  const discoveryOptions: GrokBotDiscoveryOptions = { ...options, agentId: options.grokBotAgentId,
    limit: options.grokBotLimit, offset: options.grokBotOffset, query: options.grokBotQuery };
  const discovery = await discoverGrokBotAgent(discoveryOptions);
  return { type: manifest.type, label: manifest.label, maturity: manifest.maturity, transport: { ...manifest.transport },
    ...(manifest.host ? { host: { ...manifest.host } } : {}), installed: discovery.installed, hasProject: false, hasSession: true, canListSessions: true,
    auth: { required: true, loggedIn: discovery.signedIn, message: discovery.signedIn ? "已读取当前 Grok Bot 账号；云端 owner 独立执行。" : discovery.warnings[0] },
    endpoints: [{ label: "Grok Bot 云端 owner", url: discovery.backendUrl, healthy: discovery.healthy }], projects: [],
    sessions: discovery.sessions.map(session => ({ id: session.id, ownerId: session.agentId, name: session.name, updatedAt: session.updatedAt, status: "available", live: discovery.healthy })),
    sessionPage: discovery.sessionPage, profilePath: discovery.profilePath,
    bots: discovery.bots.map(bot => ({ agentId: bot.agentId, name: bot.name, mainSessionId: bot.mainSessionId, kind: bot.kind })), warnings: discovery.warnings };
}
export async function scanGrokBotAgentAdapter(_ctx: AgentManagerApiContext, options: GrokBotScanOptions = {}): Promise<{ agents: { grokBot: AgentScanResult }; cwdOptions: string[] }> {
  return { agents: { grokBot: await scanGrokBotAgent(options) }, cwdOptions: [] };
}
/** Health/status avoids roster/session scans and never creates a Bot or routine. */
export async function getGrokBotStatus(options: GrokBotClientOptions & { client?: GrokBotClient } = {}): Promise<{ status: "signed-in" | "unavailable"; errorCode?: string; warnings: string[] }> {
  try {
    await (options.client || new GrokBotClient(options)).profileStatus();
    return { status: "signed-in", warnings: ["本机登录资料可读；云端会话状态需显式扫描确认。"] };
  } catch (error) {
    return { status: "unavailable", errorCode: error instanceof GrokBotError ? error.code : "GROK_BOT_PROFILE_UNREADABLE", warnings: [grokBotActionableError(error)] };
  }
}
