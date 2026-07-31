import fs from "node:fs";
import path from "node:path";
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";

export const DEFAULT_WEIXIN_BASE_URL = "https://ilinkai.weixin.qq.com";
export const DEFAULT_WEIXIN_CDN_BASE_URL = "https://novac2c.cdn.weixin.qq.com/c2c";
export const WEIXIN_SESSION_TIMEOUT_ERRCODE = -14;

export class WeixinHttpError extends Error {
  constructor(
    public readonly status: number,
    method: string,
    endpoint: string
  ) {
    super(`个人微信 API 明确拒绝请求（HTTP ${status}，${method} ${endpoint}）。`);
    this.name = "WeixinHttpError";
  }
}

export type WeixinOpenClawState = {
  token?: string;
  accountId?: string;
  userId?: string;
  baseUrl: string;
  syncBuf?: string;
  contextTokens: Record<string, string>;
  authState?: "never_logged_in" | "recoverable" | "invalid";
  credentialsRetained?: boolean;
  lastConfirmedAt?: string;
  invalidatedAt?: string;
  storageFormat?: "protected" | "legacy_plaintext";
  storageError?: string;
  updatedAt: string;
};

export type WeixinStateProtector = {
  scheme: string;
  protect(plaintext: string): string;
  unprotect(protectedValue: string): string;
};

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
};

export type WeixinInboundMessage = {
  from_user_id?: unknown;
  context_token?: unknown;
  item_list?: unknown;
  message_id?: unknown;
  msg_id?: unknown;
  create_time_ms?: unknown;
  create_time?: unknown;
};

export type WeixinDownloadedImage = {
  path: string;
  name: string;
  mimeType: string;
  size: number;
};

const MAX_WEIXIN_IMAGE_BYTES = 15 * 1024 * 1024;

function imageFormat(bytes: Buffer): { extension: string; mimeType: string } {
  if (bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return { extension: "png", mimeType: "image/png" };
  if (bytes.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))) return { extension: "jpg", mimeType: "image/jpeg" };
  if (bytes.subarray(0, 6).toString("ascii") === "GIF87a" || bytes.subarray(0, 6).toString("ascii") === "GIF89a") return { extension: "gif", mimeType: "image/gif" };
  if (bytes.subarray(0, 4).toString("ascii") === "RIFF" && bytes.subarray(8, 12).toString("ascii") === "WEBP") return { extension: "webp", mimeType: "image/webp" };
  return { extension: "bin", mimeType: "application/octet-stream" };
}

function imageKey(item: Record<string, unknown>): Buffer | undefined {
  const direct = String(item.aeskey || "").trim();
  if (/^[0-9a-f]{32}$/i.test(direct)) return Buffer.from(direct, "hex");
  const media = item.media && typeof item.media === "object" && !Array.isArray(item.media) ? item.media as Record<string, unknown> : {};
  const encoded = String(media.aes_key || "").trim();
  if (!encoded) return undefined;
  const decoded = Buffer.from(encoded, "base64").toString("utf8").trim();
  return /^[0-9a-f]{32}$/i.test(decoded) ? Buffer.from(decoded, "hex") : undefined;
}

/** Download an inbound personal-Weixin image into private runtime storage.
 * The CDN payload is AES-128-ECB encrypted; no remote URL or encryption key is
 * propagated to the agent prompt. */
