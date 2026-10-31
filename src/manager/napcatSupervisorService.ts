export type NapcatSupervisorServiceOptions<Result> = {
  run: (signal: AbortSignal) => Promise<Result>;
  onResult?: (result: Result) => void;
  onError?: (error: unknown) => void;
  /** Long-lived owners may retry failed runs; one-shot callers keep the existing default. */
  restartDelayMs?: number;
  repeatDelayMs?: number | (() => number);
  waitBeforeRestart?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
};

function waitBeforeRestart(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise(resolve => {
    const finish = () => { clearTimeout(timer); signal.removeEventListener("abort", finish); resolve(); };
    const timer = setTimeout(finish, milliseconds);
    timer.unref?.();
    signal.addEventListener("abort", finish, { once: true });
  });
}

export class NapcatSupervisorService<Result = unknown> {
  private active = false;
  private generation = 0;
  private flight: Promise<void> | undefined;
  private controller: AbortController | undefined;

  constructor(private readonly options: NapcatSupervisorServiceOptions<Result>) {}

  start(): Promise<void> {
    if (this.active) return this.flight ?? Promise.resolve();
    this.active = true;
    const generation = ++this.generation;
    const controller = new AbortController();
    this.controller = controller;
    const flight = Promise.resolve()
      .then(async () => {
        while (this.active && this.generation === generation && !controller.signal.aborted) {
          try {
            const result = await this.options.run(controller.signal);
            if (this.active && this.generation === generation) this.options.onResult?.(result);
            if (this.options.repeatDelayMs === undefined) return;
            const delay = typeof this.options.repeatDelayMs === "function" ? this.options.repeatDelayMs() : this.options.repeatDelayMs;
            await (this.options.waitBeforeRestart ?? waitBeforeRestart)(Math.max(1_000, delay), controller.signal);
          } catch (error) {
            if (!this.active || this.generation !== generation || controller.signal.aborted) return;
            this.options.onError?.(error);
            if (this.options.restartDelayMs === undefined) return;
            const delay = Math.max(1_000, this.options.restartDelayMs);
            await (this.options.waitBeforeRestart ?? waitBeforeRestart)(delay, controller.signal);
          }
        }
      })
      .finally(() => {
        if (this.generation === generation && this.flight === flight) {
          this.active = false;
          this.flight = undefined;
        }
        if (this.generation === generation && this.controller === controller) this.controller = undefined;
      });
    this.flight = flight;
    return flight;
  }

  async stop(): Promise<void> {
    if (!this.active && !this.flight) return;
    this.active = false;
    this.generation += 1;
    const controller = this.controller;
    const flight = this.flight;
    controller?.abort();
    if (flight) await flight;
    if (this.flight === flight) this.flight = undefined;
    if (this.controller === controller) this.controller = undefined;
  }

  isActive(): boolean {
    return this.active;
  }
}
