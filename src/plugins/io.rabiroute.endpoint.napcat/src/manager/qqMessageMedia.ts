import { constants as bufferConstants } from "node:buffer";
import { ReadSettingsError } from "@rabiroute/host-api/shared/readSettingsError";
import { promises as fs } from "node:fs";
import path from "node:path";
import type { NapCatEndpoint } from "../napcat.js";
import { qqReadSettings } from "@rabiroute/host-api/shared/qqReadSettings";

// Wire capacity; the owner applies the configured quota before reading.
export const QQ_MEDIA_MAX_BYTES = bufferConstants.MAX_LENGTH;
export type QqMessage = { message_id: string | number; message_type: string; group_id?: string | number; user_id?: string | number;
  self_id?: string | number; post_type?: string;
  time?: number; sender?: { user_id?: string | number; nickname?: string; card?: string }; message: unknown; raw_message?: string };
export type QqMedia = { kind: string; name: string; file?: string; url?: string };
/** Optional native seconds: keep numeric legacy strings, leave absent or malformed time unknown. */
export function qqMessageTimestamp(value: unknown): number | undefined {
  if (typeof value !== "number" && (typeof value !== "string" || !value.trim())) return undefined;
  const time = Number(value);
  return Number.isFinite(time) ? time : undefined;
}

export class QqReadError extends Error {
  constructor(public readonly status: number, public readonly code: string, detail?: string) { super(detail ? `${code}: ${detail}` : code); }
}

async function boundedBytes(response: Response, max: number, limitSetting?: string): Promise<Buffer> {
  if (!response.ok || !response.body) throw new QqReadError(503, "QQ_UPSTREAM_UNAVAILABLE");
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let size = 0;
  try {
    const tooLarge = () => new QqReadError(413, "QQ_RESPONSE_TOO_LARGE", limitSetting
      ? `QQ resource exceeds ${limitSetting}; effective limit is ${max} bytes. Set 0 to remove the application quota (runtime Buffer capacity still applies).` : undefined);
    if (Number(response.headers.get("content-length")) > max) throw tooLarge();
    for (;;) {
      const item = await reader.read();
      if (item.done) break;
      size += item.value.length;
      if (size > max) throw tooLarge();
      chunks.push(Buffer.from(item.value));
    }
    return Buffer.concat(chunks);
  } finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
}

/** No arbitrary OneBot action, request URL or error body crosses the public API. */
export async function qqRead(endpoint: NapCatEndpoint, action: "get_msg" | "get_group_msg_history" | "get_friend_msg_history" | "get_file" | "get_group_list" | "get_friend_list" | "get_group_member_list" | "get_login_info" | "get_recent_contact", payload: unknown,
  signal: AbortSignal, transport: typeof fetch = fetch): Promise<Record<string, unknown>> {
  const MAX_JSON_BYTES = qqReadSettings.jsonBytes;
  const origin = new URL(endpoint.httpUrl);
  if (!["http:", "https:"].includes(origin.protocol)
    || origin.username || origin.password || origin.search || origin.hash || origin.pathname !== "/") throw new QqReadError(409, "QQ_ENDPOINT_UNSAFE");
  try {
    const response = await transport(new URL(action, origin), { method: "POST", redirect: "error", signal,
      headers: { "content-type": "application/json", ...(endpoint.accessToken ? { authorization: `Bearer ${endpoint.accessToken}` } : {}) },
      body: JSON.stringify(payload) });
    if(!response.ok)throw new QqReadError(503,'QQ_UPSTREAM_UNAVAILABLE',`NapCat HTTP ${response.status}`);
    const envelope = JSON.parse((await boundedBytes(response, MAX_JSON_BYTES, "RABIROUTE_QQ_JSON_MAX_BYTES")).toString("utf8"));
    if (envelope?.status !== "ok" || envelope.retcode !== 0 || !envelope.data || typeof envelope.data !== "object") throw new QqReadError(503, "QQ_UPSTREAM_UNAVAILABLE",`NapCat retcode ${typeof envelope?.retcode==='number'?envelope.retcode:'invalid'}`);
    return envelope.data;
  } catch (error) {
    if (error instanceof QqReadError || error instanceof ReadSettingsError) throw error;
    const code=(error as {cause?:{code?:unknown}})?.cause?.code;
    if(typeof code==='string'&&['ECONNREFUSED','ECONNRESET','ETIMEDOUT','ENOTFOUND','UND_ERR_CONNECT_TIMEOUT'].includes(code))throw new QqReadError(503,'QQ_UPSTREAM_UNAVAILABLE',`NapCat transport ${code}`);
    throw new QqReadError(503, "QQ_UPSTREAM_UNAVAILABLE");
  }
}

function qqIdentityText(value: unknown): string | undefined {
  return typeof value === "string" || typeof value === "number" ? String(value) : undefined;
}

export function qqMessageHasId(value: unknown, messageId: string): value is QqMessage {
  return Boolean(value && typeof value === "object" && !Array.isArray(value)
    && qqIdentityText((value as QqMessage).message_id) === messageId);
}

/** NapCat omits the recipient on self-sent private messages; get_msg alone cannot prove their peer. */
export function qqPrivateMessageNeedsHistory(value: unknown): value is QqMessage {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const row = value as QqMessage;
  const selfId = qqIdentityText(row.self_id);
  return row.message_type === "private" && row.post_type === "message_sent"
    && selfId !== undefined && /^[1-9]\d{0,15}$/.test(selfId) && qqIdentityText(row.user_id) === selfId
    && qqIdentityText(row.sender?.user_id) === selfId;
}

