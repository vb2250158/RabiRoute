import { getTimeoutMs } from "../shared/timeoutSettings.js";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { RecentMessageContextQuery } from "../messageContextStore.js";
import type { MessageHistorySearchResult, MessageHistorySearchProbe, MessageHistorySearchTarget, MessageHistoryIndexRefreshResult } from "../messageHistorySearchIndex.js";
import { messageHistoryAppendProof, discardMessageHistoryAppendProof } from "../messageHistorySourceVersion.js";
import { subscribeMessageHistoryChanges } from "../messageHistoryChanges.js";
import { managerMessageIndexWorkerPool, managerMessageSearchWorkerPool, ManagerReadWorkerError } from "./managerReadWorkerPool.js";
import { recordPerformanceOperation } from "../performance/performanceInstrumentation.js";
import { PERFORMANCE_OPERATIONS } from "../shared/performanceOperations.js";
import { recordMessageHistoryQueryTrace, type MessageHistoryQueryTiming } from "./messageHistorySearchTelemetry.js";

type RoleIndex = { dirty: boolean; flight?: Promise<void>; error?: string; retry?: NodeJS.Timeout; retryMs?: number; indexPath?: string;
  progress?: number; waiters?: Set<() => void>; stopped?: boolean;
  builds?: number; failures?: Record<string, number>; queryFailures?: Record<string, number>; lagReasons?: Record<string, number>; lastBuildMs?: number; records?: number; filesRead?: number;
  walBytes?: number; sourceFiles?: number; currentVersion?: string; currentRecords?: number; layoutVersion?: string };
const roles = new Map<string, RoleIndex>();
let unsubscribe: (() => void) | undefined;
let reconciliation: NodeJS.Timeout | undefined;
const VISIBILITY_WINDOW_MS = 1_500;
const QUERY_QUEUE_MS = 500;
const SOURCE_CHANGE_RETRY_MS = 25;

function refresh(directory: string, state: RoleIndex): void {
  state.dirty = true;
  if (state.flight) return;
  clearTimeout(state.retry); state.retry = undefined;
  state.flight = (async () => {
    // Coalesce writes while a build is running. Each pass reuses unchanged files.
    for (let attempt = 0; attempt < 8 && state.dirty; attempt++) {
      state.dirty = false;
      const began = performance.now();
      state.builds = (state.builds ?? 0) + 1;
      try {
        const result = await managerMessageIndexWorkerPool.run<MessageHistoryIndexRefreshResult>({ type: "message_history_index", roleDir: directory, indexPath: state.indexPath });
        state.error = undefined;
        state.retryMs = undefined;
        state.records = result.records; state.filesRead = result.filesRead;
        state.walBytes = result.walBytes; state.sourceFiles = result.sourceFiles; state.currentVersion = result.currentVersion;
        state.currentRecords = result.currentRecords; state.layoutVersion = result.layoutVersion;
      } catch (error) {
        state.error = error instanceof Error ? error.message : String(error);
        const code = state.error.match(/^MESSAGE_HISTORY_INDEX_[A-Z_]+/)?.[0] ?? (error instanceof ManagerReadWorkerError ? error.code : "INDEX_BUILD_FAILED");
        state.failures ??= {}; state.failures[code] = (state.failures[code] ?? 0) + 1;
        if (state.error.startsWith("MESSAGE_HISTORY_INDEX_LAGGING")) state.dirty = true;
        else {
          // A bounded worker may stop mid-build. Resume durable checkpoints in
          // the background without requiring another user query to wake it.
          state.dirty = error instanceof ManagerReadWorkerError && ["busy", "timeout", "worker_failed", "termination_unconfirmed"].includes(error.code);
          break;
        }
      } finally {
        state.lastBuildMs = performance.now() - began;
        state.progress = (state.progress ?? 0) + 1;
        for (const notify of state.waiters ?? []) notify();
      }
    }
  })().finally(() => {
    state.flight = undefined;
    if (state.dirty && roles.get(directory) === state) {
      // A successful batch yields the worker fairly and continues immediately.
      // Backoff belongs to failed builds, not to a live source still appending.
      const sourceChanging = state.error?.startsWith("MESSAGE_HISTORY_INDEX_LAGGING");
      const retryMs = sourceChanging ? SOURCE_CHANGE_RETRY_MS : state.error ? Math.min(30_000, state.retryMs ?? 2_000) : 0;
      state.retryMs = state.error && !sourceChanging ? Math.min(30_000, retryMs * 2) : undefined;
      state.retry = setTimeout(() => { if (roles.get(directory) === state) refresh(directory, state); }, retryMs);
      state.retry.unref();
    }
  });
}

