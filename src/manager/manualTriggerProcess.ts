import type { ChildProcess } from "node:child_process";

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

export class ManualTriggerProcessRegistry {
  private readonly active = new Map<string, ChildProcess>();

  launch(
    key: string,
    start: () => ChildProcess,
    callbacks: ManualTriggerProcessCallbacks = {}
  ): ManualTriggerLaunchResult {
    const current = this.active.get(key);
    if (current && current.exitCode === null) {
      return { accepted: true, alreadyRunning: true };
    }

    const child = start();
    this.active.set(key, child);

    child.stdout?.on("data", (data) => callbacks.onStdout?.(data.toString("utf8")));
    child.stderr?.on("data", (data) => callbacks.onStderr?.(data.toString("utf8")));

    const clear = () => {
      if (this.active.get(key) === child) this.active.delete(key);
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
    const child = this.active.get(key);
    return Boolean(child && child.exitCode === null);
  }
}
