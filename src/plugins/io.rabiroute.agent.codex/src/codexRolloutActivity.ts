import fs from "node:fs";
import { readCodexRolloutLines, statCodexRollout, type CodexRolloutSource } from "./codexRolloutReader.js";

export type CodexRolloutActivityOptions = {
  chunkBytes?: number;
  maxRecordBytes?: number;
  threadId?: string;
};

export type CodexRolloutActivity = {
  state: "active" | "inactive" | "unknown";
  observedAtMs: number;
};

type RolloutActivityCacheEntry = {
  dev: number;
  size: number;
  mtimeMs: number;
  ctimeMs: number;
  ino: number;
  activity: CodexRolloutActivity;
};

const DEFAULT_CHUNK_BYTES = 256 * 1024;
const DEFAULT_MAX_RECORD_BYTES = 1024 * 1024;
const terminalEvents = new Set(["task_complete", "turn_aborted", "task_failed"]);
const cache = new Map<string, RolloutActivityCacheEntry>();
const scans = new Map<string, Promise<CodexRolloutActivity>>();

const UNKNOWN_ACTIVITY: CodexRolloutActivity = { state: "unknown", observedAtMs: 0 };

function sameFileStat(left: fs.Stats, right: fs.Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size
    && left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs;
}

type RelevantRecord =
  | { kind: "turn"; turnId: string; observedAtMs: number }
  | { kind: "terminal"; turnId: string; observedAtMs: number }
  | null;

function recordObservedAtMs(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string") return 0;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function relevantRecord(line: Buffer): RelevantRecord {
  if (line.length === 0) return null;
  const text = line.toString("utf8").trim();
  if (!text || (!text.includes('"turn_context"') && !text.includes('"task_complete"')
    && !text.includes('"turn_aborted"') && !text.includes('"task_failed"'))) return null;
  try {
    const record = JSON.parse(text) as {
      type?: unknown;
      timestamp?: unknown;
      payload?: { type?: unknown; turn_id?: unknown };
    };
    const turnId = typeof record.payload?.turn_id === "string" ? record.payload.turn_id : "";
    if (!turnId) return null;
    const observedAtMs = recordObservedAtMs(record.timestamp);
    if (record.type === "turn_context") return { kind: "turn", turnId, observedAtMs };
    const eventType = record.type === "event_msg" ? record.payload?.type : record.type;
    return typeof eventType === "string" && terminalEvents.has(eventType)
      ? { kind: "terminal", turnId, observedAtMs }
      : null;
  } catch {
    return null;
  }
}

async function immediate(): Promise<void> {
  await new Promise<void>(resolve => setImmediate(resolve));
}

async function verifyRecordedIdentity(
  handle: fs.promises.FileHandle,
  size: number,
  expectedThreadId: string
): Promise<void> {
  if (!expectedThreadId) return;
  const chunks: Buffer[] = [];
  let offset = 0;
  let complete = false;
  while (offset < size) {
    const buffer = Buffer.allocUnsafe(Math.min(DEFAULT_CHUNK_BYTES, size - offset));
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset);
    if (!bytesRead) break;
    const bytes = buffer.subarray(0, bytesRead);
    const newline = bytes.indexOf(0x0a);
    if (newline >= 0) {
      chunks.push(bytes.subarray(0, newline));
      complete = true;
      break;
    }
    chunks.push(bytes);
    offset += bytesRead;
  }
  if (!complete) throw Object.assign(new Error("The Codex rollout has no complete identity record."), {
    code: "CODEX_ROLLOUT_IDENTITY_MISSING"
  });
  const line = Buffer.concat(chunks).toString("utf8").replace(/^\uFEFF/, "").replace(/\r$/, "");
  let matches = false;
  try {
    const record = JSON.parse(line) as { type?: unknown; payload?: { id?: unknown } };
    matches = record.type === "session_meta" && record.payload?.id === expectedThreadId;
  } catch {
    matches = false;
  }
  if (!matches) throw Object.assign(new Error("The Codex rollout does not belong to the requested task."), {
    code: "CODEX_ROLLOUT_IDENTITY_MISMATCH"
  });
}

