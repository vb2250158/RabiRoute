import type {
  PlanFeedbackRecoveryCandidate,
  PlanFeedbackRecoveryOutcome
} from "./planFeedbackRecovery.js";

export const PLAN_FEEDBACK_RECOVERY_RETRY_MS = 15_000;

type MaybePromise<T> = T | Promise<T>;

export type PlanFeedbackRecoveryScheduleControls = {
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
};

export type PlanFeedbackRecoveryServiceOptions = {
  retryDelayMs?: number;
  listCandidates(): MaybePromise<readonly PlanFeedbackRecoveryCandidate[]>;
  recoverCandidate(
    candidate: PlanFeedbackRecoveryCandidate,
    controls: PlanFeedbackRecoveryScheduleControls
  ): MaybePromise<PlanFeedbackRecoveryOutcome>;
  onSummary(summary: PlanFeedbackRecoverySweepSummary): MaybePromise<void>;
  onError(event: PlanFeedbackRecoveryErrorEvent): MaybePromise<void>;
};

function recoveryKey(candidate: PlanFeedbackRecoveryCandidate): string {
  return `${candidate.roleId}:${candidate.plan.id}:${candidate.feedback.id}`;
}

export class PlanFeedbackRecoveryService {
  private readonly attempted = new Set<string>();
  private readonly retryDelayMs: number;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private currentSweep: Promise<void> | undefined;
  private pendingReason: string | undefined;
  private active = false;
  private stopped = false;
  private generation = 0;

  constructor(private readonly options: PlanFeedbackRecoveryServiceOptions) {
    this.retryDelayMs = Math.max(0, options.retryDelayMs ?? PLAN_FEEDBACK_RECOVERY_RETRY_MS);
  }

  start(reason: string): Promise<void> {
    if (this.stopped) return Promise.resolve();
    this.active = true;
    return this.requestSweep(reason);
  }

  allowRetry(roleId: string, planId: string, feedbackId: string): void {
    this.attempted.delete(`${roleId}:${planId}:${feedbackId}`);
  }
  queue(reason: string, delayMs = this.retryDelayMs): boolean {
    if (!this.active || this.stopped || this.timer) return false;

    const generation = this.generation;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      if (!this.isCurrent(generation)) return;
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
      if (this.timer) clearTimeout(this.timer);
      this.timer = undefined;
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
    const sweep = this.runSweep(reason, generation);
    this.currentSweep = sweep;
    void sweep.then(
      () => this.finishSweep(sweep, generation),
      () => this.finishSweep(sweep, generation)
    );
    return sweep;
  }

  private finishSweep(sweep: Promise<void>, generation: number): void {
    if (this.currentSweep !== sweep) return;
    this.currentSweep = undefined;
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

  private async runSweep(reason: string, generation: number): Promise<void> {
    let candidates: readonly PlanFeedbackRecoveryCandidate[];
    try {
      candidates = await this.options.listCandidates();
    } catch (error) {
      if (!this.isCurrent(generation)) return;
      await this.publishError({ reason, stage: "scan", error }, generation);
      if (this.isCurrent(generation)) {
        this.queue("recovery scan retry");
      }
      return;
    }

    if (!this.isCurrent(generation)) return;

    let delivered = 0;
    let scheduled = 0;
    let deferred = 0;
    let alreadyAttempted = 0;

    for (const candidate of candidates) {
      if (!this.isCurrent(generation)) return;
      const key = recoveryKey(candidate);
      if (this.attempted.has(key)) {
        alreadyAttempted += 1;
        continue;
      }

      let outcome: PlanFeedbackRecoveryOutcome;
      try {
        outcome = await this.options.recoverCandidate(candidate, {
          scheduleOnce: async schedule => {
            if (!this.isCurrent(generation) || this.attempted.has(key)) return false;
            this.attempted.add(key);
            try {
              await schedule();
              return true;
            } catch (error) {
              this.attempted.delete(key);
              throw error;
            }
          }
        });
      } catch (error) {
        if (!this.isCurrent(generation)) return;
        deferred += 1;
        await this.publishError({
          reason,
          stage: "candidate",
          error,
          recoveryKey: key
        }, generation);
        continue;
      }

      if (!this.isCurrent(generation)) return;
      if (outcome.state === "delivered") {
        delivered += 1;
      } else if (outcome.state === "scheduled") {
        scheduled += 1;
      } else {
        deferred += 1;
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
      this.queue("deferred delivery readback");
    }
  }

  private async publishError(
    event: PlanFeedbackRecoveryErrorEvent,
    generation: number
  ): Promise<void> {
    if (!this.isCurrent(generation)) return;
    await this.options.onError(event);
  }

  private isCurrent(generation: number): boolean {
    return this.active && !this.stopped && this.generation === generation;
  }
}