/** Publication wakes waiting requests; a bounded fallback also observes external writers. */
function waitForIndexProgress(state: RoleIndex, observed: number, deadlineAt: number, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  if (state.stopped || (state.progress ?? 0) !== observed) return Promise.resolve();
  if ((state.waiters?.size ?? 0) >= 16) throw new ManagerReadWorkerError("SEARCH_BUSY: visibility wait limit exceeded", "busy");
  return new Promise((resolve, reject) => {
    let timer: NodeJS.Timeout | undefined;
    const finish = (error?: unknown) => {
      clearTimeout(timer); signal.removeEventListener("abort", aborted); state.waiters?.delete(published);
      if (error !== undefined) reject(error); else resolve();
    };
    const published = () => finish();
    const aborted = () => finish(signal.reason);
    (state.waiters ??= new Set()).add(published);
    signal.addEventListener("abort", aborted, { once: true });
    const remaining = Math.max(1, deadlineAt - performance.now());
    // Our in-flight pass always publishes progress in its finally block. Only
    // external work needs periodic observation; both waits share one deadline.
    timer = setTimeout(published, state.flight ? remaining : Math.min(50, remaining));
  });
}

export async function queryMessageHistory(directory: string, query: RecentMessageContextQuery,
  options: { signal: AbortSignal; deadlineAt?: number; requestId?: string; indexPath?: string }): Promise<MessageHistorySearchResult> {
  const began = performance.now();
  const requestId = options.requestId ?? randomUUID();
  const timing: MessageHistoryQueryTiming = { queueMs: 0, workerMs: 0, visibilityMs: 0, snapshotMs: 0, probeAttempts: 0 };
  let visibilityBegan: number | undefined;
  if (!unsubscribe) {
    unsubscribe = subscribeMessageHistoryChanges(changed => {
      const key = path.resolve(changed);
      const state = roles.get(key);
      if (state) refresh(key, state);
    });
    // event-driven-allow: bounded message-source integrity reconciliation
    reconciliation = setInterval(() => {
      for (const [directory, state] of roles) if (!state.flight && !state.retry) refresh(directory, state);
    }, 60_000);
    reconciliation.unref();
  }
  const key = path.resolve(directory);
  let state = roles.get(key);
  if (!state) { state = { dirty: false, indexPath: options.indexPath }; roles.set(key, state); }
  else if (state.indexPath !== options.indexPath) throw new Error("MESSAGE_HISTORY_INDEX_IDENTITY_MISMATCH");
  try {
    const deadlineAt = options.deadlineAt ?? began + getTimeoutMs("history.request", 2500);
    let barrierDeadline: number | undefined;
    const initialProof = messageHistoryAppendProof(key);
    const lastCommit = initialProof?.commits.at(-1);
    const ownerTarget = lastCommit && initialProof ? { stamp: lastCommit.stamp, records: lastCommit.records,
      layoutVersion: initialProof.layoutVersion, catalogStamp: lastCommit.catalogStamp } : undefined;
    let target: MessageHistorySearchTarget | undefined;
    for (;;) {
      options.signal.throwIfAborted();
      if (state.stopped) throw new ManagerReadWorkerError("SEARCH_BUSY: search service stopped", "busy");
      if (target && barrierDeadline !== undefined && performance.now() >= barrierDeadline) throw new ManagerReadWorkerError("MESSAGE_HISTORY_INDEX_LAGGING", "busy");
      const remaining = deadlineAt - performance.now();
      if (remaining <= 0) throw new ManagerReadWorkerError("SEARCH_DEADLINE_EXCEEDED", "timeout");
      timing.probeAttempts++;
      const observedProgress = state.progress ?? 0;
      const probe = await managerMessageSearchWorkerPool.run<MessageHistorySearchProbe>({ type: "message_history_search", roleDir: key, query,
        target, proof: messageHistoryAppendProof(key), ownerTarget, indexPath: state.indexPath,
        visibilityDeadlineAt: target && barrierDeadline !== undefined ? Date.now() + Math.max(0, barrierDeadline - performance.now()) : undefined },
      { signal: options.signal, queueTimeoutMs: Math.min(getTimeoutMs("history.queue", QUERY_QUEUE_MS), remaining), timeoutMs: Math.min(getTimeoutMs("history.execution", 1800), remaining), onStarted: ms => { timing.queueMs += ms; } });
      timing.workerMs += probe.ready ? probe.result.metrics.elapsedMs : probe.elapsedMs ?? 0;
      timing.snapshotMs += probe.ready ? probe.result.metrics.snapshotMs ?? 0 : probe.elapsedMs ?? 0;
      if (probe.ready) {
        if (visibilityBegan !== undefined) timing.visibilityMs = Math.max(0, performance.now() - visibilityBegan
          - probe.result.metrics.elapsedMs + (probe.result.metrics.snapshotMs ?? 0));
        recordPerformanceOperation(PERFORMANCE_OPERATIONS.managerMessageSearchQuery, probe.result.metrics.elapsedMs);
        recordPerformanceOperation(PERFORMANCE_OPERATIONS.managerMessageSearchTotal, performance.now() - began);
        recordMessageHistoryQueryTrace(requestId, performance.now() - began, timing, { ...probe.result.coverage,
          strategy: probe.result.metrics.strategy, candidates: probe.result.metrics.candidates, returned: probe.result.entries.length,
          bytes: Buffer.byteLength(JSON.stringify(probe.result.entries)), projectionMs: probe.result.metrics.projectionMs ?? 0,
          candidateMs: probe.result.metrics.candidateMs ?? probe.result.metrics.elapsedMs });
        return probe.result;
      }
      state.lagReasons ??= {};
      const lagReason = probe.diagnostic ?? "not_ready";
      state.lagReasons[lagReason] = (state.lagReasons[lagReason] ?? 0) + 1;
      if (lagReason === "owner_target_stale" && ownerTarget && discardMessageHistoryAppendProof(key, ownerTarget.stamp, ownerTarget.catalogStamp)) {
        throw new ManagerReadWorkerError("MESSAGE_HISTORY_INDEX_LAGGING", "busy");
      }
      // A lag probe is a wake-up hint, not another source commit. The in-flight
      // builder already owns catch-up; only real change events mark it dirty.
      if (!state.flight && !state.retry) refresh(key, state);
      target ??= probe.target;
      // The visibility stage begins after discovery/queueing, not at HTTP entry.
      // Its one deadline is still capped by the unchanged request deadline.
      barrierDeadline ??= Math.min(deadlineAt, performance.now() + getTimeoutMs("history.visibility", VISIBILITY_WINDOW_MS));
      visibilityBegan ??= performance.now();
      if (!target || barrierDeadline <= performance.now()) throw new ManagerReadWorkerError(probe.reason, "busy");
      // Only the proof advances. Every retry retains the source target captured
      // by the first worker, so continuous writes cannot move this barrier.
      await waitForIndexProgress(state, observedProgress, barrierDeadline, options.signal);
    }
  } catch (error) {
    recordPerformanceOperation(PERFORMANCE_OPERATIONS.managerMessageSearchTotal, performance.now() - began, true);
    const message = error instanceof Error ? error.message : String(error);
    if (visibilityBegan !== undefined) timing.visibilityMs = performance.now() - visibilityBegan;
    recordMessageHistoryQueryTrace(requestId, performance.now() - began, timing, undefined,
      message.match(/^(?:MESSAGE_HISTORY_INDEX_[A-Z_]+|SEARCH_[A-Z_]+)/)?.[0]
        ?? (error instanceof ManagerReadWorkerError ? error.code : "SEARCH_FAILED"));
    if (/^MESSAGE_HISTORY_INDEX_(?:NOT_READY|LAGGING)/.test(message)) {
      if (!state.flight && !state.retry) refresh(key, state);
      throw new ManagerReadWorkerError(message, "busy");
    }
    if (error instanceof ManagerReadWorkerError && error.code === "worker_failed") {
      const failure = /database is locked|SQLITE_BUSY/i.test(message) ? "database_busy" : /datatype mismatch/i.test(message) ? "sql_parameter_type"
        : /malformed|not a database/i.test(message) ? "database_corrupt" : /cannot read properties/i.test(message) ? "invalid_index_row" : "worker_failed";
      state.queryFailures ??= {}; state.queryFailures[failure] = (state.queryFailures[failure] ?? 0) + 1;
      refresh(key, state);
      throw new ManagerReadWorkerError("MESSAGE_HISTORY_INDEX_UNAVAILABLE", "busy");
    }
    throw error;
  }
}