async function scanForwardRollout(
  recordedPath: string,
  fallbackObservedAtMs: number,
  options: CodexRolloutActivityOptions,
  onSource: (source: CodexRolloutSource) => void
): Promise<CodexRolloutActivity> {
  const maxRecordBytes = Math.max(64, Math.floor(options.maxRecordBytes ?? DEFAULT_MAX_RECORD_BYTES));
  let latestTurnId = "";
  let activity = UNKNOWN_ACTIVITY;
  for await (const line of readCodexRolloutLines(recordedPath, options.threadId ?? "", {
    verifyIdentity: true,
    onSource
  })) {
    const bytes = Buffer.byteLength(line);
    if (bytes > maxRecordBytes) continue;
    const record = relevantRecord(Buffer.from(line));
    if (!record) continue;
    if (record.kind === "turn") {
      latestTurnId = record.turnId;
      activity = { state: "active", observedAtMs: record.observedAtMs || fallbackObservedAtMs };
    } else if (!latestTurnId || record.turnId === latestTurnId) {
      latestTurnId = record.turnId;
      activity = { state: "inactive", observedAtMs: record.observedAtMs || fallbackObservedAtMs };
    }
  }
  return activity;
}

async function scanRolloutBackwards(
  filePath: string,
  fallbackObservedAtMs: number,
  options: CodexRolloutActivityOptions,
  onSource: (source: CodexRolloutSource) => void
): Promise<CodexRolloutActivity> {
  const chunkBytes = Math.max(16, Math.floor(options.chunkBytes ?? DEFAULT_CHUNK_BYTES));
  const maxRecordBytes = Math.max(64, Math.floor(options.maxRecordBytes ?? DEFAULT_MAX_RECORD_BYTES));
  const terminals = new Map<string, number>();
  const handle = await fs.promises.open(filePath, "r");
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) return UNKNOWN_ACTIVITY;
    onSource({ physicalPath: filePath, stat, fallback: false });
    const size = stat.size;
    await verifyRecordedIdentity(handle, size, options.threadId ?? "");
    if (size <= 0) return UNKNOWN_ACTIVITY;
    const finalByte = Buffer.allocUnsafe(1);
    await handle.read(finalByte, 0, 1, size - 1);
    let ignoreNewestBoundary = finalByte[0] !== 0x0a;
    let end = size;
    let suffix = Buffer.alloc(0);
    let discardBoundary = false;

    const inspect = (line: Buffer): CodexRolloutActivity | null => {
      if (line.length > maxRecordBytes) return null;
      const record = relevantRecord(line);
      if (!record) return null;
      if (record.kind === "terminal") {
        terminals.set(record.turnId, record.observedAtMs || fallbackObservedAtMs);
        return null;
      }
      const terminalObservedAtMs = terminals.get(record.turnId);
      return terminalObservedAtMs != null
        ? { state: "inactive", observedAtMs: terminalObservedAtMs }
        : { state: "active", observedAtMs: record.observedAtMs || fallbackObservedAtMs };
    };

    while (end > 0) {
      const start = Math.max(0, end - chunkBytes);
      const chunk = Buffer.allocUnsafe(end - start);
      await handle.read(chunk, 0, chunk.length, start);
      const newlines: number[] = [];
      for (let index = 0; index < chunk.length; index += 1) {
        if (chunk[index] === 0x0a) newlines.push(index);
      }

      if (newlines.length === 0) {
        if (!discardBoundary) {
          if (chunk.length + suffix.length <= maxRecordBytes) {
            suffix = Buffer.concat([chunk, suffix]);
          } else {
            suffix = Buffer.alloc(0);
            discardBoundary = true;
          }
        }
        end = start;
        await immediate();
        continue;
      }

      const lastNewline = newlines[newlines.length - 1];
      if (ignoreNewestBoundary) {
        ignoreNewestBoundary = false;
      } else if (!discardBoundary) {
        const result = inspect(Buffer.concat([chunk.subarray(lastNewline + 1), suffix]));
        if (result !== null) return result;
      }

      for (let index = newlines.length - 1; index >= 1; index -= 1) {
        const result = inspect(chunk.subarray(newlines[index - 1] + 1, newlines[index]));
        if (result !== null) return result;
      }

      const prefix = chunk.subarray(0, newlines[0]);
      if (prefix.length <= maxRecordBytes) {
        suffix = Buffer.from(prefix);
        discardBoundary = false;
      } else {
        suffix = Buffer.alloc(0);
        discardBoundary = true;
      }
      end = start;
      await immediate();
    }

    if (!ignoreNewestBoundary && !discardBoundary) {
      const result = inspect(suffix);
      if (result !== null) return result;
    }
    if (terminals.size) {
      return {
        state: "inactive",
        observedAtMs: Math.max(...terminals.values())
      };
    }
    return UNKNOWN_ACTIVITY;
  } finally {
    await handle.close();
  }
}

