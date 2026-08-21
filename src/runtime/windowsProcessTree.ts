import { spawn } from "node:child_process";

export type WindowsProcessTreeRunner = (pid: number) => Promise<void>;

export function runWindowsTaskkill(pid: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn("taskkill.exe", ["/PID", String(pid), "/T", "/F"], {
      windowsHide: true,
      shell: false,
      stdio: "ignore"
    });
    child.once("error", reject);
    child.once("exit", code => code === 0 ? resolve() : reject(new Error(`taskkill exited with code ${code ?? "unknown"}.`)));
  });
}

export async function stopChildProcessTree(
  child: { pid?: number; exitCode: number | null; kill(signal?: NodeJS.Signals): boolean },
  options: { platform?: NodeJS.Platform; runWindows?: WindowsProcessTreeRunner } = {}
): Promise<void> {
  if (child.exitCode !== null) return;
  if ((options.platform ?? process.platform) === "win32" && child.pid) {
    await (options.runWindows ?? runWindowsTaskkill)(child.pid);
    return;
  }
  child.kill("SIGTERM");
}
