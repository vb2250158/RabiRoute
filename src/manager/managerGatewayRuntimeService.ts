export type GatewayRuntimeReconcileAction = "none" | "start" | "stop" | "restart";

export type ManagerGatewayRuntimeRecord<TDefinition extends { id: string }> = {
  definition: TDefinition;
  needsRestart: boolean;
};

export type ManagerGatewayRuntimeStore<TRuntime> = {
  get(id: string): TRuntime | undefined;
  values(): Iterable<TRuntime>;
  keys(): Iterable<string>;
  set(id: string, runtime: TRuntime): unknown;
  delete(id: string): unknown;
};

export type ManagerGatewayRuntimeServiceCallbacks<
  TDefinition extends { id: string },
  TRuntime extends ManagerGatewayRuntimeRecord<TDefinition>
> = {
  loadDefinitions(): readonly TDefinition[];
  normalizeDefinition(definition: TDefinition): TDefinition;
  definitionFingerprint(definition: TDefinition): string;
  createRuntime(definition: TDefinition): TRuntime;
  isRunning(runtime: TRuntime): boolean;
  reconcileAction(runtime: TRuntime): GatewayRuntimeReconcileAction;
  startRuntime(runtime: TRuntime): void;
  stopRuntime(runtime: TRuntime): void;
  restartRuntime?(runtime: TRuntime): void;
  onRuntimeError?(runtime: TRuntime, error: unknown, action: "reconcile" | "start" | "stop" | "restart"): void;
};

export class ManagerGatewayRuntimeService<
  TDefinition extends { id: string },
  TRuntime extends ManagerGatewayRuntimeRecord<TDefinition>
> {
  constructor(
    private readonly store: ManagerGatewayRuntimeStore<TRuntime>,
    private readonly callbacks: ManagerGatewayRuntimeServiceCallbacks<TDefinition, TRuntime>
  ) {}

  load(): void {
    this.loadDefinitions(this.callbacks.loadDefinitions());
  }

  loadDefinitions(definitions: readonly TDefinition[]): void {
    const seen = new Set<string>();

    for (const rawDefinition of definitions) {
      const definition = this.callbacks.normalizeDefinition(rawDefinition);
      const id = definition.id;
      seen.add(id);

      const existing = this.store.get(id);
      if (!existing) {
        this.store.set(id, this.callbacks.createRuntime(definition));
        continue;
      }

      if (
        this.callbacks.definitionFingerprint(existing.definition)
        !== this.callbacks.definitionFingerprint(definition)
      ) {
        existing.needsRestart = true;
      }
      existing.definition = definition;
    }

    for (const id of [...this.store.keys()]) {
      if (seen.has(id)) continue;
      const runtime = this.store.get(id);
      if (runtime) {
        runtime.needsRestart = false;
        if (this.callbacks.isRunning(runtime)) {
          this.callbacks.stopRuntime(runtime);
        }
      }
      this.store.delete(id);
    }
  }

  reconcile(): void {
    const unreported: unknown[] = [];
    for (const runtime of [...this.store.values()]) {
      let action: "reconcile" | "start" | "stop" | "restart" = "reconcile";
      try {
        const id = runtime.definition.id;
        const requested = this.callbacks.reconcileAction(runtime);
        if (requested === "none") continue;
        action = requested;
        switch (requested) {
          case "start":
            this.start(id);
            break;
          case "stop":
            this.stop(id);
            break;
          case "restart":
            this.restart(id);
            break;
        }
      } catch (error) {
        unreported.push(...this.reportRuntimeError(runtime, error, action));
      }
    }
    if (unreported.length) throw new AggregateError(unreported, "Gateway runtime reconciliation has unreported failures.");
  }

  start(id: string): boolean {
    const runtime = this.requireRuntime(id);
    if (this.callbacks.isRunning(runtime)) return false;

    this.callbacks.startRuntime(runtime);
    runtime.needsRestart = false;
    return true;
  }

  /** One already-requested background restart must not reconcile other Routes or throw into an EventEmitter. */
  startInBackground(id: string): readonly unknown[] {
    let runtime: TRuntime | undefined;
    try {
      runtime = this.requireRuntime(id);
      this.start(id);
      return [];
    } catch (error) {
      return runtime ? this.reportRuntimeError(runtime, error, "start") : [error];
    }
  }

  stop(id: string): boolean {
    const runtime = this.requireRuntime(id);
    runtime.needsRestart = false;
    if (!this.callbacks.isRunning(runtime)) return false;

    this.callbacks.stopRuntime(runtime);
    return true;
  }

  restart(id: string): boolean {
    const runtime = this.requireRuntime(id);
    if (this.callbacks.restartRuntime) {
      this.callbacks.restartRuntime(runtime);
      return true;
    }
    runtime.needsRestart = false;
    if (this.callbacks.isRunning(runtime)) {
      this.callbacks.stopRuntime(runtime);
    }
    this.callbacks.startRuntime(runtime);
    return true;
  }

  stopAll(): void {
    const failures: unknown[] = [];
    for (const runtime of [...this.store.values()]) {
      try {
        runtime.needsRestart = false;
        if (this.callbacks.isRunning(runtime)) this.callbacks.stopRuntime(runtime);
      } catch (error) {
        failures.push(error);
        try { this.callbacks.onRuntimeError?.(runtime, error, "stop"); }
        catch (reportError) { failures.push(reportError); }
      }
    }
    if (failures.length) throw new AggregateError(failures, "Some Gateway runtimes could not be stopped.");
  }

  private requireRuntime(id: string): TRuntime {
    const runtime = this.store.get(id);
    if (!runtime) throw new Error(`Gateway runtime not found: ${id}`);
    return runtime;
  }

  private reportRuntimeError(runtime: TRuntime, error: unknown, action: "reconcile" | "start" | "stop" | "restart"): readonly unknown[] {
    if (!this.callbacks.onRuntimeError) return [error];
    try { this.callbacks.onRuntimeError(runtime, error, action); return []; }
    catch (reportError) { return [error, reportError]; }
  }
}
