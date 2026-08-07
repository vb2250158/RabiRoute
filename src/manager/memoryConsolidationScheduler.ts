export type MemoryConsolidationScheduleTarget = {
  gatewayId: string;
  roleKey: string;
  roleDir: string;
};

export type DueMemoryConsolidationRun = {
  runId: string;
  delivered?: boolean;
};

export type MemoryConsolidationSchedulerOptions = {
  listTargets: () => MemoryConsolidationScheduleTarget[];
  requestDueRun: (target: MemoryConsolidationScheduleTarget) => DueMemoryConsolidationRun | null;
  nextTriggerAt: (target: MemoryConsolidationScheduleTarget) => number | undefined;
  deliver: (target: MemoryConsolidationScheduleTarget, run: DueMemoryConsolidationRun) => void | Promise<void>;
  onError?: (target: MemoryConsolidationScheduleTarget, error: unknown) => void;
  now?: () => number;
  retryDelayMs?: number;
  scheduleDeadline?: (callback: () => void, delayMs: number) => NodeJS.Timeout;
  clearDeadline?: (timer: NodeJS.Timeout) => void;
};

export class MemoryConsolidationScheduler {
  private readonly deliveredRunIds = new Set<string>();
  private readonly now: () => number;
  private readonly retryDelayMs: number;
  private readonly scheduleDeadline: (callback: () => void, delayMs: number) => NodeJS.Timeout;
  private readonly clearDeadline: (timer: NodeJS.Timeout) => void;
  private deadline?: NodeJS.Timeout;
  private running?: Promise<void>;
  private rerunRequested = false;
  private stopped = false;

  constructor(private readonly options: MemoryConsolidationSchedulerOptions) {
    this.now = options.now ?? Date.now;
    this.retryDelayMs = Math.max(1_000, options.retryDelayMs ?? 60_000);
    this.scheduleDeadline = options.scheduleDeadline ?? ((callback, delayMs) => setTimeout(callback, delayMs));
    this.clearDeadline = options.clearDeadline ?? clearTimeout;
  }

  start(): void {
    this.stopped = false;
    void this.runOnce();
  }

  stop(): void {
    this.stopped = true;
    this.cancelDeadline();
  }

  reschedule(): void {
    if (this.stopped) return;
    this.cancelDeadline();
    if (this.running) {
      this.rerunRequested = true;
      return;
    }
    void this.runOnce();
  }

  noteRunCompleted(runId: string): void {
    this.deliveredRunIds.delete(runId);
  }

  runOnce(): Promise<void> {
    if (this.running) return this.running;
    this.running = this.execute().finally(() => {
      this.running = undefined;
      if (this.rerunRequested && !this.stopped) {
        this.rerunRequested = false;
        void this.runOnce();
      }
    });
    return this.running;
  }

  private async execute(): Promise<void> {
    if (this.stopped) return;
    this.cancelDeadline();
    const targets = this.uniqueTargets();
    const pendingByRole = new Map<string, DueMemoryConsolidationRun>();
    let retryAt: number | undefined;

    for (const target of targets) {
      let pending: DueMemoryConsolidationRun | null = null;
      try {
        pending = this.options.requestDueRun(target);
      } catch (error) {
        this.options.onError?.(target, error);
        retryAt = Math.min(retryAt ?? Number.POSITIVE_INFINITY, this.now() + this.retryDelayMs);
        continue;
      }
      if (!pending) continue;
      pendingByRole.set(target.roleKey, pending);
      if (pending.delivered) {
        this.deliveredRunIds.add(pending.runId);
        continue;
      }
      if (this.deliveredRunIds.has(pending.runId)) continue;

      this.deliveredRunIds.add(pending.runId);
      try {
        await this.options.deliver(target, pending);
      } catch (error) {
        this.deliveredRunIds.delete(pending.runId);
        this.options.onError?.(target, error);
        retryAt = Math.min(retryAt ?? Number.POSITIVE_INFINITY, this.now() + this.retryDelayMs);
      }
    }

    let nextAt = retryAt;
    for (const target of targets) {
      const pending = pendingByRole.get(target.roleKey);
      if (pending && this.deliveredRunIds.has(pending.runId)) continue;
      const triggerAt = this.options.nextTriggerAt(target);
      if (!Number.isFinite(triggerAt)) continue;
      nextAt = Math.min(nextAt ?? Number.POSITIVE_INFINITY, Number(triggerAt));
    }
    if (nextAt !== undefined && Number.isFinite(nextAt)) this.armDeadline(nextAt);
  }

  private uniqueTargets(): MemoryConsolidationScheduleTarget[] {
    const result: MemoryConsolidationScheduleTarget[] = [];
    const seen = new Set<string>();
    for (const target of this.options.listTargets()) {
      if (seen.has(target.roleKey)) continue;
      seen.add(target.roleKey);
      result.push(target);
    }
    return result;
  }

  private armDeadline(triggerAt: number): void {
    if (this.stopped) return;
    const delayMs = Math.max(0, triggerAt - this.now());
    this.deadline = this.scheduleDeadline(() => {
      this.deadline = undefined;
      void this.runOnce();
    }, delayMs);
    this.deadline.unref?.();
  }

  private cancelDeadline(): void {
    if (!this.deadline) return;
    this.clearDeadline(this.deadline);
    this.deadline = undefined;
  }
}
