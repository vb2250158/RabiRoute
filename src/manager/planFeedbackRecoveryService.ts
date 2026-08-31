import type {
  PlanFeedbackRecoveryCandidate,
  PlanFeedbackRecoveryOutcome
} from "./planFeedbackRecovery.js";
import {
  FailureCircuitRegistry,
  type FailureCircuitDecision
} from "../runtime/failureCircuit.js";

export const PLAN_FEEDBACK_RECOVERY_RETRY_MS = 15_000;

type MaybePromise<T> = T | Promise<T>;

function waitForAbortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    void promise.then(
      value => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      error => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      }
    );
  });
}

export type PlanFeedbackRecoveryScheduleControls = {
  signal: AbortSignal;
  scheduleOnce(schedule: () => MaybePromise<void>): Promise<boolean>;
};

export type PlanFeedbackRecoverySweepSummary = {
  reason: string;
  candidates: number;
  delivered: number;
  scheduled: number;
  deferred: number;
  alreadyAttempted: number;
};

export type PlanFeedbackRecoveryErrorEvent = {
  reason: string;
  stage: "scan" | "candidate";
  error: unknown;
  recoveryKey?: string;
  circuit: FailureCircuitDecision;
};

export type PlanFeedbackRecoveryServiceOptions = {
  retryDelayMs?: number;
  maximumRetryDelayMs?: number;
  incidentThreshold?: number;
  attemptTimeoutMs?: number;
  now?: () => number;
  persistencePath?: string;
  onPersistenceError?: (error: unknown) => void;
  listCandidates(signal: AbortSignal): MaybePromise<readonly PlanFeedbackRecoveryCandidate[]>;
  recoverCandidate(
    candidate: PlanFeedbackRecoveryCandidate,
    controls: PlanFeedbackRecoveryScheduleControls
  ): MaybePromise<PlanFeedbackRecoveryOutcome>;
  onSummary(summary: PlanFeedbackRecoverySweepSummary): MaybePromise<void>;
  onError(event: PlanFeedbackRecoveryErrorEvent): MaybePromise<void>;
  onIncident?(event: PlanFeedbackRecoveryErrorEvent): MaybePromise<void>;
};

function recoveryKey(candidate: PlanFeedbackRecoveryCandidate): string {
  return `${candidate.roleId}:${candidate.plan.id}:${candidate.feedback.id}`;
}

export class PlanFeedbackRecoveryService {
  private readonly attempted = new Set<string>();
  private readonly deferredUntil = new Map<string, number>();
  private readonly retryDelayMs: number;
  private readonly now: () => number;
  private readonly failureCircuits: FailureCircuitRegistry;
  private readonly attemptTimeoutMs: number;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private timerDueAt: number | undefined;
  private currentSweep: Promise<void> | undefined;
  private pendingReason: string | undefined;
  private active = false;
  private stopped = false;
  private generation = 0;
  private attemptCancellation: AbortController | undefined;
  private sweepCancellation: AbortController | undefined;

  constructor(private readonly options: PlanFeedbackRecoveryServiceOptions) {
    this.retryDelayMs = Math.max(0, options.retryDelayMs ?? PLAN_FEEDBACK_RECOVERY_RETRY_MS);
    this.now = options.now ?? Date.now;
    this.attemptTimeoutMs = Math.max(1_000, options.attemptTimeoutMs ?? 5 * 60_000);
    this.failureCircuits = new FailureCircuitRegistry({
      baseDelayMs: Math.max(1, this.retryDelayMs),
      maximumDelayMs: Math.max(Math.max(1, this.retryDelayMs), options.maximumRetryDelayMs ?? 15 * 60_000),
      incidentThreshold: options.incidentThreshold ?? 5,
      now: this.now,
      persistencePath: options.persistencePath,
      onPersistenceError: options.onPersistenceError
    });
  }

  start(reason: string): Promise<void> {
    if (this.stopped) return Promise.resolve();
    this.active = true;
    return this.requestSweep(reason);
  }

  allowRetry(roleId: string, planId: string, feedbackId: string): void {
    const key = `${roleId}:${planId}:${feedbackId}`;
    this.attempted.delete(key);
    this.deferredUntil.delete(key);
    this.failureCircuits.reset(key);
  }

