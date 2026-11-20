import fsp from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { readWorkbuddyTask, workbuddyHomeDir, workbuddyProjectId } from "./workbuddySessionStore.js";
import { currentEnvelopeDeliveryId, promptConfirmsDelivery } from "@rabiroute/host-api/shared/deliveryIdentity";
import { RABI_MESSAGE_CONTENT_HEADER, RABI_MESSAGE_SOURCE_HEADER } from "@rabiroute/host-api/shared/rabiMessage";

const workbuddyWrapperTag = /<\/?(?:system-reminder|user_query)[\s/>]/i;

function unwrapWorkbuddyUserQuery(text: string): string | undefined {
  const normalized = text.replace(/\r\n/g, "\n");
  const reminderClose = "\n</system-reminder>\n";
  let offset = 0;
  // WorkBuddy prepends its own context before the single original user query.
  for (const role of ["user-context", "additional-data"]) {
    const open = `<system-reminder data-role="${role}">\n`;
    if (!normalized.startsWith(open, offset)) return undefined;
    const bodyStart = offset + open.length;
    const bodyEnd = normalized.indexOf(reminderClose, bodyStart);
    if (bodyEnd < 0 || workbuddyWrapperTag.test(normalized.slice(bodyStart, bodyEnd))) return undefined;
    offset = bodyEnd + reminderClose.length;
  }
  const queryOpen = "<user_query>";
  const queryClose = "</user_query>";
  if (!normalized.startsWith(queryOpen, offset) || !normalized.endsWith(queryClose)) return undefined;
  const query = normalized.slice(offset + queryOpen.length, -queryClose.length);
  return workbuddyWrapperTag.test(query) ? undefined : query;
}

/** Only original native user records can confirm the reserved delivery. */
export function workbuddyRecordConfirmsDelivery(record: unknown, threadId: string, deliveryId: string, guidance = false): boolean {
  const message = record as {
    type?: string; role?: string; sessionId?: string;
    content?: string | Array<{ type?: string; text?: string }>;
    providerData?: {
      startsNewUserRequest?: boolean;
      conversationRequestId?: string;
      rootRequestId?: string;
      clientMeta?: { "codebuddy.ai"?: { queueOrigin?: string; contentBlocks?: Array<{ type?: string; text?: string }> } };
    };
  };
  if (message?.type !== "message" || message.role !== "user" || (message.sessionId && message.sessionId !== threadId)) return false;
  const data = message.providerData;
  const sameTurnGuidance = data?.startsNewUserRequest === false && data.rootRequestId
    && data.rootRequestId === data.conversationRequestId;
  if (guidance && !sameTurnGuidance) return false;
  const queued = data?.clientMeta?.["codebuddy.ai"];
  if (sameTurnGuidance && queued?.queueOrigin === "steer" && Array.isArray(queued.contentBlocks)) {
    const original = queued.contentBlocks.filter(part => part?.type === "text" && typeof part.text === "string")
      .map(part => part.text).join("\n");
    if (promptConfirmsDelivery(original, deliveryId)) return true;
  }
  const text = typeof message.content === "string" ? message.content : Array.isArray(message.content)
    ? message.content.filter(part => part?.type === "input_text" || part?.type === "text").map(part => part.text ?? "").join("\n")
    : "";
  if (text.startsWith("<system-reminder ")) {
    const query = unwrapWorkbuddyUserQuery(text);
    return message.sessionId === threadId && query !== undefined && Boolean(deliveryId)
      && currentEnvelopeDeliveryId(query) === deliveryId;
  }
  if (promptConfirmsDelivery(text, deliveryId)) return true;
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const contentStart = lines.indexOf(RABI_MESSAGE_CONTENT_HEADER);
  if (lines[0] !== RABI_MESSAGE_SOURCE_HEADER || contentStart < 0) return false;
  const headers = lines.slice(1, contentStart).filter(line => line.startsWith("- 投递 ID："));
  return headers.length === 1 && headers[0] === `- 投递 ID：${deliveryId}`;
}

