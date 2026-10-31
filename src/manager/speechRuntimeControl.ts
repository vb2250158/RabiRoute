import { getTimeoutMs, readTimeoutOverrides } from "../shared/timeoutSettings.js";
import { stickySpeechAuthority, awaitSpeechAuthority, type SpeechAuthorityGuard } from "./speechRequestAuthority.js";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawn, type ChildProcess } from "node:child_process";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
import type {
  SpeechRuntimeControlResult,
  SpeechRuntimeStatus
} from "../shared/speechControlContract.js";
import { normalizeLocalSpeechServiceUrl } from "../speech/localSpeechClient.js";
import { inspectLocalSpeechService } from "./speechServiceStatus.js";
import { prepareStableSpeechExecutable } from "./speechStableExecutable.js";
import { packagedSpeechPython, speechCoreDependencyFiles } from "./speechDependencies.js";

const execFileAsync = promisify(execFile);

// pip creates its --target directory before installing packages. Check the core
// API and microphone modules before using that directory; startup health still
// verifies the actual imports and runtime, including their transitive dependencies.

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
  packageRoot?: string;
  serviceUrl(): string;
  ensureDependencies?: (allowFirstInstall: boolean) => Promise<void>;
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
  const hostname = parsed.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  const localAddresses = Object.values(os.networkInterfaces()).flatMap(items => (items ?? []).map(item => item.address.toLowerCase()));
  if (!["localhost", "::1", os.hostname().toLowerCase(), ...localAddresses].includes(hostname) && !/^127\./.test(hostname)) {
    throw new SpeechRuntimeControlError("该语音地址属于远端服务，本机无法管理其进程；请通过来源电脑的 Manager 启动或停止。语音 HTTP 调用仍可使用此地址。", 409);
  }

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
    "$ErrorActionPreference = 'Stop'",
    "$port = [int]$env:RABIROUTE_SPEECH_PORT",
    "$expectedExe = [System.IO.Path]::GetFullPath($env:RABIROUTE_SPEECH_EXE)",
    "$expectedHost = [System.IO.Path]::GetFullPath($env:RABIROUTE_SPEECH_HOST_SCRIPT)",
    // NetTCPIP's cold module/CIM initialization can exceed the plugin's entire
    // retirement deadline. The OS TCP table gives PIDs without that module;
    // the process identity check below still decides whether stopping is allowed.
    "$netstatPath = [System.IO.Path]::Combine($env:SystemRoot, 'System32', 'netstat.exe')",
    "if (-not [System.IO.Path]::IsPathRooted($netstatPath)) { throw 'Windows system directory is unavailable.' }",
    "$ownerPids = @()",
    "$knownStates = @('BOUND', 'CLOSED', 'CLOSE_WAIT', 'CLOSING', 'DELETE_TCB', 'ESTABLISHED', 'FIN_WAIT_1', 'FIN_WAIT_2', 'LAST_ACK', 'LISTENING', 'SYN_RECEIVED', 'SYN_SENT', 'TIME_WAIT')",
    // Windows exposes IPv4 and IPv6 in separate netstat protocol tables.
    // Both must be valid before the absence of a listener can be confirmed.
    "foreach ($protocol in @('tcp', 'tcpv6')) {",
    "$netstatLines = @(& $netstatPath -ano -p $protocol)",
    "if ($LASTEXITCODE -ne 0) { throw 'Windows TCP table query failed.' }",
    "$hasHeader = $false",
    "foreach ($line in $netstatLines) {",
    "  if ($line -match '^\\s*\\S+\\s+.+\\s+PID\\s*$' -and $line -notmatch '^\\s*TCP\\s') { $hasHeader = $true; continue }",
    "  if ($line -notmatch '^\\s*TCP(?:\\s|$)') { if ($hasHeader -and $line.Trim()) { throw 'Unknown Windows TCP table record.' }; continue }",
    "  $columns = @($line.Trim() -split '\\s+')",
    "  if ($columns.Count -ne 5) { throw 'Malformed Windows TCP table record.' }",
    "  if ($columns[1] -notmatch '^(?:\\[[^\\]]+\\]|[^:]+):([0-9]+)$') { throw 'Malformed Windows TCP local endpoint.' }",
    "  $localPort = 0; if (-not [int]::TryParse($Matches[1], [ref]$localPort) -or $localPort -lt 1 -or $localPort -gt 65535) { throw 'Invalid Windows TCP local port.' }",
    "  $localHost = $columns[1].Substring(0, $columns[1].LastIndexOf(':')).Trim('[', ']'); $localAddress = $null",
    "  if (-not [System.Net.IPAddress]::TryParse($localHost, [ref]$localAddress)) { throw 'Invalid Windows TCP local address.' }",
    "  if ($localPort -ne $port) { continue }",
    "  if ($knownStates -cnotcontains $columns[3]) { throw 'Unknown Windows TCP state.' }",
    "  if ($columns[3] -cne 'LISTENING') { continue }",
    "  $listenerPid = 0; if (-not [int]::TryParse($columns[4], [ref]$listenerPid) -or $listenerPid -le 0) { throw 'Invalid Windows TCP listener PID.' }",
    "  $ownerPids += $listenerPid",
    "}",
    // Headers are localized; PID and TCP are fixed OS field/protocol names.
    // An empty or unrecognized response must not become an offline confirmation.
    "if (-not $hasHeader) { throw 'Windows TCP table header is missing.' }",
    "}",
    "$pids = @($ownerPids | Select-Object -Unique)",
    "if ($pids.Count -eq 0) { Write-Output 'null'; exit 0 }",
    "if ($pids.Count -ne 1) { throw \"RabiSpeech port has multiple owners.\" }",
    "$targetPid = [int]$pids[0]",
    // A verified executable already satisfies the existing OR ownership rule.
    // Avoid loading CIM and reading the command line for that sufficient fact.
    "$nativeProcess = $null; try { $nativeProcess = [System.Diagnostics.Process]::GetProcessById($targetPid) } catch { throw 'RabiSpeech port owner disappeared.' }",
    "try {",
    "  $exitState = $null; try { $exitState = $nativeProcess.HasExited } catch { }; if ($exitState -is [bool] -and $exitState) { throw 'RabiSpeech port owner disappeared.' }; $nativeStateKnown = $exitState -is [bool]",
    "  $canReuseExecutable = $false; try { $heldHandle = $nativeProcess.Handle; $canReuseExecutable = [bool]$heldHandle -and $heldHandle -ne [System.IntPtr]::Zero } catch { }",
    "  $actualExe = ''; try { $module = $nativeProcess.MainModule; if ($module -and $module.FileName) { $actualExe = [System.IO.Path]::GetFullPath([string]$module.FileName) } } catch { }",
    "  $exitState = $null; try { $exitState = $nativeProcess.HasExited } catch { }; if ($exitState -is [bool] -and $exitState) { throw 'RabiSpeech port owner disappeared.' }; $nativeStateKnown = $exitState -is [bool]",
    "  if ($nativeStateKnown -and [System.StringComparer]::OrdinalIgnoreCase.Equals($actualExe, $expectedExe)) { [pscustomobject]@{ pid = $targetPid; owned = $true } | ConvertTo-Json -Compress; return }",
    // Native WMI exposes the same authoritative Win32_Process properties without
    // the CIM cmdlet's cold module load. Access/architecture failures above keep
    // the original executable-or-host-script fallback available.
    "$identityFields = if ($nativeStateKnown -and $canReuseExecutable -and $actualExe) { 'CommandLine' } else { 'ExecutablePath,CommandLine' }",
    "$searcher = [System.Management.ManagementObjectSearcher]::new(\"SELECT $identityFields FROM Win32_Process WHERE ProcessId=$targetPid\")",
    "try {",
    "$processes = $searcher.Get()",
    "try {",
    "$found = $false; $result = $null",
    "foreach ($process in $processes) { try {",
    "if ($found) { throw 'Windows process identity query returned multiple owners.' }; $found = $true",
    "if ($identityFields -ne 'CommandLine') { $actualExe = if ($process.ExecutablePath) { [System.IO.Path]::GetFullPath([string]$process.ExecutablePath) } else { '' } }",
    "$commandLine = [string]$process.CommandLine",
    "$ownedByExe = [System.StringComparer]::OrdinalIgnoreCase.Equals($actualExe, $expectedExe)",
    "$ownedByHost = $commandLine.IndexOf($expectedHost, [System.StringComparison]::OrdinalIgnoreCase) -ge 0",
    "$result = [pscustomobject]@{ pid = $targetPid; owned = [bool]($ownedByExe -or $ownedByHost) }",
    "} finally { $process.Dispose() } }",
    "if (-not $found) { throw 'RabiSpeech port owner disappeared.' }",
    "$exitState = $null; try { $exitState = $nativeProcess.HasExited } catch { }; if ($exitState -is [bool] -and $exitState) { throw 'RabiSpeech port owner disappeared.' }",
    "$result | ConvertTo-Json -Compress",
    "} finally { $processes.Dispose() }",
    "} finally { $searcher.Dispose() }",
    "} finally { $nativeProcess.Dispose() }"
  ].join("\n");
  const { stdout } = await execFileAsync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
    timeout: getTimeoutMs("backend.manager.speechRuntimeControl.inspectWindowsRuntimeOwner.execFileAsync.timeout", 8_000),
    windowsHide: true,
    env: {
              RABIROUTE_TIMEOUT_OVERRIDES: JSON.stringify(readTimeoutOverrides()),
      ...process.env,
      RABIROUTE_SPEECH_PORT: String(port),
      RABIROUTE_SPEECH_EXE: expectedExecutable,
      RABIROUTE_SPEECH_HOST_SCRIPT: expectedHostScript
    }
  });
  const text = String(stdout || "").trim();
  if (text === "null") return null;
  if (!text) throw new SpeechRuntimeControlError("无法确认 RabiSpeech 端口所有者：系统查询没有返回结果。", 409);
  const value = JSON.parse(text) as Partial<RuntimeOwner>;
  const pid = Number(value.pid);
  if (!Number.isInteger(pid) || pid <= 0) {
    throw new SpeechRuntimeControlError("无法确认 RabiSpeech 端口所有者。", 409);
  }
  return { pid, owned: value.owned === true };
}

