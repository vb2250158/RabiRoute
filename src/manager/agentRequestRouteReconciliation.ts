/** Coalesces route bookkeeping without making route publication own the shared ledger loader. */
export class AgentRequestRouteReconciliation {
  private dirty = false;
  private stopped = false;
  private flight?: Promise<void>;
  private cancelReadiness?: () => void;

  constructor(private readonly options: { ready(): Promise<void>; reconcile(): Promise<void>; onError(error: unknown): void }) {}

  request(): void {
    if (this.stopped) return;
    this.dirty = true;
    if (this.flight) return;
    this.flight = Promise.resolve().then(async () => {
      if (this.stopped) return;
      try {
        await Promise.race([this.options.ready(), new Promise<void>(resolve => { this.cancelReadiness = resolve; })]);
      } catch (error) {
        this.cancelReadiness = undefined;
        this.dirty = false;
        if (!this.stopped) this.report(error);
        return;
      }
      this.cancelReadiness = undefined;
      while (!this.stopped && this.dirty) {
        this.dirty = false;
        try { await this.options.reconcile(); }
        catch (error) { if (!this.stopped) this.report(error); }
      }
    }).finally(() => {
      this.flight = undefined;
      if (!this.stopped && this.dirty) this.request();
    });
    // The Manager owner joins this actual flight at stop. Observe unexpected
    // failures immediately as well, before application shutdown begins.
    void this.flight.catch(() => {});
  }

  private report(error: unknown): void {
    const reportFailure = () => { console.error(JSON.stringify({ event: "agent_request_route_diagnostic_failed", result: "observer_failed" })); };
    try { void Promise.resolve(this.options.onError(error)).catch(reportFailure); }
    catch { reportFailure(); }
  }

  stopAccepting(): void {
    this.stopped = true;
    this.dirty = false;
    this.cancelReadiness?.();
    this.cancelReadiness = undefined;
  }

  async stop(): Promise<void> {
    this.stopAccepting();
    await this.flight;
  }
}
