import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";

export type ChatGptDesktopHostVisibilityReason =
  | "app-server-create-thread"
  | "app-server-turn-start";

export type ChatGptDesktopHostVisibilityResult = {
  attempted: boolean;
  ok: boolean;
  skipped?: boolean;
  reason: ChatGptDesktopHostVisibilityReason;
  mode?: "focused" | "started";
  target?: string;
  message?: string;
  error?: string;
  at: string;
};

export type ChatGptDesktopHostVisibilityStatePatch = {
  lastChatGptDesktopHostVisibilityAt?: string;
  lastChatGptDesktopHostVisibilityReason?: string;
  lastChatGptDesktopHostVisibilityMode?: string;
  lastChatGptDesktopHostVisibilityTarget?: string;
  lastChatGptDesktopHostVisibilityError?: string;
};

let lastDesktopHostVisibilityEnsureAt = 0;

function positiveIntegerFromEnv(name: string, fallback: number): number {
  const value = Number.parseInt(process.env[name] ?? "", 10);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

const defaultMinIntervalMs = 10_000;
const defaultStartupDelayMs = 1_500;
const defaultTimeoutMs = 6_000;
const appxDesktopHostPackagePattern = /^OpenAI\.(?:Codex|ChatGPT)_/i;
const appxManifestName = "AppxManifest.xml";

function chatGptDesktopHostVisibilityEnabled(): boolean {
  return process.env.CHATGPT_DESKTOP_VISIBILITY_NOTIFY === "1";
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

export function shouldEnsureChatGptDesktopHostVisibilityForTest(
  now: number,
  lastEnsureAt: number,
  force: boolean,
  minIntervalMs: number
): boolean {
  return force || lastEnsureAt <= 0 || now - lastEnsureAt >= minIntervalMs;
}

function decodeXmlAttribute(value: string): string {
  return value
    .replace(/&quot;/gi, '"')
    .replace(/&apos;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&amp;/gi, "&");
}

function appxManifestExecutable(packageRoot: string): string | undefined {
  try {
    const manifest = fs.readFileSync(path.join(packageRoot, appxManifestName), "utf8");
    const applicationTags = manifest.match(/<(?:[\w.-]+:)?Application\b[^>]*>/gi) ?? [];
    const executableAttribute = applicationTags
      .map((tag) => tag.match(/\bExecutable\s*=\s*(["'])(.*?)\1/i))
      .find((match): match is RegExpMatchArray => Boolean(match?.[2]));
    const executable = decodeXmlAttribute(executableAttribute?.[2]?.trim() ?? "");
    if (!executable || path.isAbsolute(executable)) {
      return undefined;
    }

    const root = path.resolve(packageRoot);
    const candidate = path.resolve(root, executable.replace(/[\\/]/g, path.sep));
    const relative = path.relative(root, candidate);
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
      return undefined;
    }
    return candidate;
  } catch {
    return undefined;
  }
}

function desktopHostPriority(executablePath: string): number {
  return path.basename(executablePath).toLowerCase() === "chatgpt.exe" ? 0 : 1;
}

function existingUniquePaths(candidates: string[]): string[] {
  const seen = new Set<string>();
  return candidates.filter((candidate) => {
    try {
      const key = path.resolve(candidate).toLowerCase();
      if (seen.has(key) || !fs.existsSync(candidate)) {
        return false;
      }
      seen.add(key);
      return true;
    } catch {
      return false;
    }
  });
}

export function findChatGptDesktopHostExecutablesForTest(
  windowsAppsRoot = "C:\\Program Files\\WindowsApps",
  configuredPath = process.env.CHATGPT_DESKTOP_EXE_PATH
): string[] {
  const configured = configuredPath?.trim();
  const candidates: string[] = [];
  if (configured) {
    candidates.push(configured);
  }

  try {
    const packageCandidates = fs.readdirSync(windowsAppsRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && appxDesktopHostPackagePattern.test(entry.name))
      .map((entry) => ({
        packageName: entry.name,
        executable: appxManifestExecutable(path.join(windowsAppsRoot, entry.name))
      }))
      .filter((entry): entry is { packageName: string; executable: string } => Boolean(entry.executable))
      .sort((left, right) => {
        const hostPriority = desktopHostPriority(left.executable) - desktopHostPriority(right.executable);
        return hostPriority || right.packageName.localeCompare(left.packageName, undefined, { numeric: true });
      });
    candidates.push(...packageCandidates.map((entry) => entry.executable));
  } catch {
    // WindowsApps may be unreadable on locked-down machines.
  }

  return existingUniquePaths(candidates);
}

function visibilityScript(targetPath: string): string {
  return `
$ErrorActionPreference = "Stop"
$targetPath = ${singleQuotePowerShell(targetPath)}
$targetExecutable = [System.IO.Path]::GetFileName($targetPath)
$targetProcessName = [System.IO.Path]::GetFileNameWithoutExtension($targetExecutable)
$processes = @(Get-Process -Name $targetProcessName -ErrorAction SilentlyContinue | Where-Object {
  try {
    $processPath = $_.Path
    $processPath -and (
      [string]::Equals($processPath, $targetPath, [System.StringComparison]::OrdinalIgnoreCase) -or
      [string]::Equals([System.IO.Path]::GetFileName($processPath), $targetExecutable, [System.StringComparison]::OrdinalIgnoreCase)
    )
  } catch {
    $false
  }
})
$withWindow = $processes | Where-Object { $_.MainWindowHandle -ne 0 } | Sort-Object StartTime -Descending | Select-Object -First 1
if ($withWindow) {
  if (-not ("RabiRouteChatGptVisibility.User32" -as [type])) {
    Add-Type @"
using System;
using System.Runtime.InteropServices;
namespace RabiRouteChatGptVisibility {
  public static class User32 {
    [DllImport("user32.dll")]
    public static extern bool SetForegroundWindow(IntPtr hWnd);
    [DllImport("user32.dll")]
    public static extern bool ShowWindowAsync(IntPtr hWnd, int nCmdShow);
  }
}
"@
  }
  [RabiRouteChatGptVisibility.User32]::ShowWindowAsync($withWindow.MainWindowHandle, 9) | Out-Null
  [RabiRouteChatGptVisibility.User32]::SetForegroundWindow($withWindow.MainWindowHandle) | Out-Null
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
  const timeoutMs = positiveIntegerFromEnv("CHATGPT_DESKTOP_VISIBILITY_TIMEOUT_MS", defaultTimeoutMs);
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
  throw new Error(output || "ChatGPT desktop host for Codex visibility script returned no result.");
}

async function discoverChatGptDesktopHostExecutableWithPowerShell(): Promise<string | undefined> {
  const script = `
$ErrorActionPreference = "SilentlyContinue"
$packages = @(
  @(Get-AppxPackage -Name OpenAI.Codex -ErrorAction SilentlyContinue)
  @(Get-AppxPackage -Name OpenAI.ChatGPT -ErrorAction SilentlyContinue)
)
$candidates = foreach ($package in $packages) {
  if (-not $package.InstallLocation) {
    continue
  }
  $manifestPath = Join-Path $package.InstallLocation "AppxManifest.xml"
  if (-not (Test-Path -LiteralPath $manifestPath)) {
    continue
  }
  try {
    [xml]$manifest = Get-Content -LiteralPath $manifestPath -Raw
    $application = $manifest.SelectSingleNode("//*[local-name()='Application' and @Executable]")
    $relativeExecutable = [string]$application.Executable
    if (-not $relativeExecutable) {
      continue
    }
    $executablePath = [System.IO.Path]::GetFullPath((Join-Path $package.InstallLocation $relativeExecutable))
    if (Test-Path -LiteralPath $executablePath) {
      [pscustomobject]@{
        Path = $executablePath
        Priority = if ([System.IO.Path]::GetFileName($executablePath) -ieq "ChatGPT.exe") { 0 } else { 1 }
        Version = [version]$package.Version
      }
    }
  } catch {
    continue
  }
}
$candidates |
  Sort-Object @{ Expression = { $_.Priority }; Ascending = $true }, @{ Expression = { $_.Version }; Descending = $true } |
  Select-Object -ExpandProperty Path -First 1
`;
  const encoded = encodePowerShell(script);
  const timeoutMs = positiveIntegerFromEnv("CHATGPT_DESKTOP_VISIBILITY_TIMEOUT_MS", defaultTimeoutMs);
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

export async function ensureChatGptDesktopHostVisible(
  reason: ChatGptDesktopHostVisibilityReason,
  options: { force?: boolean } = {}
): Promise<ChatGptDesktopHostVisibilityResult> {
  const now = Date.now();
  const at = new Date(now).toISOString();
  const minIntervalMs = positiveIntegerFromEnv("CHATGPT_DESKTOP_VISIBILITY_MIN_INTERVAL_MS", defaultMinIntervalMs);
  if (!chatGptDesktopHostVisibilityEnabled()) {
    return { attempted: false, ok: true, skipped: true, reason, message: "disabled", at };
  }
  if (process.platform !== "win32") {
    return { attempted: false, ok: true, skipped: true, reason, message: "non-windows", at };
  }
  if (!shouldEnsureChatGptDesktopHostVisibilityForTest(now, lastDesktopHostVisibilityEnsureAt, Boolean(options.force), minIntervalMs)) {
    return { attempted: false, ok: true, skipped: true, reason, message: "throttled", at };
  }

  lastDesktopHostVisibilityEnsureAt = now;
  let [target] = findChatGptDesktopHostExecutablesForTest();
  target = target ?? await discoverChatGptDesktopHostExecutableWithPowerShell();
  if (!target) {
    return {
      attempted: true,
      ok: false,
      reason,
      error: "ChatGPT desktop host was not found from OpenAI.Codex/OpenAI.ChatGPT Appx manifests or CHATGPT_DESKTOP_EXE_PATH.",
      at
    };
  }

  try {
    const result = await runVisibilityScript(target);
    if (result.mode === "started") {
      await wait(positiveIntegerFromEnv("CHATGPT_DESKTOP_VISIBILITY_STARTUP_DELAY_MS", defaultStartupDelayMs));
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

export function chatGptDesktopHostVisibilityStatePatch(result: ChatGptDesktopHostVisibilityResult): ChatGptDesktopHostVisibilityStatePatch {
  if (result.skipped) {
    return {};
  }
  return {
    lastChatGptDesktopHostVisibilityAt: result.at,
    lastChatGptDesktopHostVisibilityReason: result.reason,
    lastChatGptDesktopHostVisibilityMode: result.mode || "",
    lastChatGptDesktopHostVisibilityTarget: result.target || "",
    lastChatGptDesktopHostVisibilityError: result.ok ? "" : result.error || result.message || "ChatGPT desktop host visibility check failed."
  };
}