async function killWindowsProcessTree(pid: number): Promise<void> {
  await execFileAsync("taskkill.exe", ["/PID", String(pid), "/T", "/F"], {
    timeout: getTimeoutMs("backend.manager.speechRuntimeControl.killWindowsProcessTree.execFileAsync.timeout", 8_000),
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
    this.startTimeoutMs = options.startTimeoutMs ?? getTimeoutMs("backend.manager.speechRuntimeControl.owner.startTimeoutMs", 120_000);
    this.stopTimeoutMs = options.stopTimeoutMs ?? getTimeoutMs("backend.manager.speechRuntimeControl.owner.stopTimeoutMs", 15_000);
  }

  start(guard?: SpeechAuthorityGuard, allowFirstInstall = true): Promise<SpeechRuntimeControlResult> {
    const authority = stickySpeechAuthority(guard);
    authority();
    return this.runExclusive(() => awaitSpeechAuthority(authority, () => this.startUnlocked(authority, allowFirstInstall)));
  }

  stop(guard?: SpeechAuthorityGuard): Promise<SpeechRuntimeControlResult> {
    const authority = stickySpeechAuthority(guard);
    authority();
    return this.runExclusive(() => awaitSpeechAuthority(authority, () => this.stopUnlocked(authority)));
  }

  private runExclusive<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.transition.then(operation, operation);
    this.transition = next.then(() => undefined, () => undefined);
    return next;
  }

  private runtimePaths(): {
    serviceRoot: string;
    dependenciesRoot: string;
    runtimeExecutable: string;
    bundledExecutable: string;
    hostScript: string;
    startScript: string;
  } {
    const serviceRoot = path.join(this.options.packageRoot ?? this.options.rootDir, "plugin-adapters", "rabi-speech");
    const stableDependencies = path.join(this.options.rootDir, "plugin-adapters", "rabi-speech", ".deps");
    const bundledDependencies = path.join(serviceRoot, ".deps");
    const bundledExecutable = path.join(serviceRoot, "runtime", "RabiSpeech.exe");
    return {
      serviceRoot,
      // Existing packaged installers write beside their scripts. Retain that
      // current-release result until installation writes the stable state root;
      // a complete stable installation always takes precedence across releases.
      dependenciesRoot: this.dependenciesPresent(stableDependencies) ? stableDependencies : bundledDependencies,
      bundledExecutable,
      runtimeExecutable: this.options.packageRoot && path.resolve(this.options.packageRoot) !== path.resolve(this.options.rootDir)
        || !this.existsSync(bundledExecutable) && !!packagedSpeechPython(this.options.packageRoot ?? this.options.rootDir)
        ? path.join(this.options.rootDir, "runtime", "speech", "RabiSpeech.exe")
        : path.join(serviceRoot, "runtime", "RabiSpeech.exe"),
      hostScript: path.join(serviceRoot, "scripts", "windows_host.py"),
      startScript: path.join(serviceRoot, "scripts", "start.ps1")
    };
  }

  private dependenciesPresent(root: string): boolean {
    return speechCoreDependencyFiles.every(relative => this.existsSync(path.join(root, relative)));
  }

  /**
   * TTS workers and model paths belong to the Windows user, not the NAS source
   * tree or the replaceable program bundle.  The bundled adapter still provides
   * code and dependencies; its host reads this user-local configuration.
   */
  private userSpeechConfigPath(paths: ReturnType<SpeechRuntimeControl["runtimePaths"]>): string {
    const localAppData = process.env.LOCALAPPDATA;
    return localAppData
      ? path.join(localAppData, "RabiPC", "RabiSpeech", "config.json")
      : path.join(paths.serviceRoot, "config.json");
  }

  private assertWindowsRuntimePlatform(): void {
    if (this.platform !== "win32") {
      throw new SpeechRuntimeControlError("WebGUI 启停 RabiSpeech 当前只支持 Windows 主机。", 409);
    }
  }

  private assertWindowsRuntimeInstalled(paths: ReturnType<SpeechRuntimeControl["runtimePaths"]>): void {
    this.assertWindowsRuntimePlatform();
    if (!this.dependenciesPresent(paths.dependenciesRoot)) {
      throw new SpeechRuntimeControlError("RabiSpeech 尚未安装依赖，请先运行 scripts\\install.ps1。", 409);
    }
    if (!this.existsSync(paths.bundledExecutable) && !packagedSpeechPython(this.options.packageRoot ?? this.options.rootDir)) {
      throw new SpeechRuntimeControlError("RabiSpeech Windows 运行时不存在，请先完成安装。", 409);
    }
    if (!this.existsSync(paths.hostScript)) {
      throw new SpeechRuntimeControlError("RabiSpeech Windows host 脚本不存在。", 409);
    }
    if (!this.existsSync(paths.startScript)) {
      throw new SpeechRuntimeControlError("RabiSpeech 启动脚本不存在，请重新安装语音运行环境。", 409);
    }
  }

  private async startUnlocked(guard?: SpeechAuthorityGuard, allowFirstInstall = true): Promise<SpeechRuntimeControlResult> {
    guard = stickySpeechAuthority(guard);
    guard();
    const serviceUrl = normalizeLocalSpeechServiceUrl(this.options.serviceUrl());
    servicePort(serviceUrl);
    const current = await awaitSpeechAuthority(guard, () => this.inspect(serviceUrl));
    if (current.state === "online") {
      return { action: "already_online", status: current };
    }
    if (current.state === "invalid") {
      throw new SpeechRuntimeControlError(current.error || "RabiSpeech 服务地址无效。", 409);
    }

    await awaitSpeechAuthority(guard, async () => { await this.options.ensureDependencies?.(allowFirstInstall); });
    const paths = this.runtimePaths();
    this.assertWindowsRuntimeInstalled(paths);
    const bundledHost = this.existsSync(paths.bundledExecutable);
    const python = packagedSpeechPython(this.options.packageRoot ?? this.options.rootDir);
    const executableSource = bundledHost ? paths.bundledExecutable : python!;
    if (paths.runtimeExecutable !== executableSource) await awaitSpeechAuthority(guard, () => prepareStableSpeechExecutable(executableSource, this.options.rootDir, guard));
    let recoveredOwnedBindConflict = false;
    while (true) {
      if (!this.launchChild || this.launchChild.exitCode !== null) {
        guard();
        this.launchOutput = "";
        this.launchChild = this.spawnRuntime(
          "powershell.exe",
          ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", paths.startScript,
            ...(python ? ["-Python", python] : [])],
          {
            cwd: paths.serviceRoot,
            detached: false,
            stdio: ["ignore", "pipe", "pipe"],
            windowsHide: true,
            env: {
              ...process.env,
              RABIROUTE_TIMEOUT_OVERRIDES: JSON.stringify(readTimeoutOverrides()),
              PYTHONUTF8: "1",
              PYTHONIOENCODING: "utf-8",
              RABISPEECH_DEPS_ROOT: paths.dependenciesRoot,
              // Both optional speech bundles and the standard portable Python
              // use the same stable executable identity outside the sealed release.
              RABISPEECH_HOST_EXECUTABLE: paths.runtimeExecutable,
              RABISPEECH_CONFIG: this.userSpeechConfigPath(paths)
            }
          }
        );
        this.captureLaunchOutput(this.launchChild);
        this.launchChild.unref();
      }

      try {
        const status = await awaitSpeechAuthority(guard, () => this.waitForState(serviceUrl, "online", getTimeoutMs("speech.start", this.startTimeoutMs), () => {
          if (this.launchChild?.exitCode != null) {
            throw new SpeechRuntimeControlError(
              `RabiSpeech 启动进程提前退出（code ${this.launchChild.exitCode}）。`,
              502,
              this.launchDetail(),
              this.launchResolution()
            );
          }
        }, guard));
        return { action: "started", status };
      } catch (error) {
        guard();
        const latest = await awaitSpeechAuthority(guard, () => this.inspect(serviceUrl));
        if (latest.state === "online") {
          return { action: "already_online", status: latest };
        }
        if (
          !recoveredOwnedBindConflict
          && error instanceof SpeechRuntimeControlError
          && await awaitSpeechAuthority(guard, () => this.recoverOwnedBindConflict(paths, guard))
        ) {
          recoveredOwnedBindConflict = true;
          continue;
        }
        throw error;
      }
    }
  }

  private async stopUnlocked(guard?: SpeechAuthorityGuard): Promise<SpeechRuntimeControlResult> {
    guard = stickySpeechAuthority(guard);
    guard();
    const serviceUrl = normalizeLocalSpeechServiceUrl(this.options.serviceUrl());
    const port = servicePort(serviceUrl);
    const paths = this.runtimePaths();
    // Shutdown needs process ownership, not the dependencies required to start it.
    // An optional runtime may never have been installed, or its files may be gone.
    this.assertWindowsRuntimePlatform();

    let targetPid: number | null = null;
    if (this.launchChild?.pid && this.launchChild.exitCode === null) {
      targetPid = this.launchChild.pid;
    } else {
      const owner = await awaitSpeechAuthority(guard, () => this.inspectOwner(port, paths.runtimeExecutable, paths.hostScript));
      if (!owner) {
        const status = await awaitSpeechAuthority(guard, () => this.inspect(serviceUrl));
        if (status.state !== "offline") {
          throw new SpeechRuntimeControlError("无法确认 RabiSpeech 已停止：服务仍在线，但没有可验证的进程拥有者。", 502);
        }
        return { action: "already_offline", status };
      }
      if (!owner.owned) {
        throw new SpeechRuntimeControlError("拒绝停止：语音端口不是由当前工作区的 RabiSpeech 运行时占用。", 409);
      }
      targetPid = owner.pid;
    }

    await awaitSpeechAuthority(guard, () => this.killProcessTree(targetPid));
    this.launchChild = null;
    const status = await awaitSpeechAuthority(guard, () => this.waitForState(serviceUrl, "offline", getTimeoutMs("speech.stop", this.stopTimeoutMs), undefined, guard));
    return { action: "stopped", status };
  }

  private async waitForState(
    serviceUrl: string,
    expected: SpeechRuntimeStatus["state"],
    timeoutMs: number,
    beforeInspect?: () => void, guard?: SpeechAuthorityGuard
  ): Promise<SpeechRuntimeStatus> {
    guard = stickySpeechAuthority(guard);
    guard();
    const deadline = this.now() + timeoutMs;
    let latest = await awaitSpeechAuthority(guard, () => this.inspect(serviceUrl));
    while (latest.state !== expected && this.now() < deadline) {
      beforeInspect?.();
      await awaitSpeechAuthority(guard, () => this.wait(500));
      latest = await awaitSpeechAuthority(guard, () => this.inspect(serviceUrl));
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
      if (this.launchChild !== child) return;
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

  private async recoverOwnedBindConflict(paths: ReturnType<SpeechRuntimeControl["runtimePaths"]>, guard?: SpeechAuthorityGuard): Promise<boolean> {
    guard = stickySpeechAuthority(guard);
    guard();
    if (!/address already in use|WinError 10048|only one usage of each socket/i.test(this.launchOutput)) {
      return false;
    }
    const port = this.launchBindPort();
    if (!port) return false;
    const owner = await awaitSpeechAuthority(guard, () => this.inspectOwner(port, paths.runtimeExecutable, paths.hostScript));
    if (!owner?.owned || owner.pid === this.launchChild?.pid) return false;
    await awaitSpeechAuthority(guard, () => this.killProcessTree(owner.pid));
    this.launchChild = null;
    this.launchOutput = "";
    await awaitSpeechAuthority(guard, () => this.wait(500));
    return true;
  }

  private redactLaunchOutput(value: string): string {
    let result = value.replaceAll(this.options.rootDir, "<RabiRoute>");
    result = result.replace(/[A-Z]:\\Users\\[^\\\r\n]+/gi, "<user>");
    return result.split(/\r?\n/).map(line => line.trim()).filter(Boolean).slice(-8).join("\n");
  }
}
