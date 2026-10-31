import { getTimeoutMs } from "./runtimeTimeouts.js";
import type { PluginEffectDisposer, PluginEffectStarter } from "./types.js";
import { setImmediate as yieldToEventLoop } from "node:timers/promises";

type PendingEffect = Readonly<{ starter: PluginEffectStarter; label: string }>;
type ActiveEffect = Readonly<{ disposer: PluginEffectDisposer; label: string }>;

export class EffectScope {
  readonly #pending: PendingEffect[] = [];
  readonly #active: ActiveEffect[] = [];
  readonly #controller = new AbortController();
  #committed = false;
  #disposed = false;
  #disposal?: Promise<void>;
  readonly #unsettledDisposers = new Set<Promise<void>>();
  readonly #unsettledOperations = new Set<Promise<unknown>>();
  readonly #retirementWaiters = new Set<() => void>();
  #disposalFinished = false;
  #retirementFailed = false;
  #retirementUnconfirmedReason?: unknown;

  constructor(private readonly options: Readonly<{ disposalTimeoutMs?: number; operationTimeoutMs?: number }> = {}) {}

  add(starter: PluginEffectStarter, label = "plugin effect"): void {
    if (this.#committed || this.#disposed || this.#controller.signal.aborted) throw new Error("Plugin effect scope is already closed.");
    this.#pending.push(Object.freeze({ starter, label }));
  }
  adopt(disposer: PluginEffectDisposer, label = "adopted plugin resource"): void {
    if (typeof disposer !== "function") throw new Error("Plugin effect disposer must be a function.");
    if (this.#disposed || this.#controller.signal.aborted) {
      // A resource acquired by an operation that completed after cancellation
      // still belongs to this scope and must not escape its retirement fence.
      void this.#disposeEffect({ disposer, label }).catch(() => {});
      throw new Error("Plugin effect scope is already closed.");
    }
    this.#active.push(Object.freeze({ disposer, label }));
  }
  signal(): AbortSignal { return this.#controller.signal; }
  abort(error: unknown): void { this.#controller.abort(error); }
  markRetirementUnconfirmed(error: unknown): void {
    this.#retirementFailed = true;
    this.#retirementUnconfirmedReason = error;
    this.#retirementChanged();
  }

  async run<T>(label: string, operation: () => T | Promise<T>): Promise<T> {
    if (this.#disposed) throw new Error("Plugin effect scope is disposed.");
    this.#controller.signal.throwIfAborted();
    // A chain of already-resolved lifecycle promises must not monopolize the
    // microtask queue while unrelated HTTP, cancellation and health work waits.
    const completion = yieldToEventLoop(undefined, { signal: this.#controller.signal }).then(() => {
      this.#controller.signal.throwIfAborted();
      // Queued phases own no resources and cannot enter after cancellation.
      // Track only work that actually entered its owner's callback.
      this.#unsettledOperations.add(completion);
      // Trusted native owners must complete their own synchronous transaction/finally.
      return operation();
    }, error => { this.#controller.signal.throwIfAborted(); throw error; });
    void completion.then(
      () => { this.#unsettledOperations.delete(completion); this.#retirementChanged(); },
      () => { this.#unsettledOperations.delete(completion); this.#retirementChanged(); }
    );
    let timer: NodeJS.Timeout | undefined;
    let cancelled: (() => void) | undefined;
    const timeoutMs = Math.max(1, Math.floor(this.options.operationTimeoutMs ?? getTimeoutMs("plugin.operation", 30_000)));
    try {
      const result = await Promise.race([
        completion,
        new Promise<never>((_, reject) => {
          cancelled = () => reject(this.#controller.signal.reason);
          this.#controller.signal.addEventListener("abort", cancelled, { once: true });
          if (this.#controller.signal.aborted) cancelled();
        }),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            const error = new Error(`Plugin ${label} timed out after ${timeoutMs}ms.`);
            this.#controller.abort(error);
            reject(error);
          }, timeoutMs);
        })
      ]);
      this.#controller.signal.throwIfAborted();
      return result;
    } finally {
      if (timer) clearTimeout(timer);
      if (cancelled) this.#controller.signal.removeEventListener("abort", cancelled);
    }
  }
  async commit(): Promise<void> {
    if (this.#disposed) throw new Error("Plugin effect scope is disposed.");
    if (this.#committed) return;
    try {
      for (const effect of this.#pending) {
        await this.run(`effect startup (${effect.label})`, async () => {
          const disposer = await effect.starter();
          if (typeof disposer !== "function") throw new Error(`Plugin effect did not return a disposer: ${effect.label}.`);
          if (this.#disposed || this.#controller.signal.aborted) {
            await this.#disposeEffect({ disposer, label: effect.label });
            this.#controller.signal.throwIfAborted();
            throw new Error("Plugin effect scope is disposed.");
          }
          this.#active.push(Object.freeze({ disposer, label: effect.label }));
        });
      }
      this.#committed = true;
    } catch (error) {
      await this.dispose().catch(() => {});
      throw error;
    }
  }
  dispose(): Promise<void> {
    return this.#disposal ??= this.#disposeNow();
  }
  /** A bounded disposal rejection is not proof that its owner has stopped. */
  retirementConfirmed(): boolean {
    return this.#disposalFinished && !this.#unsettledDisposers.size && !this.#unsettledOperations.size && !this.#retirementFailed;
  }
  /** Application shutdown may join actual owners after ordinary disposal's budget expired. */
  async waitForRetirement(options: Readonly<{ timeoutMs?: number }> = {}): Promise<void> {
    if (!this.#disposal) throw new Error("Plugin effect scope has not started retirement.");
    const timeoutMs = options.timeoutMs ?? getTimeoutMs("backend.plugin-kernel.effectScope.waitForRetirement.timeoutMs", 15_000);
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) throw new RangeError("Plugin retirement join timeout must be a positive safe integer.");
    const deadlineAt = performance.now() + timeoutMs;
    for (;;) {
      const remaining = deadlineAt - performance.now();
      if (remaining <= 0) throw new Error(`Plugin retirement confirmation timed out after ${timeoutMs}ms.`);
      if (this.retirementConfirmed()) return;
      if (this.#disposalFinished && !this.#unsettledDisposers.size && !this.#unsettledOperations.size) {
        throw new Error("Plugin retirement is unconfirmed: resource cleanup or publication rollback failed.", { cause: this.#retirementUnconfirmedReason });
      }
      await new Promise<void>((resolve, reject) => {
        const changed = () => { clearTimeout(timer); this.#retirementWaiters.delete(changed); resolve(); };
        const timer = setTimeout(() => {
          this.#retirementWaiters.delete(changed);
          reject(new Error(`Plugin retirement confirmation timed out after ${timeoutMs}ms.`));
        }, remaining);
        this.#retirementWaiters.add(changed);
      });
    }
  }

  #retirementChanged(): void {
    for (const changed of [...this.#retirementWaiters]) changed();
  }
  async #disposeNow(): Promise<void> {
    this.#disposed = true;
    this.#controller.abort();
    let firstError: unknown;
    for (const effect of [...this.#active].reverse()) {
      try { await this.#disposeEffect(effect); }
      catch (error) { firstError ??= error; }
    }
    this.#active.length = 0;
    this.#pending.length = 0;
    this.#disposalFinished = true;
    this.#retirementChanged();
    if (firstError) throw firstError;
    if (this.#retirementFailed) throw new Error("Plugin retirement is unconfirmed: resource cleanup or publication rollback did not complete.", { cause: this.#retirementUnconfirmedReason });
    if (this.#unsettledOperations.size) throw new Error("Plugin retirement is unconfirmed: lifecycle operations are still running.");
  }

  async #disposeEffect(effect: ActiveEffect): Promise<void> {
      let timer: NodeJS.Timeout | undefined;
      try {
        const timeoutMs = Math.max(1, Math.floor(this.options.disposalTimeoutMs ?? getTimeoutMs("plugin.disposal", 5_000)));
        const completion = Promise.resolve().then(effect.disposer);
        this.#unsettledDisposers.add(completion);
        this.#retirementChanged();
        void completion.then(() => { this.#unsettledDisposers.delete(completion); this.#retirementChanged(); }, error => {
          this.#retirementFailed = true;
          this.#retirementUnconfirmedReason ??= error;
          this.#unsettledDisposers.delete(completion);
          this.#retirementChanged();
        });
        await Promise.race([
          completion,
          new Promise<never>((_resolve, reject) => {
            timer = setTimeout(() => reject(new Error(
              `Plugin effect disposal timed out: ${effect.label} after ${timeoutMs}ms.`
            )), timeoutMs);
          })
        ]);
      } finally {
        if (timer) clearTimeout(timer);
      }
  }
}