export function stopMessageHistorySearch(): void {
  unsubscribe?.(); unsubscribe = undefined;
  clearInterval(reconciliation); reconciliation = undefined;
  for (const state of roles.values()) {
    clearTimeout(state.retry); state.stopped = true;
    for (const notify of state.waiters ?? []) notify();
  }
  roles.clear();
}

/** Bounded operational counters only: no source paths, search terms or message bodies. */
export function messageHistorySearchStatus(directory: string): {
  known: boolean; building: boolean; retryScheduled: boolean; builds: number; failures: Record<string, number>;
  records?: number; filesRead?: number; lastBuildMs?: number; lagReasons: Record<string, number>; queryFailures: Record<string, number>;
  walBytes?: number; sourceFiles?: number; backlogMessages?: number
} {
  const state = roles.get(path.resolve(directory));
  const proof = messageHistoryAppendProof(directory);
  const knownVersion = state?.currentVersion !== undefined && proof?.commits.some(commit => commit.stamp === state.currentVersion);
  const backlogMessages = proof && knownVersion && proof.layoutVersion === state?.layoutVersion && state?.currentRecords !== undefined
    ? Math.max(0, proof.commits.at(-1)!.records - state.currentRecords) : undefined;
  return { known: Boolean(state), building: Boolean(state?.flight), retryScheduled: Boolean(state?.retry), builds: state?.builds ?? 0,
    failures: { ...state?.failures }, queryFailures: { ...state?.queryFailures }, lagReasons: { ...state?.lagReasons }, records: state?.records,
    filesRead: state?.filesRead, lastBuildMs: state?.lastBuildMs, walBytes: state?.walBytes, sourceFiles: state?.sourceFiles, backlogMessages };
}
