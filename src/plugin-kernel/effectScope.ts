import type { PluginEffectDisposer, PluginEffectStarter } from "./types.js";

type PendingEffect = Readonly<{ starter: PluginEffectStarter; label: string }>;

export class EffectScope {
  readonly #pending: PendingEffect[] = [];
  readonly #disposers: PluginEffectDisposer[] = [];
  #committed = false;
  #disposed = false;

  add(starter: PluginEffectStarter, label = "plugin effect"): void {
    if (this.#committed || this.#disposed) throw new Error("Plugin effect scope is already closed.");
    this.#pending.push(Object.freeze({ starter, label }));
  }
  async commit(): Promise<void> {
    if (this.#disposed) throw new Error("Plugin effect scope is disposed.");
    if (this.#committed) return;
    try {
      for (const effect of this.#pending) {
        const disposer = await effect.starter();
        if (typeof disposer !== "function") throw new Error(`Plugin effect did not return a disposer: ${effect.label}.`);
        this.#disposers.push(disposer);
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
    let firstError: unknown;
    for (const disposer of [...this.#disposers].reverse()) {
      try { await disposer(); } catch (error) { firstError ??= error; }
    }
    this.#disposers.length = 0;
    this.#pending.length = 0;
    if (firstError) throw firstError;
  }
}
