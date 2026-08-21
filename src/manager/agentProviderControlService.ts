import { execFile, spawn, type ChildProcess } from "node:child_process";
import { promisify } from "node:util";
import { stopChildProcessTree } from "../runtime/windowsProcessTree.js";
import type { CopilotLoginExitStatus, CopilotLoginResult } from "./agentProviderControlRoutes.js";

const execFileAsync = promisify(execFile);

export class AgentProviderProcessScope {
  private readonly children = new Set<ChildProcess>();
  private accepting = true;

  track(child: ChildProcess): ChildProcess {
    if (!this.accepting) {
      void stopChildProcessTree(child).catch(() => child.kill());
      throw new Error("Agent provider control plugin is stopping.");
    }
    this.children.add(child);
    const release = (): void => { this.children.delete(child); };
    child.once("exit", release);
    child.once("error", release);
    return child;
  }

  assertAccepting(): void {
    if (!this.accepting) throw new Error("Agent provider control plugin is stopping.");
  }

  async stop(): Promise<void> {
    this.accepting = false;
    const children = [...this.children];
    await Promise.allSettled(children.map(child => stopChildProcessTree(child).catch(() => {
      if (child.exitCode === null) child.kill();
    })));
    await Promise.all(children.map(child => child.exitCode !== null
      ? Promise.resolve()
      : new Promise<void>(resolve => {
          const timer = setTimeout(resolve, 5_000);
          timer.unref?.();
          child.once("exit", () => { clearTimeout(timer); resolve(); });
          child.once("error", () => { clearTimeout(timer); resolve(); });
        })));
    this.children.clear();
  }
}

export class CopilotControlService {
  private readonly scope = new AgentProviderProcessScope();
  private generation = 0;

  async install(): Promise<{ stdout?: string; stderr?: string }> {
    this.scope.assertAccepting();
    return new Promise((resolve, reject) => {
      const child = this.scope.track(execFile("npm", ["install", "-g", "@github/copilot"], {
        shell: true,
        timeout: 120_000,
        env: { ...process.env }
      }, (error, stdout, stderr) => {
        if (error) {
          reject(Object.assign(error, { stderr }));
          return;
        }
        resolve({ stdout, stderr });
      }));
      child.once("error", reject);
    });
  }

  async login(callbacks: { onExit: (status: CopilotLoginExitStatus) => void }): Promise<CopilotLoginResult> {
    this.scope.assertAccepting();
    const generation = ++this.generation;
    let copilotBin = "copilot";
    try {
      const { stdout } = await execFileAsync(process.platform === "win32" ? "where.exe" : "which", ["copilot"], { timeout: 2_000 });
      const first = stdout.split(/\r?\n/).map(line => line.trim()).filter(Boolean)[0];
      if (first) copilotBin = first;
    } catch {}
    this.scope.assertAccepting();

    return new Promise(resolve => {
      const child = this.scope.track(spawn(copilotBin, ["login"], {
        env: { ...process.env },
        shell: process.platform === "win32",
        windowsHide: true
      }));
      let output = "";
      let resolved = false;
      const finish = (result: CopilotLoginResult): void => {
        if (resolved) return;
        resolved = true;
        resolve(result);
      };
      const timer = setTimeout(() => {
        if (resolved) return;
        void stopChildProcessTree(child).catch(() => child.kill());
        finish({ kind: "timeout", error: "Timeout waiting for device code" });
      }, 15_000);
      timer.unref?.();
      child.stdout?.on("data", data => {
        output += data.toString();
        const code = output.match(/code\s+([A-Z0-9]{4}-[A-Z0-9]{4})/i)?.[1];
        if (!code) return;
        clearTimeout(timer);
        finish({
          kind: "device-code",
          code,
          url: /https:\/\/github\.com\/login\/device/.test(output) ? "https://github.com/login/device" : null,
          pid: child.pid
        });
      });
      child.stderr?.on("data", data => { output += data.toString(); });
      child.once("error", error => {
        clearTimeout(timer);
        finish({ kind: "failed", error: String(error) });
      });
      child.once("exit", exitCode => {
        clearTimeout(timer);
        if (generation === this.generation) {
          callbacks.onExit({ done: exitCode === 0, exitCode, error: exitCode === 0 ? "" : output.trim() });
        }
        if (!resolved) finish(exitCode === 0
          ? { kind: "completed" }
          : { kind: "failed", error: output.trim() });
      });
    });
  }

  async stop(): Promise<void> {
    this.generation += 1;
    await this.scope.stop();
  }
}
