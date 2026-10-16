import { ProgressivePlanStorageStartup } from "./progressivePlanStorageStartup.js";
import { StorageTerminationError, type StorageStartupLimits } from "./boundedStorageStartup.js";
import type { PlanStorageStartupGateSummary } from "./planStorageStartupGate.js";

export type PlanStorageStartupLifecycleState = "idle" | "running" | "ready" | "degraded" | "stopping" | "stopped";

export type PlanStorageStartupLifecycleSnapshot = Readonly<{
  state: PlanStorageStartupLifecycleState;
  attempt: number;
  incidents: number;
  lastTransitionAt: string;
  startedAt?: string;
  completedAt?: string;
  deadlineAt?: string;
  nextRetryAt?: string;
  childPid?: number;
  lastError?: string;
  summary?: PlanStorageStartupGateSummary;
}>;

export type PlanStorageStartupAttempt = Readonly<{
  pid?: number;
  result: Promise<PlanStorageStartupGateSummary>;
  cancel(): Promise<void>;
}>;

class PlanStorageStartupAttemptError extends Error {
  constructor(message: string, readonly summary?: PlanStorageStartupGateSummary) {
    super(message);
    this.name = "PlanStorageStartupAttemptError";
  }
}

export type PlanStorageStartupLifecycleOptions = Readonly<{
  rolesRoot: string;
  readOnly: boolean;
  attemptTimeoutMs?: number;
  retryBaseMs?: number;
  retryMaxMs?: number;
  terminateTimeoutMs?: number;
  limits?: StorageStartupLimits;
  attemptFactory?: (onProgress: (summary: PlanStorageStartupGateSummary) => void) => PlanStorageStartupAttempt;
  onStatus?: (snapshot: PlanStorageStartupLifecycleSnapshot) => void;
}>;

function positiveInteger(value: number | undefined, fallback: number): number {
  return Number.isSafeInteger(value) && Number(value) > 0 ? Number(value) : fallback;
}

export class PlanStorageStartupLifecycle {
  private readonly attemptTimeoutMs: number;
  private readonly retryBaseMs: number;
  private readonly retryMaxMs: number;
  private readonly attemptFactory: NonNullable<PlanStorageStartupLifecycleOptions["attemptFactory"]>;
  private currentAttempt: { value: PlanStorageStartupAttempt; settled: boolean; timeout?: NodeJS.Timeout } | undefined;
  private cancellationFlight: Promise<void> | undefined;
  private retryTimer: NodeJS.Timeout | undefined;
  private stopFlight: Promise<void> | undefined;
  private active = false;
  private terminationUnconfirmed = false;
  private readonly readyListeners = new Set<(summary: PlanStorageStartupGateSummary) => void>();
  private runtimeSnapshot: PlanStorageStartupLifecycleSnapshot;

  constructor(private readonly options: PlanStorageStartupLifecycleOptions) {
    this.attemptTimeoutMs = positiveInteger(options.attemptTimeoutMs, 45_000);
    this.retryBaseMs = positiveInteger(options.retryBaseMs, 5_000);
    this.retryMaxMs = Math.max(this.retryBaseMs, positiveInteger(options.retryMaxMs, 60_000));
    const loader = new ProgressivePlanStorageStartup({
      rolesRoot: options.rolesRoot,
      readOnly: options.readOnly,
      terminateTimeoutMs: options.terminateTimeoutMs,
      limits: options.limits
    });
    this.attemptFactory = options.attemptFactory ?? (onProgress => loader.attempt(onProgress));
    this.runtimeSnapshot = Object.freeze({
      state: "idle",
      attempt: 0,
      incidents: 0,
      lastTransitionAt: new Date().toISOString()
    });
  }

  snapshot(): PlanStorageStartupLifecycleSnapshot {
    return Object.freeze({
      ...this.runtimeSnapshot,
      summary: this.runtimeSnapshot.summary ? structuredClone(this.runtimeSnapshot.summary) : undefined
    });
  }

  onReady(listener: (summary: PlanStorageStartupGateSummary) => void): () => void {
    this.readyListeners.add(listener);
    if (this.runtimeSnapshot.state === "ready" && this.runtimeSnapshot.summary) {
      queueMicrotask(() => {
        if (this.readyListeners.has(listener) && this.runtimeSnapshot.summary) listener(this.runtimeSnapshot.summary);
      });
    }
    return () => this.readyListeners.delete(listener);
  }

  start(): void {
    if (this.active || this.terminationUnconfirmed || this.runtimeSnapshot.state === "ready" || this.runtimeSnapshot.state === "stopped") return;
    this.active = true;
    this.startAttempt();
  }

  stop(): Promise<void> {
    if (this.stopFlight) return this.stopFlight;
    if (this.runtimeSnapshot.state === "stopped") return Promise.resolve();
    this.stopFlight = this.stopOnce().catch(error => {
      this.stopFlight = undefined;
      throw error;
    });
    return this.stopFlight;
  }

