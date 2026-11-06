import fs from "node:fs";
import path from "node:path";

export type CodexRolloutActivityOptions = {
  chunkBytes?: number;
  maxRecordBytes?: number;
};

export type CodexRolloutActivity = {
  state: "active" | "inactive" | "unknown";
  observedAtMs: number;
};

type RolloutActivityCacheEntry = {
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

async function scanRolloutBackwards(
  filePath: string,
  size: number,
  fallbackObservedAtMs: number,
  options: CodexRolloutActivityOptions
): Promise<CodexRolloutActivity> {
  if (size <= 0) return UNKNOWN_ACTIVITY;
  const chunkBytes = Math.max(16, Math.floor(options.chunkBytes ?? DEFAULT_CHUNK_BYTES));
  const maxRecordBytes = Math.max(64, Math.floor(options.maxRecordBytes ?? DEFAULT_MAX_RECORD_BYTES));
  const terminals = new Map<string, number>();
  const handle = await fs.promises.open(filePath, "r");
  try {
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
  const resolved = path.resolve(filePath);
  let stat: fs.Stats;
  try {
    stat = await fs.promises.stat(resolved);
  } catch {
    return UNKNOWN_ACTIVITY;
  }
  if (!stat.isFile()) return UNKNOWN_ACTIVITY;
  const cached = cache.get(resolved);
  if (cached
    && cached.size === stat.size
    && cached.mtimeMs === stat.mtimeMs
    && cached.ctimeMs === stat.ctimeMs
    && cached.ino === stat.ino) return cached.activity;

  const existing = scans.get(resolved);
  if (existing) return existing;
  const scan = scanRolloutBackwards(resolved, stat.size, stat.mtimeMs, options)
    .then(activity => {
      cache.set(resolved, {
        size: stat.size,
        mtimeMs: stat.mtimeMs,
        ctimeMs: stat.ctimeMs,
        ino: stat.ino,
        activity
      });
      return activity;
    })
    .catch(() => UNKNOWN_ACTIVITY)
    .finally(() => {
      scans.delete(resolved);
    });
  scans.set(resolved, scan);
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
