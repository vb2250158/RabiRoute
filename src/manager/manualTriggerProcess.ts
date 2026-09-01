import type { ChildProcess } from "node:child_process";
import { stopChildProcessTree } from "../runtime/windowsProcessTree.js";

export type ManualTriggerProcessCallbacks = {
  onStdout?: (text: string) => void;
  onStderr?: (text: string) => void;
  onError?: (error: Error) => void;
  onExit?: (code: number | null, signal: NodeJS.Signals | null) => void;
};

export type ManualTriggerLaunchResult = {
  accepted: true;
  alreadyRunning: boolean;
};

export const DEFAULT_MANUAL_TRIGGER_PROCESS_OWNER = "manager:gateway-runtime";

type ManualTriggerProcessEntry = {
  child: ChildProcess;
  owner: string;
  settled: Promise<void>;
  settle: () => void;
  terminationFlight?: Promise<void>;
};

export class ManualTriggerTerminationUnconfirmedError extends Error {
  readonly code = "manual_trigger_termination_unconfirmed";

  constructor(readonly processKey: string, readonly pid?: number) {
    super(`Manual trigger process termination was not confirmed: key=${processKey}; pid=${pid ?? "unknown"}.`);
    this.name = "ManualTriggerTerminationUnconfirmedError";
  }
}

type ManualTriggerProcessRegistryOptions = Readonly<{
  terminateTimeoutMs?: number;
  forceKillTimeoutMs?: number;
  forceStopProcess?: (child: ChildProcess) => Promise<void>;
}>;

function positiveTimeout(value: number | undefined, fallback: number): number {
  return Number.isSafeInteger(value) && Number(value) > 0 ? Number(value) : fallback;
}

