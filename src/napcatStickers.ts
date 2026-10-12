import type { NapCatEndpoint, OneBotMessage } from "./napcat.js";

export type NapCatSticker = { id: string; description: string; url: string };
export const QQ_STICKER_ID = /^[a-f0-9]{32}$/;
const MAX_RESPONSE_BYTES = 1024 * 1024;

export function parseNapCatStickers(value: unknown): NapCatSticker[] {
  if (!Array.isArray(value)) throw new Error("QQ_STICKERS_INVALID_RESPONSE");
  const stickers = new Map<string, NapCatSticker>();
  for (const item of value.slice(0, 1000)) {
    const record = item && typeof item === "object" ? item as Record<string, unknown> : undefined;
    const raw = typeof item === "string" ? item : record?.url;
    if (typeof raw !== "string" || raw.length > 4096) continue;
    let url: URL;
    try { url = new URL(raw); } catch { continue; }
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.port
      || !["qq.com", "qpic.cn"].some(domain => url.hostname.endsWith(`.${domain}`))) continue;
    const md5 = typeof record?.md5 === "string" ? record.md5 : url.pathname.match(/[a-f0-9]{32}/i)?.[0];
    if (!md5 || !QQ_STICKER_ID.test(md5.toLowerCase())) continue;
    const id = md5.toLowerCase();
    const description = typeof record?.desc === "string" ? record.desc.replace(/[\x00-\x1f\x7f]/g, "").slice(0, 256) : "";
    stickers.set(id, { id, description, url: url.href });
  }
  return [...stickers.values()];
}

/** Read the selected account only. Old NapCat versions expose URLs without descriptions. */
export async function readNapCatStickers(endpoint: NapCatEndpoint, count = 1000, transport: typeof fetch = fetch): Promise<NapCatSticker[]> {
  if (!Number.isInteger(count) || count < 1 || count > 1000) throw new Error("QQ_STICKERS_INVALID_COUNT");
  const origin = new URL(endpoint.httpUrl);
  if (!["http:", "https:"].includes(origin.protocol) || origin.username || origin.password || origin.search || origin.hash || origin.pathname !== "/") {
    throw new Error("QQ_STICKERS_ENDPOINT_UNSAFE");
  }
  const read = async (action: string) => {
    const response = await transport(`${origin.origin}/${action}`, {
      method: "POST", redirect: "error", signal: AbortSignal.timeout(5000),
      headers: { "content-type": "application/json", ...(endpoint.accessToken ? { authorization: `Bearer ${endpoint.accessToken}` } : {}) },
      body: JSON.stringify({ count })
    });
    if (!response.ok || !response.body || Number(response.headers.get("content-length")) > MAX_RESPONSE_BYTES) throw new Error("QQ_STICKERS_UPSTREAM_UNAVAILABLE");
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    try {
      for (;;) {
        const result = await reader.read();
        if (result.done) break;
        bytes += result.value.length;
        if (bytes > MAX_RESPONSE_BYTES) throw new Error("QQ_STICKERS_RESPONSE_TOO_LARGE");
        chunks.push(result.value);
      }
    } finally { await reader.cancel().catch(() => undefined); }
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
  };
  const detail = await read("fetch_custom_face_detail");
  if (detail.status === "ok" && detail.retcode === 0) return parseNapCatStickers(detail.data);
  const unsupported = detail.retcode === 200 && /不支持|unsupported/i.test(String(detail.message ?? detail.wording ?? ""));
  if (!unsupported) throw new Error("QQ_STICKERS_UPSTREAM_UNAVAILABLE");
  const basic = await read("fetch_custom_face");
  if (basic.status !== "ok" || basic.retcode !== 0) throw new Error("QQ_STICKERS_UPSTREAM_UNAVAILABLE");
  return parseNapCatStickers(basic.data);
}

export async function napcatStickerMessage(endpoint: NapCatEndpoint, id: string, prefix: OneBotMessage): Promise<OneBotMessage> {
  if (!QQ_STICKER_ID.test(id)) throw new Error("QQ_STICKER_INVALID_ID");
  const sticker = (await readNapCatStickers(endpoint)).find(item => item.id === id);
  if (!sticker) throw new Error("QQ_STICKER_NOT_FOUND: refresh the selected account's sticker list.");
  return [...(typeof prefix === "string" ? [{ type: "text", data: { text: prefix } }] : prefix),
    { type: "image", data: { file: sticker.url, sub_type: 1, summary: sticker.description || "[表情]" } }];
}
