import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const read = (relative) => fs.readFileSync(new URL(relative, import.meta.url), "utf8");
const packageJson = JSON.parse(read("../package.json"));
const retiredLauncherPath = fileURLToPath(new URL("../Start-RabiRoute-Desktop.bat", import.meta.url));
const hostRuntime = read("../desktop/windows-host/HostRuntime.cs");
const hostProtocol = read("../desktop/windows-host/HostProtocol.cs");
const hostControlAudit = read("../desktop/windows-host/HostControlAudit.cs");
const hostProgram = read("../desktop/windows-host/Program.cs");
const windowsJob = read("../desktop/windows-host/WindowsJob.cs");
const trayLifecycleChannel = read("../desktop/windows-host/TrayLifecycleChannel.cs");
const trayEntry = read("../desktop/tray-task-window/main.py");
const trayApp = read("../desktop/tray-task-window/rabiroute_tray/tray_app.py");
const trayLifecycleController = read("../desktop/tray-task-window/rabiroute_tray/lifecycle_controller.py");
const trayRequirements = read("../desktop/tray-task-window/requirements.txt");
const desktopRuntimeBuild = read("./build-desktop-runtime.ps1");
const windowsReleaseBuild = read("./build-windows-release.ps1");
const releaseManifestBuilder = read("./create-windows-release-manifest.mjs");
const legacyRuntimeStop = read("./Stop-LegacyRabiRouteRuntime.ps1");
const fencedHostStop = read("./Stop-RabiRouteHostFenced.ps1");
const releaseTransaction = read("./Install-RabiRouteReleaseTransaction.ps1");
const legacyWearableTaskMigration = read("./Migrate-LegacyWearableHealthTask.ps1");
const installer = read("../installer/RabiRoute.iss");
const autostartConfigurator = fileURLToPath(new URL("./Configure-WindowsAutostart.ps1", import.meta.url));
const autostartConfiguratorSource = read("./Configure-WindowsAutostart.ps1");
const speechServiceInstaller = read("../plugin-adapters/rabi-speech/scripts/install-service.ps1");
const speechPluginDocs = read("../docs/rabispeech-plugin.md");
const speechPluginDocsEn = read("../docs/rabispeech-plugin_en.md");

test("Windows production package exposes only the lifecycle-owning Host entry", () => {
  assert.equal("start:windows" in packageJson.scripts, false);
  assert.equal(fs.existsSync(retiredLauncherPath), false, "the retired BAT launcher must not remain a source entry");
  const rootFileCopyBlock = windowsReleaseBuild.slice(
    windowsReleaseBuild.indexOf("foreach ($relative in @("),
    windowsReleaseBuild.indexOf("Copy-Item -LiteralPath $desktopRuntime"),
  );
  assert.doesNotMatch(rootFileCopyBlock, /Start-RabiRoute-Desktop\.bat/);

  assert.match(installer, /Filename: "\{app\}\\RabiRouteHost\.exe"/);
  assert.match(installer, /Install-RabiRouteReleaseTransaction\.ps1/);
  assert.match(installer, /Migrate-LegacyWearableHealthTask\.ps1/);
  assert.match(installer, /RabiRoute-portable\.zip/);
  assert.doesNotMatch(installer, /allow-unfenced-quit/);
  assert.doesNotMatch(installer, /Filename: "\{app\}\\(?:RabiRoute-Desktop|RabiRoute-Tray)\.exe"/);
  assert.doesNotMatch(installer, /127\.0\.0\.1:8790/);
});

test("Host rejects an in-place portable overlay before composing a generation", () => {
  const retiredEntries = [
    "RabiRoute-Desktop.exe",
    "RabiRoute-Tray.exe",
    "RabiRoute-Tray.new.exe",
    "Start-RabiRoute-Tray.bat",
    "Start-RabiRoute-Health-Watchdog.bat",
    "Start-RabiRoute-MessageAdapter-Watchdog.bat",
    "Install-RabiRoute-HealthWatchdogTask.ps1",
    "watch-message-adapters.ps1",
    "watch-rabiroute-desktop-lifecycle.ps1",
    "watch-rabiroute-health-hidden.vbs",
    "watch-rabiroute-health.ps1",
  ];
  for (const entry of retiredEntries) {
    const leaf = path.basename(entry);
    assert.ok(hostProgram.includes(`"${leaf}"`), `Host guard must recognize ${entry}`);
    assert.ok(releaseTransaction.includes(leaf), `release transaction must quarantine ${entry}`);
  }
  assert.match(hostProgram, /legacy_overlay_blocked/);
  assert.match(hostProgram, /new empty folder/);
  assert.match(hostProgram, /Windows Setup/);
  const retiredGuardIndex = hostProgram.indexOf(
    "PortableOverlayGuard.FindRetiredLifecycleEntriesForStartup(packageRoot, stateRoot)",
  );
  const hostCompositionIndex = hostProgram.indexOf("new HostRuntime(");
  assert.notEqual(retiredGuardIndex, -1, "startup must invoke the two-root retired lifecycle guard");
  assert.notEqual(hostCompositionIndex, -1, "contract must locate Host composition before comparing order");
  assert.ok(
    retiredGuardIndex < hostCompositionIndex,
    "portable overlay detection must run before Manager or Tray composition",
  );
  assert.doesNotMatch(hostProgram, /Delete|File\.Move|File\.Delete|Directory\.Delete/);
  assert.match(releaseTransaction, /\.rabiroute-quarantine/);
  assert.match(releaseTransaction, /legacy-runtime/);
  assert.match(releaseTransaction, /\.retired/);
  assert.match(releaseTransaction, /status="planned"/);
  assert.match(releaseTransaction, /status = "moved"/);
  assert.doesNotMatch(releaseTransaction, /Remove-Item[\s\S]{0,100}\$quarantineRoot/);
});

test("RabiSpeech documentation has one Host-owned lifecycle entry", () => {
  for (const docs of [speechPluginDocs, speechPluginDocsEn]) {
    assert.match(docs, /RabiRouteHost\.exe/);
    assert.match(docs, /install-service\.ps1/);
    assert.doesNotMatch(docs, /install-service\.ps1\s+-StartNow/);
  }
});

