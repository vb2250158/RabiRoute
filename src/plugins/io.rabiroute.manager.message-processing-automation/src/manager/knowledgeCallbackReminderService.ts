export const MAX_KNOWLEDGE_CALLBACK_REMINDER_DELAY_MS = 2_147_000_000;

type MaybePromise<T> = T | Promise<T>;

export type KnowledgeCallbackReminderRecord = {
  id: string;
  knowledgeCallbackDueAt?: string;
};

export type KnowledgeCallbackReminderServiceOptions<
  TRecord extends KnowledgeCallbackReminderRecord,
  TTimer = ReturnType<typeof setTimeout>
> = {
  listExisting(): MaybePromise<readonly TRecord[]>;
  getRecord(id: string): MaybePromise<TRecord | undefined>;
  isPending(record: TRecord): MaybePromise<boolean>;
  deliverReminder(record: TRecord): MaybePromise<void>;
  completeAttempt(record: TRecord, error?: unknown): MaybePromise<TRecord | undefined>;
  onError(error: unknown, record?: TRecord): MaybePromise<void>;
  now?: () => number | Date;
  scheduleTimer?: (callback: () => void | Promise<void>, delayMs: number) => TTimer;
  clearTimer?: (timer: TTimer) => void;
};

type ScheduledTimer<TTimer> = {
  handle: TTimer;
  revision: number;
};

export class KnowledgeCallbackReminderService<
  TRecord extends KnowledgeCallbackReminderRecord,
  TTimer = ReturnType<typeof setTimeout>
> {
  private readonly now: () => number;
  private readonly scheduleTimer: (callback: () => void | Promise<void>, delayMs: number) => TTimer;
  private readonly clearTimer: (timer: TTimer) => void;
  private readonly timers = new Map<string, ScheduledTimer<TTimer>>();
  private readonly revisions = new Map<string, number>();
  private readonly flights = new Set<Promise<void>>();
  private generation = 0;
  private active = false;

  constructor(private readonly options: KnowledgeCallbackReminderServiceOptions<TRecord, TTimer>) {
    this.now = () => {
      const value = options.now?.() ?? Date.now();
      return value instanceof Date ? value.getTime() : value;
    };
    this.scheduleTimer = options.scheduleTimer
      ?? ((callback, delayMs) => setTimeout(callback, delayMs) as TTimer);
    this.clearTimer = options.clearTimer
      ?? (timer => clearTimeout(timer as ReturnType<typeof setTimeout>));
  }

  async start(): Promise<void> {
    if (this.active) return;
    this.active = true;
    const generation = ++this.generation;
    try {
      const records = await this.options.listExisting();
      if (!this.isCurrent(generation)) return;
      await Promise.all(records.map(record => this.scheduleForGeneration(record, generation)));
    } catch (error) {
      if (this.isCurrent(generation)) {
        this.reportError(error);
        this.active = false;
        this.generation += 1;
        for (const timer of this.timers.values()) this.clearTimer(timer.handle);
        this.timers.clear();
      }
      throw error;
    }
  }

  schedule(record: TRecord): Promise<void> {
    return this.scheduleForGeneration(record, this.generation);
  }

  async stop(): Promise<void> {
    this.active = false;
    this.generation += 1;
    for (const timer of this.timers.values()) this.clearTimer(timer.handle);
    this.timers.clear();
    await Promise.allSettled([...this.flights]);
  }

  private async scheduleForGeneration(record: TRecord, generation: number): Promise<void> {
    const revision = this.nextRevision(record.id);
    this.cancelTimer(record.id);
    if (!this.isCurrent(generation)) return;

    let pending: boolean;
    try {
      pending = await this.options.isPending(record);
    } catch (error) {
      if (this.isCurrentSchedule(record.id, generation, revision)) this.reportError(error, record);
      return;
    }
    if (!this.isCurrentSchedule(record.id, generation, revision) || !pending) return;

    const dueAt = this.parseDueAt(record.knowledgeCallbackDueAt);
    if (dueAt === undefined) return;
    const delayMs = Math.min(
      MAX_KNOWLEDGE_CALLBACK_REMINDER_DELAY_MS,
      Math.max(0, dueAt - this.now())
    );
    const handle = this.scheduleTimer(
      () => this.launchTimerFlight(record.id, generation, revision),
      delayMs
    );
    this.timers.set(record.id, { handle, revision });
    const unref = (handle as { unref?: () => void }).unref;
    unref?.call(handle);
  }

  private launchTimerFlight(id: string, generation: number, revision: number): Promise<void> {
    const timer = this.timers.get(id);
    if (timer?.revision === revision) this.timers.delete(id);
    if (!this.isCurrentSchedule(id, generation, revision)) return Promise.resolve();

    const flight = this.runTimerFlight(id, generation);
    this.flights.add(flight);
    void flight.then(
      () => this.flights.delete(flight),
      () => this.flights.delete(flight)
    );
    return flight;
  }

  private async runTimerFlight(id: string, generation: number): Promise<void> {
    if (!this.isCurrent(generation)) return;

    let record: TRecord | undefined;
    try {
      record = await this.options.getRecord(id);
    } catch (error) {
      if (this.isCurrent(generation)) this.reportError(error);
      return;
    }
    if (!this.isCurrent(generation) || !record) return;

    let pending: boolean;
    try {
      pending = await this.options.isPending(record);
    } catch (error) {
      if (this.isCurrent(generation)) this.reportError(error, record);
      return;
    }
    if (!this.isCurrent(generation) || !pending) return;

    const dueAt = this.parseDueAt(record.knowledgeCallbackDueAt);
    if (dueAt === undefined) return;
    if (dueAt > this.now()) {
      await this.scheduleForGeneration(record, generation);
      return;
    }
    if (!this.isCurrent(generation)) return;

    let deliveryError: unknown;
    try {
      await this.options.deliverReminder(record);
    } catch (error) {
      deliveryError = error;
      this.reportError(error, record);
    }

    let completedRecord: TRecord | undefined;
    try {
      completedRecord = await this.options.completeAttempt(record, deliveryError);
    } catch (error) {
      this.reportError(error, record);
      return;
    }

    if (completedRecord && this.isCurrent(generation)) {
      await this.scheduleForGeneration(completedRecord, generation);
    }
  }

  private nextRevision(id: string): number {
    const revision = (this.revisions.get(id) ?? 0) + 1;
    this.revisions.set(id, revision);
    return revision;
  }

  private cancelTimer(id: string): void {
    const timer = this.timers.get(id);
    if (!timer) return;
    this.clearTimer(timer.handle);
    this.timers.delete(id);
  }

  private isCurrent(generation: number): boolean {
    return this.active && generation === this.generation;
  }

  private isCurrentSchedule(id: string, generation: number, revision: number): boolean {
    return this.isCurrent(generation) && this.revisions.get(id) === revision;
  }

  private parseDueAt(value: string | undefined): number | undefined {
    if (!value) return undefined;
    const timestamp = Date.parse(value);
    return Number.isFinite(timestamp) ? timestamp : undefined;
  }

  private reportError(error: unknown, record?: TRecord): void {
    try {
      void Promise.resolve(this.options.onError(error, record)).catch(() => {});
    } catch {
      // Error reporting is best-effort and must not escape timer callbacks or flights.
    }
  }
}
