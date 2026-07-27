import fs from "node:fs";
import path from "node:path";
import { createHash, randomBytes } from "node:crypto";

export const DEFAULT_WEIXIN_BASE_URL = "https://ilinkai.weixin.qq.com";
export const WEIXIN_SESSION_TIMEOUT_ERRCODE = -14;

export type WeixinOpenClawState = {
  token?: string;
  accountId?: string;
  userId?: string;
  baseUrl: string;
  syncBuf?: string;
  contextTokens: Record<string, string>;
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

export function weixinStatePath(dataDir: string): string {
  return path.join(dataDir, "weixin-openclaw-state.json");
}

export function readWeixinState(dataDir: string, baseUrl = DEFAULT_WEIXIN_BASE_URL): WeixinOpenClawState {
  const filePath = weixinStatePath(dataDir);
  if (!fs.existsSync(filePath)) {
    return { baseUrl, contextTokens: {}, updatedAt: new Date(0).toISOString() };
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8")) as Partial<WeixinOpenClawState>;
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
      updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : new Date(0).toISOString()
    };
  } catch {
    return { baseUrl, contextTokens: {}, updatedAt: new Date(0).toISOString() };
  }
}

export function writeWeixinState(dataDir: string, state: WeixinOpenClawState): void {
  fs.mkdirSync(dataDir, { recursive: true });
  const filePath = weixinStatePath(dataDir);
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify({ ...state, updatedAt: new Date().toISOString() }, null, 2), "utf8");
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
    if (!response.ok) throw new Error(`${method} ${endpoint} failed: HTTP ${response.status}`);
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
