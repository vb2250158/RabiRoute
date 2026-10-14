import fs from "node:fs";
import path from "node:path";
import { DEFAULT_GROK_BOT_BACKEND_URL, encodeGrokBotSessionId, GrokBotClient, GrokBotError, grokBotProfilePath,
  type GrokBotClientOptions, type GrokBotNativeBot, type GrokBotNativeSession } from "./grokBotClient.js";

export type GrokBotDiscoveredSession = GrokBotNativeSession & { id: string; name: string; updatedAt?: string };
export type GrokBotDiscoveryOptions = GrokBotClientOptions & {
  client?: GrokBotClient;
  agentId?: string;
  limit?: number;
  offset?: number;
  query?: string;
};
export type GrokBotDiscovery = {
  installed: boolean;
  signedIn: boolean;
  healthy: boolean;
  status: "ready" | "unavailable";
  backendUrl: string;
  bots: GrokBotNativeBot[];
  sessions: GrokBotDiscoveredSession[];
  warnings: string[];
  errorCode?: string;
  sessionPage: { offset: number; limit: number; returned: number; hasMore: boolean; nextOffset?: number };
};
export function grokBotActionableError(error: unknown): string {
  const code = error instanceof GrokBotError ? error.code : "GROK_BOT_DISCOVERY_FAILED";
  const explanations: Record<string, string> = {
    GROK_BOT_PROFILE_MISSING: "未发现 Grok Bot 登录资料，请先安装并登录 Grok Bot。",
    GROK_BOT_NOT_SIGNED_IN: "Grok Bot 尚未登录，请在 Grok Bot 中登录后再刷新。",
    GROK_BOT_TOKEN_EXPIRED: "Grok Bot 登录已过期，请在 Grok Bot 中恢复登录后再刷新。",
    GROK_BOT_LOGIN_EXPIRED: "Grok Bot 服务拒绝了当前登录，请在 Grok Bot 中恢复登录后再刷新。",
    GROK_BOT_ACCOUNT_MISMATCH: "Grok Bot 当前账号与受保护资料不一致，请在 Grok Bot 中确认账号后重新扫描。",
    GROK_BOT_ACCOUNT_CHANGED: "读取期间 Grok Bot 账号已切换，请重新扫描当前账号。",
    GROK_BOT_BACKEND_MISMATCH: "配置的服务地址与当前 Grok Bot 登录来源不一致，请恢复真实原生服务地址。",
    GROK_BOT_SESSION_NOT_FOUND: "绑定的 Grok Bot 会话已不可用，请重新选择原 Bot 的真实会话。",
    GROK_BOT_OWNER_REFUSED: "Grok Bot 服务拒绝了本次读取，请核对当前账号和 Bot 归属。",
    GROK_BOT_PLATFORM_UNSUPPORTED: "当前登录发现支持 Windows，请显式提供已验证的 owner 连接。",
    GROK_BOT_CREDENTIAL_UNREADABLE: "无法读取 Grok Bot 受保护登录资料，请使用原 Windows 用户登录。",
    GROK_BOT_PROFILE_UNREADABLE: "无法读取 Grok Bot 登录资料，请核对资料目录与 Windows 用户。",
    GROK_BOT_PROFILE_HELPER_UNAVAILABLE: "当前版本缺少 Grok Bot 登录读取资源，请更新 RabiRoute 原生资源后再刷新。",
    GROK_BOT_PROFILE_TIMEOUT: "读取 Grok Bot 登录资料超时，请在主机负载降低后刷新；超时不代表未登录。"
  };
  return explanations[code] || "Grok Bot 当前不可用（" + code + "），请恢复原服务后刷新。";
}
function nativeTime(value?: string): string | undefined {
  if (!value) return undefined;
  const time = Number(value);
  return Number.isSafeInteger(time) && time >= 0 && time <= 8.64e15 ? new Date(time).toISOString() : undefined;
}
/** Called only by explicit discovery; status/auth reads do not scan sessions. */
export async function discoverGrokBotAgent(options: GrokBotDiscoveryOptions = {}): Promise<GrokBotDiscovery> {
  const offset = Math.max(0, Math.floor(options.offset ?? 0));
  const limit = Math.max(1, Math.min(500, Math.floor(options.limit ?? 100)));
  const result: GrokBotDiscovery = { installed: fs.existsSync(path.join(grokBotProfilePath(options.profilePath), "desktop-status.json")),
    signedIn: false, healthy: false, status: "unavailable", backendUrl: options.client?.backendUrl || DEFAULT_GROK_BOT_BACKEND_URL, bots: [], sessions: [], warnings: [],
    sessionPage: { offset, limit, returned: 0, hasMore: false } };
  try {
    const client = options.client || new GrokBotClient({ backendUrl: options.backendUrl, profilePath: options.profilePath,
      timeoutMs: options.timeoutMs, readProfile: options.readProfile, request: options.request });
    result.backendUrl = client.backendUrl;
    const account = await client.profileStatus();
    result.installed = true;
    result.signedIn = true;
    const roster = await client.listBots(account.accountScope);
    result.bots = roster.bots;
    if (roster.truncated) result.warnings.push("Grok Bot 服务返回了截断的 Bot 列表，当前结果不能代表全部 Bot。");
    const bots = options.agentId ? roster.bots.filter(bot => bot.agentId === options.agentId) : roster.bots;
    if (options.agentId && bots.length === 0) throw new GrokBotError("GROK_BOT_SESSION_NOT_FOUND");
    // Owner currently exposes one roster and one session list per Bot. Bound
    // targets read only that Bot; explicit full discovery uses bounded workers.
    const pages = new Map<string, GrokBotNativeSession[]>();
    let nextBot = 0;
    await Promise.all(Array.from({ length: Math.min(4, bots.length) }, async () => {
      while (nextBot < bots.length) {
        const bot = bots[nextBot++];
        pages.set(bot.agentId, await client.listSessions(bot.agentId, account.accountScope));
      }
    }));
    if ((await client.profileStatus()).accountScope !== account.accountScope) throw new GrokBotError("GROK_BOT_ACCOUNT_CHANGED");
    const sessions = bots.flatMap(bot => (pages.get(bot.agentId) || []).map(session => ({ ...session,
      id: encodeGrokBotSessionId(bot.agentId, session.sessionId, session), name: session.defaultMain ? bot.name + " · 默认会话" : bot.name,
      updatedAt: nativeTime(session.lastActivityAtMs || session.updatedAtMs) })));
    const query = options.query?.trim().toLocaleLowerCase();
    const filtered = sessions.filter(session => !query || session.name.toLocaleLowerCase().includes(query))
      .sort((left, right) => Number(right.lastActivityAtMs || right.updatedAtMs || 0) - Number(left.lastActivityAtMs || left.updatedAtMs || 0) || left.id.localeCompare(right.id));
    result.sessions = filtered.slice(offset, offset + limit);
    const hasMore = offset + result.sessions.length < filtered.length;
    result.sessionPage = { offset, limit, returned: result.sessions.length, hasMore,
      ...(hasMore ? { nextOffset: offset + result.sessions.length } : {}) };
    result.healthy = true;
    result.status = "ready";
    if (sessions.length === 0) result.warnings.push("当前账号没有可绑定的 Grok Bot 会话；发现过程不会新建 Bot 或会话。");
    result.warnings.push("Grok Bot 原生 owner 接入仍为实验状态；发现成功不代表消息投递或回传已验收。");
  } catch (error) {
    result.errorCode = error instanceof GrokBotError ? error.code : "GROK_BOT_DISCOVERY_FAILED";
    result.warnings.push(grokBotActionableError(error));
  }
  return result;
}
