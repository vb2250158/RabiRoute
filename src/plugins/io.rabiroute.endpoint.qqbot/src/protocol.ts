import { createHash, createPrivateKey, createPublicKey, sign, verify } from "node:crypto";
import type { QqBotMessageRecord } from "@rabiroute/host-api/history";

export type BotCredentials = { appId: string; appSecret: string; sandbox: boolean };
export type BotNativeMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
export type BotNativeResult = { status: number; data: unknown; traceId?: string };
export type BotContent = Record<string, unknown> | FormData;

export function botSigningKey(secret: string) {
  const bytes = Buffer.from(secret, "utf8");
  const seed = Buffer.alloc(32, bytes);
  const privateKey = createPrivateKey({
    key: Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), seed]),
    format: "der",
    type: "pkcs8"
  });
  return { privateKey, publicKey: createPublicKey(privateKey) };
}

export type CallbackResult =
  | { status: 400 | 403 }
  | { status: 200; body: { plain_token: string; signature: string } }
  | { status: 200; body: { op: 12 }; record?: QqBotMessageRecord };

const messageEvents = new Set(["C2C_MESSAGE_CREATE", "GROUP_AT_MESSAGE_CREATE", "GROUP_MESSAGE_CREATE",
  "AT_MESSAGE_CREATE", "MESSAGE_CREATE", "DIRECT_MESSAGE_CREATE"]);

export function qqbotRouteKind(record: QqBotMessageRecord) {
  if (record.eventType && !messageEvents.has(record.eventType)) return "qqbot_event";
  if (record.dmGuildId) return "qqbot_dm";
  if (record.channelId) return "qqbot_channel";
  return record.groupId ? "qqbot_group" : "qqbot_private";
}

export function decodeBotDispatch(payload: {
  op?: number; t?: string; id?: string; d?: Record<string, any>;
}, account: { id: string; revision: string }, gatewayId: string, now: number): QqBotMessageRecord | undefined {
  const eventType = payload.t;
  const data = payload.d;
  if (payload.op !== 0 || typeof eventType !== "string" || !/^[A-Z][A-Z0-9_]{1,79}$/.test(eventType)
    || !data || typeof data !== "object" || Array.isArray(data)
    || ["READY", "RESUMED"].includes(eventType)) return;
  const isMessage = messageEvents.has(eventType);
  const groupId = validId(data.group_openid) ? data.group_openid : undefined;
  const guildId = validId(data.guild_id) ? data.guild_id : undefined;
  const channelId = validId(data.channel_id) ? data.channel_id : undefined;
  const dmGuildId = eventType === "DIRECT_MESSAGE_CREATE" ? guildId : undefined;
  const sender = data.author?.member_openid ?? data.author?.user_openid ?? data.author?.id
    ?? data.user_openid ?? data.openid ?? data.user?.id ?? data.op_user_id;
  const userId = validId(sender) ? sender : "";
  const platformMessageId = isMessage && typeof data.id === "string" && data.id && data.id.length <= 256 ? data.id : "";
  const eventId = typeof payload.id === "string" && payload.id.length <= 256 ? payload.id : undefined;
  if (isMessage && (!platformMessageId || !userId
    || (eventType.startsWith("GROUP_") && !groupId)
    || (eventType === "DIRECT_MESSAGE_CREATE" && !dmGuildId)
    || (["AT_MESSAGE_CREATE", "MESSAGE_CREATE"].includes(eventType) && !channelId))) return;
  const remoteAttachments = Array.isArray(data.attachments) ? data.attachments.flatMap((file: unknown) => {
    if (!file || typeof file !== "object") return [];
    const item = file as Record<string, unknown>;
    if (typeof item.url !== "string" || item.url.length > 8192) return [];
    const url = item.url.startsWith("//") ? "https:" + item.url : item.url.startsWith("https://") ? item.url : "https://" + item.url;
    try {
      const parsed = new URL(url);
      if (parsed.protocol !== "https:" || parsed.username || parsed.password) return [];
    } catch { return []; }
    return [{ url, name: typeof item.filename === "string" ? item.filename : undefined,
      contentType: typeof item.content_type === "string" ? item.content_type : undefined,
      size: typeof item.size === "number" && item.size >= 0 ? item.size : undefined }];
  }) : [];
  const content = typeof data.content === "string" ? data.content.trim() : "";
  const rawMessage = isMessage
    ? [content, ...remoteAttachments.map(file => `[附件 ${file.name || file.contentType || "QQ"}] ${file.url}`)].filter(Boolean).join("\n")
    : `[QQ 官方机器人事件 ${eventType}] ${JSON.stringify(data)}`;
  if (!rawMessage) return;
  const eventTime = typeof data.timestamp === "string" ? Date.parse(data.timestamp) : NaN;
  const target = dmGuildId ?? channelId ?? groupId ?? userId;
  const messageId = "qqbot-" + createHash("sha256").update(JSON.stringify([
    account.id, gatewayId, target, platformMessageId || [eventType, eventId ?? data]
  ])).digest("hex");
  return { adapterType: "qqbot", gatewayId, instanceId: account.id, accountRevision: account.revision,
    groupId, userId, channelId, guildId: dmGuildId ? data.src_guild_id : guildId, dmGuildId, eventType, eventId,
    ...(remoteAttachments.length ? { remoteAttachments } : {}), nativeEvent: data,
    platformMessageId, messageId, rawMessage,
    senderName: typeof data.author?.username === "string" ? data.author.username : undefined,
    time: Number.isFinite(eventTime) ? Math.floor(eventTime / 1000) : Math.floor(now / 1000) };
}

