import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { projectDirectoryLayout } from "../shared/projectDirectoryLayout.js";
import { installDataMutationAuditSink } from "../observability/dataMutationAudit.js";

export type ManagerOperationalLevel = "debug" | "info" | "warn" | "error";

export type ManagerOperationalLogStatus = {
  state: "healthy" | "degraded";
  pendingRecords: number;
  lastCompletedAt?: string;
  lastErrorAt?: string;
  lastError?: string;
};

export type ManagerOperationalEvent = {
  schemaVersion: 2;
  eventId: string;
  time: string;
  level: ManagerOperationalLevel;
  event: string;
  group: string;
  pid: number;
  traceId?: string;
  spanId?: string;
  parentSpanId?: string;
  requestId?: string;
  method?: string;
  pathname?: string;
  statusCode?: number;
  durationMs?: number;
  routeId?: string;
  childPid?: number;
  action?: string;
  result?: string;
  source?: string;
  actor?: { kind: string; id?: string };
  owner?: string;
  target?: { type: string; id: string };
  dataSource?: { kind: string; id: string };
  outcome?: string;
  operationId?: string;
  before?: { revision?: string; digest?: string };
  after?: { revision?: string; digest?: string };
  changes?: Array<{ field: string; from?: string | number | boolean | null; to?: string | number | boolean | null }>;
  diagnostic?: { callsite?: string; stack?: string };
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
    detail?: Omit<ManagerOperationalEvent, "schemaVersion" | "eventId" | "time" | "level" | "event" | "pid" | "group"> & {
      group?: string;
    }
  ): ManagerOperationalEvent | null;
  flush(): Promise<void>;
  status(): ManagerOperationalLogStatus;
};