export async function downloadWeixinImages(
  items: unknown,
  dataDir: string,
  messageId: string,
  fetchImpl: typeof fetch = fetch
): Promise<WeixinDownloadedImage[]> {
  if (!Array.isArray(items)) return [];
  const output: WeixinDownloadedImage[] = [];
  for (const [index, raw] of items.entries()) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const item = raw as Record<string, unknown>;
    if (Number(item.type || 0) !== 2) continue;
    const image = item.image_item && typeof item.image_item === "object" && !Array.isArray(item.image_item)
      ? item.image_item as Record<string, unknown>
      : {};
    const media = image.media && typeof image.media === "object" && !Array.isArray(image.media)
      ? image.media as Record<string, unknown>
      : {};
    const urlText = String(media.full_url || "").trim();
    const key = imageKey(image);
    if (!urlText || !key) continue;
    let url: URL;
    try { url = new URL(urlText); } catch { continue; }
    if (url.protocol !== "https:" || !url.hostname.endsWith(".weixin.qq.com")) continue;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 20_000);
    try {
      const response = await fetchImpl(url, { signal: controller.signal });
      if (!response.ok) continue;
      const encrypted = Buffer.from(await response.arrayBuffer());
      if (!encrypted.length || encrypted.length > MAX_WEIXIN_IMAGE_BYTES + 32) continue;
      let bytes: Buffer;
      try {
        const decipher = createDecipheriv("aes-128-ecb", key, null);
        bytes = Buffer.concat([decipher.update(encrypted), decipher.final()]);
      } catch {
        continue;
      }
      if (!bytes.length || bytes.length > MAX_WEIXIN_IMAGE_BYTES) continue;
      const format = imageFormat(bytes);
      if (!format.mimeType.startsWith("image/")) continue;
      const dir = path.join(dataDir, "weixin-media", String(messageId).replace(/[^a-zA-Z0-9_-]/g, "_"));
      fs.mkdirSync(dir, { recursive: true });
      const name = `image-${index}.${format.extension}`;
      const filePath = path.join(dir, name);
      fs.writeFileSync(filePath, bytes);
      output.push({ path: filePath, name, mimeType: format.mimeType, size: bytes.length });
    } finally {
      clearTimeout(timeout);
    }
  }
  return output;
}

export function weixinStatePath(dataDir: string): string {
  return path.join(dataDir, "weixin-openclaw-state.json");
}

function powerShellDpapi(script: string, input: string): string {
  const executable = path.join(
    process.env.SystemRoot || "C:\\Windows",
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe"
  );
  const result = spawnSync(executable, ["-NoProfile", "-NonInteractive", "-Command", script], {
    input,
    encoding: "utf8",
    windowsHide: true,
    timeout: 5000,
    maxBuffer: 4 * 1024 * 1024
  });
  if (result.status !== 0 || result.error || !String(result.stdout || "").trim()) {
    throw new Error("Windows DPAPI operation failed.");
  }
  return String(result.stdout).trim();
}

function windowsStateProtector(): WeixinStateProtector {
  const protectScript = [
    "Add-Type -AssemblyName System.Security",
    "$plain=[Text.Encoding]::UTF8.GetBytes([Console]::In.ReadToEnd())",
    "$cipher=[Security.Cryptography.ProtectedData]::Protect($plain,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser)",
    "[Console]::Out.Write([Convert]::ToBase64String($cipher))"
  ].join(";");
  const unprotectScript = [
    "Add-Type -AssemblyName System.Security",
    "$cipher=[Convert]::FromBase64String([Console]::In.ReadToEnd().Trim())",
    "$plain=[Security.Cryptography.ProtectedData]::Unprotect($cipher,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser)",
    "[Console]::Out.Write([Convert]::ToBase64String($plain))"
  ].join(";");
  return {
    scheme: "windows-dpapi-current-user",
    protect: plaintext => powerShellDpapi(protectScript, plaintext),
    unprotect: protectedValue => Buffer.from(powerShellDpapi(unprotectScript, protectedValue), "base64").toString("utf8")
  };
}

function localKeyStateProtector(dataDir: string): WeixinStateProtector {
  const keyPath = path.join(dataDir, ".weixin-session.key");
  const readKey = (): Buffer => {
    fs.mkdirSync(dataDir, { recursive: true });
    if (!fs.existsSync(keyPath)) {
      try {
        fs.writeFileSync(keyPath, randomBytes(32), { flag: "wx", mode: 0o600 });
      } catch (error) {
        if (!fs.existsSync(keyPath)) throw error;
      }
    }
    const key = fs.readFileSync(keyPath);
    if (key.length !== 32) throw new Error("Local Weixin session key is invalid.");
    return key;
  };
  return {
    scheme: "local-aes-256-gcm-v1",
    protect: plaintext => {
      const iv = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", readKey(), iv);
      const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
      return [iv, cipher.getAuthTag(), encrypted].map(value => value.toString("base64")).join(".");
    },
    unprotect: protectedValue => {
      const [ivText, tagText, encryptedText] = protectedValue.split(".");
      if (!ivText || !tagText || !encryptedText) throw new Error("Protected Weixin session payload is invalid.");
      const decipher = createDecipheriv("aes-256-gcm", readKey(), Buffer.from(ivText, "base64"));
      decipher.setAuthTag(Buffer.from(tagText, "base64"));
      return Buffer.concat([
        decipher.update(Buffer.from(encryptedText, "base64")),
        decipher.final()
      ]).toString("utf8");
    }
  };
}

