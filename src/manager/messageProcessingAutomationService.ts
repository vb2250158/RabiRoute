import type { AgentRequestRecord } from "../agentRequests/store.js";

export const MESSAGE_PROCESSING_AUTOMATION_MAX_DELAY_MS = 2_147_000_000;

type AutomationTimer = ReturnType<typeof setTimeout>;

export type MessageProcessingAutomationServiceOptions = {
  listExistingRequests: () => Iterable<AgentRequestRecord>;
  getRequest: (requestId: string) => AgentRequestRecord | undefined;
  deliverReminder: (request: AgentRequestRecord) => void | Promise<void>;
  onError?: (request: AgentRequestRecord, error: unknown) => void | Promise<void>;
  now?: () => number;
  scheduleTimer?: (callback: () => void, delayMs: number) => AutomationTimer;
  clearTimer?: (timer: AutomationTimer) => void;
};

type ScheduledReminder = {
  generation: number;
  timer: AutomationTimer;
};

export class MessageProcessingAutomationService {
  private readonly timers = new Map<string, ScheduledReminder>();
  private readonly inFlight = new Map<string, number>();
  private readonly flights = new Set<Promise<void>>();
  private readonly now: () => number;
  private readonly scheduleTimer: (callback: () => void, delayMs: number) => AutomationTimer;
  private readonly clearTimer: (timer: AutomationTimer) => void;
  private active = false;
  private generation = 0;

  constructor(private readonly options: MessageProcessingAutomationServiceOptions) {
    this.now = options.now ?? Date.now;
    this.scheduleTimer = options.scheduleTimer ?? ((callback, delayMs) => setTimeout(callback, delayMs));
    this.clearTimer = options.clearTimer ?? clearTimeout;
  }

  start(): void {
    if (this.active) return;
    this.active = true;
    const generation = ++this.generation;
    try {
      for (const request of this.options.listExistingRequests()) {
        this.arm(request, generation);
      }
    } catch (error) {
      this.stop();
      throw error;
    }
  }

  async stop(): Promise<void> {
    this.active = false;
    this.generation += 1;
    for (const scheduled of this.timers.values()) {
      this.clearTimer(scheduled.timer);
    }
    this.timers.clear();
    const flights = [...this.flights];
    if (flights.length) await Promise.allSettled(flights);
    this.inFlight.clear();
  }

  schedule(request: AgentRequestRecord): void {
    if (!this.active) return;
    this.arm(request, this.generation);
  }
  refresh(): void {
    if (!this.active) return;
    const generation = this.generation;
    const current = new Map<string, AgentRequestRecord>();
    for (const request of this.options.listExistingRequests()) current.set(request.id, request);
    for (const requestId of [...this.timers.keys()]) {
      if (!current.has(requestId)) this.cancelTimer(requestId);
    }
    for (const request of current.values()) this.arm(request, generation);
  }

  private arm(request: AgentRequestRecord, generation: number): void {
    if (!this.isCurrent(generation)) return;
    this.cancelTimer(request.id);
    if (!this.schedulable(request)) return;
    if (this.inFlight.get(request.id) === generation) return;

    const triggerAt = Date.parse(request.nextReminderAt!);
    const delayMs = Math.min(
      Math.max(0, triggerAt - this.now()),
      MESSAGE_PROCESSING_AUTOMATION_MAX_DELAY_MS
    );
    let timer!: AutomationTimer;
    timer = this.scheduleTimer(() => {
      const scheduled = this.timers.get(request.id);
      if (!scheduled || scheduled.timer !== timer || scheduled.generation !== generation) return;
      this.timers.delete(request.id);
      if (!this.isCurrent(generation)) return;
      const flight = this.runReminder(request, generation);
      this.flights.add(flight);
      void flight.finally(() => this.flights.delete(flight));
    }, delayMs);
    timer.unref?.();
    this.timers.set(request.id, { generation, timer });
  }

  private async runReminder(scheduledRequest: AgentRequestRecord, generation: number): Promise<void> {
    if (!this.isCurrent(generation)) return;

    let request: AgentRequestRecord | undefined;
    try {
      request = this.options.getRequest(scheduledRequest.id);
    } catch (error) {
      await this.reportError(scheduledRequest, error, generation);
      return;
    }
    if (!request || !this.schedulable(request)) return;

    const triggerAt = Date.parse(request.nextReminderAt!);
    if (triggerAt > this.now()) {
      this.arm(request, generation);
      return;
    }

    this.inFlight.set(request.id, generation);
    try {
      await this.options.deliverReminder(request);
    } catch (error) {
      await this.reportError(request, error, generation);
    } finally {
      if (this.inFlight.get(request.id) === generation) this.inFlight.delete(request.id);
    }

    if (!this.isCurrent(generation)) return;
    try {
      const latest = this.options.getRequest(request.id);
      if (latest) this.arm(latest, generation);
    } catch (error) {
      await this.reportError(request, error, generation);
    }
  }

  private async reportError(
    request: AgentRequestRecord,
    error: unknown,
    generation: number
  ): Promise<void> {
    if (!this.isCurrent(generation) || !this.options.onError) return;
    try {
      await this.options.onError(request, error);
    } catch {
      // Error reporting must not create an unhandled timer callback rejection.
    }
  }

  private schedulable(request: AgentRequestRecord): boolean {
    return request.status === "awaiting_response"
      && Boolean(request.nextReminderAt)
      && Number.isFinite(Date.parse(request.nextReminderAt || ""));
  }

  private cancelTimer(requestId: string): void {
    const scheduled = this.timers.get(requestId);
    if (!scheduled) return;
    this.clearTimer(scheduled.timer);
    this.timers.delete(requestId);
  }

  private isCurrent(generation: number): boolean {
    return this.active && generation === this.generation;
  }
}
