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
    const definitions = this.callbacks.loadDefinitions();
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
    for (const runtime of [...this.store.values()]) {
      const id = runtime.definition.id;
      switch (this.callbacks.reconcileAction(runtime)) {
        case "start":
          this.start(id);
          break;
        case "stop":
          this.stop(id);
          break;
        case "restart":
          this.restart(id);
          break;
        case "none":
          break;
      }
    }
  }

  start(id: string): boolean {
    const runtime = this.requireRuntime(id);
    if (this.callbacks.isRunning(runtime)) return false;

    this.callbacks.startRuntime(runtime);
    runtime.needsRestart = false;
    return true;
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
    for (const runtime of [...this.store.values()]) {
      runtime.needsRestart = false;
      if (this.callbacks.isRunning(runtime)) {
        this.callbacks.stopRuntime(runtime);
      }
    }
  }

  private requireRuntime(id: string): TRuntime {
    const runtime = this.store.get(id);
    if (!runtime) throw new Error(`Gateway runtime not found: ${id}`);
    return runtime;
  }
}
