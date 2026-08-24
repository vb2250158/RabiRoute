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

type RuntimeChild = Pick<ChildProcess, "exitCode" | "pid" | "unref"> &
  Partial<Pick<ChildProcess, "stdout" | "stderr">>;

type RuntimeOwner = {
  pid: number;
  owned: boolean;
};

export class SpeechRuntimeControlError extends Error {
  constructor(
    message: string,
    readonly status = 502,
    readonly detail = "",
    readonly resolution = ""
  ) {
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
  now?: () => number;
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
  private readonly now: () => number;
  private readonly startTimeoutMs: number;
  private readonly stopTimeoutMs: number;
  private transition: Promise<void> = Promise.resolve();
  private launchChild: RuntimeChild | null = null;
  private launchOutput = "";

  constructor(private readonly options: SpeechRuntimeControlOptions) {
    this.platform = options.platform ?? process.platform;
    this.existsSync = options.existsSync ?? fs.existsSync;
    this.inspect = options.inspect ?? (serviceUrl => inspectLocalSpeechService(serviceUrl, {
      includeCapabilities: false
    }));
    this.spawnRuntime = options.spawnRuntime ?? ((command, args, spawnOptions) => spawn(command, args, spawnOptions));
    this.inspectOwner = options.inspectOwner ?? inspectWindowsRuntimeOwner;
    this.killProcessTree = options.killProcessTree ?? killWindowsProcessTree;
    this.wait = options.wait ?? wait;
    this.now = options.now ?? Date.now;
    this.startTimeoutMs = options.startTimeoutMs ?? 120_000;
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
    startScript: string;
  } {
    const serviceRoot = path.join(this.options.rootDir, "plugin-adapters", "rabi-speech");
    return {
      serviceRoot,
      runtimeExecutable: path.join(serviceRoot, "runtime", "RabiSpeech.exe"),
      hostScript: path.join(serviceRoot, "scripts", "windows_host.py"),
      startScript: path.join(serviceRoot, "scripts", "start.ps1")
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
    if (!this.existsSync(paths.startScript)) {
      throw new SpeechRuntimeControlError("RabiSpeech 启动脚本不存在，请重新安装语音运行环境。", 409);
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
    let recoveredOwnedBindConflict = false;
    while (true) {
      if (!this.launchChild || this.launchChild.exitCode !== null) {
        this.launchOutput = "";
        this.launchChild = this.spawnRuntime(
          "powershell.exe",
          ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", paths.startScript],
          {
            cwd: paths.serviceRoot,
            detached: false,
            stdio: ["ignore", "pipe", "pipe"],
            windowsHide: true,
            env: {
              ...process.env,
              PYTHONUTF8: "1",
              PYTHONIOENCODING: "utf-8"
            }
          }
        );
        this.captureLaunchOutput(this.launchChild);
        this.launchChild.unref();
      }

      try {
        const status = await this.waitForState(serviceUrl, "online", this.startTimeoutMs, () => {
          if (this.launchChild?.exitCode != null) {
            throw new SpeechRuntimeControlError(
              `RabiSpeech 启动进程提前退出（code ${this.launchChild.exitCode}）。`,
              502,
              this.launchDetail(),
              this.launchResolution()
            );
          }
        });
        return { action: "started", status };
      } catch (error) {
        const latest = await this.inspect(serviceUrl);
        if (latest.state === "online") {
          return { action: "already_online", status: latest };
        }
        if (
          !recoveredOwnedBindConflict
          && error instanceof SpeechRuntimeControlError
          && await this.recoverOwnedBindConflict(paths)
        ) {
          recoveredOwnedBindConflict = true;
          continue;
        }
        throw error;
      }
    }
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
    const deadline = this.now() + timeoutMs;
    let latest = await this.inspect(serviceUrl);
    while (latest.state !== expected && this.now() < deadline) {
      beforeInspect?.();
      await this.wait(500);
      latest = await this.inspect(serviceUrl);
    }
    if (latest.state === expected) return latest;
    if (expected === "online") {
      throw new SpeechRuntimeControlError(
        "RabiSpeech 启动超时。",
        502,
        this.launchDetail(latest.error),
        this.launchResolution()
      );
    }
    throw new SpeechRuntimeControlError(
      "RabiSpeech 停止超时。",
      502,
      latest.error || "语音端口仍未释放。",
      "等待几秒后重新关闭；仍失败时检查 8781 端口占用。"
    );
  }

  private captureLaunchOutput(child: RuntimeChild): void {
    const capture = (chunk: unknown) => {
      const text = String(chunk || "");
      if (!text) return;
      this.launchOutput = `${this.launchOutput}${text}`.slice(-8_000);
    };
    child.stdout?.on("data", capture);
    child.stderr?.on("data", capture);
  }

  private launchDetail(latestError = ""): string {
    const output = this.redactLaunchOutput(this.launchOutput).trim();
    const health = latestError.trim();
    if (output && health) return `${health}\n启动日志：${output}`;
    if (output) return `启动日志：${output}`;
    return health || "启动进程仍在运行，但语音服务没有完成健康检查。";
  }

  private launchResolution(): string {
    const output = this.launchOutput;
    if (/ModuleNotFoundError|dependencies are missing|No module named/i.test(output)) {
      return "在“模型管理”中重新安装语音运行环境，或运行 plugin-adapters\\rabi-speech\\scripts\\install.ps1，然后重新启动。";
    }
    if (/address already in use|WinError 10048|only one usage of each socket/i.test(output)) {
      const port = this.launchBindPort();
      return `关闭占用 ${port ?? servicePort(this.options.serviceUrl())} 端口的旧进程，再重新启动语音服务。`;
    }
    if (/config(?:uration)? .*missing|JSONDecodeError|invalid.*config/i.test(output)) {
      return "检查当前用户 RabiSpeech 运行目录中的 config.json，修正配置后重新启动。";
    }
    return "关闭语音服务后重新启动；仍失败时运行 plugin-adapters\\rabi-speech\\scripts\\start.ps1 查看启动日志。";
  }

  private launchBindPort(): number | null {
    const matches = [
      /bind on address\s*\([^)]*?,\s*(\d{1,5})\s*\)/i,
      /(?:0\.0\.0\.0|127\.0\.0\.1|localhost|\[::\])[:'",\s]+(\d{1,5})\b/i
    ];
    for (const pattern of matches) {
      const value = Number(this.launchOutput.match(pattern)?.[1]);
      if (Number.isInteger(value) && value > 0 && value <= 65_535) return value;
    }
    return null;
  }

  private async recoverOwnedBindConflict(paths: ReturnType<SpeechRuntimeControl["runtimePaths"]>): Promise<boolean> {
    if (!/address already in use|WinError 10048|only one usage of each socket/i.test(this.launchOutput)) {
      return false;
    }
    const port = this.launchBindPort();
    if (!port) return false;
    const owner = await this.inspectOwner(port, paths.runtimeExecutable, paths.hostScript);
    if (!owner?.owned || owner.pid === this.launchChild?.pid) return false;
    await this.killProcessTree(owner.pid);
    this.launchChild = null;
    this.launchOutput = "";
    await this.wait(500);
    return true;
  }

  private redactLaunchOutput(value: string): string {
    let result = value.replaceAll(this.options.rootDir, "<RabiRoute>");
    result = result.replace(/[A-Z]:\\Users\\[^\\\r\n]+/gi, "<user>");
    return result.split(/\r?\n/).map(line => line.trim()).filter(Boolean).slice(-8).join("\n");
  }
}
