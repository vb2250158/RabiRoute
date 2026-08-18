import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { projectDirectoryLayout } from "../shared/projectDirectoryLayout.js";

export type ManagerOperationalLevel = "info" | "warn" | "error";

export type ManagerOperationalEvent = {
  schemaVersion: 1;
  eventId: string;
  time: string;
  level: ManagerOperationalLevel;
  event: string;
  pid: number;
  requestId?: string;
  method?: string;
  pathname?: string;
  statusCode?: number;
  durationMs?: number;
  routeId?: string;
  childPid?: number;
  action?: string;
  result?: string;
  error?: {
    name: string;
    message: string;
    code?: string;
    stack?: string;
  };
};

export type ManagerOperationalLog = {
  logDirectory: string;
  record(
    level: ManagerOperationalLevel,
    event: string,
    detail?: Omit<ManagerOperationalEvent, "schemaVersion" | "eventId" | "time" | "level" | "event" | "pid">
  ): ManagerOperationalEvent | null;
  flush(): Promise<void>;
};

function redactProjectRoot(value: unknown, projectRoot: string): string {
  let text = String(value ?? "");
  for (const variant of new Set([projectRoot, projectRoot.replace(/\\/g, "/"), projectRoot.replace(/\//g, "\\")])) {
    if (variant) text = text.split(variant).join("<projectRoot>");
  }
  return text;
}

export function managerOperationalError(error: unknown, projectRoot: string): ManagerOperationalEvent["error"] {
  const candidate = error as NodeJS.ErrnoException;
  const value = error instanceof Error ? error : new Error(String(error));
  return {
    name: value.name || "Error",
    message: redactProjectRoot(value.message, projectRoot).slice(0, 4_000),
    code: String(candidate?.code ?? "").trim() || undefined,
    stack: redactProjectRoot(value.stack, projectRoot).slice(0, 16_000) || undefined
  };
}

export function createManagerOperationalLog(options: {
  rootDir: string;
  now?: () => Date;
  pid?: number;
}): ManagerOperationalLog {
  const projectRoot = path.resolve(options.rootDir);
  const logDirectory = projectDirectoryLayout(projectRoot).managerLogRoot;
  const now = options.now ?? (() => new Date());
  const pid = options.pid ?? process.pid;
  const pending = new Map<string, string[]>();
  let flushTimer: NodeJS.Timeout | undefined;
  let activeFlush: Promise<void> | undefined;

  const scheduleFlush = (): void => {
    if (flushTimer || activeFlush || pending.size === 0) return;
    flushTimer = setTimeout(() => {
      flushTimer = undefined;
      void startFlush();
    }, 25);
  };

  const startFlush = (): Promise<void> | undefined => {
    if (activeFlush || pending.size === 0) return activeFlush;
    const batch = new Map(pending);
    pending.clear();
    const operation = (async () => {
      await fs.promises.mkdir(logDirectory, { recursive: true });
      for (const [shard, lines] of batch) {
        await fs.promises.appendFile(path.join(logDirectory, shard), lines.join(""), "utf8");
      }
    })().catch((writeError) => {
      const message = writeError instanceof Error ? writeError.message : String(writeError);
      process.stderr.write(`[RabiRoute Manager operations] failed to persist batch: ${message}\n`);
    }).finally(() => {
      activeFlush = undefined;
      if (pending.size > 0) scheduleFlush();
    });
    activeFlush = operation;
    return operation;
  };

  const flush = async (): Promise<void> => {
    while (pending.size > 0 || activeFlush) {
      if (flushTimer) {
        clearTimeout(flushTimer);
        flushTimer = undefined;
      }
      const active = activeFlush ?? startFlush();
      if (active) await active;
    }
  };

  return {
    logDirectory,
    record(level, event, detail = {}) {
      const recordedAt = now();
      const record: ManagerOperationalEvent = {
        schemaVersion: 1,
        eventId: randomUUID(),
        time: recordedAt.toISOString(),
        level,
        event,
        pid,
        ...detail
      };
      const shard = `manager-operations-${recordedAt.toISOString().slice(0, 10)}.jsonl`;
      const lines = pending.get(shard) ?? [];
      lines.push(`${JSON.stringify(record)}\n`);
      pending.set(shard, lines);
      scheduleFlush();
      return record;
    },
    flush
  };
}
