function synchronous(operation, label) {
  const result = operation();
  if (result && typeof result.then === "function") {
    // Observe an invalid asynchronous callback without treating it as a transaction.
    Promise.resolve(result).catch(() => {});
    throw new Error(`Plugin publication callback must be synchronous: ${label}.`);
  }
}

export class PublicationScope {
  #effects;
  #entries = [];
  #attempted = [];
  #closed = false;
  #sealed = false;
  #cancelled = false;
  #published = false;
  constructor(effects) { this.#effects = effects; }
  add(publication, label = "plugin publication") {
    if (this.#closed || this.#effects.signal().aborted) throw new Error("Plugin publication scope is closed.");
    if (typeof publication?.publish !== "function" || typeof publication?.rollback !== "function") {
      throw new Error(`Plugin publication requires publish and rollback: ${label}.`);
    }
    if ((publication.afterPublish !== undefined && typeof publication.afterPublish !== "function")
      || (publication.retire !== undefined && typeof publication.retire !== "function")) {
      throw new Error(`Plugin publication callbacks must be functions: ${label}.`);
    }
    this.#entries.push({ publication: Object.freeze({
      publish: publication.publish.bind(publication), rollback: publication.rollback.bind(publication),
      afterPublish: publication.afterPublish?.bind(publication), retire: publication.retire?.bind(publication)
    }), label });
  }
  publish() {
    if (this.#closed || this.#effects.signal().aborted) throw new Error("Plugin publication scope is closed.");
    this.#closed = true;
    for (const entry of this.#entries) {
      this.#attempted.push(entry);
      synchronous(() => entry.publication.publish(), entry.label);
    }
  }
  rollback() {
    if (this.#published) throw new Error("Published plugin activation cannot be rolled back.");
    this.#cancelled = true;
    const failures = [];
    for (const entry of this.#attempted.splice(0).reverse()) {
      try { synchronous(() => entry.publication.rollback(), `${entry.label} rollback`); }
      catch (error) { failures.push(error); }
    }
    if (failures.length) throw new AggregateError(failures, "Plugin publication rollback failed.");
  }
  seal() {
    if (!this.#closed || this.#sealed || this.#cancelled || this.#published) throw new Error("Plugin publication was not prepared or is already sealed.");
    for (const { publication, label } of this.#entries) {
      // Adoption can fail. Keep even successfully staged registrations inert
      // until every activation in the transaction has finished this phase.
      if (publication.retire) this.#effects.adopt(() => {
        if (this.#published) return publication.retire();
      }, `${label} retirement`);
    }
    this.#sealed = true;
    // No plugin code, adoption, or other fallible work is left in this finalizer.
    return () => {
      if (this.#cancelled) return;
      this.#published = true;
      this.#attempted.length = 0;
    };
  }
  async afterPublish(previousRetirement) {
    if (!this.#published) throw new Error("Plugin publication is not committed.");
    const context = Object.freeze({ signal: this.#effects.signal(), previousRetirement });
    for (const { publication } of this.#entries) {
      context.signal.throwIfAborted();
      await publication.afterPublish?.(context);
    }
  }
}