type HistoryCursor = {
  version: 1;
  sessionId: string;
  source: string;
  offset: number;
  sequence: number;
  size: number;
  modified: number;
};

function decodeCursor(value: string | undefined, sessionId: string): HistoryCursor | undefined {
  if (!value) return undefined;
  let cursor: HistoryCursor;
  try { cursor = JSON.parse(Buffer.from(value, "base64url").toString("utf8")); }
  catch { throw new Error("WorkBuddy 历史游标无效，请使用原任务返回的游标。"); }
  if (cursor.version !== 1 || cursor.sessionId !== sessionId || typeof cursor.source !== "string"
    || ![cursor.offset, cursor.sequence, cursor.size].every(number => Number.isSafeInteger(number) && number >= 0)
    || !Number.isFinite(cursor.modified) || cursor.offset > cursor.size) {
    throw new Error("WorkBuddy 历史游标与任务不匹配。");
  }
  return cursor;
}

async function openWorkbuddyTranscript(sessionId: string) {
  const task = readWorkbuddyTask(sessionId);
  if (!task) throw new Error(`WorkBuddy task ${sessionId} was not found.`);
  if (path.basename(sessionId) !== sessionId || sessionId === "." || sessionId === "..") {
    throw new Error("WorkBuddy 任务 ID 无法用于原生历史定位。");
  }
  const projects = await fsp.realpath(path.join(workbuddyHomeDir(), "projects"));
  const file = await fsp.realpath(path.join(projects, workbuddyProjectId(task.workspace), `${sessionId}.jsonl`));
  const relative = path.relative(projects, file);
  if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("WorkBuddy 历史来源超出任务目录。");
  return { file, handle: await fsp.open(file, "r") };
}

/** Look for a recent receipt before scanning older history pages. */
export async function hasRecentWorkbuddyDelivery(sessionId: string, deliveryId: string, guidance: boolean): Promise<boolean> {
  const { handle } = await openWorkbuddyTranscript(sessionId);
  try {
    const before = await handle.stat();
    if (!before.isFile()) throw new Error("WorkBuddy 历史来源不是文件。");
    const length = Math.min(before.size, 2 * 1024 * 1024);
    if (!length) return false;
    const offset = before.size - length;
    const tail = Buffer.alloc(length);
    if ((await handle.read(tail, 0, length, offset)).bytesRead !== length) return false;
    const firstNewline = offset ? tail.indexOf(10) : -1;
    if (offset && firstNewline < 0) return false;
    let start = firstNewline + 1;
    const idBytes = Buffer.from(deliveryId);
    while (start < tail.length) {
      const newline = tail.indexOf(10, start);
      if (newline < 0) break;
      const line = tail.subarray(start, newline);
      start = newline + 1;
      if (!line.includes(idBytes)) continue;
      let record: unknown;
      try { record = JSON.parse(line.toString("utf8").replace(/^\uFEFF/, "")); } catch { continue; }
      if (!workbuddyRecordConfirmsDelivery(record, sessionId, deliveryId, guidance)) continue;
      const after = await handle.stat();
      return after.size >= before.size && (after.size !== before.size || after.mtimeMs === before.mtimeMs);
    }
    return false;
  } finally { await handle.close(); }
}

