import type { PluginEffectDisposer, PluginEffectStarter } from "./types.js";

type PendingEffect = Readonly<{ starter: PluginEffectStarter; label: string }>;
type ActiveEffect = Readonly<{ disposer: PluginEffectDisposer; label: string }>;

export class EffectScope {
  readonly #pending: PendingEffect[] = [];
  readonly #active: ActiveEffect[] = [];
  readonly #controller = new AbortController();
  #committed = false;
  #disposed = false;

  constructor(private readonly options: Readonly<{ disposalTimeoutMs?: number }> = {}) {}

  add(starter: PluginEffectStarter, label = "plugin effect"): void {
    if (this.#committed || this.#disposed) throw new Error("Plugin effect scope is already closed.");
    this.#pending.push(Object.freeze({ starter, label }));
  }
  adopt(disposer: PluginEffectDisposer, label = "adopted plugin resource"): void {
    if (this.#disposed || typeof disposer !== "function") throw new Error("Plugin effect scope is already closed.");
    this.#active.push(Object.freeze({ disposer, label }));
  }
  signal(): AbortSignal { return this.#controller.signal; }
  async commit(): Promise<void> {
    if (this.#disposed) throw new Error("Plugin effect scope is disposed.");
    if (this.#committed) return;
    try {
      for (const effect of this.#pending) {
        const disposer = await effect.starter();
        if (typeof disposer !== "function") throw new Error(`Plugin effect did not return a disposer: ${effect.label}.`);
        this.#active.push(Object.freeze({ disposer, label: effect.label }));
      }
      this.#committed = true;
    } catch (error) {
      await this.dispose().catch(() => {});
      throw error;
    }
  }
  async dispose(): Promise<void> {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#controller.abort();
    let firstError: unknown;
    for (const effect of [...this.#active].reverse()) {
      let timer: NodeJS.Timeout | undefined;
      try {
        const timeoutMs = Math.max(1, Math.floor(this.options.disposalTimeoutMs ?? 5_000));
        await Promise.race([
          Promise.resolve().then(effect.disposer),
          new Promise<never>((_resolve, reject) => {
            timer = setTimeout(() => reject(new Error(
              `Plugin effect disposal timed out: ${effect.label} after ${timeoutMs}ms.`
            )), timeoutMs);
          })
        ]);
      } catch (error) {
        firstError ??= error;
      } finally {
        if (timer) clearTimeout(timer);
      }
    }
    this.#active.length = 0;
    this.#pending.length = 0;
    if (firstError) throw firstError;
  }
}
