import fs from "node:fs";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
import type {
  SpeechRuntimeControlResult,
  SpeechRuntimeStatus
} from "../shared/speechControlContract.js";
import { normalizeLocalSpeechServiceUrl } from "../speech/localSpeechClient.js";
import { inspectLocalSpeechService } from "./speechServiceStatus.js";

const execFileAsync = promisify(execFile);

type RuntimeChild = Pick<ChildProcess, "exitCode" | "pid" | "unref">;

type RuntimeOwner = {
  pid: number;
  owned: boolean;
};

export class SpeechRuntimeControlError extends Error {
  constructor(message: string, readonly status = 502) {
    super(message);
    this.name = "SpeechRuntimeControlError";
  }
}

export type SpeechRuntimeControlOptions = {
  rootDir: string;
  serviceUrl(): string;
  platform?: NodeJS.Platform;
  existsSync?: typeof fs.existsSync;
  inspect?: (serviceUrl: string) => Promise<SpeechRuntimeStatus>;
  spawnRuntime?: (command: string, args: string[], options: Parameters<typeof spawn>[2]) => RuntimeChild;
  inspectOwner?: (port: number, expectedExecutable: string, expectedHostScript: string) => Promise<RuntimeOwner | null>;
  killProcessTree?: (pid: number) => Promise<void>;
  wait?: (milliseconds: number) => Promise<void>;
  startTimeoutMs?: number;
  stopTimeoutMs?: number;
};

function wait(milliseconds: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

function servicePort(serviceUrl: string): number {
  const parsed = new URL(normalizeLocalSpeechServiceUrl(serviceUrl));
  if (parsed.protocol !== "http:") {
    throw new SpeechRuntimeControlError("WebGUI 只能启动本机 HTTP RabiSpeech 服务。", 409);
  }
  const port = Number(parsed.port || "80");
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new SpeechRuntimeControlError("RabiSpeech 服务端口无效。", 409);
  }
  return port;
}

async function inspectWindowsRuntimeOwner(
  port: number,
  expectedExecutable: string,
  expectedHostScript: string
): Promise<RuntimeOwner | null> {
  const script = [
    "$port = [int]$env:RABIROUTE_SPEECH_PORT",
    "$expectedExe = [System.IO.Path]::GetFullPath($env:RABIROUTE_SPEECH_EXE)",
    "$expectedHost = [System.IO.Path]::GetFullPath($env:RABIROUTE_SPEECH_HOST_SCRIPT)",
    "$connections = @(Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction SilentlyContinue)",
    "$pids = @($connections | Select-Object -ExpandProperty OwningProcess -Unique)",
    "if ($pids.Count -eq 0) { Write-Output 'null'; exit 0 }",
    "if ($pids.Count -ne 1) { throw \"RabiSpeech port has multiple owners.\" }",
    "$targetPid = [int]$pids[0]",
    "$process = Get-CimInstance Win32_Process -Filter \"ProcessId = $targetPid\"",
    "if (-not $process) { throw \"RabiSpeech port owner disappeared.\" }",
    "$actualExe = if ($process.ExecutablePath) { [System.IO.Path]::GetFullPath([string]$process.ExecutablePath) } else { '' }",
    "$commandLine = [string]$process.CommandLine",
    "$ownedByExe = [System.StringComparer]::OrdinalIgnoreCase.Equals($actualExe, $expectedExe)",
    "$ownedByHost = $commandLine.IndexOf($expectedHost, [System.StringComparison]::OrdinalIgnoreCase) -ge 0",
    "[pscustomobject]@{ pid = $targetPid; owned = [bool]($ownedByExe -or $ownedByHost) } | ConvertTo-Json -Compress"
  ].join("\n");
  const { stdout } = await execFileAsync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
    timeout: 8_000,
    windowsHide: true,
    env: {
      ...process.env,
      RABIROUTE_SPEECH_PORT: String(port),
      RABIROUTE_SPEECH_EXE: expectedExecutable,
      RABIROUTE_SPEECH_HOST_SCRIPT: expectedHostScript
    }
  });
  const text = String(stdout || "").trim();
  if (!text || text === "null") return null;
  const value = JSON.parse(text) as Partial<RuntimeOwner>;
  const pid = Number(value.pid);
  if (!Number.isInteger(pid) || pid <= 0) {
    throw new SpeechRuntimeControlError("无法确认 RabiSpeech 端口所有者。", 409);
  }
  return { pid, owned: value.owned === true };
}

async function killWindowsProcessTree(pid: number): Promise<void> {
  await execFileAsync("taskkill.exe", ["/PID", String(pid), "/T", "/F"], {
    timeout: 8_000,
    windowsHide: true
  });
}

export class SpeechRuntimeControl {
  private readonly platform: NodeJS.Platform;
  private readonly existsSync: typeof fs.existsSync;
  private readonly inspect: (serviceUrl: string) => Promise<SpeechRuntimeStatus>;
  private readonly spawnRuntime: NonNullable<SpeechRuntimeControlOptions["spawnRuntime"]>;
  private readonly inspectOwner: NonNullable<SpeechRuntimeControlOptions["inspectOwner"]>;
  private readonly killProcessTree: NonNullable<SpeechRuntimeControlOptions["killProcessTree"]>;
  private readonly wait: (milliseconds: number) => Promise<void>;
  private readonly startTimeoutMs: number;
  private readonly stopTimeoutMs: number;
  private transition: Promise<void> = Promise.resolve();
  private launchChild: RuntimeChild | null = null;