export function qqMessageMatches(value: unknown, kind: string, target: string, source: "message" | "history" = "message"): value is QqMessage {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const row = value as QqMessage;
  const selfId = qqIdentityText(row.self_id), messageId = qqIdentityText(row.message_id);
  const selfSender = selfId !== undefined && /^[1-9]\d{0,15}$/.test(selfId) && qqIdentityText(row.user_id) === selfId;
  const matchesTarget = kind === "private" && (row.post_type === "message_sent" || selfSender)
    ? source === "history" && qqPrivateMessageNeedsHistory(row) : qqIdentityText(kind === "group" ? row.group_id : row.user_id) === target;
  return row.message_type === kind && matchesTarget
    && messageId !== undefined && /^-?\d{1,20}$/.test(messageId);
}

/** Video thumbnails are deliberately excluded: only actual message media is downloadable. */
export function qqMessageMedia(message: unknown): QqMedia[] {
  const segments: { type?: unknown; data?: Record<string, unknown> }[] = Array.isArray(message) ? message :
    typeof message === "string" ? [...message.matchAll(/\[CQ:(image|video|record|file),([^\]]+)\]/g)].map(match => ({
      type: match[1], data: Object.fromEntries(match[2].split(",").map(field => {
        const split = field.indexOf("=");
        return [field.slice(0, split), field.slice(split + 1).replaceAll("&#44;", ",").replaceAll("&#91;", "[").replaceAll("&#93;", "]").replaceAll("&amp;", "&")];
      }))
    })) : [];
  return segments.filter(item => item && ["image", "video", "record", "file"].includes(String(item.type))).map((item, index) => {
    const data = item.data ?? {};
    const kind = item.type === "record" ? "audio" : String(item.type);
    const file = typeof data.file_id === "string" && data.file_id ? data.file_id : typeof data.file === "string" ? data.file : undefined;
    const rawName = typeof data.name === "string" ? data.name : typeof data.file_name === "string" ? data.file_name : "";
    const name = path.basename(rawName.replaceAll("\\", "/")).replace(/[\x00-\x1f\x7f]/g, "").slice(0, 200)
      || `${kind}-${index + 1}${kind === "video" ? ".mp4" : kind === "image" ? ".png" : kind === "audio" ? ".silk" : ".bin"}`;
    return { kind, name, file, url: typeof data.url === "string" ? data.url : undefined };
  });
}

export function qqMessageText(message: QqMessage): string {
  if (Array.isArray(message.message)) return message.message.filter(item => item?.type === "text").map(item => String(item.data?.text ?? "")).join("").slice(0, 100_000);
  return String(message.raw_message ?? message.message ?? "").replace(/\[CQ:[^\]]*\]/g, "").slice(0, 100_000);
}

export async function readQqMedia(endpoint: NapCatEndpoint, media: QqMedia, signal: AbortSignal, transport: typeof fetch = fetch): Promise<Buffer> {
  const QQ_MEDIA_MAX_BYTES = qqReadSettings.mediaBytes;
  // Never pass a URL, path or base64 value from the message to get_file's arbitrary-file mode.
  if (!media.file || media.file.length > 4096 || /[/\\:]|^base64/i.test(media.file)) throw new QqReadError(422, "QQ_MEDIA_REFERENCE_UNAVAILABLE");
  const result = await qqRead(endpoint, "get_file", { file_id: media.file }, signal, transport);
  const tooLarge = () => new QqReadError(413, "QQ_MEDIA_TOO_LARGE",
    `QQ attachment exceeds RABIROUTE_QQ_MEDIA_MAX_BYTES; effective limit is ${QQ_MEDIA_MAX_BYTES} bytes. Set 0 to remove the application quota (runtime Buffer capacity still applies).`);
  if (Number(result.file_size) > QQ_MEDIA_MAX_BYTES) throw tooLarge();
  const localFile = typeof result.file === "string" && path.isAbsolute(result.file) ? result.file : undefined;
  if (localFile) {
    // The trusted local NapCat resolved this path from the selected message's resource ID.
    const handle = await fs.open(localFile, "r");
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size === 0) throw new QqReadError(422, "QQ_MEDIA_EMPTY");
      if (stat.size > QQ_MEDIA_MAX_BYTES) throw tooLarge();
      const bytes = Buffer.alloc(stat.size);
      let offset = 0;
      while (offset < bytes.length) {
        signal.throwIfAborted();
        const read = await handle.read(bytes, offset, bytes.length - offset, offset);
        if (!read.bytesRead) throw new QqReadError(409, "QQ_MEDIA_CHANGED");
        offset += read.bytesRead;
      }
      if ((await handle.stat()).size !== stat.size) throw new QqReadError(409, "QQ_MEDIA_CHANGED");
      return bytes;
    } finally { await handle.close(); }
  }
  // NapCat resolves the selected attachment; CDN host names and ports are not permissions.
  const value = typeof result.url === "string" && result.url ? result.url : media.url;
  let url: URL;
  try { url = new URL(value ?? ""); } catch { throw new QqReadError(422, "QQ_MEDIA_REFERENCE_UNAVAILABLE"); }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) throw new QqReadError(422, "QQ_MEDIA_URL_UNSUPPORTED");
  const bytes = await boundedBytes(await transport(url, { signal, redirect: "follow" }), QQ_MEDIA_MAX_BYTES, "RABIROUTE_QQ_MEDIA_MAX_BYTES");
  if (!bytes.length) throw new QqReadError(422, "QQ_MEDIA_EMPTY");
  return bytes;
}
