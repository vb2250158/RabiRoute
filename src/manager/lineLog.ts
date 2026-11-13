import fs from "node:fs";
import path from "node:path";

export type LineLogStatus = {
  pendingLines: number;
  lastCompletedAt?: string;
  lastError?: string;
};

export type LineLog = {
  append(source: string, line: string): void;
  flush(): Promise<void>;
  status(): LineLogStatus;
};

export type LineLogOptions = {
  directory: string;
  retentionDays?: number;
  maxTotalBytes?: number;
  flushDelayMs?: number;
  now?: () => Date;
};

const DAY_MS = 86_400_000;
const SHARD_LINE_LIMIT = 200;

function shardFor(source: string, day: string): string {
  const safe = source.replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^[._]+/, "").slice(0, 80) || "runtime";
  return `${safe}-${day}.log`;
}

/**
 * Line-oriented log sink for captured child-process output.
 * Writes are batched so high-frequency stdout does not turn into one append per line.
 */
export function createLineLog(options: LineLogOptions): LineLog {
  const directory = options.directory;
  const retentionDays = Math.max(1, options.retentionDays ?? 7);
  const maxTotalBytes = Math.max(1_048_576, options.maxTotalBytes ?? 100 * 1024 * 1024);
  const flushDelayMs = Math.max(10, options.flushDelayMs ?? 50);
  const now = options.now ?? (() => new Date());
  const pending = new Map<string, string[]>();
  let pendingCount = 0;
  let timer: NodeJS.Timeout | undefined;
  let active: Promise<void> | undefined;
  let lastError: string | undefined;
  let lastCompletedAt: string | undefined;
  let lastRetentionDay = "";
  const shardCache = new Map<string, { day: string; shard: string }>();

  const schedule = (): void => {
    if (timer || active) return;
    timer = setTimeout(() => {
      timer = undefined;
      void start()?.catch(() => {});
    }, lastError ? Math.max(flushDelayMs, 1_000) : flushDelayMs);
    timer.unref?.();
  };

  const enforceRetention = async (keep: ReadonlySet<string>): Promise<void> => {
    let names: string[];
    try {
      names = await fs.promises.readdir(directory);
    } catch {
      return;
    }
    const cutoff = now().getTime() - retentionDays * DAY_MS;
    const kept: Array<{ file: string; size: number; mtimeMs: number }> = [];
    for (const name of names) {
      if (!name.endsWith(".log")) continue;
      const file = path.join(directory, name);
      try {
        const stat = await fs.promises.stat(file);
        if (!keep.has(name) && stat.mtimeMs < cutoff) {
          await fs.promises.unlink(file);
          continue;
        }
        kept.push({ file, size: stat.size, mtimeMs: stat.mtimeMs });
      } catch {
        // A file that disappeared between listing and inspection needs no action.
      }
    }
    let total = kept.reduce((sum, item) => sum + item.size, 0);
    if (total <= maxTotalBytes) return;
    kept.sort((left, right) => left.mtimeMs - right.mtimeMs);
    for (const item of kept) {
      if (total <= maxTotalBytes) break;
      if (keep.has(path.basename(item.file))) continue;
      try {
        await fs.promises.unlink(item.file);
        total -= item.size;
      } catch {
        // Ignore files removed while retention was running.
      }
    }
  };

  const start = (): Promise<void> | undefined => {
    if (active || pending.size === 0) return active;
    const batch = new Map(pending);
    const writtenShards = new Set(batch.keys());
    pending.clear();
    pendingCount = 0;
    const operation = (async () => {
      await fs.promises.mkdir(directory, { recursive: true });
      for (const [shard, lines] of batch) {
        await fs.promises.appendFile(path.join(directory, shard), lines.join(""), "utf8");
        batch.delete(shard);
      }
      const day = now().toISOString().slice(0, 10);
      if (lastRetentionDay !== day) {
        lastRetentionDay = day;
        await enforceRetention(new Set([...writtenShards, ...pending.keys()]));
      }
      lastCompletedAt = now().toISOString();
      lastError = undefined;
    })().catch((error) => {
      for (const [shard, lines] of batch) {
        pending.set(shard, [...lines, ...(pending.get(shard) ?? [])]);
        pendingCount += lines.length;
      }
      lastError = error instanceof Error ? error.message : String(error);
    }).finally(() => {
      active = undefined;
      if (pending.size > 0) schedule();
    });
    active = operation;
    return operation;
  };

  return {
    append(source, line) {
      const day = now().toISOString().slice(0, 10);
      const cached = shardCache.get(source);
      let shard: string;
      if (cached && cached.day === day) {
        shard = cached.shard;
      } else {
        shard = shardFor(source, day);
        shardCache.set(source, { day, shard });
      }
      const lines = pending.get(shard) ?? [];
      lines.push(line.endsWith("\n") ? line : `${line}\n`);
      pending.set(shard, lines);
      pendingCount += 1;
      if (pendingCount >= SHARD_LINE_LIMIT) {
        void start()?.catch(() => {});
        return;
      }
      schedule();
    },
    async flush() {
      if (timer) {
        clearTimeout(timer);
        timer = undefined;
      }
      let attempts = 0;
      while ((pending.size > 0 || active) && attempts < 3) {
        await (start() ?? active ?? Promise.resolve());
        attempts += 1;
      }
      if (pendingCount > 0) {
        throw new Error(`line log kept ${pendingCount} pending line(s) after ${attempts} flush attempt(s)`);
      }
    },
    status() {
      return { pendingLines: pendingCount, lastCompletedAt, lastError };
    }
  };
}