export function decodeCallback(
  raw: Buffer,
  headers: { appId?: string; timestamp?: string; signature?: string },
  account: { appId: string; id: string; revision: string; key: ReturnType<typeof botSigningKey> },
  gatewayId: string,
  now: number
): CallbackResult {
  if (headers.appId !== account.appId) return { status: 403 };
  let payload;
  try { payload = JSON.parse(raw.toString("utf8")); } catch { return { status: 400 }; }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return { status: 400 };
  const data = payload.d;
  if (payload.op === 13) {
    const token = data?.plain_token;
    const ts = data?.event_ts;
    if (typeof token !== "string" || !/^[A-Za-z0-9_-]{1,256}$/.test(token)
      || typeof ts !== "string" || !/^\d{10,13}$/.test(ts)) return { status: 400 };
    return { status: 200, body: { plain_token: token, signature: sign(null, Buffer.from(ts + token), account.key.privateKey).toString("hex") } };
  }
  const timestamp = headers.timestamp ?? "";
  const signature = headers.signature ?? "";
  if (!/^\d{10,13}$/.test(timestamp) || !/^[0-9a-f]{128}$/i.test(signature)
    || !verify(null, Buffer.concat([Buffer.from(timestamp), raw]), account.key.publicKey, Buffer.from(signature, "hex"))) {
    return { status: 403 };
  }
  return { status: 200, body: { op: 12 }, record: decodeBotDispatch(payload, account, gatewayId, now) };
}

function validId(value: unknown): value is string {
  return typeof value === "string" && /^[\w-][\w.=-]{0,255}$/u.test(value);
}

