import path from "node:path";

export class PlanPageCatalogInitializingError extends Error {
  readonly reason = "PLAN_CATALOG_INITIALIZING";
  constructor() {
    super("计划目录正在初始化，请稍后重试。");
    this.name = "PlanPageCatalogInitializingError";
  }
}

export interface PlanPageCatalogOwner<Input, Output> {
  /** Must validate the requested fence before publishing or returning data. */
  prepare(): Promise<void>;
  query(input: Input): Promise<Output>;
  /** Resolves only after the owned process/resources have stopped. */
  stop(): Promise<void>;
}

type Entry<Input, Output> = {
  owner: PlanPageCatalogOwner<Input, Output>;
  ready: Promise<void>;
  prepared: boolean;
  failure?: unknown;
  cancelPreparation?: () => void;
  stopFlight?: Promise<void>;
  activeQueries: number;
  subscribers: number;
  invalidated: boolean;
};

/** Owns preparation, not plan truth. Request cancellation never cancels prepare. */
export class PlanPageCatalogLifecycle<Input, Output> {
  private readonly entries = new Map<string, Entry<Input, Output>>();
  private stopped = false;
  private readonly shutdown = new AbortController();
  private stopFlight?: Promise<void>;

  constructor(private readonly options: {
    maxRoles: number;
    buildTimeoutMs: number;
    maxQueriesPerRole?: number;
    create: (roleDir: string) => PlanPageCatalogOwner<Input, Output>;
  }) {
    if (!Number.isSafeInteger(options.maxRoles) || options.maxRoles < 1
      || !Number.isSafeInteger(options.buildTimeoutMs) || options.buildTimeoutMs < 1
      || !Number.isSafeInteger(options.maxQueriesPerRole ?? 8) || (options.maxQueriesPerRole ?? 8) < 1) {
      throw new Error("Invalid plan catalog lifecycle limits.");
    }
  }

  private stopOwner(entry: Entry<Input, Output>): Promise<void> {
    if (!entry.stopFlight) {
      entry.stopFlight = Promise.resolve().then(() => entry.owner.stop()).catch(error => {
        entry.stopFlight = undefined;
        throw error;
      });
    }
    return entry.stopFlight;
  }

  private ensure(roleDir: string): Entry<Input, Output> {
    if (this.stopped) throw new Error("PLAN_CATALOG_STOPPED");
    const key = path.resolve(roleDir);
    const existing = this.entries.get(key);
    if (existing) return existing;
    if (this.entries.size >= this.options.maxRoles) throw new Error("PLAN_CATALOG_CAPACITY");
    const owner = this.options.create(key);
    const entry: Entry<Input, Output> = { owner, ready: Promise.resolve(), prepared: false, activeQueries: 0, subscribers: 0, invalidated: false };
    this.entries.set(key, entry);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const expired = new Promise<never>((_resolve, reject) => {
      entry.cancelPreparation = () => reject(new Error("PLAN_CATALOG_STOPPED"));
      timer = setTimeout(() => reject(new Error("PLAN_CATALOG_BUILD_TIMEOUT")), this.options.buildTimeoutMs);
    });
    entry.ready = Promise.race([Promise.resolve().then(() => owner.prepare()), expired])
      .then(() => {
        if (this.stopped) throw new Error("PLAN_CATALOG_STOPPED");
        if (entry.invalidated || this.entries.get(key) !== entry) throw new Error("PLAN_CATALOG_DIRTY");
        entry.prepared = true;
      })
      .catch(async error => {
        entry.failure = error ?? new Error("PLAN_CATALOG_BUILD_FAILED");
        // Retain the slot if shutdown fails: do not spawn a replacement beside
        // an unconfirmed old process. stop() can retry that cleanup later.
        await this.stopOwner(entry);
        if (this.entries.get(key) === entry) this.entries.delete(key);
        throw error;
      }).finally(() => { if (timer) clearTimeout(timer); });
    // A cancelled subscriber may be the last observer of preparation.
    void entry.ready.catch(() => undefined);
    return entry;
  }