function defaultStateProtector(dataDir: string): WeixinStateProtector {
  return process.platform === "win32" ? windowsStateProtector() : localKeyStateProtector(dataDir);
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
            storageError: "个人微信安全会话无法由当前系统账户解密。",
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
            storageError: "个人微信安全会话解密失败；凭据文件已保留，未要求重新扫码。",
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
      storageError: "个人微信会话状态文件无法读取。",
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
  fs.writeFileSync(tempPath, JSON.stringify(persisted, null, 2), "utf8");
  fs.renameSync(tempPath, filePath);
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
  options: { params?: Record<string, string>; payload?: unknown; tokenRequired?: boolean; timeoutMs?: number; headers?: Record<string, string> } = {}
): Promise<Record<string, unknown>> {
  const url = new URL(endpoint.replace(/^\//, ""), `${state.baseUrl.replace(/\/$/, "")}/`);
  for (const [key, value] of Object.entries(options.params ?? {})) url.searchParams.set(key, value);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? 35000);
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
  }
}

export function weixinApiSucceeded(payload: Record<string, unknown>): boolean {
  return Number(payload.ret || 0) === 0 && Number(payload.errcode || 0) === 0;
}

export function weixinApiError(payload: Record<string, unknown>): string {
  return `ret=${Number(payload.ret || 0)}, errcode=${Number(payload.errcode || 0)}, errmsg=${String(payload.errmsg || "")}`;
}

export async function requestWeixinQrSession(baseUrl: string, botType = "3"): Promise<WeixinQrSession> {
  const data = await requestJson({ baseUrl }, "GET", "ilink/bot/get_bot_qrcode", {
    params: { bot_type: botType },
    timeoutMs: 15000
  });
  const qrcode = String(data.qrcode || "").trim();
  const qrcodeImageContent = String(data.qrcode_img_content || "").trim();
  if (!qrcode || !qrcodeImageContent) throw new Error("微信二维码响应缺少 qrcode 或 qrcode_img_content。 ");
  return { qrcode, qrcodeImageContent, startedAt: Date.now(), status: "wait" };
}

export async function pollWeixinQrSession(
  baseUrl: string,
  session: WeixinQrSession
): Promise<Record<string, unknown>> {
  return requestJson({ baseUrl }, "GET", "ilink/bot/get_qrcode_status", {
    params: { qrcode: session.qrcode },
    timeoutMs: 35000,
    headers: { "iLink-App-ClientVersion": "1" }
  });
}