test("installer commits its autostart choice to the Manager desktop settings truth", () => {
  assert.match(installer, /function InstallTransaction: Boolean/);
  assert.match(installer, /WizardIsTaskSelected\('autostart'\)/);
  assert.match(installer, /Configure-WindowsAutostart\.ps1/);
  assert.match(installer, /RunPowerShell\([\s\S]*ResultCode/);
  assert.match(installer, /PrepareToInstall[\s\S]*InstallTransaction/);
  assert.match(releaseTransaction, /\$AutostartEnabled/);
  assert.match(installer, / -AutostartEnabled /);
  assert.match(releaseTransaction, /"-PreflightOnly"/);
  assert.match(releaseTransaction, /"Autostart commit"/);
  assert.doesNotMatch(installer, /Type: files; Name: "\{userstartup\}\\RabiRoute\.lnk"/);
  assert.doesNotMatch(installer, /Name: "\{userstartup\}\\RabiRoute"/);
  assert.match(
    autostartConfiguratorSource,
    /Join-Path \$install "Start-RabiRoute-Desktop\.bat"/,
    "autostart migration must still recognize an exact shortcut target to the retired BAT",
  );

  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-autostart-contract-"));
  const appData = path.join(root, "appdata");
  const installRoot = path.join(root, "install");
  fs.mkdirSync(installRoot, { recursive: true });
  fs.writeFileSync(path.join(installRoot, "RabiRouteHost.exe"), "fixture", "utf8");
  const settingsPath = path.join(root, "data", "desktop", "settings.json");
  try {
    const actualSettings = path.join(installRoot, "data", "desktop", "settings.json");
    fs.mkdirSync(path.dirname(actualSettings), { recursive: true });
    fs.writeFileSync(actualSettings, JSON.stringify({ theme: "dark", autostart: false }), "utf8");
    const powershell = process.env.SystemRoot ? path.join(process.env.SystemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe") : "powershell.exe";
    const run = (enabled) => spawnSync(powershell, ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", autostartConfigurator, "-InstallRoot", installRoot, "-Enabled", enabled], { encoding: "utf8", env: { ...process.env, APPDATA: appData } });
    const enabled = run("true");
    assert.equal(enabled.status, 0, enabled.stderr || enabled.stdout);
    assert.deepEqual(JSON.parse(fs.readFileSync(actualSettings, "utf8")), { theme: "dark", autostart: true });

    const disabled = run("false");
    assert.equal(disabled.status, 0, disabled.stderr || disabled.stdout);
    assert.deepEqual(JSON.parse(fs.readFileSync(actualSettings, "utf8")), { theme: "dark", autostart: false });

    fs.writeFileSync(actualSettings, "{broken", "utf8");
    const rejected = run("true");
    assert.notEqual(rejected.status, 0);
    assert.equal(fs.readFileSync(actualSettings, "utf8"), "{broken");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("Host owns one complete Manager and Tray application generation", () => {
  assert.match(hostProgram, /NamedMutexLease\(HostIdentity\.MutexName\)/);
  assert.match(windowsJob, /JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE/);
  assert.match(windowsJob, /CREATE_SUSPENDED/);
  assert.match(windowsJob, /AssignProcessToJobObject/);

  assert.match(hostRuntime, /ManagerPortPreference\.ResolveStartupPolicy\(stateRoot, log\)/);
  assert.match(hostRuntime, /\["GATEWAY_MANAGER_PORT"\] = managerPortPolicy/);
  assert.match(hostRuntime, /ManagerPortPreference\.SaveSuccessfulEndpoint\(stateRoot, ready\.BaseUrl, log\)/);
  assert.match(hostRuntime, /RABIROUTE_MANAGER_READY/);
  assert.ok(
    hostRuntime.indexOf("var ready = await readiness.Task")
      < hostRuntime.indexOf("tray = NativeChildProcess.StartSuspendedInJob"),
    "Tray must start only after this generation's structured Manager READY",
  );
  assert.match(hostRuntime, /"--manager-url", ready\.BaseUrl/);
  assert.match(hostRuntime, /"--host-lifecycle-pipe", lifecyclePipe/);
  assert.match(hostRuntime, /BuildTrayArguments\([\s\S]{0,300}trayLifecycle\.PipeName\)/);
  assert.match(
    hostRuntime,
    /trayLifecycle\.WaitForReadyAsync\([\s\S]*generationId,[\s\S]*ready\.ManagerInstanceId,[\s\S]*tray\.ProcessId,[\s\S]*TrayReadyTimeout/,
  );
  assert.match(hostRuntime, /Tray exited before publishing exact Host lifecycle READY/);
  assert.match(hostRuntime, /\["RABIROUTE_HOST_CONTROL_TOKEN"\] = null/);
  assert.doesNotMatch(hostRuntime, /_tray\.TryCloseMainWindow/);
  assert.match(trayLifecycleChannel, /PipeOptions\.CurrentUserOnly/);
  assert.match(trayLifecycleChannel, /Encoding\.UTF8\.GetBytes\("shutdown\\n"\)/);
});

test("Hosted Tray is a thin surface and never acquires lifecycle ownership", () => {
  for (const required of [
    "--surface-child",
    "--manager-url",
    "--application-generation-id",
    "--manager-instance-id",
    "--host-executable",
    "--host-lifecycle-pipe",
  ]) assert.ok(trayEntry.includes(`"${required}"`), `missing hosted Tray argument ${required}`);

  assert.match(trayEntry, /RabiRoute Tray can only be launched by RabiRoute Host/);
  assert.match(trayApp, /QLocalSocket/);
  assert.match(trayApp, /raw_command\.strip\(\)\.lower\(\) == b"shutdown"/);
  assert.doesNotMatch(trayApp, /QLockFile|desktop-instance\.lock|lock\.unlock\(\)/);
  assert.doesNotMatch(trayEntry, /_start_manager|resolve_manager_endpoint|--owns-manager|--startup-status/);
  assert.match(trayLifecycleController, /"--command",\s*"quit"/);
  assert.match(trayLifecycleController, /"--application-generation-id"/);

  assert.match(desktopRuntimeBuild, /Copy-Item .*"main\.py"/s);
  assert.match(desktopRuntimeBuild, /Copy-Item .*"rabiroute_tray"/s);
  assert.match(desktopRuntimeBuild, /python-\$PythonVersion-embed-amd64\.zip/);
  assert.match(desktopRuntimeBuild, /--target \$sitePackages/);
  assert.match(desktopRuntimeBuild, /--ignore-installed/);
  assert.match(desktopRuntimeBuild, /--no-warn-conflicts/);
  assert.match(hostRuntime, /"desktop-runtime", "python", "pythonw\.exe"/);
  assert.match(hostRuntime, /BuildTrayArguments[\s\S]{0,800}"-B",\s*trayMain/);
  assert.equal(hostRuntime.match(/"-B"/g)?.length, 1, "Host must inject exactly one Python no-bytecode switch before the Tray script");
  assert.match(desktopRuntimeBuild, /\$runtimePython -B -I -c \$qtSmoke/);
  assert.doesNotMatch(hostRuntime, /"python", "Scripts", "pythonw\.exe"/);
  assert.doesNotMatch(desktopRuntimeBuild, /-m venv/);
  assert.doesNotMatch(desktopRuntimeBuild, /RabiRoute-Desktop\.exe|RabiRoute-Tray\.exe/);
});

test("Host control and diagnostics cannot wedge the lifecycle owner", () => {
  assert.match(hostProtocol, /PipeOptions\.Asynchronous \| PipeOptions\.CurrentUserOnly/);
  assert.match(hostRuntime, /readCancellation\.CancelAfter\(TimeSpan\.FromSeconds\(5\)\)/);
  assert.doesNotMatch(hostRuntime, /completion\.Task\.WaitAsync\(TimeSpan/);
  assert.match(hostProtocol, /ControlFenceGenerationId/);
  assert.match(hostRuntime, /string\.Equals\(_state, "healthy"[\s\S]{0,100}\? _generation : null/);
  assert.match(hostRuntime, /ObserveCompletedHandlersAsync/);
  assert.match(hostRuntime, /controlAcceptCancellation\.Cancel\(\)[\s\S]*CompleteAcceptedMutationsForHostShutdownAsync[\s\S]*controlHandlerCancellation\.Cancel\(\)/);
  assert.match(hostRuntime, /ConcurrentDictionary<string, QueuedCommand> _acceptedMutations/);
  assert.match(hostRuntime, /await Task\.WhenAll\(accepted\.Select\(command => command\.ResponseSent\.Task\)\)/);
  assert.match(hostRuntime, /marker\.Event \?\?= new HostAuditEvent/);
  assert.match(hostRuntime, /var persisted = _audit\.Append\(marker\.Event\)/);
  assert.match(hostRuntime, /if \(completedPersisted\) markTerminalAuditAppended\(\)/);
  assert.doesNotMatch(hostRuntime, /AppendAudit\(command\.Operation,\s*"generation_stopped"/);
  assert.match(hostRuntime, /if \(!CanAdoptGeneration\(generation\.Failure\)\) return false/);
  assert.match(hostRuntime, /TrySelectPublishedManagerUrl\(_publication, generationId, out managerUrl\)/);
  assert.doesNotMatch(hostRuntime, /case "activate":[\s\S]{0,120}generation\.Ready\.BaseUrl/);
  assert.match(hostRuntime, /server = HostProtocol\.CreateServer\(\)/);
  assert.match(hostRuntime, /string\.IsNullOrWhiteSpace\(request\.Command\)/);
  assert.match(hostRuntime, /catch \(Exception exception\)/);

  assert.match(hostRuntime, /Channel\.CreateBounded<string>/);
  assert.match(hostRuntime, /FullMode = BoundedChannelFullMode\.DropOldest/);
  assert.match(hostRuntime, /RotateIfNeeded/);
  assert.match(hostRuntime, /Diagnostics are best-effort and must never become lifecycle authority/);
  assert.doesNotMatch(hostRuntime, /lock \(_gate\)[\s\S]{0,120}File\.AppendAllText/);
  assert.match(hostControlAudit, /EnsureTerminalIndex\(filePath\)/);
  assert.match(hostControlAudit, /_terminalOperationIds\.Contains\(entry\.OperationId\)/);
  assert.match(hostControlAudit, /var recovered = new HashSet<string>[\s\S]*_terminalOperationIds\.UnionWith\(recovered\)[\s\S]*_terminalIndexPath = filePath/);
  assert.match(hostControlAudit, /ContainsExactRecord\(filePath, payload\)/);
  assert.match(hostControlAudit, /InvalidateTerminalIndex\(entry\)/);
  assert.doesNotMatch(hostControlAudit, /entry\.Phase == "completed" && ContainsTerminalRecord/);
});

test("startup cancellation remains distinct from a readiness timeout", () => {
  const selection = hostRuntime.slice(
    hostRuntime.indexOf("var first = await Task.WhenAny(readiness.Task, managerExit, timeout)"),
    hostRuntime.indexOf("var ready = await readiness.Task"),
  );
  assert.match(selection, /cancellationToken\.ThrowIfCancellationRequested\(\)/);
  assert.match(selection, /throw new TimeoutException/);
  assert.ok(
    selection.indexOf("cancellationToken.ThrowIfCancellationRequested()")
      < selection.indexOf("throw new TimeoutException"),
  );
  assert.match(hostRuntime, /CancelAndDisposeStartupAsync\(startup, startupCancellation, "explicit-(?:quit|restart)"\)/);
  assert.match(hostRuntime, /var canceledActiveStartup = !startup\.IsCompleted/);
  assert.match(hostRuntime, /catch \(OperationCanceledException\) when \(canceledActiveStartup/);
  assert.match(hostRuntime, /throw new OperationCanceledException\("Application generation startup was canceled\./);
  assert.match(hostRuntime, /CancelAndDisposeStartupAsync\(startup, startupCancellation, "explicit-quit"\)/);
  assert.match(hostRuntime, /await CancelPendingTransitionAsync\("fenced_quit_during_startup"\)/);
  assert.match(hostRuntime, /BeginInternalRecovery\("client_replacement_failed"\)/);
});

test("installer migration stops only exact install-owned legacy processes", () => {
  assert.match(installer, /Stop-RabiRouteHostFenced\.ps1/);
  assert.match(releaseTransaction, /"Fenced Host stop"/);
  assert.match(fencedHostStop, /@\("--command", "status", "--json"\)/);
  assert.match(
    fencedHostStop,
    /"healthy",\s*"degraded"[\s\S]*applicationGenerationId/,
    "healthy and degraded Host states must fence quit with the application generation",
  );
  assert.match(
    fencedHostStop,
    /"faulted"[\s\S]*applicationGenerationId[\s\S]*controlFenceGenerationId/,
    "only a faulted Host without an application generation may fall back to the control fence",
  );
  assert.match(fencedHostStop, /Unsupported Host state[\s\S]*refusing fenced quit/);
  assert.match(fencedHostStop, /Faulted Host status omitted controlFenceGenerationId/);
  assert.match(fencedHostStop, /@\("--command", "quit", "--application-generation-id", \$generation, "--json"\)/);
  assert.match(fencedHostStop, /Start-Process[\s\S]*-Wait[\s\S]*-PassThru/);
  assert.match(fencedHostStop, /\$process\.ExitCode -ne 0/);
  assert.doesNotMatch(fencedHostStop, /allow-unfenced-quit|Stop-Process|taskkill/i);
  assert.ok(
    releaseTransaction.indexOf('"Fenced Host stop"')
      < releaseTransaction.indexOf('"Legacy lifecycle migration"'),
    "installer must fail closed on Host quit before touching legacy runtime or payload",
  );
  assert.match(installer, /function InitializeUninstall\(\): Boolean;/);
  assert.match(installer, /RunUninstallTransaction\(True\)/);
  assert.match(installer, /Stop-LegacyRabiRouteRuntime\.ps1"; Flags: dontcopy/);
  assert.match(installer, /Migrate-LegacyWearableHealthTask\.ps1"; Flags: dontcopy/);
  assert.match(releaseTransaction, /Invoke-LegacyTaskMigration "Inspect"[\s\S]*\[IO\.Directory\]::CreateDirectory\(\$install\)/);
  assert.match(releaseTransaction, /legacyTaskMigrationState/);
  assert.match(legacyWearableTaskMigration, /RabiLinkWearableHealthCompanion/);
  assert.match(legacyWearableTaskMigration, /http:\/\/127\.0\.0\.1:/);
  assert.match(legacyWearableTaskMigration, /"8790"/);
  assert.match(legacyWearableTaskMigration, /examples\\\\android-rabi-link-probe/);
  assert.match(installer, /-InstallRoot /);
  assert.match(legacyRuntimeStop, /Join-Path \$install "node\.exe"/);
  assert.match(legacyRuntimeStop, /watch-rabiroute-desktop-lifecycle\.ps1/);
  assert.match(legacyRuntimeStop, /Exact-Path \$process\.ExecutablePath/);
  assert.match(legacyRuntimeStop, /Command-References \$process\.CommandLine \$managerEntry/);
  assert.match(legacyRuntimeStop, /\$legacyWatcherEntries/);
  assert.match(legacyRuntimeStop, /watch-rabiroute-health\.ps1/);
  assert.match(legacyRuntimeStop, /watch-message-adapters\.ps1/);
  assert.match(legacyRuntimeStop, /Command-References \$Process\.CommandLine \$_/);
  assert.match(legacyRuntimeStop, /Regex\]::Escape\(\$canonical\)/);
  assert.match(legacyRuntimeStop, /Stop-Process -Id \$targetPid/);
  assert.ok(
    legacyRuntimeStop.indexOf("Stop-MatchingProcesses $watcherPredicate")
      < legacyRuntimeStop.indexOf("Stop-MatchingProcesses $runtimePredicate"),
    "the legacy watcher must be quiesced before Manager and Tray",
  );
  assert.doesNotMatch(legacyRuntimeStop, /Stop-Process\s+-(?:Name|InputObject)|taskkill(?:\.exe)?/i);
  assert.doesNotMatch(installer, /schtasks\.exe[\s\S]*RabiRouteHealthWatchdog/);
  assert.match(legacyRuntimeStop, /Assert-InstallOwnedWatchdogTask/);
  assert.match(legacyRuntimeStop, /Remove-InstallOwnedWatchdogTask/);
});

test("RabiSpeech legacy service migration is exact, fail-closed, and cannot be recreated", () => {
  for (const fingerprint of [
    /\$speechTaskName = "RabiSpeech"/,
    /\$speechTaskDescription = "Rabi local-only TTS\/ASR provider service"/,
    /\[string\]\$Task\.TaskPath -ne "\\"/,
    /\$trustedPowerShell/,
    /\$wrapperArguments/,
    /\$directArguments/,
    /Assert-ExactSpeechWrapper/,
    /Assert-CurrentUserTaskIdentity/,
    /Could not enumerate scheduled tasks/,
    /Is-InstallOwnedSpeechProcess/,
  ]) assert.match(legacyRuntimeStop, fingerprint);
  assert.match(legacyRuntimeStop, /Stop-ScheduledTask -InputObject \$task/);
  assert.match(legacyRuntimeStop, /Wait-ForSpeechTaskStop/);
  assert.match(legacyRuntimeStop, /Unregister-ScheduledTask -InputObject \$remaining\[0\]/);
  assert.ok(
    legacyRuntimeStop.indexOf("Stop-ScheduledTask -InputObject $task")
      < legacyRuntimeStop.indexOf("Stop-MatchingProcesses $speechPredicate"),
  );
  assert.ok(
    legacyRuntimeStop.indexOf("Stop-MatchingProcesses $speechPredicate")
      < legacyRuntimeStop.indexOf("Unregister-ScheduledTask -InputObject $remaining[0]"),
  );
  assert.doesNotMatch(speechServiceInstaller, /Register-ScheduledTask|New-ScheduledTaskAction|Start-ScheduledTask/);
  assert.match(speechServiceInstaller, /has been retired/);
  assert.match(speechServiceInstaller, /RabiRouteHost\.exe/);
  assert.match(
    windowsReleaseBuild,
    /Copy-TrackedTree/,
  );
  assert.doesNotMatch(
    windowsReleaseBuild,
    /\$excludedRuntimeFiles[\s\S]{0,600}"plugin-adapters\/rabi-speech\/scripts\/install-service\.ps1"/,
  );
  assert.doesNotMatch(installer, /Source: .*plugin-adapters\\rabi-speech/i);
  assert.match(installer, /Source: "\{#PortableZip\}"/);
  assert.match(releaseTransaction, /release-manifest\.json/);
});

test("RabiSpeech task migration mutates only the fully fingerprinted app-owned task", {
  skip: process.platform !== "win32",
  timeout: 30_000,
}, () => {
  const sandbox = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), "rabispeech task migration contract-"));
  const installRoot = path.join(sandbox, "RabiPC");
  const localAppData = path.join(sandbox, "LocalAppData");
  const speechRoot = path.join(installRoot, "plugin-adapters", "rabi-speech");
  const runtime = path.join(speechRoot, "runtime", "RabiSpeech.exe");
  const hostScript = path.join(speechRoot, "scripts", "windows_host.py");
  const legacyStartScript = path.join(speechRoot, "scripts", "start.ps1");
  const wrapper = path.join(localAppData, "RabiPC", "RabiSpeech", "start-rabispeech.ps1");
  const harness = path.join(sandbox, "migration-harness.ps1");
  const migrationScript = fileURLToPath(new URL("./Stop-LegacyRabiRouteRuntime.ps1", import.meta.url));
  const powershellExe = path.join(
    process.env.SystemRoot ?? "C:\\Windows",
    "System32", "WindowsPowerShell", "v1.0", "powershell.exe",
  );

  fs.mkdirSync(path.dirname(runtime), { recursive: true });
  fs.mkdirSync(path.dirname(hostScript), { recursive: true });
  fs.mkdirSync(path.dirname(wrapper), { recursive: true });
  fs.writeFileSync(runtime, "fixture", "utf8");
  fs.writeFileSync(hostScript, "fixture", "utf8");
  fs.writeFileSync(legacyStartScript, "# historical install-owned start entry\r\n", "utf8");
  const exactWrapper = [
    "param()", "", '$ErrorActionPreference = "Stop"',
    `$serviceRoot = '${speechRoot}'`,
    "$runtime = Join-Path $serviceRoot 'runtime\\RabiSpeech.exe'",
    "$hostScript = Join-Path $serviceRoot 'scripts\\windows_host.py'",
    "$dependencies = Join-Path $serviceRoot '.deps'",
    "$config = Join-Path $PSScriptRoot 'config.json'", "",
    "foreach ($required in @($runtime, $hostScript, $dependencies, $config)) {",
    "  if (!(Test-Path -LiteralPath $required)) {",
    '    throw "RabiSpeech user runtime is incomplete: $required"',
    "  }", "}", "",
    "$env:RABISPEECH_ROOT = $serviceRoot",
    "$env:RABISPEECH_DATA_ROOT = $PSScriptRoot",
    "$env:RABISPEECH_CONFIG = $config",
    '$env:PYTHONPATH = "$dependencies;$serviceRoot" + $(if ($env:PYTHONPATH) { ";$env:PYTHONPATH" } else { "" })', "",
    "$nvidiaRoot = Join-Path $dependencies 'nvidia'",
    "if (Test-Path -LiteralPath $nvidiaRoot) {",
    "  $nvidiaBins = Get-ChildItem -LiteralPath $nvidiaRoot -Directory |",
    "    ForEach-Object { Join-Path $_.FullName 'bin' } |",
    "    Where-Object { Test-Path -LiteralPath $_ }",
    "  if ($nvidiaBins) {",
    "    $env:PATH = (($nvidiaBins -join ';') + ';' + $env:PATH)",
    "  }", "}", "",
    '$pythonHome = (& py -3.10 -c "import sys; print(sys.base_prefix)").Trim()',
    "if ($LASTEXITCODE -ne 0 -or !(Test-Path -LiteralPath $pythonHome -PathType Container)) {",
    "  throw 'RabiSpeech could not resolve Python 3.10.'",
    "}",
    "$env:PYTHONHOME = $pythonHome",
    '$env:PATH = "$pythonHome;$env:PATH"',
    "& $runtime $hostScript",
    "exit $LASTEXITCODE",
  ].join("\r\n");
  fs.writeFileSync(wrapper, exactWrapper, "utf8");
  fs.writeFileSync(harness, String.raw`param(
  [string]$MigrationScript,
  [string]$InstallRoot,
  [string]$LocalAppData,
  [string]$Scenario
)
$env:LOCALAPPDATA = $LocalAppData
$script:taskExists = $Scenario -notin @('watchdog-owned', 'watchdog-foreign', 'orphan-wrapper')
$script:watchdogExists = $Scenario -in @('watchdog-owned', 'watchdog-foreign')
$script:taskState = 'Running'
$script:processExists = $script:taskExists
$script:events = [System.Collections.Generic.List[string]]::new()
$wrapper = Join-Path $LocalAppData 'RabiPC\RabiSpeech\start-rabispeech.ps1'
$speechRoot = Join-Path $InstallRoot 'plugin-adapters\rabi-speech'
$runtime = Join-Path $speechRoot 'runtime\RabiSpeech.exe'
$hostScript = Join-Path $speechRoot 'scripts\windows_host.py'
$description = if ($Scenario -eq 'mismatch') { 'user-owned task' } else { 'Rabi local-only TTS/ASR provider service' }
$currentIdentity = [System.Security.Principal.WindowsIdentity]::GetCurrent()
$logonTrigger = [pscustomobject]@{
  Enabled = $true
  UserId = $currentIdentity.Name
  CimClass = [pscustomobject]@{ CimClassName = 'MSFT_TaskLogonTrigger' }
}
$taskStartScript = if ($Scenario -eq 'historical-direct') { Join-Path $speechRoot 'scripts\start.ps1' } else { $wrapper }
$taskWorkingDirectory = if ($Scenario -eq 'historical-direct') { $speechRoot } else { Split-Path -Parent $wrapper }
$action = [pscustomobject]@{
  Execute = 'powershell.exe'
  Arguments = '-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "' + $taskStartScript + '"'
  WorkingDirectory = $taskWorkingDirectory
}
$task = [pscustomobject]@{
  TaskName = 'RabiSpeech'
  TaskPath = '\'
  Description = $description
  Actions = @($action)
  Triggers = @($logonTrigger)
  Principal = [pscustomobject]@{
    UserId = $currentIdentity.Name
    RunLevel = 'Limited'
    LogonType = 'Interactive'
  }
  Settings = [pscustomobject]@{
    RestartCount = 3
    RestartInterval = 'PT1M'
    ExecutionTimeLimit = 'PT0S'
    MultipleInstances = 'IgnoreNew'
    Enabled = $true
    Hidden = $false
  }
  State = $script:taskState
}
$watchdogDescription = if ($Scenario -eq 'watchdog-foreign') { 'user-owned watchdog' } else { 'RabiRoute RabiRoute Desktop and message-adapter health recovery. Runs one guarded cycle per trigger.' }
$watchdog = [pscustomobject]@{
  TaskName = 'RabiRouteHealthWatchdog'
  TaskPath = '\'
  Description = $watchdogDescription
  Actions = @([pscustomobject]@{
    Execute = 'powershell.exe'
    Arguments = '-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "' + (Join-Path $InstallRoot 'scripts\watch-rabiroute-health.ps1') + '" -ManagerUrl "http://127.0.0.1:8790" -DefaultRouteName "default-main" -Once -NoDesktopRepair'
    WorkingDirectory = $InstallRoot
  })
  Triggers = @(
    $logonTrigger,
    [pscustomobject]@{
      Enabled = $true
      CimClass = [pscustomobject]@{ CimClassName = 'MSFT_TaskTimeTrigger' }
    }
  )
  Principal = [pscustomobject]@{
    UserId = $currentIdentity.Name
    RunLevel = 'Limited'
    LogonType = 'Interactive'
  }
  Settings = [pscustomobject]@{
    RestartCount = 3
    RestartInterval = 'PT1M'
    ExecutionTimeLimit = 'PT10M'
    MultipleInstances = 'IgnoreNew'
    Enabled = $true
    Hidden = $false
  }
  State = 'Ready'
}
function Get-ScheduledTask {
  [CmdletBinding()] param([string]$TaskName)
  if ($Scenario -eq 'query-error') { throw 'fixture scheduler unavailable' }
  $result = @()
  if ($script:taskExists) {
    $task.State = $script:taskState
    $result += $task
  }
  if ($script:watchdogExists) { $result += $watchdog }
  return $result
}
function Stop-ScheduledTask {
  [CmdletBinding()] param($InputObject)
  [void]$script:events.Add('stop-task')
  $script:taskState = 'Ready'
}
function Unregister-ScheduledTask {
  [CmdletBinding(SupportsShouldProcess=$true)] param($InputObject)
  if ($InputObject.TaskName -eq 'RabiRouteHealthWatchdog') {
    [void]$script:events.Add('unregister-watchdog')
    $script:watchdogExists = $false
  } else {
    [void]$script:events.Add('unregister-task')
    $script:taskExists = $false
  }
}
function Get-CimInstance {
  [CmdletBinding()] param([Parameter(Position=0)][string]$ClassName, [string]$Filter)
  if (-not $script:processExists) { return @() }
  return [pscustomobject]@{
    ProcessId = 4242
    Name = 'RabiSpeech.exe'
    ExecutablePath = $runtime
    CommandLine = '"' + $runtime + '" "' + $hostScript + '"'
  }
}
function Stop-Process {
  [CmdletBinding()] param([int]$Id, [switch]$Force)
  [void]$script:events.Add('stop-process:' + $Id)
  $script:processExists = $false
}
function Start-Sleep { param([int]$Milliseconds) }
try {
  . $MigrationScript -InstallRoot $InstallRoot
  [pscustomobject]@{ ok = $true; events = @($script:events) } | ConvertTo-Json -Compress
  exit 0
} catch {
  [pscustomobject]@{ ok = $false; error = $_.Exception.Message; events = @($script:events) } | ConvertTo-Json -Compress
  exit 17
}
`, "utf8");

  try {
    const run = (scenario) => spawnSync(powershellExe, [
      "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
      "-File", harness,
      "-MigrationScript", migrationScript,
      "-InstallRoot", installRoot,
      "-LocalAppData", localAppData,
      "-Scenario", scenario,
    ], { encoding: "utf8", timeout: 20_000, windowsHide: true });

    const owned = run("owned");
    assert.equal(owned.status, 0, owned.stderr || owned.stdout);
    assert.deepEqual(JSON.parse(owned.stdout.trim()).events, [
      "stop-task", "stop-process:4242", "unregister-task",
    ]);
    assert.match(fs.readFileSync(wrapper, "utf8"), /legacy RabiSpeech wrapper has been retired/);

    const historicalDirect = run("historical-direct");
    assert.equal(historicalDirect.status, 0, historicalDirect.stderr || historicalDirect.stdout);
    assert.deepEqual(JSON.parse(historicalDirect.stdout.trim()).events, [
      "stop-task", "stop-process:4242", "unregister-task",
    ]);

    const queryError = run("query-error");
    assert.equal(queryError.status, 17, queryError.stderr || queryError.stdout);
    const queryErrorResult = JSON.parse(queryError.stdout.trim());
    assert.match(queryErrorResult.error, /Could not enumerate scheduled tasks/);
    assert.deepEqual(queryErrorResult.events, []);

    fs.writeFileSync(wrapper, exactWrapper, "utf8");
    const orphanWrapper = run("orphan-wrapper");
    assert.equal(orphanWrapper.status, 0, orphanWrapper.stderr || orphanWrapper.stdout);
    assert.deepEqual(JSON.parse(orphanWrapper.stdout.trim()).events, []);
    assert.match(fs.readFileSync(wrapper, "utf8"), /legacy RabiSpeech wrapper has been retired/);

    const watchdogOwned = run("watchdog-owned");
    assert.equal(watchdogOwned.status, 0, watchdogOwned.stderr || watchdogOwned.stdout);
    assert.deepEqual(JSON.parse(watchdogOwned.stdout.trim()).events, ["unregister-watchdog"]);

    const watchdogForeign = run("watchdog-foreign");
    assert.equal(watchdogForeign.status, 17, watchdogForeign.stderr || watchdogForeign.stdout);
    const watchdogForeignResult = JSON.parse(watchdogForeign.stdout.trim());
    assert.match(watchdogForeignResult.error, /unknown description/);
    assert.deepEqual(watchdogForeignResult.events, []);

    const mismatch = run("mismatch");
    assert.equal(mismatch.status, 17, mismatch.stderr || mismatch.stdout);
    const mismatchResult = JSON.parse(mismatch.stdout.trim());
    assert.match(mismatchResult.error, /unknown description/);
    assert.deepEqual(mismatchResult.events, []);

    fs.writeFileSync(wrapper, `${exactWrapper}\r\n# foreign trailing command\r\nStart-Process calc.exe\r\n`, "utf8");
    const foreignWrapper = run("owned");
    assert.equal(foreignWrapper.status, 17, foreignWrapper.stderr || foreignWrapper.stdout);
    const foreignWrapperResult = JSON.parse(foreignWrapper.stdout.trim());
    assert.match(foreignWrapperResult.error, /not the exact install-owned wrapper/);
    assert.deepEqual(foreignWrapperResult.events, []);
  } finally {
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
});

test("legacy migration stops a real root Manager and watcher without matching path suffixes", {
  skip: process.platform !== "win32",
  timeout: 30_000,
}, async () => {
  const installRoot = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), "rabi route legacy contract-"));
  const nodeExe = path.join(installRoot, "node.exe");
  const managerEntry = path.join(installRoot, "dist", "manager.js");
  const managerSuffixEntry = `${managerEntry}.backup`;
  const watcherEntry = path.join(installRoot, "scripts", "watch-rabiroute-desktop-lifecycle.ps1");
  const watcherSuffixEntry = `${watcherEntry}.backup.ps1`;
  const napCatNodeExe = path.join(installRoot, "tools", "NapCat", "node.exe");
  const napCatEntry = path.join(installRoot, "tools", "NapCat", "napcat.mjs");
  const powershellExe = path.join(
    process.env.SystemRoot ?? "C:\\Windows",
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe",
  );
  const migrationScript = fileURLToPath(new URL("./Stop-LegacyRabiRouteRuntime.ps1", import.meta.url));
  const migrationHarness = path.join(installRoot, "migration-harness.ps1");
  const children = [];

  const start = (executable, args) => {
    const child = spawn(executable, args, { stdio: "ignore", windowsHide: true });
    children.push(child);
    return child;
  };
  const waitForExit = async (child, label) => {
    if (child.exitCode !== null) return;
    await Promise.race([
      once(child, "exit"),
      delay(10_000).then(() => {
        throw new Error(`${label} did not exit`);
      }),
    ]);
  };

  try {
    fs.mkdirSync(path.dirname(managerEntry), { recursive: true });
    fs.mkdirSync(path.dirname(watcherEntry), { recursive: true });
    fs.mkdirSync(path.dirname(napCatEntry), { recursive: true });
    fs.copyFileSync(process.execPath, nodeExe);
    fs.copyFileSync(process.execPath, napCatNodeExe);
    const sleeper = "setInterval(() => {}, 1000);\n";
    fs.writeFileSync(managerEntry, sleeper, "utf8");
    fs.writeFileSync(managerSuffixEntry, sleeper, "utf8");
    const watcher = "while ($true) { Start-Sleep -Milliseconds 100 }\n";
    fs.writeFileSync(watcherEntry, watcher, "utf8");
    fs.writeFileSync(watcherSuffixEntry, watcher, "utf8");
    fs.writeFileSync(napCatEntry, sleeper, "utf8");
    fs.writeFileSync(migrationHarness, [
      "param([string]$MigrationScript, [string]$InstallRoot)",
      "function Get-ScheduledTask { [CmdletBinding()] param([string]$TaskName); return @() }",
      ". $MigrationScript -InstallRoot $InstallRoot",
    ].join("\r\n"), "utf8");

    const managerTarget = start(nodeExe, [managerEntry]);
    const watcherTarget = start(powershellExe, [
      "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", watcherEntry,
    ]);
    const managerSuffix = start(nodeExe, [managerSuffixEntry]);
    const watcherSuffix = start(powershellExe, [
      "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", watcherSuffixEntry,
    ]);
    const napCatLike = start(napCatNodeExe, [napCatEntry, "--napcat-runtime"]);
    await delay(500);

    const migration = spawnSync(powershellExe, [
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      migrationHarness,
      "-MigrationScript",
      migrationScript,
      "-InstallRoot",
      installRoot,
    ], { encoding: "utf8", timeout: 20_000, windowsHide: true });

    assert.equal(migration.status, 0, migration.stderr || migration.stdout);
    await Promise.all([
      waitForExit(managerTarget, "install-root Manager"),
      waitForExit(watcherTarget, "install-root lifecycle watcher"),
    ]);
    await delay(100);
    assert.equal(managerSuffix.exitCode, null, "manager.js.backup must not match manager.js");
    assert.equal(watcherSuffix.exitCode, null, "watcher .ps1.backup must not match the watcher path");
    assert.equal(napCatLike.exitCode, null, "a NapCat-like Node process must remain untouched");
  } finally {
    for (const child of children) {
      if (child.exitCode === null) child.kill();
    }
    await Promise.all(children.map(async (child) => {
      if (child.exitCode === null) {
        await Promise.race([once(child, "exit"), delay(5_000)]);
      }
    }));
    fs.rmSync(installRoot, { recursive: true, force: true });
  }
});

test("Windows release build rejects a network source repository", () => {
  assert.match(windowsReleaseBuild, /function Assert-LocalDirectory/);
  assert.match(windowsReleaseBuild, /Assert-LocalDirectory \$repo/);
  assert.match(windowsReleaseBuild, /DriveType -eq 4/);
});

test("Windows release payload materializes local packages and rejects reparse points", () => {
  assert.match(windowsReleaseBuild, /"plugins\\contracts\\plugin-sdk"/);
  assert.match(windowsReleaseBuild, /Copy-Item -LiteralPath \$pluginSdkSource -Destination \$pluginSdkInstall -Recurse -Force/);
  assert.match(windowsReleaseBuild, /FileAttributes\]::ReparsePoint/);
  assert.match(windowsReleaseBuild, /Release payload contains non-portable reparse points/);
  assert.match(windowsReleaseBuild, /Release payload contains retired lifecycle entries/);
  assert.match(windowsReleaseBuild, /watch-message-adapters\.ps1/);
  assert.match(windowsReleaseBuild, /watch-rabiroute-health-hidden\.vbs/);
});

test("Windows release identity is derived from a canonical payload manifest", () => {
  assert.match(windowsReleaseBuild, /create-windows-release-manifest\.mjs/);
  assert.match(windowsReleaseBuild, /if \(\$hostVersionEntry\.Name -eq \$canonicalManifestName\) \{ continue \}/);
  assert.match(windowsReleaseBuild, /A scoped runtime manifest entered the release payload before canonical manifest creation/);
  assert.match(windowsReleaseBuild, /releaseManifest\.packageVersion/);
  assert.match(windowsReleaseBuild, /Canonical release manifest does not cover the complete payload/);
  assert.match(windowsReleaseBuild, /Canonical release manifest is missing required runtime file/);
  assert.match(windowsReleaseBuild, /releaseManifest\.releaseId/);
  assert.match(releaseManifestBuilder, /payloadSha256/);
  assert.match(releaseManifestBuilder, /releaseId/);
  assert.match(releaseManifestBuilder, /topLevelEntries/);
  assert.match(releaseManifestBuilder, /Runtime\/private path cannot enter a release manifest/);
  assert.match(releaseManifestBuilder, /assertNoRetiredManagerSemantics/);
  assert.match(releaseManifestBuilder, /fixed Manager URL value/);
  assert.match(releaseManifestBuilder, /fixed Manager port value/);
  assert.ok(windowsReleaseBuild.indexOf("create-windows-release-manifest.mjs") > windowsReleaseBuild.indexOf("if (-not $SkipBuild)"));
});

test("Windows portable archive includes dotfiles and round-trips the complete distribution", () => {
  assert.doesNotMatch(windowsReleaseBuild, /Compress-Archive/);
  assert.match(windowsReleaseBuild, /function New-PortableArchive/);
  assert.match(windowsReleaseBuild, /Get-ChildItem -LiteralPath \$sourceFull -Recurse -Force -File/);
  assert.match(windowsReleaseBuild, /ZipFileExtensions\]::CreateEntryFromFile/);
  assert.match(windowsReleaseBuild, /function Assert-PortableArchiveRoundTrip/);
  assert.match(windowsReleaseBuild, /Expand-Archive -LiteralPath \$ArchivePath/);
  assert.match(windowsReleaseBuild, /Portable archive round-trip does not match the complete distribution/);
  assert.match(windowsReleaseBuild, /Portable archive round-trip changed file content/);
  assert.ok(
    windowsReleaseBuild.indexOf("Assert-PortableArchiveRoundTrip -SourceRoot $distribution")
      > windowsReleaseBuild.indexOf("New-PortableArchive -SourceRoot $distribution"),
  );
  assert.ok(
    windowsReleaseBuild.indexOf("Assert-PortableArchiveRoundTrip -SourceRoot $distribution")
      < windowsReleaseBuild.indexOf("Compiling $installerBase.exe"),
  );
});

test("Windows release smoke captures the WinExe exit code explicitly", () => {
  assert.match(windowsReleaseBuild, /Start-Process[\s\S]*-ArgumentList "--self-test"[\s\S]*-Wait[\s\S]*-PassThru/);
  assert.match(windowsReleaseBuild, /\$smokeProcess\.ExitCode/);
  assert.doesNotMatch(windowsReleaseBuild, /& \(Join-Path \$payload "RabiRouteHost\.exe"\) --self-test/);
});

test("packaged Tray carries only the Qt modules used by the production surface", () => {
  assert.match(trayRequirements, /^PySide6_Essentials>=/m);
  assert.doesNotMatch(trayRequirements, /^PySide6>=/m);
  for (const moduleName of ["QtCore", "QtGui", "QtNetwork", "QtWidgets"]) {
    assert.match(desktopRuntimeBuild, new RegExp(`\\b${moduleName}\\b`));
  }
  assert.match(desktopRuntimeBuild, /"qml", "metatypes", "include", "typesystems"/);
  assert.match(desktopRuntimeBuild, /QApplication\.instance\(\)/);
  assert.match(desktopRuntimeBuild, /QSystemTrayIcon/);
  assert.match(desktopRuntimeBuild, /QLocalServer/);
  assert.match(desktopRuntimeBuild, /from rabiroute_tray import desktop_diagnostics/);
  assert.match(desktopRuntimeBuild, /"python310\.zip", "\.", "\.\.", "Lib\\site-packages"/);
  assert.match(desktopRuntimeBuild, /QT_QPA_PLATFORM = "offscreen"/);
});