  constructor(private readonly options: SpeechRuntimeControlOptions) {
    this.platform = options.platform ?? process.platform;
    this.existsSync = options.existsSync ?? fs.existsSync;
    this.inspect = options.inspect ?? (serviceUrl => inspectLocalSpeechService(serviceUrl));
    this.spawnRuntime = options.spawnRuntime ?? ((command, args, spawnOptions) => spawn(command, args, spawnOptions));
    this.inspectOwner = options.inspectOwner ?? inspectWindowsRuntimeOwner;
    this.killProcessTree = options.killProcessTree ?? killWindowsProcessTree;
    this.wait = options.wait ?? wait;
    this.startTimeoutMs = options.startTimeoutMs ?? 60_000;
    this.stopTimeoutMs = options.stopTimeoutMs ?? 15_000;
  }

  start(): Promise<SpeechRuntimeControlResult> {
    return this.runExclusive(() => this.startUnlocked());
  }

  stop(): Promise<SpeechRuntimeControlResult> {
    return this.runExclusive(() => this.stopUnlocked());
  }

  private runExclusive<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.transition.then(operation, operation);
    this.transition = next.then(() => undefined, () => undefined);
    return next;
  }

  private runtimePaths(): {
    serviceRoot: string;
    runtimeExecutable: string;
    hostScript: string;
  } {
    const serviceRoot = path.join(this.options.rootDir, "plugin-adapters", "rabi-speech");
    return {
      serviceRoot,
      runtimeExecutable: path.join(serviceRoot, "runtime", "RabiSpeech.exe"),
      hostScript: path.join(serviceRoot, "scripts", "windows_host.py")
    };
  }

  private assertWindowsRuntimeInstalled(paths: ReturnType<SpeechRuntimeControl["runtimePaths"]>): void {
    if (this.platform !== "win32") {
      throw new SpeechRuntimeControlError("WebGUI 启停 RabiSpeech 当前只支持 Windows 主机。", 409);
    }
    if (!this.existsSync(path.join(paths.serviceRoot, ".deps"))) {
      throw new SpeechRuntimeControlError("RabiSpeech 尚未安装依赖，请先运行 scripts\\install.ps1。", 409);
    }
    if (!this.existsSync(paths.runtimeExecutable)) {
      throw new SpeechRuntimeControlError("RabiSpeech Windows 运行时不存在，请先完成安装。", 409);
    }
    if (!this.existsSync(paths.hostScript)) {
      throw new SpeechRuntimeControlError("RabiSpeech Windows host 脚本不存在。", 409);
    }
  }

  private async startUnlocked(): Promise<SpeechRuntimeControlResult> {
    const serviceUrl = normalizeLocalSpeechServiceUrl(this.options.serviceUrl());
    servicePort(serviceUrl);
    const current = await this.inspect(serviceUrl);
    if (current.state === "online") {
      return { action: "already_online", status: current };
    }
    if (current.state === "invalid") {
      throw new SpeechRuntimeControlError(current.error || "RabiSpeech 服务地址无效。", 409);
    }

    const paths = this.runtimePaths();
    this.assertWindowsRuntimeInstalled(paths);
    if (!this.launchChild || this.launchChild.exitCode !== null) {
      this.launchChild = this.spawnRuntime(
        paths.runtimeExecutable,
        [paths.hostScript],
        {
          cwd: paths.serviceRoot,
          detached: true,
          stdio: "ignore",
          windowsHide: true
        }
      );
      this.launchChild.unref();
    }

    const status = await this.waitForState(serviceUrl, "online", this.startTimeoutMs, () => {
      if (this.launchChild?.exitCode != null) {
        throw new SpeechRuntimeControlError(`RabiSpeech 启动进程提前退出（code ${this.launchChild.exitCode}）。`);
      }
    });
    return { action: "started", status };
  }

  private async stopUnlocked(): Promise<SpeechRuntimeControlResult> {
    const serviceUrl = normalizeLocalSpeechServiceUrl(this.options.serviceUrl());
    const port = servicePort(serviceUrl);
    const paths = this.runtimePaths();
    this.assertWindowsRuntimeInstalled(paths);

    let targetPid: number | null = null;
    if (this.launchChild?.pid && this.launchChild.exitCode === null) {
      targetPid = this.launchChild.pid;
    } else {
      const owner = await this.inspectOwner(port, paths.runtimeExecutable, paths.hostScript);
      if (!owner) {
        const status = await this.inspect(serviceUrl);
        return { action: "already_offline", status };
      }
      if (!owner.owned) {
        throw new SpeechRuntimeControlError("拒绝停止：语音端口不是由当前工作区的 RabiSpeech 运行时占用。", 409);
      }
      targetPid = owner.pid;
    }

    await this.killProcessTree(targetPid);
    this.launchChild = null;
    const status = await this.waitForState(serviceUrl, "offline", this.stopTimeoutMs);
    return { action: "stopped", status };
  }

  private async waitForState(
    serviceUrl: string,
    expected: SpeechRuntimeStatus["state"],
    timeoutMs: number,
    beforeInspect?: () => void
  ): Promise<SpeechRuntimeStatus> {
    const deadline = Date.now() + timeoutMs;
    let latest = await this.inspect(serviceUrl);
    while (latest.state !== expected && Date.now() < deadline) {
      beforeInspect?.();
      await this.wait(500);
      latest = await this.inspect(serviceUrl);
    }
    if (latest.state === expected) return latest;
    throw new SpeechRuntimeControlError(expected === "online"
      ? "RabiSpeech 启动后未在时限内通过健康检查。"
      : "RabiSpeech 停止后语音端口仍未释放。");
  }
}