export async function pollWeixinUpdates(state: WeixinOpenClawState): Promise<Record<string, unknown>> {
  if (!state.token) throw new Error("微信尚未登录。 ");
  return requestJson(state, "POST", "ilink/bot/getupdates", {
    tokenRequired: true,
    timeoutMs: 35000,
    payload: {
      base_info: { channel_version: "rabiroute" },
      get_updates_buf: state.syncBuf || ""
    }
  });
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

export async function sendWeixinText(
  dataDir: string,
  sessionId: string,
  text: string,
  deliveryId: string
): Promise<Record<string, unknown>> {
  const state = readWeixinState(dataDir);
  if (!state.token) throw new Error("个人微信未登录，请先在 RabiRoute 扫码。 ");
  const contextToken = state.contextTokens[sessionId];
  if (!contextToken) throw new Error("该微信会话没有可用 context token；需要用户先发一条新消息。 ");
  const payload = await requestJson(state, "POST", "ilink/bot/sendmessage", {
    tokenRequired: true,
    payload: {
      base_info: { channel_version: "rabiroute" },
      msg: {
        from_user_id: "",
        to_user_id: sessionId,
        client_id: deliveryClientId(deliveryId),
        message_type: 2,
        message_state: 2,
        context_token: contextToken,
        item_list: [{ type: 1, text_item: { text } }]
      }
    }
  });
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
  return sendWeixinMedia(dataDir, sessionId, filePath, fileName, deliveryId, "file");
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
  kind: "file" | "image"
): Promise<Record<string, unknown>> {
  const state = readWeixinState(dataDir);
  if (!state.token) throw new Error("个人微信未登录，请先在 RabiRoute 扫码。 ");
  const contextToken = state.contextTokens[sessionId];
  if (!contextToken) throw new Error("该微信会话没有可用 context token；需要用户先发一条新消息。 ");
  const stat = await fs.promises.stat(filePath);
  if (!stat.isFile()) throw new Error("个人微信待发送路径不是普通文件。 ");

  const plaintext = await fs.promises.readFile(filePath);
  const aesKey = randomBytes(16);
  const fileKey = randomBytes(16).toString("hex");
  const rawMd5 = createHash("md5").update(plaintext).digest("hex");
  const ciphertext = encryptAesEcb(plaintext, aesKey);
  const upload = await requestJson(state, "POST", "ilink/bot/getuploadurl", {
    tokenRequired: true,
    timeoutMs: 15000,
    payload: {
      filekey: fileKey,
      media_type: kind === "image" ? 1 : 3,
      to_user_id: sessionId,
      rawsize: plaintext.length,
      rawfilemd5: rawMd5,
      filesize: aesEcbPaddedSize(plaintext.length),
      no_need_thumb: true,
      aeskey: aesKey.toString("hex"),
      base_info: { channel_version: "rabiroute" }
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
        body: new Uint8Array(ciphertext)
      });
      if (!response.ok) {
        const detail = response.headers.get("x-error-message") || await response.text();
        throw new Error(`微信 CDN 上传失败：HTTP ${response.status}${detail ? ` ${detail}` : ""}`);
      }
      encryptedQueryParam = String(response.headers.get("x-encrypted-param") || "").trim();
      if (!encryptedQueryParam) throw new Error("微信 CDN 上传响应缺少文件引用。 ");
      break;
    } catch (error) {
      lastUploadError = error;
      if (attempt === 3) throw error;
    }
  }
  if (!encryptedQueryParam) {
    throw lastUploadError instanceof Error ? lastUploadError : new Error("微信 CDN 文件上传失败。 ");
  }

  const payload = await requestJson(state, "POST", "ilink/bot/sendmessage", {
    tokenRequired: true,
    timeoutMs: 15000,
    payload: {
      base_info: { channel_version: "rabiroute" },
      msg: {
        from_user_id: "",
        to_user_id: sessionId,
        client_id: deliveryClientId(deliveryId),
        message_type: 2,
        message_state: 2,
        context_token: contextToken,
        item_list: [kind === "image"
          ? {
              type: 2,
              image_item: {
                media: {
                  encrypt_query_param: encryptedQueryParam,
                  aes_key: aesKey.toString("base64"),
                  encrypt_type: 1
                }
              }
            }
          : {
              type: 4,
              file_item: {
                media: {
                  encrypt_query_param: encryptedQueryParam,
                  aes_key: Buffer.from(aesKey.toString("hex")).toString("base64"),
                  encrypt_type: 1
                },
                file_name: fileName,
                len: String(plaintext.length)
              }
            }
        ]
      }
    }
  });
  if (!weixinApiSucceeded(payload)) throw new Error(`微信文件发送失败：${weixinApiError(payload)}`);
  return { ok: true, fileName, size: plaintext.length, kind };
}

export function textFromWeixinItems(items: unknown): { text: string; messageType: string; quotedText?: string; repliedMessageId?: string } {
  if (!Array.isArray(items)) return { text: "", messageType: "unknown" };
  const parts: string[] = [];
  const kinds = new Set<string>();
  let quotedText: string | undefined;
  let repliedMessageId: string | undefined;
  for (const raw of items) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const item = raw as Record<string, unknown>;
    const type = Number(item.type || 0);
    if (type === 1) {
      const textItem = item.text_item as Record<string, unknown> | undefined;
      const value = String(textItem?.text || "").trim();
      if (value) parts.push(value);
      kinds.add("text");
    } else if (type === 2) {
      parts.push("[图片]");
      kinds.add("image");
    } else if (type === 3) {
      const voiceItem = item.voice_item as Record<string, unknown> | undefined;
      parts.push(String(voiceItem?.text || "").trim() || "[语音]");
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
      repliedMessageId = String(refItem.message_id || refItem.msg_id || "").trim() || undefined;
    }
  }
  return {
    text: parts.join("\n").trim(),
    messageType: kinds.size === 1 ? [...kinds][0] : kinds.size > 1 ? "mixed" : "unknown",
    quotedText,
    repliedMessageId
  };
}
