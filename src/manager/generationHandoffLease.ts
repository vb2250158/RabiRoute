export class GenerationHandoffLease {
  readonly #tokens = new Set<symbol>();

  get active(): boolean {
    return this.#tokens.size > 0;
  }

  get size(): number {
    return this.#tokens.size;
  }

  acquire(): () => boolean {
    const token = Symbol("generation-handoff-lease");
    this.#tokens.add(token);
    let released = false;
    return () => {
      if (released) return false;
      released = true;
      this.#tokens.delete(token);
      return this.#tokens.size === 0;
    };
  }
}
