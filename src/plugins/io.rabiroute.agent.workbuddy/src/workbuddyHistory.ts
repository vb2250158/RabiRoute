import fsp from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { readWorkbuddyTask, workbuddyHomeDir, workbuddyProjectId } from "./workbuddySessionStore.js";

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
  const task = readWorkbuddyTask(sessionId);
  if (!task) throw new Error(`WorkBuddy task ${sessionId} was not found.`);
  if (path.basename(sessionId) !== sessionId || sessionId === "." || sessionId === "..") {
    throw new Error("WorkBuddy 任务 ID 无法用于原生历史定位。");
  }
  const projects = await fsp.realpath(path.join(workbuddyHomeDir(), "projects"));
  const file = await fsp.realpath(path.join(projects, workbuddyProjectId(task.workspace), `${sessionId}.jsonl`));
  const relative = path.relative(projects, file);
  if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("WorkBuddy 历史来源超出任务目录。");
  const handle = await fsp.open(file, "r");
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
