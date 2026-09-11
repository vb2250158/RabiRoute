import { AsyncLocalStorage } from "node:async_hooks";
import { retainHotPatchResult } from "./hotPatchIterator.js";

export type AutomaticCodeDefinition = Readonly<{
  moduleId: string;
  sourceHash: string;
  shapeHash: string;
  implementations: Readonly<Record<string, string>>;
}>;
type Callable = (...arguments_: unknown[]) => unknown;
type Module = { definition: AutomaticCodeDefinition; evaluate: (source: string) => unknown; initial: ReadonlyMap<string, Callable> };
type Revision = { sequence: number; definitions: ReadonlyMap<string, AutomaticCodeDefinition>; functions: Map<string, ReadonlyMap<string, Callable>>; leases: number };
type ExecutionScope = { revision: Revision; active: boolean; holds: number; boundary?: ExecutionScope };

export class AutomaticCodeRuntime {
  private readonly modules = new Map<string, Module>();
  private readonly context = new AsyncLocalStorage<ExecutionScope>();
  private current: Revision = { sequence: 0, definitions: new Map(), functions: new Map(), leases: 0 };
  private previous?: Revision;
  private readonly revisions = new Set<Revision>([this.current]);

  private hold(scope: ExecutionScope): () => void {
    scope.holds++;
    scope.revision.leases++;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      scope.holds--;
      scope.revision.leases--;
      if (scope.holds === 0) scope.active = false;
      this.collect();
    };
  }

  acquireBoundary() {
    const scope: ExecutionScope = { revision: this.current, active: true, holds: 0 };
    scope.boundary = scope;
    const release = this.hold(scope);
    return { revision: scope.revision.sequence, release, run: <Result>(operation: () => Result): Result => this.context.run(scope, operation) };
  }

  trackOperation<Result>(operation: Promise<Result>): Promise<Result> {
    const inherited = this.context.getStore();
    const scope = inherited?.boundary ?? inherited;
    if (!scope?.active) return operation;
    const release = this.hold(scope);
    void operation.then(release, release);
    return operation;
  }

  register(definition: AutomaticCodeDefinition, evaluate: (source: string) => unknown) {
    definition = structuredClone(definition);
    const existing = this.modules.get(definition.moduleId);
    if (existing && existing.definition.sourceHash !== definition.sourceHash) throw new Error(`Duplicate automatic module baseline: ${definition.moduleId}`);
    if (!existing) this.modules.set(definition.moduleId, { definition, evaluate, initial: this.prepare(definition, evaluate) });
    return { invoke: (symbol: string, receiver: unknown, arguments_: ArrayLike<unknown>) => this.invoke(definition.moduleId, symbol, receiver, arguments_) };
  }

  private prepare(definition: AutomaticCodeDefinition, evaluate: (source: string) => unknown): ReadonlyMap<string, Callable> {
    const functions = new Map<string, Callable>();
    for (const [id, source] of Object.entries(definition.implementations)) {
      const value = evaluate(`(${source}\n)`);
      if (typeof value !== "function") throw new Error(`Invalid automatic implementation: ${definition.moduleId}/${id}`);
      functions.set(id, value as Callable);
    }
    return functions;
  }

  private invoke(moduleId: string, symbol: string, receiver: unknown, arguments_: ArrayLike<unknown>): unknown {
    const inherited = this.context.getStore();
    const active = inherited?.active ? inherited : inherited?.boundary?.active ? inherited.boundary : undefined;
    const revision = active?.revision ?? this.current;
    const scope: ExecutionScope = { revision, active: true, holds: 0, boundary: active?.boundary };
    const release = this.hold(scope);
    const run = <Result>(operation: () => Result): Result => this.context.run(scope, operation);
    try {
      const module = this.modules.get(moduleId)!;
      let functions = revision.functions.get(moduleId);
      if (!functions) {
        const definition = revision.definitions.get(moduleId);
        if (definition && definition.shapeHash !== module.definition.shapeHash) throw new Error(`Automatic code shape changed: ${moduleId}`);
        functions = definition ? this.prepare(definition, module.evaluate) : module.initial;
        revision.functions.set(moduleId, functions);
      }
      const implementation = functions.get(symbol);
      if (!implementation) throw new Error(`Unknown automatic code symbol: ${moduleId}/${symbol}`);
      const result = run(() => Reflect.apply(implementation, receiver, Array.from(arguments_)));
      return retainHotPatchResult(result, { revision: revision.sequence, contract: {}, run, release });
    } catch (error) { release(); throw error; }
  }

  prepareBatch(definitions: readonly AutomaticCodeDefinition[], expectedRevision: number): () => number {
    if (expectedRevision !== this.current.sequence) throw new Error("Automatic code revision changed before preparation.");
    this.collect();
    if (this.revisions.size >= 32) throw new Error("Automatic code revisions are pinned by in-flight work.");
    const identities = new Set<string>();
    const pending = new Map(this.current.definitions);
    const functions = new Map(this.current.functions);
    for (const supplied of definitions) {
      const definition = structuredClone(supplied);
      if (identities.has(definition.moduleId)) throw new Error(`Duplicate automatic code candidate: ${definition.moduleId}`);
      identities.add(definition.moduleId);
      const module = this.modules.get(definition.moduleId);
      const baseline = module?.definition ?? pending.get(definition.moduleId);
      if (baseline && (baseline.shapeHash !== definition.shapeHash
        || Object.keys(baseline.implementations).sort().join("\0") !== Object.keys(definition.implementations).sort().join("\0"))) {
        throw new Error(`Automatic code requires a controlled switch: ${definition.moduleId}: imports, exports, signatures, initializers or unsupported bodies changed.`);
      }
      pending.set(definition.moduleId, definition);
      if (module) functions.set(definition.moduleId, this.prepare(definition, module.evaluate));
    }
    let committed = false;
    return () => {
      if (committed || expectedRevision !== this.current.sequence) throw new Error("Automatic code prepared revision is stale.");
      this.collect();
      if (this.revisions.size >= 32) throw new Error("Automatic code revisions are pinned by in-flight work.");
      committed = true;
      this.previous = this.current;
      this.current = { sequence: expectedRevision + 1, definitions: pending, functions, leases: 0 };
      this.revisions.add(this.current);
      this.collect();
      return this.current.sequence;
    };
  }

  private collect(): void {
    for (const revision of this.revisions) if (revision !== this.current && revision !== this.previous && revision.leases === 0) this.revisions.delete(revision);
  }

  snapshot() {
    return { revision: this.current.sequence, modules: [...this.modules.keys()], retained: [...this.revisions].map(revision => ({ revision: revision.sequence, leases: revision.leases })) };
  }
}

export const automaticCodeRuntime = new AutomaticCodeRuntime();
export function registerAutomaticCode(moduleId: string, definition: AutomaticCodeDefinition, evaluate: (source: string) => unknown) {
  if (moduleId !== definition.moduleId) throw new Error("Automatic code module identity mismatch.");
  return automaticCodeRuntime.register(definition, evaluate);
}