/** Read bounded native JSONL pages without loading or executing the task owner. */
export async function readWorkbuddyHistory(sessionId: string, options: {
  cursor?: string;
  limit?: number;
  maxBytes?: number;
  signal?: AbortSignal;
  assertAuthorized?: () => void;
} = {}) {
  options.assertAuthorized?.();
  options.signal?.throwIfAborted();
  const limit = options.limit ?? 200;
  const maxBytes = options.maxBytes ?? 2 * 1024 * 1024;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200
    || !Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new Error("WorkBuddy 历史分页参数无效。");
  const { file, handle } = await openWorkbuddyTranscript(sessionId);
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw new Error("WorkBuddy 历史来源不是文件。");
    const source = createHash("sha256").update(JSON.stringify([file, stat.dev, stat.ino, stat.birthtimeMs])).digest("hex");
    const cursor = decodeCursor(options.cursor, sessionId);
    if (cursor && (cursor.source !== source || stat.size < cursor.size
      || stat.size === cursor.size && stat.mtimeMs !== cursor.modified)) {
      throw new Error("WorkBuddy 历史来源已变化，请重新读取第一页。");
    }
    let offset = cursor?.offset ?? 0;
    let sequence = cursor?.sequence ?? 0;
    if (offset > 0) {
      const boundary = Buffer.alloc(1);
      await handle.read(boundary, 0, 1, offset - 1);
      if (boundary[0] !== 10) throw new Error("WorkBuddy 历史游标没有指向完整记录边界。");
    }
    const firstSequence = sequence + 1;
    const entries: Array<{ sequence: number; record: unknown }> = [];
    const warnings: Array<{ sequence: number; errorCode: string }> = [];
    let scanned = 0;
    let bytes = 0;
    let pendingTail = false;
    if (offset < stat.size) {
      const chunk = Buffer.alloc(64 * 1024);
      let position = offset;
      let pending = Buffer.alloc(0);
      let exhausted = true;
      page: while (position < stat.size) {
        options.signal?.throwIfAborted();
        const { bytesRead } = await handle.read(chunk, 0, Math.min(chunk.length, stat.size - position), position);
        if (!bytesRead) throw new Error("WorkBuddy 历史在读取期间发生截断，请重新读取第一页。");
        position += bytesRead;
        const buffer = Buffer.concat([pending, chunk.subarray(0, bytesRead)]);
        let start = 0;
        let newline: number;
        while ((newline = buffer.indexOf(10, start)) >= 0) {
          const length = newline + 1 - start;
          if (bytes + length > maxBytes) {
            if (!scanned) throw new Error(`WorkBuddy 下一条完整历史记录需要 ${length} 字节，超过本页读取预算。`);
            exhausted = false;
            break page;
          }
          const line = buffer.subarray(start, newline).toString("utf8").replace(/^\uFEFF/, "");
          offset += length;
          bytes += length;
          start = newline + 1;
          if (!line.trim()) continue;
          sequence++;
          scanned++;
          try {
            const record = JSON.parse(line);
            if (record?.sessionId && record.sessionId !== sessionId) {
              warnings.push({ sequence, errorCode: "WORKBUDDY_HISTORY_SESSION_MISMATCH" });
            } else entries.push({ sequence, record });
          } catch { warnings.push({ sequence, errorCode: "WORKBUDDY_HISTORY_ROW_INVALID" }); }
          if (scanned >= limit) { exhausted = false; break page; }
        }
        pending = buffer.subarray(start);
        if (pending.length > maxBytes) throw new Error("WorkBuddy 下一条历史记录超过本页读取预算。");
      }
      pendingTail = exhausted && offset < stat.size;
    }
    options.signal?.throwIfAborted();
    options.assertAuthorized?.();
    const after = await handle.stat();
    if (after.size < stat.size || after.size === stat.size && after.mtimeMs !== stat.mtimeMs) {
      throw new Error("WorkBuddy 历史在读取期间发生改写，请重新读取第一页。");
    }
    const resumeCursor = Buffer.from(JSON.stringify({ version: 1, sessionId, source, offset, sequence,
      size: stat.size, modified: stat.mtimeMs } satisfies HistoryCursor)).toString("base64url");
    const hasMore = offset < stat.size && !pendingTail;
    return {
      provider: "workbuddy", sessionId, source: "workbuddy-native-transcript", entries,
      nextCursor: hasMore ? resumeCursor : null, resumeCursor,
      coverage: { firstSequence, lastSequence: sequence, scannedRecords: scanned, returnedRecords: entries.length,
        reachedEnd: !hasMore && !pendingTail, pendingTail, partial: warnings.length > 0 || pendingTail },
      warnings
    };
  } finally { await handle.close(); }
}
