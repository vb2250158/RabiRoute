import fs from "node:fs";

/** Physical status reads belong to the bounded Manager read process. */
export function readGatewayStatusInWorker(statusPath: string): Record<string, unknown> {
  if (process.env.RABIROUTE_MANAGER_READ_PROCESS !== "1") {
    throw new Error("Gateway status files must be read inside a Manager read worker.");
  }
  try {
    const value: unknown = JSON.parse(fs.readFileSync(statusPath, "utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid gateway status.");
    return { ...value as Record<string, unknown>, statusPath };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { statusPath, napcat: { connected: false } };
    throw error;
  }
}

type Entry = {
  path: string;
  value?: Record<string, unknown>;
  refreshedAt?: string;
  error?: string;
  lastAttempt: number;
  controller?: AbortController;
};

/** Generation-owned, read-only snapshots; callers never wait for storage. */
export class GatewayStatusSnapshotService {
  private readonly entries = new Map<string, Entry>();
  private stopped = false;

  constructor(private readonly options: {
    load(statusPath: string, signal: AbortSignal): Promise<Record<string, unknown>>;
    now?: () => number;
    refreshIntervalMs?: number;
  }) {}

  read(gatewayId: string, statusPath: string): Record<string, unknown> {
    let entry = this.entries.get(gatewayId);
    if (entry && entry.path !== statusPath) {
      entry.controller?.abort();
      this.entries.delete(gatewayId);
      entry = undefined;
    }
    if (!entry) {
      if (this.entries.size >= 256) {
        const oldest = this.entries.keys().next().value!;
        this.entries.get(oldest)?.controller?.abort();
        this.entries.delete(oldest);
      }
      entry = { path: statusPath, lastAttempt: Number.NEGATIVE_INFINITY };
      this.entries.set(gatewayId, entry);
    }
    const now = (this.options.now ?? Date.now)();
    if (!this.stopped && !entry.controller && now - entry.lastAttempt >= (this.options.refreshIntervalMs ?? 5_000)) {
      this.refresh(gatewayId, entry, now);
    }
    return {
      ...structuredClone(entry.value ?? { napcat: { connected: false } }),
      statusPath,
      gatewayStatusSnapshot: {
        state: this.stopped ? "stopped" : entry.controller ? entry.value ? "refreshing" : "warming" : entry.error ? "stale" : entry.value ? "ready" : "warming",
        refreshedAt: entry.refreshedAt,
        error: entry.error
      }
    };
  }

  private refresh(gatewayId: string, entry: Entry, now: number): void {
    entry.lastAttempt = now;
    const controller = new AbortController();
    entry.controller = controller;
    void Promise.resolve().then(() => {
      controller.signal.throwIfAborted();
      return this.options.load(entry.path, controller.signal);
    }).then(value => {
      if (this.stopped || controller.signal.aborted || this.entries.get(gatewayId) !== entry) return;
      entry.value = structuredClone(value);
      entry.refreshedAt = new Date((this.options.now ?? Date.now)()).toISOString();
      entry.error = undefined;
    }).catch(error => {
      if (!this.stopped && !controller.signal.aborted && this.entries.get(gatewayId) === entry) {
        entry.error = error instanceof Error ? error.message : String(error);
      }
    }).finally(() => {
      if (entry.controller === controller) entry.controller = undefined;
    });
  }

  stop(): void {
    this.stopped = true;
    for (const entry of this.entries.values()) entry.controller?.abort();
  }
}
