import fs from "node:fs";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import {
  buildCodexRuntimeEnv,
  codexSharedRuntimeCommand,
  CODEX_SHARED_RUNTIME_READY_URL,
  CODEX_SHARED_RUNTIME_URL
} from "../codexSharedRuntime.js";

let ownedProcess: ChildProcess | null = null;

async function isReady(): Promise<boolean> {
  try {
    const response = await fetch(CODEX_SHARED_RUNTIME_READY_URL, { signal: AbortSignal.timeout(1_000) });
    return response.ok;
  } catch {
    return false;
  }
}

export async function ensureCodexSharedRuntime(dataDir: string): Promise<void> {
  if (await isReady()) return;

  fs.mkdirSync(dataDir, { recursive: true });
  const stdout = fs.openSync(path.join(dataDir, "codex-shared-runtime.stdout.log"), "a");
  const stderr = fs.openSync(path.join(dataDir, "codex-shared-runtime.stderr.log"), "a");
  const launch = codexSharedRuntimeCommand();
  ownedProcess = spawn(launch.command, launch.args, {
    cwd: process.cwd(),
    env: buildCodexRuntimeEnv(),
    shell: false,
    windowsHide: true,
    stdio: ["ignore", stdout, stderr]
  });
  fs.closeSync(stdout);
  fs.closeSync(stderr);
  ownedProcess.once("exit", () => { ownedProcess = null; });

  for (let attempt = 0; attempt < 40; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 250));
    if (await isReady()) return;
    if (ownedProcess.exitCode != null) break;
  }
  throw new Error(`Codex shared Runtime did not become ready at ${CODEX_SHARED_RUNTIME_URL}.`);
}

export function stopOwnedCodexSharedRuntime(): void {
  if (ownedProcess && ownedProcess.exitCode == null && !ownedProcess.killed) ownedProcess.kill();
  ownedProcess = null;
}
