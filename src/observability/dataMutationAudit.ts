import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";

export type OperationSource =
  | "http"
  | "background"
  | "manager"
  | "gateway"
  | "host"
  | "relay"
  | "mobile"
  | "tray";

export type OperationActor = {
  kind: "user" | "agent" | "system" | "migration";
  id?: string;
};

export type OperationContext = {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  requestId?: string;
  operationId?: string;
  source: OperationSource;
  actor: OperationActor;
};

export type MutationAuditRevision = {
  revision?: string;
  digest?: string;
};

export type MutationAuditChange = {
  field: string;
  from?: string | number | boolean | null;
  to?: string | number | boolean | null;
};

export type DataMutationAuditRecord = {
  level?: "debug" | "info" | "warn" | "error";
  group: string;
  event: string;
  owner: string;
  action: string;
  target: { type: string; id: string };
  dataSource: { kind: "file" | "ledger" | "remote" | "runtime"; id: string };
  outcome: "started" | "queued" | "committed" | "no_change" | "replayed" | "rejected" | "failed" | "cancelled";
  operationId?: string;
  before?: MutationAuditRevision;
  after?: MutationAuditRevision;
  changes?: MutationAuditChange[];
  durationMs?: number;
  result?: string;
  error?: unknown;
  diagnostic?: { callsite?: string; stack?: string };
};

export type RecordedDataMutationAudit = DataMutationAuditRecord & OperationContext & {
  recordedAt: string;
};

type DataMutationAuditSink = (record: RecordedDataMutationAudit) => void;

const operationContextStorage = new AsyncLocalStorage<OperationContext>();
const sinks = new Set<DataMutationAuditSink>();

function cleanIdentifier(value: unknown, fallback: string, limit = 300): string {
  const normalized = String(value ?? "").trim().slice(0, limit);
  return normalized || fallback;
}

export function createOperationContext(
  input: Partial<Omit<OperationContext, "traceId" | "spanId">> & Pick<OperationContext, "source" | "actor"> & {
    traceId?: string;
    spanId?: string;
  }
): OperationContext {
  return {
    traceId: cleanIdentifier(input.traceId, randomUUID(), 160),
    spanId: cleanIdentifier(input.spanId, randomUUID(), 160),
    parentSpanId: input.parentSpanId ? cleanIdentifier(input.parentSpanId, "", 160) || undefined : undefined,
    requestId: input.requestId ? cleanIdentifier(input.requestId, "", 160) || undefined : undefined,
    operationId: input.operationId ? cleanIdentifier(input.operationId, "", 300) || undefined : undefined,
    source: input.source,
    actor: {
      kind: input.actor.kind,
      id: input.actor.id ? cleanIdentifier(input.actor.id, "", 300) || undefined : undefined
    }
  };
}

export function runWithOperationContext<T>(context: OperationContext, action: () => T): T {
  return operationContextStorage.run(context, action);
}

export function currentOperationContext(): OperationContext | undefined {
  return operationContextStorage.getStore();
}

export function installDataMutationAuditSink(sink: DataMutationAuditSink): () => void {
  sinks.add(sink);
  return () => sinks.delete(sink);
}

export function recordDataMutationAudit(record: DataMutationAuditRecord): RecordedDataMutationAudit {
  const active = currentOperationContext();
  const context = active ?? createOperationContext({
    source: "background",
    actor: { kind: "system" },
    operationId: record.operationId
  });
  const resolved: RecordedDataMutationAudit = {
    ...record,
    ...context,
    operationId: record.operationId ?? context.operationId,
    group: cleanIdentifier(record.group, "unclassified", 160),
    event: cleanIdentifier(record.event, "data_mutation", 160),
    owner: cleanIdentifier(record.owner, "unknown", 200),
    action: cleanIdentifier(record.action, "unknown", 200),
    target: {
      type: cleanIdentifier(record.target.type, "unknown", 160),
      id: cleanIdentifier(record.target.id, "unknown", 500)
    },
    dataSource: {
      kind: record.dataSource.kind,
      id: cleanIdentifier(record.dataSource.id, "unknown", 500)
    },
    recordedAt: new Date().toISOString()
  };
  for (const sink of sinks) {
    try {
      sink(resolved);
    } catch {
      // Diagnostics must not change the business mutation result.
    }
  }
  return resolved;
}
