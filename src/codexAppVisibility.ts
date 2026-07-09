import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";

export type CodexAppVisibilityReason =
  | "desktop-ipc-delivery"
  | "app-server-create-thread"
  | "app-server-resume-thread"
  | "app-server-fallback"
  | "app-server-turn-start";

export type CodexAppVisibilityResult = {
  attempted: boolean;
  ok: boolean;
  skipped?: boolean;
  reason: CodexAppVisibilityReason;
  mode?: "focused" | "started";
  target?: string;
  message?: string;
  error?: string;
  at: string;
};

export type CodexAppVisibilityStatePatch = {
  lastCodexAppVisibilityAt?: string;
  lastCodexAppVisibilityReason?: string;
  lastCodexAppVisibilityMode?: string;
  lastCodexAppVisibilityTarget?: string;
  lastCodexAppVisibilityError?: string;
};

let lastVisibilityEnsureAt = 0;

function positiveIntegerFromEnv(name: string, fallback: number): number {
  const value = Number.parseInt(process.env[name] ?? "", 10);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

const defaultMinIntervalMs = 10_000;
const defaultStartupDelayMs = 1_500;
const defaultTimeoutMs = 6_000;

function codexAppVisibilityEnabled(): boolean {
  return process.env.CODEX_APP_VISIBILITY_NOTIFY !== "0";
}

function singleQuotePowerShell(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function encodePowerShell(command: string): string {
  return Buffer.from(command, "utf16le").toString("base64");
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function shouldEnsureCodexAppVisibilityForTest(
  now: number,
  lastEnsureAt: number,
  force: boolean,
  minIntervalMs: number
): boolean {
  return force || lastEnsureAt <= 0 || now - lastEnsureAt >= minIntervalMs;
}

export function findCodexAppExecutablesForTest(
  windowsAppsRoot = "C:\\Program Files\\WindowsApps",
  configuredPath = process.env.CODEX_APP_EXE_PATH
): string[] {
  const configured = configuredPath?.trim();
  const candidates: string[] = [];
  if (configured) {
    candidates.push(configured);
  }

  try {
    const packageDirs = fs.readdirSync(windowsAppsRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && /^OpenAI\.Codex_/i.test(entry.name))
      .map((entry) => entry.name)
      .sort((left, right) => right.localeCompare(left, undefined, { numeric: true }));
    for (const packageDir of packageDirs) {
      candidates.push(path.join(windowsAppsRoot, packageDir, "app", "Codex.exe"));
    }
  } catch {
    // WindowsApps may be unreadable on locked-down machines.
  }

  return [...new Set(candidates)].filter((candidate) => {
    try {
      return fs.existsSync(candidate);
    } catch {
      return false;
    }
  });
}

function visibilityScript(targetPath: string): string {
  return `
$ErrorActionPreference = "Stop"
$targetPath = ${singleQuotePowerShell(targetPath)}
$processes = @(Get-Process -Name Codex -ErrorAction SilentlyContinue | Where-Object {
  try {
    $_.Path -eq $targetPath -or $_.Path -like "*\\WindowsApps\\OpenAI.Codex_*\\app\\Codex.exe"
  } catch {
    $false
  }
})
$withWindow = $processes | Where-Object { $_.MainWindowHandle -ne 0 } | Sort-Object StartTime -Descending | Select-Object -First 1
if ($withWindow) {
  if (-not ("RabiRouteCodexVisibility.User32" -as [type])) {
    Add-Type @"
using System;
using System.Runtime.InteropServices;
namespace RabiRouteCodexVisibility {
  public static class User32 {
    [DllImport("user32.dll")]
    public static extern bool SetForegroundWindow(IntPtr hWnd);
    [DllImport("user32.dll")]
    public static extern bool ShowWindowAsync(IntPtr hWnd, int nCmdShow);
  }
}
"@
  }
  [RabiRouteCodexVisibility.User32]::ShowWindowAsync($withWindow.MainWindowHandle, 9) | Out-Null
  [RabiRouteCodexVisibility.User32]::SetForegroundWindow($withWindow.MainWindowHandle) | Out-Null
  "focused|$($withWindow.Id)|$($withWindow.Path)"
  exit 0
}
if (Test-Path -LiteralPath $targetPath) {
  Start-Process -FilePath $targetPath | Out-Null
  "started|$targetPath"
  exit 0
}
"missing|$targetPath"
exit 1
`;
}

async function runVisibilityScript(targetPath: string): Promise<{ mode: "focused" | "started"; message: string }> {
  const encoded = encodePowerShell(visibilityScript(targetPath));
  const timeoutMs = positiveIntegerFromEnv("CODEX_APP_VISIBILITY_TIMEOUT_MS", defaultTimeoutMs);
  const output = await new Promise<string>((resolve, reject) => {
    execFile("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encoded], {
      windowsHide: true,
      timeout: timeoutMs
    }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error((stderr || error.message).trim()));
        return;
      }
      resolve(stdout.trim());
    });
  });

  if (output.startsWith("focused|")) {
    return { mode: "focused", message: output };
  }
  if (output.startsWith("started|")) {
    return { mode: "started", message: output };
  }
  throw new Error(output || "Codex App visibility script returned no result.");
}