export function createBotApi(request: typeof fetch = fetch) {
  const tokenCache = new Map<string, { expiresAt: number; pending: Promise<string> }>();
  async function obtainToken(credentials: BotCredentials, revision?: string): Promise<string> {
    const cacheKey = revision && credentials.appId + ":" + revision;
    const cached = cacheKey ? tokenCache.get(cacheKey) : undefined;
    if (cached && cached.expiresAt > Date.now()) return cached.pending;
    const entry = { expiresAt: Infinity, pending: Promise.resolve("") };
    entry.pending = (async () => {
      const response = await request("https://bots.qq.com/app/getAppAccessToken", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ appId: credentials.appId, clientSecret: credentials.appSecret }),
        redirect: "error", signal: AbortSignal.timeout(8000)
      });
      const data = await response.json() as { access_token?: string; expires_in?: number | string };
      const expiry = Number(data.expires_in);
      if (!response.ok || typeof data.access_token !== "string" || !data.access_token || !Number.isFinite(expiry) || expiry <= 0) {
        throw new Error("QQ 开放平台未签发访问令牌，请核对 AppID、AppSecret 和网络。");
      }
      entry.expiresAt = Date.now() + Math.max(0, expiry - 60) * 1000;
      return data.access_token;
    })();
    if (cacheKey) {
      for (const [key, value] of tokenCache) if (value.expiresAt <= Date.now()) tokenCache.delete(key);
      tokenCache.set(cacheKey, entry);
    }
    try { return await entry.pending; } catch (error) {
      if (cacheKey && tokenCache.get(cacheKey) === entry) tokenCache.delete(cacheKey);
      throw error;
    }
  }

  async function invoke(credentials: BotCredentials, revision: string, method: BotNativeMethod, path: string,
    content: BotContent | undefined, assertCurrent: () => void, signal?: AbortSignal): Promise<BotNativeResult> {
    const base = credentials.sandbox ? "https://sandbox.api.sgroup.qq.com" : "https://api.sgroup.qq.com";
    const url = new URL(path, base);
    if (!path.startsWith("/") || url.origin !== base || url.hash || url.username || url.password) {
      throw new Error("QQ 机器人 API 地址无效。");
    }
    const token = await obtainToken(credentials, revision);
    assertCurrent();
    const deadline = AbortSignal.timeout(12000);
    const headers: Record<string, string> = { authorization: "QQBot " + token, "x-union-appid": credentials.appId };
    const body = content instanceof FormData ? content : content === undefined ? undefined : JSON.stringify(content);
    if (typeof body === "string") headers["content-type"] = "application/json";
    const response = await request(url.href, {
      method, headers, body, redirect: "error", signal: signal ? AbortSignal.any([signal, deadline]) : deadline
    });
    const raw = await response.text();
    let data;
    try { data = raw ? JSON.parse(raw) : null; }
    catch { throw new Error(`QQ 机器人接口未返回可确认的 JSON 结果（HTTP ${response.status}）。`); }
    if (response.status === 401) tokenCache.delete(credentials.appId + ":" + revision);
    return { status: response.status, data, traceId: response.headers.get("x-tps-trace-id") ?? undefined };
  }
  return {
    async check(credentials: BotCredentials) { await obtainToken(credentials); },
    invoke,
    token: obtainToken,
    invalidateToken(credentials: BotCredentials, revision: string) { tokenCache.delete(credentials.appId + ":" + revision); },
    async reply(credentials: BotCredentials, revision: string,
      source: Pick<QqBotMessageRecord, "groupId" | "userId" | "channelId" | "dmGuildId" | "platformMessageId">,
      text: string, assertCurrent: () => void) {
      if (!source.platformMessageId) throw new Error("此 QQ 平台事件没有可引用的来源消息。");
      const channel = source.dmGuildId ? "/dms/" + encodeURIComponent(source.dmGuildId)
        : source.channelId ? "/channels/" + encodeURIComponent(source.channelId) : "";
      const conversation = source.groupId ? "/v2/groups/" + encodeURIComponent(source.groupId) : "/v2/users/" + encodeURIComponent(source.userId);
      const response = await invoke(credentials, revision, "POST", (channel || conversation) + "/messages", {
        content: text, msg_id: source.platformMessageId, ...(!channel ? { msg_type: 0, msg_seq: 1 } : {})
      }, assertCurrent);
      const data = response.data as { id?: string; code?: number } | null;
      if (response.status >= 300 || typeof data?.id !== "string" || !data.id) {
        throw new Error(`QQ 机器人回复未获平台确认（HTTP ${response.status}${Number.isSafeInteger(data?.code) ? `，平台错误 ${data?.code}` : ""}）。`);
      }
      return { messageId: data.id };
    }
  };
}
