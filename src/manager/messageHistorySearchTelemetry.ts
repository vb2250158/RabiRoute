import { createOperationContext, currentOperationContext, recordDataMutationAudit, runWithOperationContext } from "../observability/dataMutationAudit.js";

export type MessageHistoryQueryTiming = { queueMs: number; workerMs: number; visibilityMs: number; snapshotMs: number; probeAttempts: number };

/** Only identifiers, versions and numeric measurements cross this logging boundary. */
export function recordMessageHistoryQueryTrace(requestId: string, durationMs: number, timing: MessageHistoryQueryTiming,
  result?: { indexVersion: string; sourceVersion: string; strategy: string; candidates: number; returned: number; bytes: number; projectionMs: number; candidateMs: number },
  errorCode?: string): void {
  const context = currentOperationContext() ?? createOperationContext({ source: "http", actor: { kind: "system" } });
  const values = { ...timing, ...(result ? { candidates: result.candidates, returned: result.returned, bytes: result.bytes,
    projectionMs: result.projectionMs, candidateMs: result.candidateMs, strategy: result.strategy } : {}) };
  runWithOperationContext({ ...context, requestId }, () => recordDataMutationAudit({
    level: "debug", group: "message-search", event: "message_history_query", owner: "message-history-search", action: "query",
    target: { type: "request", id: requestId }, dataSource: { kind: "runtime", id: result?.indexVersion ?? "unavailable" },
    outcome: errorCode ? "failed" : "no_change", durationMs, result: errorCode ?? "ok",
    after: result ? { revision: result.indexVersion, digest: result.sourceVersion } : undefined,
    changes: Object.entries(values).map(([field, to]) => ({ field, to }))
  }));
}

export function recordMessageHistoryResponseTrace(requestId: string, durationMs: number, bytes: number, status: number): void {
  const context = currentOperationContext() ?? createOperationContext({ source: "http", actor: { kind: "system" } });
  runWithOperationContext({ ...context, requestId }, () => recordDataMutationAudit({
    level: "debug", group: "message-search", event: "message_history_response", owner: "message-history-search", action: "serialize",
    target: { type: "request", id: requestId }, dataSource: { kind: "runtime", id: "http-response" },
    outcome: status >= 400 ? "failed" : "no_change", durationMs, result: `http_${status}`,
    changes: [{ field: "bytes", to: bytes }, { field: "status", to: status }]
  }));
}
