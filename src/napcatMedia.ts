import fs from "node:fs";
import path from "node:path";
import type { MessageAttachmentRecord } from "./history.js";

const MAX_NAPCAT_MEDIA_BYTES = 20 * 1024 * 1024;
const NAPCAT_MEDIA_TIMEOUT_MS = 12_000;

type MediaCandidate = {
  kind: "image";
  file?: string;
  url?: string;
};

export type MaterializeNapCatAttachmentsOptions = {
  dataDir: string;
  instanceId: string;
  messageId: string | number;
  fetch?: typeof fetch;
};

function cqUnescape(value: string): string {
  return value
    .replaceAll("&#44;", ",")
    .replaceAll("&#91;", "[")
    .replaceAll("&#93;", "]")
    .replaceAll("&amp;", "&");
}

function structuredCandidates(message: unknown): MediaCandidate[] {
  if (!Array.isArray(message)) return [];
  return message.flatMap((raw) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return [];
    const segment = raw as { type?: unknown; data?: Record<string, unknown> };
    if (segment.type !== "image") return [];
    return [{
      kind: "image" as const,
      file: String(segment.data?.file ?? "").trim() || undefined,
      url: String(segment.data?.url ?? "").trim() || undefined
    }];
  });
}

function rawCandidates(rawMessage: string): MediaCandidate[] {
  return [...rawMessage.matchAll(/\[CQ:image,([^\]]+)\]/gi)].map((match) => {
    const data = new Map<string, string>();
    for (const field of String(match[1] || "").split(",")) {
      const separator = field.indexOf("=");
      if (separator <= 0) continue;
      data.set(field.slice(0, separator), cqUnescape(field.slice(separator + 1)));
    }
    return { kind: "image" as const, file: data.get("file"), url: data.get("url") };
  });
}

function candidates(message: unknown, rawMessage: string): MediaCandidate[] {
  const structured = structuredCandidates(message);
  if (structured.length > 0) return structured;
  return rawCandidates(rawMessage);
}

function safePart(value: unknown, fallback: string): string {
  const normalized = String(value ?? "")
    .replace(/[<>:"/\\|?*\x00-\x1f]+/g, "_")
    .replace(/[. ]+$/g, "")
    .slice(0, 120);
  return normalized && normalized !== "." && normalized !== ".." ? normalized : fallback;
}

function fileName(candidate: MediaCandidate, index: number, mimeType?: string): string {
  let name = safePart(path.basename(candidate.file || ""), `image-${index + 1}`);
  if (!path.extname(name)) {
    const extension = mimeType === "image/jpeg" ? ".jpg"
      : mimeType === "image/gif" ? ".gif"
        : mimeType === "image/webp" ? ".webp"
          : ".png";
    name += extension;
  }
  return name;
}

async function download(candidate: MediaCandidate, fetchImpl: typeof fetch): Promise<{ body: Buffer; mimeType?: string }> {
  if (!candidate.url || !/^https?:\/\//i.test(candidate.url)) {
    throw new Error("图片消息没有可下载的 HTTP 地址");
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), NAPCAT_MEDIA_TIMEOUT_MS);
  try {
    const response = await fetchImpl(candidate.url, { signal: controller.signal });
    if (!response.ok) throw new Error(`图片下载失败：HTTP ${response.status}`);
    const declaredSize = Number(response.headers.get("content-length") || "0");
    if (declaredSize > MAX_NAPCAT_MEDIA_BYTES) throw new Error("图片超过 20 MiB 限制");
    const body = Buffer.from(await response.arrayBuffer());
    if (body.length > MAX_NAPCAT_MEDIA_BYTES) throw new Error("图片超过 20 MiB 限制");
    if (body.length === 0) throw new Error("图片下载结果为空");
    return { body, mimeType: response.headers.get("content-type")?.split(";", 1)[0]?.trim() || undefined };
  } finally {
    clearTimeout(timeout);
  }
}

export async function materializeNapCatAttachments(
  message: unknown,
  rawMessage: string,
  options: MaterializeNapCatAttachmentsOptions
): Promise<MessageAttachmentRecord[]> {
  const fetchImpl = options.fetch ?? fetch;
  const messageId = String(options.messageId).trim() || "unknown-message";
  const directory = path.join(
    path.resolve(options.dataDir),
    "napcat-media",
    safePart(options.instanceId, "default"),
    safePart(messageId, "unknown-message")
  );
  const output: MessageAttachmentRecord[] = [];
  for (const [index, candidate] of candidates(message, rawMessage).entries()) {
    const id = `${messageId}:image:${index + 1}`;
    try {
      const downloaded = await download(candidate, fetchImpl);
      const name = fileName(candidate, index, downloaded.mimeType);
      fs.mkdirSync(directory, { recursive: true });
      const localPath = path.join(directory, `${String(index + 1).padStart(2, "0")}-${name}`);
      fs.writeFileSync(localPath, downloaded.body);
      output.push({
        id,
        kind: "image",
        name,
        mimeType: downloaded.mimeType,
        size: downloaded.body.length,
        path: localPath,
        status: "ready",
        sourceMessageId: messageId
      });
    } catch (error) {
      output.push({
        id,
        kind: "image",
        name: fileName(candidate, index),
        status: "unavailable",
        error: error instanceof Error ? error.message : String(error),
        sourceMessageId: messageId
      });
    }
  }
  return output;
}
