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
  stopPromise?: Promise<void>;
};

export class ManualTriggerProcessRegistry {
  private readonly active = new Map<string, ManualTriggerProcessEntry>();
  private readonly blockedOwners = new Map<string, number>();
  private blockAllLaunches = 0;

  constructor(
    private readonly stopProcess: (child: ChildProcess) => Promise<void> = stopChildProcessTree,
    private readonly defaultOwner = DEFAULT_MANUAL_TRIGGER_PROCESS_OWNER
  ) {}

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
      this.completeEntry(key, entry);
      callbacks.onError?.(error);
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

  async stopOwner(owner: string): Promise<void> {
    const normalizedOwner = this.requireOwner(owner);
    await this.withOwnerBlocked(normalizedOwner, async () => {
      while (true) {
        const entries = this.entriesForOwner(normalizedOwner);
        if (entries.length === 0) return;
        await Promise.all(entries.map(([key, entry]) => this.stopEntry(key, entry)));
      }
    });
  }

  async stopAll(): Promise<void> {
    this.blockAllLaunches += 1;
    try {
      while (this.active.size > 0) {
        await Promise.all([...this.active.entries()].map(([key, entry]) => this.stopEntry(key, entry)));
      }
    } finally {
      this.blockAllLaunches -= 1;
    }
  }

  private entriesForOwner(owner: string): Array<[string, ManualTriggerProcessEntry]> {
    return [...this.active.entries()].filter(([, entry]) => entry.owner === owner);
  }

  private assertLaunchAllowed(owner: string): void {
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
    entry.settle();
  }

  private stopEntry(key: string, entry: ManualTriggerProcessEntry): Promise<void> {
    if (entry.stopPromise) return entry.stopPromise;

    entry.stopPromise = (async () => {
      const { child } = entry;
      if (child.exitCode !== null) {
        this.completeEntry(key, entry);
        return;
      }

      await this.stopProcess(child).catch(() => {
        child.kill();
      });
      if (child.exitCode !== null) this.completeEntry(key, entry);
      await entry.settled;
    })();
    return entry.stopPromise;
  }
}