function redactProjectRoot(value: unknown, projectRoot: string): string {
  let text = String(value ?? "");
  for (const variant of new Set([projectRoot, projectRoot.replace(/\\/g, "/"), projectRoot.replace(/\//g, "\\")])) {
    if (variant) text = text.split(variant).join("<projectRoot>");
  }
  text = text
    .replace(/\b(Bearer\s+)[^\s,;]+/gi, "$1<redacted>")
    .replace(/\b(token|password|cookie|authorization|api[_-]?key|secret)\s*[:=]\s*[^\s,;]+/gi, "$1=<redacted>");
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

function commaSeparatedSet(value: string | undefined): Set<string> | undefined {
  const items = String(value ?? "").split(",").map(item => item.trim()).filter(Boolean);
  return items.length > 0 ? new Set(items) : undefined;
}

async function enforceOperationalLogRetention(
  logDirectory: string,
  currentDate: string,
  retentionDays: number,
  maxTotalBytes: number
): Promise<void> {
  const entries = await fs.promises.readdir(logDirectory, { withFileTypes: true });
  const files = await Promise.all(entries.flatMap(entry => {
    const match = entry.isFile() ? entry.name.match(/^manager-operations-(\d{4}-\d{2}-\d{2})\.jsonl$/) : null;
    if (!match) return [];
    const filePath = path.join(logDirectory, entry.name);
    return [fs.promises.stat(filePath).then(stat => ({ filePath, name: entry.name, date: match[1]!, size: stat.size }))];
  }));
  const currentTime = Date.parse(`${currentDate}T00:00:00.000Z`);
  const cutoff = currentTime - (retentionDays - 1) * 24 * 60 * 60 * 1_000;
  const retained: typeof files = [];
  for (const file of files) {
    const fileTime = Date.parse(`${file.date}T00:00:00.000Z`);
    if (file.date !== currentDate && Number.isFinite(fileTime) && fileTime < cutoff) {
      await fs.promises.unlink(file.filePath);
    } else {
      retained.push(file);
    }
  }
  let totalBytes = retained.reduce((sum, file) => sum + file.size, 0);
  for (const file of retained.sort((left, right) => left.date.localeCompare(right.date) || left.name.localeCompare(right.name))) {
    if (totalBytes <= maxTotalBytes) break;
    if (file.date === currentDate) continue;
    await fs.promises.unlink(file.filePath);
    totalBytes -= file.size;
  }
}

export function createManagerOperationalLog(options: {
  rootDir: string;
  now?: () => Date;
  pid?: number;
  enabledGroups?: ReadonlySet<string>;
  diagnosticGroups?: ReadonlySet<string>;
  retryBaseMs?: number;
  retentionDays?: number;
  maxTotalBytes?: number;
}): ManagerOperationalLog {
  const projectRoot = path.resolve(options.rootDir);
  const logDirectory = projectDirectoryLayout(projectRoot).managerLogRoot;
  const now = options.now ?? (() => new Date());
  const pid = options.pid ?? process.pid;
  const pending = new Map<string, string[]>();
  let flushTimer: NodeJS.Timeout | undefined;
  let activeFlush: Promise<void> | undefined;
  let retryAttempt = 0;
  let lastCompletedAt: string | undefined;
  let lastErrorAt: string | undefined;
  let lastError: string | undefined;
  let lastRetentionDate = "";
  const configuredGroups = options.enabledGroups ?? commaSeparatedSet(process.env.RABIROUTE_OPERATION_LOG_GROUPS);
  const diagnosticGroups = options.diagnosticGroups ?? commaSeparatedSet(process.env.RABIROUTE_DIAGNOSTIC_LOG_GROUPS) ?? new Set<string>();
  const retentionDays = Math.max(1, Math.floor(options.retentionDays ?? (Number(process.env.RABIROUTE_OPERATION_LOG_RETENTION_DAYS) || 30)));
  const maxTotalBytes = Math.max(1_048_576, Math.floor(options.maxTotalBytes ?? (Number(process.env.RABIROUTE_OPERATION_LOG_MAX_BYTES) || 512 * 1024 * 1024)));

  const pendingRecordCount = (): number => [...pending.values()].reduce((sum, lines) => sum + lines.length, 0);

  const scheduleFlush = (delayMs = 25): void => {
    if (flushTimer || activeFlush || pending.size === 0) return;
    flushTimer = setTimeout(() => {
      flushTimer = undefined;
      void startFlush()?.catch(() => {});
    }, Math.max(0, delayMs));
    flushTimer.unref?.();
  };

  const startFlush = (): Promise<void> | undefined => {
    if (activeFlush || pending.size === 0) return activeFlush;
    const batch = new Map(pending);
    pending.clear();
    const operation = (async () => {
      await fs.promises.mkdir(logDirectory, { recursive: true });
      const retentionDate = now().toISOString().slice(0, 10);
      if (lastRetentionDate !== retentionDate) {
        await enforceOperationalLogRetention(logDirectory, retentionDate, retentionDays, maxTotalBytes);
        lastRetentionDate = retentionDate;
      }
      for (const [shard, lines] of batch) {
        await fs.promises.appendFile(path.join(logDirectory, shard), lines.join(""), "utf8");
      }
      retryAttempt = 0;
      lastCompletedAt = now().toISOString();
      lastErrorAt = undefined;
      lastError = undefined;
    })().catch((writeError) => {
      const message = writeError instanceof Error ? writeError.message : String(writeError);
      for (const [shard, lines] of batch) {
        pending.set(shard, [...lines, ...(pending.get(shard) ?? [])]);
      }
      retryAttempt += 1;
      lastErrorAt = now().toISOString();
      lastError = redactProjectRoot(message, projectRoot).slice(0, 4_000);
      process.stderr.write(`[RabiRoute Manager operations] failed to persist batch: ${message}\n`);
      throw writeError;
    }).finally(() => {
      activeFlush = undefined;
      if (pending.size > 0) {
        const retryDelay = Math.min(5_000, Math.max(25, options.retryBaseMs ?? 100) * (2 ** Math.min(6, retryAttempt)));
        scheduleFlush(retryAttempt > 0 ? retryDelay : 25);
      }
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
      const group = String(detail.group || "manager").trim() || "manager";
      if (configuredGroups && !configuredGroups.has(group)) return null;
      const recordedAt = now();
      const record: ManagerOperationalEvent = {
        schemaVersion: 2,
        eventId: randomUUID(),
        time: recordedAt.toISOString(),
        level,
        event,
        pid,
        ...detail,
        group
      };
      if (diagnosticGroups.has(group) && !record.diagnostic?.stack) {
        record.diagnostic = {
          ...record.diagnostic,
          stack: managerOperationalError(new Error(`Diagnostic callsite for ${event}`), projectRoot)?.stack
        };
      }
      const shard = `manager-operations-${recordedAt.toISOString().slice(0, 10)}.jsonl`;
      const lines = pending.get(shard) ?? [];
      lines.push(`${JSON.stringify(record)}\n`);
      pending.set(shard, lines);
      scheduleFlush();
      return record;
    },
    flush,
    status() {
      return {
        state: lastError ? "degraded" : "healthy",
        pendingRecords: pendingRecordCount(),
        lastCompletedAt,
        lastErrorAt,
        lastError
      };
    }
  };
}

export function installOperationalMutationAuditSink(
  operationalLog: ManagerOperationalLog,
  projectRoot: string
): () => void {
  return installDataMutationAuditSink(record => {
    operationalLog.record(
      record.level ?? (record.outcome === "failed" ? "error" : record.outcome === "rejected" ? "warn" : "info"),
      record.event,
      {
        group: record.group,
        traceId: record.traceId,
        spanId: record.spanId,
        parentSpanId: record.parentSpanId,
        requestId: record.requestId,
        operationId: record.operationId,
        source: record.source,
        actor: record.actor,
        owner: record.owner,
        action: record.action,
        target: record.target,
        dataSource: record.dataSource,
        outcome: record.outcome,
        before: record.before,
        after: record.after,
        changes: record.changes,
        durationMs: record.durationMs,
        result: record.result,
        error: record.error ? managerOperationalError(record.error, projectRoot) : undefined,
        diagnostic: record.diagnostic
      }
    );
  });
}