async function discoverCodexAppExecutableWithPowerShell(): Promise<string | undefined> {
  const script = `
$ErrorActionPreference = "SilentlyContinue"
$paths = @()
$processPath = Get-Process -Name Codex -ErrorAction SilentlyContinue |
  Where-Object { $_.Path -like "*\\WindowsApps\\OpenAI.Codex_*\\app\\Codex.exe" } |
  Select-Object -ExpandProperty Path -First 1
if ($processPath) {
  $paths += $processPath
}
$package = Get-AppxPackage -Name OpenAI.Codex -ErrorAction SilentlyContinue |
  Sort-Object Version -Descending |
  Select-Object -First 1
if ($package -and $package.InstallLocation) {
  $paths += (Join-Path $package.InstallLocation "app\\Codex.exe")
}
$paths | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
`;
  const encoded = encodePowerShell(script);
  const timeoutMs = positiveIntegerFromEnv("CODEX_APP_VISIBILITY_TIMEOUT_MS", defaultTimeoutMs);
  try {
    const output = await new Promise<string>((resolve, reject) => {
      execFile("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encoded], {
        windowsHide: true,
        timeout: timeoutMs
      }, (error, stdout, stderr) => {
        if (error) {
          reject(new Error((stderr || error.message).trim()));
          return;
        }
        resolve(stdout.trim());
      });
    });
    return output.split(/\r?\n/).map((line) => line.trim()).find(Boolean);
  } catch {
    return undefined;
  }
}

export async function ensureCodexAppVisible(
  reason: CodexAppVisibilityReason,
  options: { force?: boolean } = {}
): Promise<CodexAppVisibilityResult> {
  const now = Date.now();
  const at = new Date(now).toISOString();
  const minIntervalMs = positiveIntegerFromEnv("CODEX_APP_VISIBILITY_MIN_INTERVAL_MS", defaultMinIntervalMs);
  if (!codexAppVisibilityEnabled()) {
    return { attempted: false, ok: true, skipped: true, reason, message: "disabled", at };
  }
  if (process.platform !== "win32") {
    return { attempted: false, ok: true, skipped: true, reason, message: "non-windows", at };
  }
  if (!shouldEnsureCodexAppVisibilityForTest(now, lastVisibilityEnsureAt, Boolean(options.force), minIntervalMs)) {
    return { attempted: false, ok: true, skipped: true, reason, message: "throttled", at };
  }

  lastVisibilityEnsureAt = now;
  let [target] = findCodexAppExecutablesForTest();
  target = target ?? await discoverCodexAppExecutableWithPowerShell();
  if (!target) {
    return {
      attempted: true,
      ok: false,
      reason,
      error: "Codex.exe was not found under C:\\Program Files\\WindowsApps\\OpenAI.Codex_*\\app or CODEX_APP_EXE_PATH.",
      at
    };
  }

  try {
    const result = await runVisibilityScript(target);
    if (result.mode === "started") {
      await wait(positiveIntegerFromEnv("CODEX_APP_VISIBILITY_STARTUP_DELAY_MS", defaultStartupDelayMs));
    }
    return {
      attempted: true,
      ok: true,
      reason,
      mode: result.mode,
      target,
      message: result.message,
      at
    };
  } catch (error) {
    return {
      attempted: true,
      ok: false,
      reason,
      target,
      error: error instanceof Error ? error.message : String(error),
      at
    };
  }
}

export function codexAppVisibilityStatePatch(result: CodexAppVisibilityResult): CodexAppVisibilityStatePatch {
  if (result.skipped) {
    return {};
  }
  return {
    lastCodexAppVisibilityAt: result.at,
    lastCodexAppVisibilityReason: result.reason,
    lastCodexAppVisibilityMode: result.mode || "",
    lastCodexAppVisibilityTarget: result.target || "",
    lastCodexAppVisibilityError: result.ok ? "" : result.error || result.message || "Codex App visibility check failed."
  };
}
