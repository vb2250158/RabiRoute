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

type ManualTriggerProcessEntry = {
  child: ChildProcess;
  owner?: string;
};

export class ManualTriggerProcessRegistry {
  private readonly active = new Map<string, ManualTriggerProcessEntry>();

  constructor(private readonly stopProcess: (child: ChildProcess) => Promise<void> = stopChildProcessTree) {}

  launch(
    key: string,
    start: () => ChildProcess,
    callbacks: ManualTriggerProcessCallbacks = {},
    owner?: string
  ): ManualTriggerLaunchResult {
    const current = this.active.get(key)?.child;
    if (current && current.exitCode === null) {
      return { accepted: true, alreadyRunning: true };
    }

    const child = start();
    this.active.set(key, { child, owner });

    child.stdout?.on("data", (data) => callbacks.onStdout?.(data.toString("utf8")));
    child.stderr?.on("data", (data) => callbacks.onStderr?.(data.toString("utf8")));

    const clear = () => {
      if (this.active.get(key)?.child === child) this.active.delete(key);
    };
    child.once("error", (error) => {
      clear();
      callbacks.onError?.(error);
    });
    child.once("exit", (code, signal) => {
      clear();
      callbacks.onExit?.(code, signal);
    });

    return { accepted: true, alreadyRunning: false };
  }

  isRunning(key: string): boolean {
    const child = this.active.get(key)?.child;
    return Boolean(child && child.exitCode === null);
  }

  async stopOwner(owner: string): Promise<void> {
    const entries = [...this.active.entries()].filter(([, entry]) => entry.owner === owner);
    await Promise.all(entries.map(([key, entry]) => this.stopEntry(key, entry)));
  }

  async stopAll(): Promise<void> {
    await Promise.all([...this.active.entries()].map(([key, entry]) => this.stopEntry(key, entry)));
  }

  private async stopEntry(key: string, entry: ManualTriggerProcessEntry): Promise<void> {
    const { child } = entry;
    if (child.exitCode !== null) {
      if (this.active.get(key) === entry) this.active.delete(key);
      return;
    }
    const exited = new Promise<void>(resolve => child.once("exit", () => resolve()));
    await this.stopProcess(child).catch(() => { child.kill(); });
    await Promise.race([exited, new Promise<void>(resolve => setTimeout(resolve, 5_000))]);
    if (this.active.get(key) === entry && child.exitCode !== null) this.active.delete(key);
  }
}