  /** Explicit full invalidation; incremental changes remain the owner's job. */
  async invalidate(roleDir: string): Promise<void> {
    const key = path.resolve(roleDir);
    const entry = this.entries.get(key);
    if (!entry) return;
    entry.invalidated = true;
    entry.cancelPreparation?.();
    await this.stopOwner(entry);
    if (this.entries.get(key) === entry) this.entries.delete(key);
  }

  /** Starts or joins shared preparation, independent of HTTP cancellation. */
  async prepare(roleDir: string): Promise<void> {
    const entry = this.ensure(roleDir);
    if (entry.invalidated) throw new Error("PLAN_CATALOG_DIRTY");
    await entry.ready;
    if (this.stopped) throw new Error("PLAN_CATALOG_STOPPED");
    if (entry.invalidated) throw new Error("PLAN_CATALOG_DIRTY");
  }

  async query(roleDir: string, input: Input, signal?: AbortSignal, readyOnly = false): Promise<Output> {
    if (signal?.aborted) throw new Error("PLAN_CATALOG_REQUEST_ABORTED");
    const entry = this.ensure(roleDir);
    if (entry.invalidated) throw new Error("PLAN_CATALOG_DIRTY");
    if (entry.failure !== undefined) throw entry.failure;
    if (entry.subscribers >= (this.options.maxQueriesPerRole ?? 8)) throw new Error("PLAN_CATALOG_QUERY_CAPACITY");
    if (readyOnly && !entry.prepared) throw new PlanPageCatalogInitializingError();
    entry.subscribers++;
    let abort: (() => void) | undefined;
    let onStop: (() => void) | undefined;
    const cancelled = new Promise<never>((_resolve, reject) => {
      abort = () => reject(new Error("PLAN_CATALOG_REQUEST_ABORTED"));
      signal?.addEventListener("abort", abort, { once: true });
      onStop = () => reject(new Error("PLAN_CATALOG_STOPPED"));
      this.shutdown.signal.addEventListener("abort", onStop, { once: true });
      if (signal?.aborted) abort();
      if (this.shutdown.signal.aborted) onStop();
    });
    try {
      await Promise.race([entry.ready, cancelled]);
      if (this.stopped) throw new Error("PLAN_CATALOG_STOPPED");
      if (entry.invalidated) throw new Error("PLAN_CATALOG_DIRTY");
      if (signal?.aborted) throw new Error("PLAN_CATALOG_REQUEST_ABORTED");
      if (entry.activeQueries >= (this.options.maxQueriesPerRole ?? 8)) throw new Error("PLAN_CATALOG_QUERY_CAPACITY");
      entry.activeQueries++;
      const operation = Promise.resolve().then(() => entry.owner.query(input))
        .finally(() => { entry.activeQueries--; });
      // Cancellation releases the caller, not the underlying query's capacity.
      const result = await Promise.race([operation, cancelled]);
      if (entry.invalidated) throw new Error("PLAN_CATALOG_DIRTY");
      if (this.stopped) throw new Error("PLAN_CATALOG_STOPPED");
      return result;
    } finally {
      entry.subscribers--;
      if (abort) signal?.removeEventListener("abort", abort);
      if (onStop) this.shutdown.signal.removeEventListener("abort", onStop);
    }
  }

  stop(): Promise<void> {
    this.stopped = true;
    this.shutdown.abort();
    if (this.stopFlight) return this.stopFlight;
    for (const entry of this.entries.values()) entry.cancelPreparation?.();
    this.stopFlight = Promise.all([...this.entries.values()].map(async entry => {
      await this.stopOwner(entry);
      await entry.ready.catch(() => undefined);
    }))
      .then(() => { this.entries.clear(); })
      .catch(error => { this.stopFlight = undefined; throw error; });
    return this.stopFlight;
  }
}