  private async stopOnce(): Promise<void> {
    this.active = false;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = undefined;
    this.transition({ state: "stopping", incidents: 0, nextRetryAt: undefined });
    const current = this.currentAttempt;
    if (current) {
      current.settled = true;
      if (current.timeout) clearTimeout(current.timeout);
      this.cancellationFlight = this.trackCancellation(current.value.cancel());
    }
    if (this.cancellationFlight) {
      try {
        await this.cancellationFlight;
      } catch (error) {
        this.transition({ state: "degraded", incidents: 1, lastError: "Storage startup child exit is unconfirmed." });
        throw error;
      }
    }
    this.currentAttempt = undefined;
    this.readyListeners.clear();
    this.transition({ state: "stopped", incidents: 0, childPid: undefined, deadlineAt: undefined, nextRetryAt: undefined });
  }

  private trackCancellation(cancellation: Promise<void>): Promise<void> {
    const tracked = Promise.resolve(cancellation).finally(() => {
      if (this.cancellationFlight === tracked) this.cancellationFlight = undefined;
    });
    void tracked.catch(() => {});
    return tracked;
  }

  private transition(patch: Partial<PlanStorageStartupLifecycleSnapshot>): void {
    this.runtimeSnapshot = Object.freeze({
      ...this.runtimeSnapshot,
      ...patch,
      lastTransitionAt: new Date().toISOString()
    });
    try {
      this.options.onStatus?.(this.snapshot());
    } catch (error) {
      console.error("Plan storage startup observer failed.", error);
    }
  }

  private startAttempt(): void {
    if (!this.active) return;
    const attemptNumber = this.runtimeSnapshot.attempt + 1;
    const reportProgress = (summary: PlanStorageStartupGateSummary): void => {
      if (!token || !this.active || this.currentAttempt !== token || token.settled) return;
      this.transition({
        summary: structuredClone(summary),
        deadlineAt: new Date(Date.now() + this.attemptTimeoutMs).toISOString(),
        ...(summary.failures.length ? { state: "degraded" as const, incidents: 1 } : {})
      });
      token.timeout?.refresh();
    };
    let attempt: PlanStorageStartupAttempt;
    let token: NonNullable<PlanStorageStartupLifecycle["currentAttempt"]>;
    try {
      attempt = this.attemptFactory(summary => queueMicrotask(() => reportProgress(summary)));
    } catch {
      this.failAttempt(new Error("Plan storage startup child failed to start."), attemptNumber);
      return;
    }
    const startedAt = new Date();
    token = { value: attempt, settled: false, timeout: undefined as NodeJS.Timeout | undefined };
    this.currentAttempt = token;
    this.transition({
      state: "running",
      attempt: attemptNumber,
      incidents: 0,
      startedAt: startedAt.toISOString(),
      completedAt: undefined,
      deadlineAt: new Date(startedAt.getTime() + this.attemptTimeoutMs).toISOString(),
      nextRetryAt: undefined,
      childPid: attempt.pid,
      lastError: undefined
    });
    token.timeout = setTimeout(() => {
      if (token.settled) return;
      token.settled = true;
      this.currentAttempt = undefined;
      const cancellation = Promise.resolve().then(() => attempt.cancel())
        .then(() => this.failAttempt(new Error(`Plan storage startup attempt timed out after ${this.attemptTimeoutMs}ms.`), attemptNumber))
        .catch(() => {
          this.currentAttempt = token;
          const error = new StorageTerminationError();
          this.failAttempt(error, attemptNumber);
          throw error;
        });
      this.cancellationFlight = this.trackCancellation(cancellation);
    }, this.attemptTimeoutMs);
    token.timeout.unref();
    void attempt.result.then(summary => {
      if (token.settled) return;
      token.settled = true;
      if (token.timeout) clearTimeout(token.timeout);
      this.currentAttempt = undefined;
      if (!this.active) return;
      if (summary.failures.length) {
        this.failAttempt(new PlanStorageStartupAttemptError("Plan storage startup gate failed.", summary), attemptNumber);
        return;
      }
      this.active = false;
      this.transition({
        state: "ready",
        incidents: 0,
        completedAt: new Date().toISOString(),
        deadlineAt: undefined,
        childPid: undefined,
        lastError: undefined,
        summary
      });
      for (const listener of [...this.readyListeners]) {
        try { listener(structuredClone(summary)); } catch (error) {
          console.error("Plan storage ready observer failed.", error);
        }
      }
    }).catch(error => {
      if (token.settled) return;
      token.settled = true;
      if (token.timeout) clearTimeout(token.timeout);
      this.currentAttempt = error instanceof StorageTerminationError ? token : undefined;
      this.failAttempt(error instanceof Error ? error : new Error(String(error)), attemptNumber);
    });
  }

  private failAttempt(error: Error, attemptNumber: number): void {
    if (!this.active) return;
    if (error instanceof StorageTerminationError) this.terminationUnconfirmed = true;
    const exponent = Math.max(0, Math.min(20, attemptNumber - 1));
    const retryMs = Math.min(this.retryMaxMs, this.retryBaseMs * (2 ** exponent));
    const nextRetryAt = new Date(Date.now() + retryMs).toISOString();
    this.transition({
      state: "degraded",
      attempt: attemptNumber,
      incidents: 1,
      completedAt: new Date().toISOString(),
      deadlineAt: undefined,
      childPid: undefined,
      lastError: error.message,
      nextRetryAt: this.terminationUnconfirmed ? undefined : nextRetryAt,
      summary: error instanceof PlanStorageStartupAttemptError ? error.summary : this.runtimeSnapshot.summary
    });
    if (this.terminationUnconfirmed) return;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = undefined;
      this.startAttempt();
    }, retryMs);
    this.retryTimer.unref();
  }
}
