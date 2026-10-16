export type StorageAttempt<Value> = Readonly<{
  result: Promise<Value>;
  cancel(): Promise<void>;
}>;

export type StorageStartupLimits = Readonly<{
  concurrency?: number;
  batchSize?: number;
  itemTimeoutMs?: number;
  batchTimeoutMs?: number;
}>;

export class StorageTerminationError extends Error {
  constructor() {
    super("Storage startup child termination could not be confirmed.");
    this.name = "StorageTerminationError";
  }
}

function positive(value: number | undefined, fallback: number): number {
  return Number.isSafeInteger(value) && Number(value) > 0 ? Number(value) : fallback;
}

export class BoundedStorageStartup {
  private readonly active = new Map<StorageAttempt<unknown>, () => void>();
  private stopped = false;
  private stopFlight?: Promise<void>;

  constructor(private readonly limits: StorageStartupLimits = {}) {}

  async run<Item, Value>(
    items: readonly Item[],
    create: (item: Item) => StorageAttempt<Value>,
    publish: (item: Item, value: Value) => void | Promise<void>,
    failed: (item: Item) => void | Promise<void>
  ): Promise<void> {
    const concurrency = Math.min(positive(this.limits.concurrency, 2), 4);
    const batchSize = Math.min(positive(this.limits.batchSize, 4), 16);
    for (let offset = 0; offset < items.length && !this.stopped; offset += batchSize) {
      const batch = items.slice(offset, offset + batchSize);
      const deadline = Date.now() + positive(this.limits.batchTimeoutMs, 30_000);
      let cursor = 0;
      let fatal: unknown;
      await Promise.all(Array.from({ length: Math.min(concurrency, batch.length) }, async () => {
        while (cursor < batch.length && !this.stopped && !fatal) {
          const item = batch[cursor++];
          try {
            if (Date.now() >= deadline) {
              await failed(item);
              continue;
            }
            let value: Value;
            try {
              value = await this.read(create(item), Math.min(
                positive(this.limits.itemTimeoutMs, 10_000),
                Math.max(1, deadline - Date.now())
              ));
            } catch (error) {
              if (error instanceof StorageTerminationError) throw error;
              if (!this.stopped) await failed(item);
              continue;
            }
            if (!this.stopped) await publish(item, value);
          } catch (error) {
            fatal = error;
          }
        }
      }));
      if (fatal) {
        try { await this.cancel(); } catch { throw new StorageTerminationError(); }
        throw fatal;
      }
      if (!this.stopped) await new Promise<void>(resolve => setImmediate(resolve));
    }
  }

  cancel(): Promise<void> {
    if (this.stopFlight) return this.stopFlight;
    this.stopped = true;
    const stopping = Promise.all([...this.active].map(async ([attempt, interrupt]) => {
      interrupt();
      try { await attempt.cancel(); } catch { throw new StorageTerminationError(); }
      this.active.delete(attempt);
    })).then(() => undefined);
    this.stopFlight = stopping.catch(error => {
      this.stopFlight = undefined;
      throw error;
    });
    return this.stopFlight;
  }

  private async read<Value>(attempt: StorageAttempt<Value>, timeoutMs: number): Promise<Value> {
    let timer: NodeJS.Timeout | undefined;
    const interrupted = new Promise<never>((_resolve, reject) => {
      const interrupt = (): void => reject(new Error("Storage startup item timed out or stopped."));
      this.active.set(attempt, interrupt);
      timer = setTimeout(interrupt, timeoutMs);
    });
    try {
      return await Promise.race([attempt.result, interrupted]);
    } finally {
      if (timer) clearTimeout(timer);
      try {
        await attempt.cancel();
        this.active.delete(attempt);
      } catch {
        this.stopped = true;
        throw new StorageTerminationError();
      }
    }
  }
}
