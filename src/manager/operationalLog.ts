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
      try {
        fs.mkdirSync(logDirectory, { recursive: true });
        fs.appendFileSync(path.join(logDirectory, shard), `${JSON.stringify(record)}\n`, "utf8");
        return record;
      } catch (writeError) {
        const message = writeError instanceof Error ? writeError.message : String(writeError);
        process.stderr.write(`[RabiRoute Manager operations] failed to persist ${event}: ${message}\n`);
        return null;
      }
    }
  };
}