  failureSummary() {
    return this.failureCircuits.summary();
  }
  queue(reason: string, delayMs = this.retryDelayMs): boolean {
    if (!this.active || this.stopped) return false;

    const dueAt = this.now() + Math.max(0, delayMs);
    if (this.timer && this.timerDueAt !== undefined && this.timerDueAt <= dueAt) return false;
    if (this.timer) clearTimeout(this.timer);

    const generation = this.generation;
    this.timerDueAt = dueAt;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.timerDueAt = undefined;
      if (!this.isCurrent(generation)) return;
      const remaining = dueAt - this.now();
      if (remaining > 0) {
        this.queue(reason, remaining);
        return;
      }
      void this.requestSweep(reason).catch(() => {});
    }, Math.max(0, delayMs));
    this.timer.unref();
    return true;
  }

  async stop(): Promise<void> {
    if (!this.stopped) {
      this.stopped = true;
      this.active = false;
      this.generation += 1;
      this.pendingReason = undefined;
      this.sweepCancellation?.abort(new DOMException("Plan feedback recovery stopped.", "AbortError"));
      this.attemptCancellation?.abort(new DOMException("Plan feedback recovery stopped.", "AbortError"));
      if (this.timer) clearTimeout(this.timer);
      this.timer = undefined;
      this.timerDueAt = undefined;
    }

    const sweep = this.currentSweep;
    if (sweep) await sweep;
  }

  private requestSweep(reason: string): Promise<void> {
    if (!this.active || this.stopped) return Promise.resolve();
    if (this.currentSweep) {
      this.pendingReason ??= reason;
      return this.currentSweep;
    }

    const generation = this.generation;
    const sweepCancellation = new AbortController();
    this.sweepCancellation = sweepCancellation;
    const sweep = this.runSweep(reason, generation, sweepCancellation.signal);
    this.currentSweep = sweep;
    void sweep.then(
      () => this.finishSweep(sweep, generation, sweepCancellation),
      () => this.finishSweep(sweep, generation, sweepCancellation)
    );
    return sweep;
  }

  private finishSweep(sweep: Promise<void>, generation: number, sweepCancellation: AbortController): void {
    if (this.currentSweep !== sweep) return;
    this.currentSweep = undefined;
    if (this.sweepCancellation === sweepCancellation) this.sweepCancellation = undefined;
    if (!this.isCurrent(generation)) {
      this.pendingReason = undefined;
      return;
    }

    const pendingReason = this.pendingReason;
    this.pendingReason = undefined;
    if (pendingReason) {
      void this.requestSweep(pendingReason).catch(() => {});
    }
  }

  private async runSweep(reason: string, generation: number, signal: AbortSignal): Promise<void> {
    let candidates: readonly PlanFeedbackRecoveryCandidate[];
    try {
      candidates = await waitForAbortable(Promise.resolve(this.options.listCandidates(signal)), signal);
    } catch (error) {
      if (!this.isCurrent(generation)) return;
      const circuit = this.failureCircuits.recordFailure("scan", error);
      const event = { reason, stage: "scan" as const, error, circuit };
      if (circuit.shouldReport) await this.publishError(event, generation);
      if (circuit.incidentOpened) await this.publishIncident(event, generation);
      if (this.isCurrent(generation)) {
        this.queue("recovery scan retry", circuit.delayMs);
      }
      return;
    }
    this.failureCircuits.recordSuccess("scan");

    if (!this.isCurrent(generation)) return;
    const activeKeys = new Set(candidates.map(recoveryKey));
    this.failureCircuits.retain(["scan", ...activeKeys]);
    for (const key of this.attempted) {
      if (!activeKeys.has(key)) this.attempted.delete(key);
    }
    for (const key of this.deferredUntil.keys()) {
      if (!activeKeys.has(key)) this.deferredUntil.delete(key);
    }

    let delivered = 0;
    let scheduled = 0;
    let deferred = 0;
    let alreadyAttempted = 0;
    let nextRetryDelayMs: number | undefined;

    for (const candidate of candidates) {
      if (!this.isCurrent(generation)) return;
      const key = recoveryKey(candidate);
      const deferredUntil = this.deferredUntil.get(key);
      if (deferredUntil !== undefined && this.now() < deferredUntil) {
        deferred += 1;
        nextRetryDelayMs = Math.min(
          nextRetryDelayMs ?? Number.POSITIVE_INFINITY,
          Math.max(0, deferredUntil - this.now())
        );
        continue;
      }
      this.deferredUntil.delete(key);
      if (!this.failureCircuits.canAttempt(key)) {
        deferred += 1;
        const retryAt = this.failureCircuits.nextRetryAt(key);
        if (retryAt !== undefined) {
          const delay = Math.max(0, retryAt - this.now());
          nextRetryDelayMs = Math.min(nextRetryDelayMs ?? Number.POSITIVE_INFINITY, delay);
        }
        continue;
      }
      if (this.attempted.has(key)) {
        alreadyAttempted += 1;
        continue;
      }

      let outcome: PlanFeedbackRecoveryOutcome;
      const attemptCancellation = new AbortController();
      this.attemptCancellation = attemptCancellation;
      const attemptTimeout = setTimeout(() => {
        attemptCancellation.abort(new DOMException(
          `Plan feedback recovery attempt exceeded ${this.attemptTimeoutMs}ms.`,
          "TimeoutError"
        ));
      }, this.attemptTimeoutMs);
      attemptTimeout.unref();
      try {
        const recovery = Promise.resolve(this.options.recoverCandidate(candidate, {
          signal: attemptCancellation.signal,
          scheduleOnce: async schedule => {
            if (attemptCancellation.signal.aborted
              || !this.isCurrent(generation)
              || this.attempted.has(key)) return false;
            this.attempted.add(key);
            try {
              await schedule();
              if (attemptCancellation.signal.aborted) throw attemptCancellation.signal.reason;
              return true;
            } catch (error) {
              this.attempted.delete(key);
              throw error;
            }
          }
        }));
        outcome = await waitForAbortable(recovery, attemptCancellation.signal);
      } catch (error) {
        if (!this.isCurrent(generation)) return;
        deferred += 1;
        const circuit = this.failureCircuits.recordFailure(key, error);
        nextRetryDelayMs = Math.min(nextRetryDelayMs ?? Number.POSITIVE_INFINITY, circuit.delayMs);
        const event = {
          reason,
          stage: "candidate" as const,
          error,
          recoveryKey: key,
          circuit
        };
        if (circuit.shouldReport) await this.publishError(event, generation);
        if (circuit.incidentOpened) await this.publishIncident(event, generation);
        continue;
      } finally {
        clearTimeout(attemptTimeout);
        if (this.attemptCancellation === attemptCancellation) this.attemptCancellation = undefined;
      }

      if (!this.isCurrent(generation)) return;
      if (outcome.state === "delivered") {
        this.deferredUntil.delete(key);
        this.failureCircuits.recordSuccess(key);
        delivered += 1;
      } else if (outcome.state === "scheduled") {
        this.deferredUntil.delete(key);
        this.failureCircuits.recordSuccess(key);
        scheduled += 1;
      } else if (outcome.state === "failed") {
        deferred += 1;
        const circuit = this.failureCircuits.recordFailure(key, outcome.error);
        nextRetryDelayMs = Math.min(nextRetryDelayMs ?? Number.POSITIVE_INFINITY, circuit.delayMs);
        const event = {
          reason,
          stage: "candidate" as const,
          error: outcome.error,
          recoveryKey: key,
          circuit
        };
        if (circuit.shouldReport) await this.publishError(event, generation);
        if (circuit.incidentOpened) {
          await this.publishIncident(event, generation);
        }
      } else {
        deferred += 1;
        this.failureCircuits.recordSuccess(key);
        const retryAt = this.now() + this.retryDelayMs;
        this.deferredUntil.set(key, retryAt);
        nextRetryDelayMs = Math.min(nextRetryDelayMs ?? Number.POSITIVE_INFINITY, this.retryDelayMs);
      }
    }

    if (!this.isCurrent(generation)) return;
    await this.options.onSummary({
      reason,
      candidates: candidates.length,
      delivered,
      scheduled,
      deferred,
      alreadyAttempted
    });
    if (this.isCurrent(generation) && deferred > 0) {
      this.queue("deferred delivery readback", nextRetryDelayMs ?? this.retryDelayMs);
    }
  }

  private async publishError(
    event: PlanFeedbackRecoveryErrorEvent,
    generation: number
  ): Promise<void> {
    if (!this.isCurrent(generation)) return;
    await this.options.onError(event);
  }

  private async publishIncident(
    event: PlanFeedbackRecoveryErrorEvent,
    generation: number
  ): Promise<void> {
    if (!this.isCurrent(generation)) return;
    await this.options.onIncident?.(event);
  }

  private isCurrent(generation: number): boolean {
    return this.active && !this.stopped && this.generation === generation;
  }
}
