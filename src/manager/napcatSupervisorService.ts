export type NapcatSupervisorServiceOptions<Result> = {
  run: (signal: AbortSignal) => Promise<Result>;
  onResult?: (result: Result) => void;
  onError?: (error: unknown) => void;
};

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
      .then(() => this.options.run(controller.signal))
      .then(result => {
        if (this.active && this.generation === generation) this.options.onResult?.(result);
      })
      .catch(error => {
        if (this.active && this.generation === generation) this.options.onError?.(error);
      })
      .finally(() => {
        if (this.generation === generation && this.flight === flight) this.flight = undefined;
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
