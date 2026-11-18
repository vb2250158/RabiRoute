import { getTimeoutMs } from "@rabiroute/host-api/shared/timeoutSettings";
import fs from "node:fs";
import path from "node:path";
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import {
  createLocalSecretProtector,
  type LocalSecretProtector
} from "@rabiroute/host-api/shared/localSecretProtection";
import { recordDataMutationAudit } from "@rabiroute/host-api/observability/dataMutationAudit";

export const DEFAULT_WEIXIN_BASE_URL = "https://ilinkai.weixin.qq.com";
export const DEFAULT_WEIXIN_CDN_BASE_URL = "https://novac2c.cdn.weixin.qq.com/c2c";
export const WEIXIN_SESSION_TIMEOUT_ERRCODE = -14;

export class WeixinHttpError extends Error {
  constructor(
    public readonly status: number,
    method: string,
    endpoint: string
  ) {
    super(`微信机器人 API 明确拒绝请求（HTTP ${status}，${method} ${endpoint}）。`);
    this.name = "WeixinHttpError";
  }
}

export type WeixinOpenClawState = {
  token?: string;
  accountId?: string;
  userId?: string;
  baseUrl: string;
  syncBuf?: string;
  longPollingTimeoutMs?: number;
  contextTokens: Record<string, string>;
  authState?: "never_logged_in" | "recoverable" | "invalid";
  credentialsRetained?: boolean;
  lastConfirmedAt?: string;
  invalidatedAt?: string;
  storageFormat?: "protected" | "legacy_plaintext";
  storageError?: string;
  updatedAt: string;
};

export type WeixinStateProtector = LocalSecretProtector;

type PersistedWeixinState = {
  schemaVersion: 2;
  protection?: string;
  protectedSession?: string;
  baseUrl: string;
  authState: "never_logged_in" | "recoverable" | "invalid";
  credentialsRetained: boolean;
  lastConfirmedAt?: string;
  invalidatedAt?: string;
  updatedAt: string;
};

export type WeixinQrSession = {
  qrcode: string;
  qrcodeImageContent: string;
  startedAt: number;
  status: string;
  pollBaseUrl?: string;
};

export type WeixinInboundMessage = {
  from_user_id?: unknown;
  context_token?: unknown;
  item_list?: unknown;
  message_id?: unknown;
  msg_id?: unknown;
  message_type?: unknown;
  create_time_ms?: unknown;
  create_time?: unknown;
};

export type WeixinDownloadedMedia = {
  path: string;
  name: string;
  mimeType: string;
  size: number;
};

const WEIXIN_MEDIA_LIMIT = 100 * 1024 * 1024;

function imageFormat(bytes: Buffer): { extension: string; mimeType: string } {
  if (bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return { extension: "png", mimeType: "image/png" };
  if (bytes.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))) return { extension: "jpg", mimeType: "image/jpeg" };
  if (bytes.subarray(0, 6).toString("ascii") === "GIF87a" || bytes.subarray(0, 6).toString("ascii") === "GIF89a") return { extension: "gif", mimeType: "image/gif" };
  if (bytes.subarray(0, 4).toString("ascii") === "RIFF" && bytes.subarray(8, 12).toString("ascii") === "WEBP") return { extension: "webp", mimeType: "image/webp" };
  return { extension: "bin", mimeType: "application/octet-stream" };
}

function mediaKey(item: Record<string, unknown>, media: Record<string, unknown>, isImage: boolean): Buffer | undefined {
  const direct = String(item.aeskey || "").trim();
  if (isImage && /^[0-9a-f]{32}$/i.test(direct)) return Buffer.from(direct, "hex");
  const encoded = String(media.aes_key || "").trim();
  if (!encoded) return undefined;
  const decoded = Buffer.from(encoded, "base64");
  if (decoded.length === 16) return decoded;
  const hex = decoded.toString("ascii");
  return /^[0-9a-f]{32}$/i.test(hex) ? Buffer.from(hex, "hex") : undefined;
}

const inboundMediaFields = { 2: "image_item", 3: "voice_item", 4: "file_item", 5: "video_item" } as const;

function mediaRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

async function readWeixinMediaBody(response: Response): Promise<Buffer | undefined> {
  if (!response.ok || Number(response.headers.get("content-length")) > WEIXIN_MEDIA_LIMIT + 16) {
    await response.body?.cancel();
    return;
  }
  const reader = response.body?.getReader();
  if (!reader) return;
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const chunk = await reader.read();
    if (chunk.done) return Buffer.concat(chunks, size);
    size += chunk.value.byteLength;
    if (size > WEIXIN_MEDIA_LIMIT + 16) {
      await reader.cancel();
      return;
    }
    chunks.push(chunk.value);
  }
}

export async function downloadWeixinMedia(
  items: unknown,
  dataDir: string,
  messageId: string,
  fetchImpl: typeof fetch = fetch,
  signal?: AbortSignal
): Promise<WeixinDownloadedMedia[]> {
  if (!Array.isArray(items)) return [];
  const output: WeixinDownloadedMedia[] = [];
  for (const [index, raw] of items.entries()) {
    if (signal?.aborted) break;
    const item = mediaRecord(raw);
    const type = Number(item.type) as keyof typeof inboundMediaFields;
    const field = inboundMediaFields[type];
    if (!field) continue;
    const metadata = mediaRecord(item[field]);
    const media = mediaRecord(metadata.media);
    const query = String(media.encrypt_query_param || "").trim();
    const urlText = String(media.full_url || "").trim()
      || (query ? DEFAULT_WEIXIN_CDN_BASE_URL + "/download?encrypted_query_param=" + encodeURIComponent(query) : "");
    const key = mediaKey(metadata, media, type === 2);
    if (!urlText || (!key && (type !== 2 || media.aes_key || metadata.aeskey))) continue;
    let url: URL;
    try { url = new URL(urlText); } catch { continue; }
    if (url.protocol !== "https:" || !url.hostname.endsWith(".weixin.qq.com") || url.username || url.password) continue;
    const controller = new AbortController();
    const abortFromParent = () => controller.abort();
    if (signal?.aborted) controller.abort();
    else signal?.addEventListener("abort", abortFromParent, { once: true });
    const timeout = setTimeout(() => controller.abort(), getTimeoutMs("deadline.weixinOpenClaw.downloadWeixinImages", 20_000));
    try {
      const response = await fetchImpl(url, { signal: controller.signal, redirect: "error" });
      const payload = await readWeixinMediaBody(response);
      if (!payload?.length) continue;
      const decipher = key ? createDecipheriv("aes-128-ecb", key, null) : undefined;
      const bytes = decipher ? Buffer.concat([decipher.update(payload), decipher.final()]) : payload;
      if (!bytes.length || bytes.length > WEIXIN_MEDIA_LIMIT) continue;
      const format = type === 2 ? imageFormat(bytes) : undefined;
      if (format && !format.mimeType.startsWith("image/")) continue;
      const dir = path.join(dataDir, "weixin-media", String(messageId).replace(/[^a-zA-Z0-9_-]/g, "_"));
      fs.mkdirSync(dir, { recursive: true });
      const fileName = path.win32.basename(path.posix.basename(String(metadata.file_name || "")))
        .replace(/[<>:"/\\|?*\x00-\x1f]/g, "_").trim().slice(0, 180);
      const name = format ? `image-${index}.${format.extension}`
        : type === 3 ? `voice-${index}.silk`
        : type === 5 ? `video-${index}.mp4`
        : `file-${index}-${fileName || "attachment"}`;
      const mimeType = format?.mimeType ?? (type === 3 ? "audio/silk" : type === 5 ? "video/mp4" : "application/octet-stream");
      const filePath = path.join(dir, name);
      await fs.promises.writeFile(filePath, bytes);
      recordDataMutationAudit({
        group: "weixin",
        event: "weixin_media_written",
        owner: "weixin-openclaw",
        action: "store-inbound-media",
        target: { type: "message-media", id: `${messageId}:${index}` },
        dataSource: { kind: "file", id: `weixin-media/${name}` },
        outcome: "committed",
        changes: [{ field: "size", to: bytes.length }]
      });
      output.push({ path: filePath, name, mimeType, size: bytes.length });
    } catch (error) {
      if (!signal?.aborted) recordDataMutationAudit({
        level: "warn", group: "weixin", event: "weixin_media_failed", owner: "weixin-openclaw",
        action: "store-inbound-media", target: { type: "message-media", id: `${messageId}:${index}` },
        dataSource: { kind: "file", id: "weixin-media" },
        outcome: "failed", result: error instanceof Error ? error.name : "unknown"
      });
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", abortFromParent);
    }
  }
  return output;
}

export function weixinStatePath(dataDir: string): string {
  return path.join(dataDir, "weixin-openclaw-state.json");
}

function defaultStateProtector(dataDir: string): WeixinStateProtector {
  return createLocalSecretProtector(dataDir, ".weixin-session.key");
}

export function readWeixinState(
  dataDir: string,
  baseUrl = DEFAULT_WEIXIN_BASE_URL,
  protector = defaultStateProtector(dataDir)
): WeixinOpenClawState {
  const filePath = weixinStatePath(dataDir);
  if (!fs.existsSync(filePath)) {
    return {
      baseUrl,
      contextTokens: {},
      authState: "never_logged_in",
      credentialsRetained: false,
      updatedAt: new Date(0).toISOString()
    };
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8")) as Partial<WeixinOpenClawState> & Partial<PersistedWeixinState>;
    if (parsed.schemaVersion === 2) {
      const persistedBaseUrl = typeof parsed.baseUrl === "string" && parsed.baseUrl.trim()
        ? parsed.baseUrl.replace(/\/$/, "")
        : baseUrl;
      const authState = parsed.authState === "recoverable" || parsed.authState === "invalid"
        ? parsed.authState
        : "never_logged_in";
      if (typeof parsed.protectedSession === "string" && parsed.protectedSession) {
        if (parsed.protection !== protector.scheme) {
          return {
            baseUrl: persistedBaseUrl,
            contextTokens: {},
            authState: "recoverable",
            credentialsRetained: true,
            storageFormat: "protected",
            storageError: "微信机器人安全会话无法由当前系统账户解密。",
            lastConfirmedAt: parsed.lastConfirmedAt,
            updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : new Date(0).toISOString()
          };
        }
        try {
          const secret = JSON.parse(protector.unprotect(parsed.protectedSession)) as Partial<WeixinOpenClawState>;
          const token = typeof secret.token === "string" && secret.token.trim() ? secret.token.trim() : undefined;
          return {
            token,
            accountId: typeof secret.accountId === "string" && secret.accountId.trim() ? secret.accountId.trim() : undefined,
            userId: typeof secret.userId === "string" && secret.userId.trim() ? secret.userId.trim() : undefined,
            baseUrl: persistedBaseUrl,
            syncBuf: typeof secret.syncBuf === "string" ? secret.syncBuf : undefined,
            contextTokens: secret.contextTokens && typeof secret.contextTokens === "object" && !Array.isArray(secret.contextTokens)
              ? Object.fromEntries(Object.entries(secret.contextTokens).filter((entry): entry is [string, string] =>
                Boolean(entry[0].trim() && typeof entry[1] === "string" && entry[1].trim())))
              : {},
            authState: token ? "recoverable" : authState,
            credentialsRetained: Boolean(token || parsed.credentialsRetained),
            lastConfirmedAt: parsed.lastConfirmedAt,
            invalidatedAt: parsed.invalidatedAt,
            storageFormat: "protected",
            updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : new Date(0).toISOString()
          };
        } catch {
          return {
            baseUrl: persistedBaseUrl,
            contextTokens: {},
            authState: "recoverable",
            credentialsRetained: true,
            storageFormat: "protected",
            storageError: "微信机器人安全会话解密失败；凭据文件已保留，未要求重新扫码。",
            lastConfirmedAt: parsed.lastConfirmedAt,
            updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : new Date(0).toISOString()
          };
        }
      }
      return {
        baseUrl: persistedBaseUrl,
        contextTokens: {},
        authState,
        credentialsRetained: false,
        invalidatedAt: parsed.invalidatedAt,
        lastConfirmedAt: parsed.lastConfirmedAt,
        storageFormat: "protected",
        updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : new Date(0).toISOString()
      };
    }
    return {
      token: typeof parsed.token === "string" && parsed.token.trim() ? parsed.token.trim() : undefined,
      accountId: typeof parsed.accountId === "string" && parsed.accountId.trim() ? parsed.accountId.trim() : undefined,
      userId: typeof parsed.userId === "string" && parsed.userId.trim() ? parsed.userId.trim() : undefined,
      baseUrl: typeof parsed.baseUrl === "string" && parsed.baseUrl.trim() ? parsed.baseUrl.replace(/\/$/, "") : baseUrl,
      syncBuf: typeof parsed.syncBuf === "string" ? parsed.syncBuf : undefined,
      contextTokens: parsed.contextTokens && typeof parsed.contextTokens === "object" && !Array.isArray(parsed.contextTokens)
        ? Object.fromEntries(Object.entries(parsed.contextTokens).flatMap(([key, value]) => {
          const token = typeof value === "string" ? value.trim() : "";
          return key.trim() && token ? [[key.trim(), token]] : [];
        }))
        : {},
      authState: typeof parsed.token === "string" && parsed.token.trim() ? "recoverable" : "invalid",
      credentialsRetained: Boolean(typeof parsed.token === "string" && parsed.token.trim()),
      storageFormat: "legacy_plaintext",
      updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : new Date(0).toISOString()
    };
  } catch {
    return {
      baseUrl,
      contextTokens: {},
      authState: "invalid",
      credentialsRetained: false,
      storageError: "微信机器人会话状态文件无法读取。",
      updatedAt: new Date(0).toISOString()
    };
  }
}

export function writeWeixinState(
  dataDir: string,
  state: WeixinOpenClawState,
  protector = defaultStateProtector(dataDir)
): void {
  fs.mkdirSync(dataDir, { recursive: true });
  const filePath = weixinStatePath(dataDir);
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  const now = new Date().toISOString();
  const authState = state.token ? "recoverable" : state.authState === "never_logged_in" ? "never_logged_in" : "invalid";
  const secret = state.token ? {
    token: state.token,
    accountId: state.accountId,
    userId: state.userId,
    syncBuf: state.syncBuf,
    contextTokens: state.contextTokens
  } : undefined;
  const persisted: PersistedWeixinState = {
    schemaVersion: 2,
    protection: secret ? protector.scheme : undefined,
    protectedSession: secret ? protector.protect(JSON.stringify(secret)) : undefined,
    baseUrl: state.baseUrl,
    authState,
    credentialsRetained: Boolean(secret),
    lastConfirmedAt: state.lastConfirmedAt,
    invalidatedAt: state.invalidatedAt,
    updatedAt: now
  };
  try {
    fs.writeFileSync(tempPath, JSON.stringify(persisted, null, 2), "utf8");
    fs.renameSync(tempPath, filePath);
  } catch (error) {
    recordDataMutationAudit({
      level: "error",
      group: "weixin",
      event: "weixin_state_write_failed",
      owner: "weixin-openclaw",
      action: "persist-session-state",
      target: { type: "weixin-session", id: "current" },
      dataSource: { kind: "file", id: "weixin-openclaw-state.json" },
      outcome: "failed",
      error
    });
    throw error;
  }
  recordDataMutationAudit({
    group: "weixin",
    event: "weixin_state_written",
    owner: "weixin-openclaw",
    action: "persist-session-state",
    target: { type: "weixin-session", id: "current" },
    dataSource: { kind: "file", id: "weixin-openclaw-state.json" },
    outcome: "committed",
    after: { revision: now },
    result: authState,
    changes: [{ field: "credentialsRetained", to: Boolean(secret) }]
  });
}

function base64RandomUin(): string {
  return randomBytes(4).readUInt32BE(0).toString();
}

function requestHeaders(token?: string, extra?: Record<string, string>): Record<string, string> {
  return {
    "content-type": "application/json",
    AuthorizationType: "ilink_bot_token",
    "X-WECHAT-UIN": Buffer.from(base64RandomUin(), "utf8").toString("base64"),
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    ...extra
  };
}

async function requestJson(
  state: Pick<WeixinOpenClawState, "baseUrl" | "token">,
  method: "GET" | "POST",
  endpoint: string,
  options: { params?: Record<string, string>; payload?: unknown; tokenRequired?: boolean; timeoutMs?: number; headers?: Record<string, string>; signal?: AbortSignal } = {}
): Promise<Record<string, unknown>> {
  const url = new URL(endpoint.replace(/^\//, ""), `${state.baseUrl.replace(/\/$/, "")}/`);
  for (const [key, value] of Object.entries(options.params ?? {})) url.searchParams.set(key, value);
  const controller = new AbortController();
  const abortFromParent = () => controller.abort();
  if (options.signal?.aborted) controller.abort();
  else options.signal?.addEventListener("abort", abortFromParent, { once: true });
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? getTimeoutMs("backend.weixinOpenClaw.requestJson.setTimeout.timeoutMs", 35000));
  try {
    const response = await fetch(url, {
      method,
      headers: requestHeaders(options.tokenRequired ? state.token : undefined, options.headers),
      body: method === "POST" ? JSON.stringify(options.payload ?? {}) : undefined,
      signal: controller.signal
    });
    const text = await response.text();
    if (!response.ok) throw new WeixinHttpError(response.status, method, endpoint);
    return text ? JSON.parse(text) as Record<string, unknown> : {};
  } finally {
    clearTimeout(timeout);
    options.signal?.removeEventListener("abort", abortFromParent);
  }
}

export function weixinApiSucceeded(payload: Record<string, unknown>): boolean {
  return Number(payload.ret || 0) === 0 && Number(payload.errcode || 0) === 0;
}

export function weixinApiError(payload: Record<string, unknown>): string {
  return `ret=${Number(payload.ret || 0)}, errcode=${Number(payload.errcode || 0)}, errmsg=${String(payload.errmsg || "")}`;
}

export async function requestWeixinQrSession(
  baseUrl: string, botType = "3", signal?: AbortSignal, realNameTicket?: string
): Promise<WeixinQrSession> {
  const options = {
    params: { bot_type: botType },
    timeoutMs: getTimeoutMs("backend.weixinOpenClaw.requestWeixinQrSession.requestJson.timeoutMs", 15000),
    signal
  };
  let data: Record<string, unknown>;
  try {
    data = await requestJson({ baseUrl }, "POST", "ilink/bot/get_bot_qrcode", { ...options,
      payload: { local_token_list: [], ...(realNameTicket ? { bot_spam_ticket: realNameTicket } : {}) } });
  } catch (error) {
    if (realNameTicket || !(error instanceof WeixinHttpError) || ![404, 405].includes(error.status)) throw error;
    data = await requestJson({ baseUrl }, "GET", "ilink/bot/get_bot_qrcode", options);
  }
  const qrcode = String(data.qrcode || "").trim();
  const qrcodeImageContent = String(data.qrcode_img_content || "").trim();
  if (!qrcode || !qrcodeImageContent) throw new Error("微信二维码响应缺少 qrcode 或 qrcode_img_content。 ");
  return { qrcode, qrcodeImageContent, startedAt: Date.now(), status: "wait" };
}

const realNameOrigin = "https://weixin110.qq.com";
const realNameEndpoint = "/security/acct/botrealnameverifycgi";

async function requestWeixinRealName(params: Record<string, string>, signal: AbortSignal) {
  const url = new URL(realNameEndpoint, realNameOrigin);
  for (const [name, value] of Object.entries(params)) url.searchParams.set(name, value);
  const response = await fetch(url, { headers: { Accept: "application/json" }, signal: AbortSignal.any([signal, AbortSignal.timeout(10000)]) });
  if (!response.ok) throw new WeixinHttpError(response.status, "GET", realNameEndpoint);
  const result = mediaRecord(await response.json());
  return mediaRecord(result.data ?? result);
}

export async function startWeixinRealName(signal: AbortSignal) {
  const result = await requestWeixinRealName({ step: "get_auth_url", plugin_version: weixinBaseInfo.channel_version }, signal);
  const ticket = typeof result.bot_spam_ticket === "string" ? result.bot_spam_ticket : "";
  const qrContent = typeof result.auth_url === "string" ? result.auth_url : "";
  const expiresAt = Number(result.expire_time) * 1000;
  if (!/^[a-f0-9]{32}$/i.test(ticket) || !qrContent || !Number.isFinite(expiresAt) || expiresAt <= Date.now()) {
    throw new Error("微信平台没有返回有效的实名授权二维码。");
  }
  return { ticket, qrContent, expiresAt };
}

export async function pollWeixinRealName(ticket: string, signal: AbortSignal) {
  const result = await requestWeixinRealName({ step: "query_auth_result", bot_spam_ticket: ticket }, signal);
  return Number(result.auth_status);
}

export async function pollWeixinQrSession(
  baseUrl: string,
  session: WeixinQrSession,
  signal?: AbortSignal,
  verifyCode?: string
): Promise<Record<string, unknown>> {
  return requestJson({ baseUrl: session.pollBaseUrl ?? baseUrl }, "GET", "ilink/bot/get_qrcode_status", {
    params: { qrcode: session.qrcode, ...(verifyCode ? { verify_code: verifyCode } : {}) },
    timeoutMs: getTimeoutMs("backend.weixinOpenClaw.pollWeixinQrSession.requestJson.timeoutMs", 35000),
    headers: { "iLink-App-ClientVersion": "1" },
    signal
  });
}

export async function pollWeixinUpdates(state: WeixinOpenClawState, signal?: AbortSignal): Promise<Record<string, unknown>> {
  if (!state.token) throw new Error("微信尚未登录。 ");
  return requestJson(state, "POST", "ilink/bot/getupdates", {
    tokenRequired: true,
    timeoutMs: getTimeoutMs("backend.weixinOpenClaw.pollWeixinUpdates.requestJson.timeoutMs", state.longPollingTimeoutMs ?? 35000),
    signal,
    payload: {
      base_info: weixinBaseInfo,
      get_updates_buf: state.syncBuf || ""
    }
  });
}

const weixinBaseInfo = { channel_version: "0.1.5", bot_agent: "RabiRoute" };

export async function notifyWeixinConnection(state: WeixinOpenClawState, connected: boolean, signal?: AbortSignal): Promise<void> {
  if (!state.token) return;
  const result = await requestJson(state, "POST", connected ? "ilink/bot/msg/notifystart" : "ilink/bot/msg/notifystop", {
    tokenRequired: true, timeoutMs: 3000, signal, payload: { base_info: weixinBaseInfo }
  });
  if (!weixinApiSucceeded(result)) throw new Error(weixinApiError(result));
}

export async function setWeixinTyping(dataDir: string, sessionId: string, typing: boolean, signal?: AbortSignal): Promise<void> {
  const state = readWeixinState(dataDir);
  if (!state.token) throw new Error("请先扫码登录微信机器人。");
  const contextToken = state.contextTokens[sessionId];
  const config = await requestJson(state, "POST", "ilink/bot/getconfig", { tokenRequired: true, signal, payload: {
    base_info: weixinBaseInfo, ilink_user_id: sessionId, ...(contextToken ? { context_token: contextToken } : {})
  } });
  if (!weixinApiSucceeded(config)) throw new Error(weixinApiError(config));
  const ticket = config.typing_ticket;
  if (typeof ticket !== "string" || !ticket) throw new Error("微信平台没有返回此会话的输入状态凭据。");
  const result = await requestJson(state, "POST", "ilink/bot/sendtyping", { tokenRequired: true, signal, payload: {
    base_info: weixinBaseInfo, ilink_user_id: sessionId, typing_ticket: ticket, status: typing ? 1 : 2
  } });
  if (!weixinApiSucceeded(result)) throw new Error(weixinApiError(result));
}

function deliveryClientId(deliveryId: string): string {
  return createHash("sha256").update(deliveryId).digest("hex").slice(0, 32);
}

function aesEcbPaddedSize(plaintextSize: number): number {
  return Math.ceil((plaintextSize + 1) / 16) * 16;
}

function encryptAesEcb(plaintext: Buffer, key: Buffer): Buffer {
  const cipher = createCipheriv("aes-128-ecb", key, null);
  return Buffer.concat([cipher.update(plaintext), cipher.final()]);
}

function sendWeixinItem(
  state: WeixinOpenClawState, sessionId: string, deliveryId: string, item: object, timeoutMs?: number
): Promise<Record<string, unknown>> {
  const contextToken = state.contextTokens[sessionId];
  return requestJson(state, "POST", "ilink/bot/sendmessage", { tokenRequired: true, timeoutMs, payload: {
    base_info: weixinBaseInfo,
    msg: { from_user_id: "", to_user_id: sessionId, client_id: deliveryClientId(deliveryId), message_type: 2,
      message_state: 2, ...(contextToken ? { context_token: contextToken } : {}), item_list: [item] }
  } });
}

export async function sendWeixinText(
  dataDir: string,
  sessionId: string,
  text: string,
  deliveryId: string
): Promise<Record<string, unknown>> {
  const state = readWeixinState(dataDir);
  if (!state.token) throw new Error("微信机器人未登录，请先在 RabiRoute 扫码。 ");
  const payload = await sendWeixinItem(state, sessionId, deliveryId, { type: 1, text_item: { text } });
  if (!weixinApiSucceeded(payload)) throw new Error(`微信发送失败：${weixinApiError(payload)}`);
  return payload;
}

export async function sendWeixinFile(
  dataDir: string,
  sessionId: string,
  filePath: string,
  fileName: string,
  deliveryId: string
): Promise<Record<string, unknown>> {
  const kind = path.extname(fileName || filePath).toLowerCase() === ".mp4" ? "video" : "file";
  return sendWeixinMedia(dataDir, sessionId, filePath, fileName, deliveryId, kind);
}

export async function sendWeixinImage(
  dataDir: string,
  sessionId: string,
  filePath: string,
  deliveryId: string
): Promise<Record<string, unknown>> {
  return sendWeixinMedia(dataDir, sessionId, filePath, path.basename(filePath), deliveryId, "image");
}

async function sendWeixinMedia(
  dataDir: string,
  sessionId: string,
  filePath: string,
  fileName: string,
  deliveryId: string,
  kind: "file" | "image" | "video"
): Promise<Record<string, unknown>> {
  const state = readWeixinState(dataDir);
  if (!state.token) throw new Error("微信机器人未登录，请先在 RabiRoute 扫码。 ");
  const stat = await fs.promises.stat(filePath);
  if (!stat.isFile()) throw new Error("微信机器人待发送路径不是普通文件。 ");

  const plaintext = await fs.promises.readFile(filePath);
  const aesKey = randomBytes(16);
  const fileKey = randomBytes(16).toString("hex");
  const rawMd5 = createHash("md5").update(plaintext).digest("hex");
  const ciphertext = encryptAesEcb(plaintext, aesKey);
  const upload = await requestJson(state, "POST", "ilink/bot/getuploadurl", {
    tokenRequired: true,
    timeoutMs: getTimeoutMs("backend.weixinOpenClaw.sendWeixinMedia.requestJson.timeoutMs", 15000),
    payload: {
      filekey: fileKey,
      media_type: kind === "image" ? 1 : kind === "video" ? 2 : 3,
      to_user_id: sessionId,
      rawsize: plaintext.length,
      rawfilemd5: rawMd5,
      filesize: aesEcbPaddedSize(plaintext.length),
      no_need_thumb: true,
      aeskey: aesKey.toString("hex"),
      base_info: weixinBaseInfo
    }
  });
  if (!weixinApiSucceeded(upload)) throw new Error(`微信文件上传授权失败：${weixinApiError(upload)}`);
  const uploadFullUrl = String(upload.upload_full_url || "").trim();
  const uploadParam = String(upload.upload_param || "").trim();
  if (!uploadFullUrl && !uploadParam) throw new Error("微信文件上传授权没有返回上传地址。 ");
  const uploadUrl = uploadFullUrl || `${DEFAULT_WEIXIN_CDN_BASE_URL}/upload?encrypted_query_param=${encodeURIComponent(uploadParam)}&filekey=${encodeURIComponent(fileKey)}`;

  let encryptedQueryParam = "";
  let lastUploadError: unknown;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const response = await fetch(uploadUrl, {
        method: "POST",
        headers: { "content-type": "application/octet-stream" },
        body: new Uint8Array(ciphertext),
        signal: AbortSignal.timeout(30000)
      });
      await response.body?.cancel();
      if (response.status !== 200) throw new WeixinHttpError(response.status, "POST", "media upload");
      encryptedQueryParam = String(response.headers.get("x-encrypted-param") || "").trim();
      if (!encryptedQueryParam) throw new Error("微信 CDN 上传响应缺少文件引用。 ");
      break;
    } catch (error) {
      lastUploadError = error;
      if (attempt === 3 || (error instanceof WeixinHttpError && error.status >= 400 && error.status < 500)) throw error;
    }
  }
  if (!encryptedQueryParam) {
    throw lastUploadError instanceof Error ? lastUploadError : new Error("微信 CDN 文件上传失败。 ");
  }

  const media = { encrypt_query_param: encryptedQueryParam,
    aes_key: Buffer.from(aesKey.toString("hex")).toString("base64"), encrypt_type: 1 };
  const item = kind === "image" ? { type: 2, image_item: { media, mid_size: ciphertext.length } }
    : kind === "video" ? { type: 5, video_item: { media, video_size: ciphertext.length } }
    : { type: 4, file_item: { media, file_name: fileName, len: String(plaintext.length) } };
  const payload = await sendWeixinItem(state, sessionId, deliveryId, item,
    getTimeoutMs("backend.weixinOpenClaw.sendWeixinMedia.requestJson.timeoutMs", 15000));
  if (!weixinApiSucceeded(payload)) throw new Error(`微信文件发送失败：${weixinApiError(payload)}`);
  return { ok: true, fileName, size: plaintext.length, kind };
}

export function textFromWeixinItems(items: unknown): { text: string; messageType: string; hasText?: boolean; quotedText?: string; repliedMessageId?: string } {
  if (!Array.isArray(items)) return { text: "", messageType: "unknown" };
  const parts: string[] = [];
  const kinds = new Set<string>();
  let quotedText: string | undefined;
  let repliedMessageId: string | undefined;
  let hasText = false;
  for (const raw of items) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const item = raw as Record<string, unknown>;
    const type = Number(item.type || 0);
    if (type === 1) {
      const textItem = item.text_item as Record<string, unknown> | undefined;
      const value = String(textItem?.text || "").trim();
      if (value) { parts.push(value); hasText = true; }
      kinds.add("text");
    } else if (type === 2) {
      parts.push("[图片]");
      kinds.add("image");
    } else if (type === 3) {
      const voiceItem = item.voice_item as Record<string, unknown> | undefined;
      const transcript = String(voiceItem?.text || "").trim();
      if (transcript) hasText = true;
      parts.push(transcript || "[语音]");
      kinds.add("voice");
    } else if (type === 4) {
      parts.push("[文件]");
      kinds.add("file");
    } else if (type === 5) {
      parts.push("[视频]");
      kinds.add("video");
    }
    const ref = item.ref_msg as Record<string, unknown> | undefined;
    const refItem = ref?.message_item as Record<string, unknown> | undefined;
    if (refItem) {
      quotedText = textFromWeixinItems([refItem]).text || undefined;
      repliedMessageId = String(ref?.message_id || ref?.msg_id || refItem.message_id || refItem.msg_id || "").trim() || undefined;
    }
  }
  return {
    text: parts.join("\n").trim(),
    hasText,
    messageType: kinds.size === 1 ? [...kinds][0] : kinds.size > 1 ? "mixed" : "unknown",
    quotedText,
    repliedMessageId
  };
}
