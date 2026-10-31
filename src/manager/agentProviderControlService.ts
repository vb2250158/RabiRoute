import { getTimeoutMs } from "../shared/timeoutSettings.js";
import { execFile, spawn, type ChildProcess, type ExecFileException } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import path from "node:path";
import { resolveNpmCli, type NpmCliResolveOptions } from "../../apps/rabi-agent/lib/npm-cli.mjs";
import { stopChildProcessTree } from "../runtime/windowsProcessTree.js";
import type { CopilotLoginExitStatus, CopilotLoginResult } from "./agentProviderControlRoutes.js";

const execFileAsync = promisify(execFile);

/** Packaged Node may omit npm while the local system npm installation remains on PATH. */
export function resolveCopilotInstallNpmCli(options: NpmCliResolveOptions & { realpath?: (filename: string) => string } = {}): string {
  const { execPath = process.execPath, env = process.env, platform = process.platform,
    isFile = (filename: string) => { try { return fs.statSync(filename).isFile(); } catch { return false; } },
    realpath = fs.realpathSync } = options;
  try { return resolveNpmCli({ execPath, env, platform, isFile }); }
  catch (error) { if (env.npm_execpath?.trim()) throw error; }
  const paths = platform === "win32" ? path.win32 : path.posix;
  const configuredPath = Object.entries(env).find(([key]) => key.toLowerCase() === "path")?.[1] ?? "";
  for (const entry of configuredPath.split(platform === "win32" ? /;(?=(?:[^"]*"[^"]*")*[^"]*$)/ : ":")) {
    const directory = entry.trim().replace(/^"(.*)"$/, "$1");
    if (!directory) continue;
    for (const name of platform === "win32" ? ["npm.cmd", "npm"] : ["npm"]) {
      const shim = paths.resolve(directory, name);
      if (!isFile(shim)) continue;
      let actual: string;
      try { actual = realpath(shim); } catch { continue; }
      if (paths.basename(actual) === "npm-cli.js" && isFile(actual)) return actual;
      if (platform === "win32") {
        // Reuse the SDK's npm layout resolution beside the trusted PATH shim; never execute that shim.
        try { return resolveNpmCli({ execPath: paths.join(paths.dirname(actual), "node.exe"), env: {}, platform, isFile }); }
        catch { /* Continue to the next configured npm installation. */ }
      }
    }
  }
  throw new Error("npm CLI was not found beside Node or on the configured PATH. Repair the local Node/npm installation before installing Copilot.");
}

export class AgentProviderProcessScope {
  private readonly children = new Map<ChildProcess, Promise<void>>();
  private readonly closures = new WeakMap<ChildProcess, Promise<void>>();
  private accepting = true;
  private lateTerminationError: unknown;
  private hasLateTerminationError = false;
  private stopFlight?: Promise<void>;
  constructor(private readonly stopProcessTree = stopChildProcessTree) {}
  track(child: ChildProcess): ChildProcess {
    const closed = new Promise<void>(resolve => child.once("close", () => { this.children.delete(child); resolve(); }));
    this.children.set(child, closed);
    this.closures.set(child, closed);
    if (!this.accepting) {
      // Retain the rejected child in the same cleanup map until actual close.
      void this.terminate(child).catch(error => { if (!this.hasLateTerminationError) this.lateTerminationError = error; this.hasLateTerminationError = true; });
      throw new Error("Agent provider control plugin is stopping.");
    }
    return child;
  }
  assertAccepting(): void { if (!this.accepting) throw new Error("Agent provider control plugin is stopping."); }
  join(child: ChildProcess): Promise<void> {
    const closed = this.closures.get(child);
    if (!closed) throw new Error("Agent provider process is not owned by this scope.");
    return closed;
  }
  async terminate(child: ChildProcess): Promise<void> {
    try { await this.stopProcessTree(child); }
    catch (error) { if (child.exitCode === null && !child.kill()) throw error; }
    await this.join(child);
  }
  stop(): Promise<void> {
    this.accepting = false;
    return this.stopFlight ??= this.stopOwnedProcesses();
  }
  private async stopOwnedProcesses(): Promise<void> {
    // close, not exit/error, acknowledges stdio cleanup; there is no successful timeout shortcut.
    while (this.children.size) {
      const outcomes = await Promise.allSettled([...this.children.keys()].map(child => this.terminate(child)));
      const failures = outcomes.flatMap(outcome => outcome.status === "rejected" ? [outcome.reason] : []);
      if (failures.length) throw new AggregateError(failures, "Agent provider process cleanup failed.");
    }
    if (this.hasLateTerminationError) throw this.lateTerminationError;
  }
}

type InstallCallback = (error: ExecFileException | null, stdout: string, stderr: string) => void;
export type CopilotControlDependencies = Readonly<{
  locateCopilot?: () => Promise<string>;
  spawnLogin?: (bin: string) => ChildProcess;
  execInstall?: (callback: InstallCallback) => ChildProcess;
  loginTimeoutMs?: number;
  scope?: AgentProviderProcessScope;
}>;
export class CopilotControlService {
  private readonly scope: AgentProviderProcessScope;
  private generation = 0;
  constructor(private readonly dependencies: CopilotControlDependencies = {}) { this.scope = dependencies.scope ?? new AgentProviderProcessScope(); }
  async install(): Promise<{ stdout?: string; stderr?: string }> {
    this.scope.assertAccepting();
    let child: ChildProcess | undefined;
    try {
      return await new Promise<{ stdout?: string; stderr?: string }>((resolve, reject) => {
        const execute = this.dependencies.execInstall ?? (callback => {
          const environment = { ...process.env }, executable = process.execPath;
          const npmCli = resolveCopilotInstallNpmCli({ execPath: executable, env: environment });
          this.scope.assertAccepting();
          return execFile(executable, [npmCli, "install", "-g", "@github/copilot"], {
            shell: false, windowsHide: true, timeout: getTimeoutMs("backend.manager.agentProviderControlService.install.execFile.timeout", 120_000), env: environment
          }, callback);
        });
        this.scope.assertAccepting();
        child = execute((error, stdout, stderr) => error ? reject(Object.assign(error, { stdout, stderr })) : resolve({ stdout, stderr }));
        this.scope.track(child);
        child.once("error", reject);
      });
    } finally { if (child) await this.scope.join(child); }
  }
  private async locateCopilot(): Promise<string> {
    if (this.dependencies.locateCopilot) return this.dependencies.locateCopilot();
    try {
      const { stdout } = await execFileAsync(process.platform === "win32" ? "where.exe" : "which", ["copilot"], { timeout: getTimeoutMs("backend.manager.agentProviderControlService.locateCopilot.execFileAsync.timeout", 2_000), windowsHide: true });
      return stdout.split(/\r?\n/).map(line => line.trim()).filter(Boolean)[0] || "copilot";
    } catch { return "copilot"; }
  }
  async login(callbacks: { onExit: (status: CopilotLoginExitStatus) => void }): Promise<CopilotLoginResult> {
    this.scope.assertAccepting();
    const generation = ++this.generation;
    const copilotBin = await this.locateCopilot();
    this.scope.assertAccepting();
    return new Promise(resolve => {
      const launch = this.dependencies.spawnLogin ?? (bin => spawn(bin, ["login"], { env: { ...process.env }, shell: process.platform === "win32", windowsHide: true }));
      const child = this.scope.track(launch(copilotBin));
      let output = "", resolved = false, timedOut = false, processError: Error | undefined;
      const finish = (result: CopilotLoginResult): void => { if (!resolved) { resolved = true; resolve(result); } };
      const timer = setTimeout(() => {
        if (resolved) return;
        timedOut = true;
        void this.scope.terminate(child).then(() => finish({ kind: "timeout", error: "Timeout waiting for device code" }), error => finish({ kind: "failed", error: String(error) }));
      }, this.dependencies.loginTimeoutMs ?? getTimeoutMs("agent.providerLogin",  15_000));
      timer.unref?.();
      child.stdout?.on("data", data => {
        output += data.toString();
        const code = output.match(/code\s+([A-Z0-9]{4}-[A-Z0-9]{4})/i)?.[1];
        if (!code || timedOut) return;
        clearTimeout(timer);
        finish({ kind: "device-code", code, url: /https:\/\/github\.com\/login\/device/.test(output) ? "https://github.com/login/device" : null, ...(child.pid === undefined ? {} : { pid: child.pid }) });
      });
      child.stderr?.on("data", data => { output += data.toString(); });
      child.once("error", error => { processError = error; });
      child.once("close", exitCode => {
        clearTimeout(timer);
        if (generation === this.generation) callbacks.onExit({ done: exitCode === 0, exitCode, error: exitCode === 0 ? "" : output.trim() });
        if (timedOut) return;
        finish(processError ? { kind: "failed", error: String(processError) } : exitCode === 0 ? { kind: "completed" } : { kind: "failed", error: output.trim() });
      });
    });
  }
  async stop(): Promise<void> { this.generation += 1; await this.scope.stop(); }
}