function waitBounded(promise: Promise<unknown>, timeoutMs: number): Promise<boolean> {
  return new Promise(resolve => {
    let settled = false;
    const finish = (value: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    timer.unref?.();
    void promise.then(() => finish(true), () => finish(false));
  });
}

export class ManualTriggerProcessRegistry {
  private readonly active = new Map<string, ManualTriggerProcessEntry>();
  private readonly blockedOwners = new Map<string, number>();
  private readonly terminationUnconfirmed = new Set<ManualTriggerProcessEntry>();
  private readonly ownerTerminationFlights = new Map<string, Promise<void>>();
  private registryTerminationFlight: Promise<void> | undefined;
  private blockAllLaunches = 0;
  private readonly terminateTimeoutMs: number;
  private readonly forceKillTimeoutMs: number;
  private readonly forceStopProcess: (child: ChildProcess) => Promise<void>;

  constructor(
    private readonly requestGracefulStop: (child: ChildProcess) => Promise<void> = async child => {
      child.kill("SIGTERM");
    },
    private readonly defaultOwner = DEFAULT_MANUAL_TRIGGER_PROCESS_OWNER,
    options: ManualTriggerProcessRegistryOptions = {}
  ) {
    this.terminateTimeoutMs = positiveTimeout(options.terminateTimeoutMs, 2_000);
    this.forceKillTimeoutMs = positiveTimeout(options.forceKillTimeoutMs, 2_000);
    this.forceStopProcess = options.forceStopProcess ?? stopChildProcessTree;
  }

  launch(
    key: string,
    start: () => ChildProcess,
    callbacks: ManualTriggerProcessCallbacks = {},
    owner?: string
  ): ManualTriggerLaunchResult {
    const processOwner = this.requireOwner(owner ?? this.defaultOwner);
    this.assertLaunchAllowed(processOwner);

    const current = this.active.get(key);
    if (current?.child.exitCode === null) {
      if (current.owner !== processOwner) {
        throw new Error(
          `Manual trigger process '${key}' is already owned by '${current.owner}', not '${processOwner}'.`
        );
      }
      return { accepted: true, alreadyRunning: true };
    }
    if (current) this.completeEntry(key, current);

    const child = start();
    let settle = (): void => {};
    const settled = new Promise<void>(resolve => { settle = resolve; });
    const entry: ManualTriggerProcessEntry = { child, owner: processOwner, settled, settle };
    this.active.set(key, entry);

    child.stdout?.on("data", (data) => callbacks.onStdout?.(data.toString("utf8")));
    child.stderr?.on("data", (data) => callbacks.onStderr?.(data.toString("utf8")));

    child.once("error", (error) => {
      if (child.exitCode !== null) {
        this.completeEntry(key, entry);
      } else {
        // An error event does not prove that the OS process exited. Reuse the
        // entry's bounded termination flight and keep the registry fenced if
        // graceful and forced tree termination cannot be confirmed.
        void this.stopEntry(key, entry).catch(() => {});
      }
      try {
        callbacks.onError?.(error);
      } catch {
        // Observation must not interrupt the registry-owned termination path.
      }
    });
    child.once("exit", (code, signal) => {
      this.completeEntry(key, entry);
      callbacks.onExit?.(code, signal);
    });

    if (child.exitCode !== null) this.completeEntry(key, entry);
    return { accepted: true, alreadyRunning: false };
  }

  launchOwned(
    owner: string,
    key: string,
    start: () => ChildProcess,
    callbacks: ManualTriggerProcessCallbacks = {}
  ): ManualTriggerLaunchResult {
    return this.launch(key, start, callbacks, this.requireOwner(owner));
  }

  isRunning(key: string): boolean {
    const child = this.active.get(key)?.child;
    return Boolean(child && child.exitCode === null);
  }

  async drainOwner(owner: string): Promise<void> {
    const normalizedOwner = this.requireOwner(owner);
    await this.withOwnerBlocked(normalizedOwner, async () => {
      while (true) {
        const entries = this.entriesForOwner(normalizedOwner);
        if (entries.length === 0) return;
        await Promise.all(entries.map(([, entry]) => entry.settled));
      }
    });
  }

  stopOwner(owner: string): Promise<void> {
    const normalizedOwner = this.requireOwner(owner);
    const currentFlight = this.ownerTerminationFlights.get(normalizedOwner);
    if (currentFlight) return currentFlight;

    const flight = this.withOwnerBlocked(normalizedOwner, async () => {
      while (true) {
        const entries = this.entriesForOwner(normalizedOwner);
        if (entries.length === 0) return;
        await Promise.all(entries.map(([key, entry]) => this.stopEntry(key, entry)));
      }
    });
    this.ownerTerminationFlights.set(normalizedOwner, flight);
    void flight.then(
      () => this.clearOwnerTerminationFlight(normalizedOwner, flight),
      () => this.clearOwnerTerminationFlight(normalizedOwner, flight)
    );
    return flight;
  }

  stopAll(): Promise<void> {
    if (this.registryTerminationFlight) return this.registryTerminationFlight;
    this.blockAllLaunches += 1;
    const flight = (async () => {
      while (this.active.size > 0) {
        await Promise.all([...this.active.entries()].map(([key, entry]) => this.stopEntry(key, entry)));
      }
    })();
    this.registryTerminationFlight = flight;
    void flight.then(
      () => this.clearRegistryTerminationFlight(flight),
      () => this.clearRegistryTerminationFlight(flight)
    );
    return flight;
  }

  private clearOwnerTerminationFlight(owner: string, flight: Promise<void>): void {
    if (this.ownerTerminationFlights.get(owner) === flight) {
      this.ownerTerminationFlights.delete(owner);
    }
  }

  private clearRegistryTerminationFlight(flight: Promise<void>): void {
    if (this.registryTerminationFlight === flight) {
      this.registryTerminationFlight = undefined;
      this.blockAllLaunches -= 1;
    }
  }

  private entriesForOwner(owner: string): Array<[string, ManualTriggerProcessEntry]> {
    return [...this.active.entries()].filter(([, entry]) => entry.owner === owner);
  }

  private assertLaunchAllowed(owner: string): void {
    if (this.terminationUnconfirmed.size > 0) {
      throw new Error("Manual trigger process registry is fenced by an unconfirmed child termination.");
    }
    if (this.blockAllLaunches > 0) {
      throw new Error("Manual trigger process registry is stopping all processes.");
    }
    if ((this.blockedOwners.get(owner) ?? 0) > 0) {
      throw new Error(`Manual trigger process owner '${owner}' is stopping or draining.`);
    }
  }

  private requireOwner(owner: string): string {
    const normalized = owner.trim();
    if (!normalized) throw new Error("Manual trigger process owner is required.");
    return normalized;
  }

  private async withOwnerBlocked(owner: string, action: () => Promise<void>): Promise<void> {
    this.blockedOwners.set(owner, (this.blockedOwners.get(owner) ?? 0) + 1);
    try {
      await action();
    } finally {
      const remaining = (this.blockedOwners.get(owner) ?? 1) - 1;
      if (remaining > 0) this.blockedOwners.set(owner, remaining);
      else this.blockedOwners.delete(owner);
    }
  }

  private completeEntry(key: string, entry: ManualTriggerProcessEntry): void {
    if (this.active.get(key) === entry) this.active.delete(key);
    this.terminationUnconfirmed.delete(entry);
    entry.settle();
  }

  private stopEntry(key: string, entry: ManualTriggerProcessEntry): Promise<void> {
    if (entry.terminationFlight) return entry.terminationFlight;

    entry.terminationFlight = (async () => {
      const { child } = entry;
      if (child.exitCode !== null) {
        this.completeEntry(key, entry);
        return;
      }

      const gracefulStop = Promise.resolve().then(() => this.requestGracefulStop(child));
      void gracefulStop.catch(() => {});
      if (child.exitCode !== null) this.completeEntry(key, entry);
      if (await waitBounded(entry.settled, this.terminateTimeoutMs)) return;

      const forcedStop = Promise.resolve().then(() => this.forceStopProcess(child));
      void forcedStop.catch(() => {});
      if (child.exitCode !== null) this.completeEntry(key, entry);
      if (await waitBounded(entry.settled, this.forceKillTimeoutMs)) return;

      this.terminationUnconfirmed.add(entry);
      throw new ManualTriggerTerminationUnconfirmedError(key, child.pid);
    })();
    return entry.terminationFlight;
  }
}
