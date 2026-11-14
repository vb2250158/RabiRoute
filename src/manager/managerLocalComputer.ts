import path from "node:path";
import os from "node:os";
import { TerminalService } from "../../apps/rabi-agent/lib/terminal-service.mjs";
import { computerActionDefinition, terminalActionDefinition, normalizeComputerSettings, assertComputerActionEnabled, assertComputerFeatureEnabled, type ComputerSettings, type ComputerSettingsDefinition, BOOTSTRAP_COMPUTER_SETTINGS_DEFINITION, type ComputerExecutionContext } from "../../apps/rabi-agent/lib/computer-control-contract.mjs";
import { ComputerService, type ComputerPresentationTheme } from "../../apps/rabi-agent/lib/computer-service.mjs";

/** Local execution only. The Registry retains output replay; business and delivery owners are unchanged. */
export class ManagerLocalComputer {
  private readonly terminal: TerminalService;
  private readonly computer: ComputerService;
  private readonly pending = new Set<Promise<unknown>>();
  private stopping = false;
  private retirement?: Promise<void>;
  private readonly settings: () => unknown;
  private readonly definition:()=>ComputerSettingsDefinition;

  constructor(options: {
    stateDirectory: string;
    instanceId?: string;
    qtPresentation?: { command: string; args: string[] };
    getSettings?: () => unknown;
    getDefinition?:()=>ComputerSettingsDefinition;
    getPresentationTheme?: () => ComputerPresentationTheme | undefined;
    restoreDesktopRelease?: NonNullable<ConstructorParameters<typeof ComputerService>[0]>["restoreDesktopRelease"];
    commitDesktopRelease?: NonNullable<ConstructorParameters<typeof ComputerService>[0]>["commitDesktopRelease"];
    resolveDesktopRelease?: NonNullable<ConstructorParameters<typeof ComputerService>[0]>["resolveDesktopRelease"];
    computerServiceOptions?: Pick<NonNullable<ConstructorParameters<typeof ComputerService>[0]>,"nativeFactory"|"receiptRoot">;
    emit(event: Record<string, unknown>): void;
    defaultCwd?: string;
    timeout?: (key: string, fallback: number) => number;
  }) {
    this.settings = options.getSettings ?? (() => normalizeComputerSettings());
    this.definition=options.getDefinition??(()=>BOOTSTRAP_COMPUTER_SETTINGS_DEFINITION);
    this.terminal = new TerminalService({ emit: options.emit, defaultCwd: options.defaultCwd ?? os.homedir(),
      historyDirectory: path.join(options.stateDirectory, "terminal-history"), timeout: options.timeout });
    this.computer = new ComputerService({ ...options.computerServiceOptions, resolveDesktopRelease: options.resolveDesktopRelease, restoreDesktopRelease: options.restoreDesktopRelease, commitDesktopRelease: options.commitDesktopRelease, getPresentationTheme:options.getPresentationTheme, onControlChange: () => options.emit({type:"computerEvent"}), instanceId: options.instanceId, qtPresentation: options.qtPresentation, getDefinition:this.definition, getSettings: this.settings, uploadHistoryRoot: path.join(options.stateDirectory, "upload-history"), timeout: options.timeout });
  }

  desktopReleaseStatus() { return this.computer.desktopReleaseStatus(); }
  prepareDesktopRelease(reference: unknown) { return this.computer.prepareDesktopRelease(reference); }
  activateDesktopRelease(prepared: unknown, expectedRevision: number) { return this.computer.activateDesktopRelease(prepared, expectedRevision); }
  discardDesktopRelease(prepared: unknown) { return this.computer.discardDesktopRelease(prepared); }

  get terminalShells(): string[] { return [...this.terminal.shells]; }
  get computerCapabilities(): string[] { return [...this.computer.capabilities]; }

  execute(operation: "terminal" | "computer", input: Record<string, unknown>, guard: () => void = () => {}, execution: Partial<ComputerExecutionContext> = {}): Promise<unknown> {
    if (this.stopping) return Promise.reject(new Error("The host computer is stopping."));
    const pending = Promise.resolve().then(() => {
      if (this.stopping) throw new Error("The host computer is stopping.");
      guard();
      if (operation === "computer" && !computerActionDefinition(String(input.action))?.receipt && !computerActionDefinition(String(input.action))?.recovery) this.definition().assertAction(this.settings(),String(input.action));
      if (operation === "terminal" && !terminalActionDefinition(String(input.action))?.recovery) this.definition().assertFeature(this.settings(),"terminal");
      return operation === "terminal" ? this.terminal.execute(input) : this.computer.execute(input, { ...execution, sourceId: execution.sourceId ?? "manager", getSettings: this.settings, guard });
    }).then(result => { guard(); return result; });
    this.pending.add(pending);
    void pending.then(() => this.pending.delete(pending), () => this.pending.delete(pending));
    return pending;
  }

  setPresentationTheme(value: ComputerPresentationTheme | undefined): Promise<void> { return this.computer.setPresentationTheme(value); }

  endSource(connectionId: string): Promise<unknown> { return this.computer.endSource(connectionId); }

  endTask(taskId: string, sourceId: string): Promise<unknown> { return this.computer.endTask(taskId, sourceId); }

  async settingsChanged(): Promise<void> { await this.computer.reconcileSettings(); }

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
