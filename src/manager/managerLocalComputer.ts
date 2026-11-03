import path from "node:path";
import os from "node:os";
import { TerminalService } from "../../apps/rabi-agent/lib/terminal-service.mjs";
import { ComputerService } from "../../apps/rabi-agent/lib/computer-service.mjs";

/** Local execution only. The Registry retains output replay; business and delivery owners are unchanged. */
export class ManagerLocalComputer {
  private readonly terminal: TerminalService;
  private readonly computer: ComputerService;
  private readonly pending = new Set<Promise<unknown>>();
  private stopping = false;
  private retirement?: Promise<void>;

  constructor(options: {
    stateDirectory: string;
    emit(event: Record<string, unknown>): void;
    defaultCwd?: string;
    timeout?: (key: string, fallback: number) => number;
  }) {
    this.terminal = new TerminalService({ emit: options.emit, defaultCwd: options.defaultCwd ?? os.homedir(),
      historyDirectory: path.join(options.stateDirectory, "terminal-history"), timeout: options.timeout });
    this.computer = new ComputerService({ uploadHistoryRoot: path.join(options.stateDirectory, "upload-history"), timeout: options.timeout });
  }

  get terminalShells(): string[] { return [...this.terminal.shells]; }
  get computerCapabilities(): string[] { return ["files", ...(process.platform === "win32" ? ["windows", "screenshots"] : [])]; }

  execute(operation: "terminal" | "computer", input: Record<string, unknown>, guard: () => void = () => {}): Promise<unknown> {
    if (this.stopping) return Promise.reject(new Error("The host computer is stopping."));
    const pending = Promise.resolve().then(() => {
      if (this.stopping) throw new Error("The host computer is stopping.");
      guard();
      return (operation === "terminal" ? this.terminal : this.computer).execute(input);
    }).then(result => { guard(); return result; });
    this.pending.add(pending);
    void pending.then(() => this.pending.delete(pending), () => this.pending.delete(pending));
    return pending;
  }

  stop(): Promise<void> {
    if (this.retirement) return this.retirement;
    this.stopping = true;
    this.retirement = (async () => {
      const results = await Promise.allSettled([
        Promise.resolve().then(() => this.terminal.stop()), Promise.resolve().then(() => this.computer.stop()),
        ...this.pending
      ]);
      // Operation failures belong to their callers. Only original resource owners report cleanup failures.
      const failures = results.slice(0, 2).filter(result => result.status === "rejected").map(result => result.reason);
      if (failures.length) throw new AggregateError(failures, "Host computer cleanup remains unconfirmed; retain original operation IDs.");
    })();
    return this.retirement;
  }
}