export async function readCodexRolloutActivity(
  filePath: string,
  options: CodexRolloutActivityOptions = {}
): Promise<CodexRolloutActivity> {
  if (!filePath) return UNKNOWN_ACTIVITY;
  let physical: Awaited<ReturnType<typeof statCodexRollout>>;
  try {
    physical = await statCodexRollout(filePath);
  } catch {
    return UNKNOWN_ACTIVITY;
  }
  const { physicalPath: resolved, stat, fallback } = physical;
  if (!stat.isFile()) return UNKNOWN_ACTIVITY;
  const forwardScan = fallback || resolved.endsWith(".zst");
  const cacheKey = `${filePath}\0${resolved}\0${fallback ? "fallback" : "recorded"}\0${options.threadId ?? ""}`;
  const cached = cache.get(cacheKey);
  if (cached
    && cached.dev === stat.dev
    && cached.size === stat.size
    && cached.mtimeMs === stat.mtimeMs
    && cached.ctimeMs === stat.ctimeMs
    && cached.ino === stat.ino) return cached.activity;

  const existing = scans.get(cacheKey);
  if (existing) return existing;
  let opened: CodexRolloutSource | undefined;
  const onSource = (source: CodexRolloutSource): void => { opened = source; };
  const scan = (forwardScan
    ? scanForwardRollout(filePath, stat.mtimeMs, options, onSource)
    : scanRolloutBackwards(resolved, stat.mtimeMs, options, onSource))
    .then(async activity => {
      const current = await statCodexRollout(filePath);
      if (!opened || opened.physicalPath !== resolved || current.physicalPath !== resolved
        || current.fallback !== fallback || !sameFileStat(stat, opened.stat)
        || !sameFileStat(opened.stat, current.stat)) {
        return UNKNOWN_ACTIVITY;
      }
      cache.set(cacheKey, {
        dev: opened.stat.dev,
        size: opened.stat.size,
        mtimeMs: opened.stat.mtimeMs,
        ctimeMs: opened.stat.ctimeMs,
        ino: opened.stat.ino,
        activity
      });
      return activity;
    })
    .catch(() => UNKNOWN_ACTIVITY)
    .finally(() => {
      scans.delete(cacheKey);
    });
  scans.set(cacheKey, scan);
  return scan;
}

export async function rolloutShowsActive(
  filePath: string,
  options: CodexRolloutActivityOptions = {}
): Promise<boolean> {
  return (await readCodexRolloutActivity(filePath, options)).state === "active";
}

export function clearCodexRolloutActivityCacheForTest(): void {
  cache.clear();
  scans.clear();
}
