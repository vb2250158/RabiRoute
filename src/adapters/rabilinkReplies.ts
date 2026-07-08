import fs from "node:fs";
import path from "node:path";
import { config } from "../config.js";
import { nestedTextFromData, stringPayloadField } from "./webhookAdapter.js";

export function readJsonlTail(filePath: string, limit: number, afterId: string): Record<string, unknown>[] {
  if (!fs.existsSync(filePath)) return [];
  const rows = fs.readFileSync(filePath, "utf8")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line) as Record<string, unknown>;
      } catch {
        return null;
      }
    })
    .filter((item): item is Record<string, unknown> => Boolean(item));
  const afterIndex = afterId ? rows.findIndex((item) => String(item.id ?? "") === afterId) : -1;
  const selected = afterIndex >= 0 ? rows.slice(afterIndex + 1) : rows.slice(-limit);
  return selected.slice(-limit);
}

export function rabiLinkReplyLogFilePath(): string {
  return path.join(config.dataDir, "rabilink-replies.jsonl");
}

export function localRabiLinkReplies(requestUrl: URL): Record<string, unknown> {
  const limit = Math.max(1, Math.min(100, Number(requestUrl.searchParams.get("limit") || 20) || 20));
  const afterId = String(requestUrl.searchParams.get("afterId") || requestUrl.searchParams.get("after") || "");
  const filePath = rabiLinkReplyLogFilePath();
  const replies = readJsonlTail(filePath, limit, afterId);
  const cursor = String(replies.at(-1)?.id ?? "");
  return {
    ok: true,
    code: 0,
    data: {
      file: path.relative(process.cwd(), filePath).replace(/\\/g, "/"),
      replies,
      cursor,
      nextCursor: cursor
    },
    replies,
    cursor,
    nextCursor: cursor
  };
}

function replyContextOf(row: Record<string, unknown>): Record<string, unknown> {
  const context = row.replyContext;
  return context && typeof context === "object" && !Array.isArray(context) ? context as Record<string, unknown> : {};
}

export function replyMatchesTask(row: Record<string, unknown>, taskId: string): boolean {
  const context = replyContextOf(row);
  const messageId = stringPayloadField(row.messageId) || stringPayloadField(context.messageId);
  return messageId === taskId;
}

export function replyText(row: Record<string, unknown>): string {
  return stringPayloadField(row.text)
    || stringPayloadField(row.reply)
    || stringPayloadField(row.answer)
    || stringPayloadField(row.content)
    || nestedTextFromData(row.payload);
}

export function replyIsFinal(row: Record<string, unknown>): boolean {
  const status = stringPayloadField(row.status).toLowerCase();
  const payload = row.payload && typeof row.payload === "object" && !Array.isArray(row.payload)
    ? row.payload as Record<string, unknown>
    : {};
  return row.done === true
    || row.final === true
    || payload.done === true
    || payload.final === true
    || status === "done"
    || status === "failed";
}

export function replyKey(row: Record<string, unknown>, index: number): string {
  return stringPayloadField(row.id)
    || stringPayloadField(row.sentMessageId)
    || `${stringPayloadField(row.messageId)}:${row.time ?? ""}:${replyText(row).slice(0, 80)}:${index}`;
}
