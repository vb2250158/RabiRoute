import { promises as fs } from "node:fs";
import path from "node:path";
import type { NapCatEndpoint } from "../napcat.js";

export const QQ_MEDIA_MAX_BYTES = 64 * 1024 * 1024;
const MAX_JSON_BYTES = 1024 * 1024;
export type QqMessage = { message_id: string | number; message_type: string; group_id?: string | number; user_id?: string | number;
  time?: number; sender?: { user_id?: string | number; nickname?: string; card?: string }; message: unknown; raw_message?: string };
export type QqMedia = { kind: string; name: string; file?: string; url?: string };
export class QqReadError extends Error {
  constructor(public readonly status: number, public readonly code: string) { super(code); }
}

async function boundedBytes(response: Response, max: number): Promise<Buffer> {
  if (!response.ok || !response.body) throw new QqReadError(503, "QQ_UPSTREAM_UNAVAILABLE");
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let size = 0;
  try {
    if (Number(response.headers.get("content-length")) > max) throw new QqReadError(413, "QQ_RESPONSE_TOO_LARGE");
    for (;;) {
      const item = await reader.read();
      if (item.done) break;
      size += item.value.length;
      if (size > max) throw new QqReadError(413, "QQ_RESPONSE_TOO_LARGE");
      chunks.push(Buffer.from(item.value));
    }
    return Buffer.concat(chunks);
  } finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
}

/** No arbitrary OneBot action, request URL or error body crosses the public API. */
export async function qqRead(endpoint: NapCatEndpoint, action: "get_msg" | "get_group_msg_history" | "get_friend_msg_history" | "get_file", payload: unknown,
  signal: AbortSignal, transport: typeof fetch = fetch): Promise<Record<string, unknown>> {
  const origin = new URL(endpoint.httpUrl);
  if (origin.protocol !== "http:" || !["127.0.0.1", "[::1]"].includes(origin.hostname)
    || origin.username || origin.password || origin.search || origin.hash || origin.pathname !== "/") throw new QqReadError(409, "QQ_ENDPOINT_UNSAFE");
  try {
    const response = await transport(new URL(action, origin), { method: "POST", redirect: "error", signal,
      headers: { "content-type": "application/json", ...(endpoint.accessToken ? { authorization: `Bearer ${endpoint.accessToken}` } : {}) },
      body: JSON.stringify(payload) });
    const envelope = JSON.parse((await boundedBytes(response, MAX_JSON_BYTES)).toString("utf8"));
    if (envelope?.status !== "ok" || envelope.retcode !== 0 || !envelope.data || typeof envelope.data !== "object") throw new QqReadError(503, "QQ_UPSTREAM_UNAVAILABLE");
    return envelope.data;
  } catch (error) {
    if (error instanceof QqReadError) throw error;
    throw new QqReadError(503, "QQ_UPSTREAM_UNAVAILABLE");
  }
}

export function qqMessageMatches(value: unknown, kind: string, target: string): value is QqMessage {
  if (!value || typeof value !== "object") return false;
  const row = value as QqMessage;
  return row.message_type === kind && String(kind === "group" ? row.group_id : row.user_id) === target
    && /^-?\d{1,20}$/.test(String(row.message_id));
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
  // Never pass a URL, path or base64 value from the message to get_file's arbitrary-file mode.
  if (!media.file || media.file.length > 4096 || /[/\\:]|^base64/i.test(media.file)) throw new QqReadError(422, "QQ_MEDIA_REFERENCE_UNAVAILABLE");
  const result = await qqRead(endpoint, "get_file", { file_id: media.file }, signal, transport);
  if (Number(result.file_size) > QQ_MEDIA_MAX_BYTES) throw new QqReadError(413, "QQ_MEDIA_TOO_LARGE");
  const localFile = typeof result.file === "string" && path.isAbsolute(result.file) ? result.file : undefined;
  if (localFile) {
    // The trusted local NapCat resolved this path from the selected message's resource ID.
    const handle = await fs.open(localFile, "r");
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size === 0) throw new QqReadError(422, "QQ_MEDIA_EMPTY");
      if (stat.size > QQ_MEDIA_MAX_BYTES) throw new QqReadError(413, "QQ_MEDIA_TOO_LARGE");
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
  // Only official QQ media hosts. Do not proxy arbitrary message URLs or redirects.
  const value = typeof result.url === "string" && result.url ? result.url : media.url;
  let url: URL;
  try { url = new URL(value ?? ""); } catch { throw new QqReadError(422, "QQ_MEDIA_REFERENCE_UNAVAILABLE"); }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.port
    || !["qq.com", "qpic.cn"].some(domain => url.hostname.endsWith(`.${domain}`))) throw new QqReadError(422, "QQ_MEDIA_URL_UNSUPPORTED");
  const bytes = await boundedBytes(await transport(url, { signal, redirect: "error" }), QQ_MEDIA_MAX_BYTES);
  if (!bytes.length) throw new QqReadError(422, "QQ_MEDIA_EMPTY");
  return bytes;
}
