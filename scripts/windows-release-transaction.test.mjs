import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { writeManifest } from "./create-windows-release-manifest.mjs";

const transaction = fileURLToPath(new URL("./Install-RabiRouteReleaseTransaction.ps1", import.meta.url));
const transactionContract = fs.readFileSync(transaction, "utf8");
const uninstallTransaction = fileURLToPath(new URL("./Uninstall-RabiRouteReleaseTransaction.ps1", import.meta.url));
const uninstallContract = fs.readFileSync(uninstallTransaction, "utf8");
const legacyTaskMigration = fileURLToPath(new URL("./Migrate-LegacyWearableHealthTask.ps1", import.meta.url));
const autostartConfigurator = fileURLToPath(new URL("./Configure-WindowsAutostart.ps1", import.meta.url));
const stopContract = fs.readFileSync(new URL("./Stop-RabiRouteHostFenced.ps1", import.meta.url), "utf8");
const installer = fs.readFileSync(new URL("../installer/RabiRoute.iss", import.meta.url), "utf8");
const build = fs.readFileSync(new URL("./build-windows-release.ps1", import.meta.url), "utf8");
const powershell = path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");

function runQuitFenceResolver(status) {
  const start = stopContract.indexOf("function Resolve-HostQuitFence");
  const end = stopContract.indexOf("function Invoke-HostJson", start);
  assert.ok(start >= 0 && end > start, "Stop helper must expose one pure quit-fence resolver");
  const resolver = stopContract.slice(start, end);
  const script = `${resolver}\n` +
    `$status = @'\n${JSON.stringify(status)}\n'@ | ConvertFrom-Json\n` +
    "try { Resolve-HostQuitFence $status | ConvertTo-Json -Compress } " +
    "catch { [Console]::Error.WriteLine($_.Exception.Message); exit 7 }\n";
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-stop-fence-"));
  const probe = path.join(root, "probe.ps1");
  fs.writeFileSync(probe, script, "utf8");
  try {
    return spawnSync(powershell, ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", probe], {
      encoding: "utf8",
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test("fenced stop selects the state-owned generation and fails closed on incomplete or transitional status", { skip: process.platform !== "win32" }, () => {
  for (const [state, applicationGenerationId] of [["healthy", "healthy-a"], ["degraded", "degraded-a"], ["faulted", "faulted-a"]]) {
    const result = runQuitFenceResolver({ state, applicationGenerationId, controlFenceGenerationId: "control-b" });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.deepEqual(JSON.parse(result.stdout), { generationId: applicationGenerationId, source: "applicationGenerationId" });
  }

  const faulted = runQuitFenceResolver({ state: "faulted", applicationGenerationId: null, controlFenceGenerationId: "faulted-control" });
  assert.equal(faulted.status, 0, faulted.stderr || faulted.stdout);
  assert.deepEqual(JSON.parse(faulted.stdout), { generationId: "faulted-control", source: "controlFenceGenerationId" });

  for (const [status, expected] of [
    [{ state: "healthy", applicationGenerationId: null, controlFenceGenerationId: "must-not-fallback" }, /omitted applicationGenerationId/],
    [{ state: "faulted", applicationGenerationId: null, controlFenceGenerationId: null }, /omitted controlFenceGenerationId/],
    [{ state: "starting", applicationGenerationId: "starting-a", controlFenceGenerationId: "control-a" }, /Unsupported Host state/],
  ]) {
    const result = runQuitFenceResolver(status);
    assert.equal(result.status, 7);
    assert.match(result.stderr, expected);
  }
});

function makeFixture(scenario = "success") {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-release-transaction-"));
  const install = path.join(root, "install");
  const distribution = path.join(root, "distribution");
  const version = path.join(distribution, "version-build");
  fs.mkdirSync(version, { recursive: true });
  for (const relative of [
    "RabiRouteHost.Core.dll", "node.exe", "dist/manager.js", "ribiwebgui/dist/index.html",
    "desktop-runtime/main.py", "desktop-runtime/python/python.exe",
  ]) {
    const destination = path.join(version, ...relative.split("/"));
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.writeFileSync(destination, `candidate:${relative}`);
  }
  const manifest = writeManifest(version, "9.9.9");
  const immutable = path.join(distribution, "versions", manifest.releaseId);
  fs.mkdirSync(path.dirname(immutable), { recursive: true });
  fs.renameSync(version, immutable);
  fs.writeFileSync(path.join(distribution, "RabiRouteHost.exe"), "candidate-bootstrap");
  fs.writeFileSync(path.join(distribution, "current.json"), `${JSON.stringify({
    schemaVersion: 1, appId: "io.rabiroute.windows", releaseId: manifest.releaseId,
    versionPath: `versions/${manifest.releaseId}`, payloadSha256: manifest.payloadSha256,
  })}\n`);
  if (scenario === "bad-core") fs.appendFileSync(path.join(immutable, "RabiRouteHost.Core.dll"), "tampered");
  if (scenario === "missing-node") fs.rmSync(path.join(immutable, "node.exe"));
  if (scenario === "extra-root") fs.writeFileSync(path.join(distribution, "foreign.exe"), "not manifest owned");
  if (scenario === "forged-identity") {
    const forged = "f".repeat(64);
    const manifestPath = path.join(immutable, "release-manifest.json");
    const editedManifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    editedManifest.payloadSha256 = forged;
    fs.writeFileSync(manifestPath, `${JSON.stringify(editedManifest)}\n`);
    const pointerPath = path.join(distribution, "current.json");
    const editedPointer = JSON.parse(fs.readFileSync(pointerPath, "utf8"));
    editedPointer.payloadSha256 = forged;
    fs.writeFileSync(pointerPath, `${JSON.stringify(editedPointer)}\n`);
  }
  fs.mkdirSync(install, { recursive: true });
  fs.writeFileSync(path.join(install, "RabiRouteHost.exe"), "old-bootstrap");
  const previousReleaseId = "8.8.8-existing";
  const previousPointer = `${JSON.stringify({
    schemaVersion: 1, appId: "io.rabiroute.windows", releaseId: previousReleaseId,
    versionPath: `versions/${previousReleaseId}`, payloadSha256: "previous-payload",
  })}\n`;
  fs.writeFileSync(path.join(install, "current.json"), previousPointer);
  const currentSid = "S-1-5-21-1000";
  const runner = "Z:\\DigitalLife\\RabiRoute\\examples\\android-rabi-link-probe\\scripts\\Start-RabiLinkWearableCompanion.ps1";
  const taskStore = path.join(root, "task-store.json");
  const appData = path.join(root, "appdata");
  fs.mkdirSync(appData, { recursive: true });
  const legacyTaskRecord = {
    taskName: "RabiLinkWearableHealthCompanion", taskPath: "\\",
    principal: { userId: currentSid, logonType: "InteractiveToken", runLevel: "Limited" },
    triggers: [{ type: "Logon", userId: currentSid }],
    actions: [{
      execute: "C:\\Program Files\\PowerShell\\7\\pwsh.exe",
      arguments: `-NoLogo -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "${runner}" -ManagerUrl "http://127.0.0.1:8790" -RoleId "YeYu"`,
      workingDirectory: path.win32.dirname(runner),
    }],
    description: "RabiLink 小米手表/手环健康 ADB Companion；配置真源在手机端。",
    state: "Running", xml: "<Task version=\"1.4\"><RegistrationInfo><Description>RabiLink legacy</Description></RegistrationInfo></Task>",
  };
  fs.writeFileSync(taskStore, `${JSON.stringify({ schemaVersion: 1, currentSid, tasks: [legacyTaskRecord] })}\n`);
  const helper = path.join(root, "helper.ps1");
  fs.writeFileSync(helper, "param([Parameter(ValueFromRemainingArguments=$true)]$Rest)\nexit 0\n");
  const zip = path.join(root, "portable.zip");
  const zipped = spawnSync(powershell, ["-NoProfile", "-NonInteractive", "-Command", "Compress-Archive -Path (Join-Path $env:RABIROUTE_TEST_DISTRIBUTION '*') -DestinationPath $env:RABIROUTE_TEST_ZIP -Force"], {
    encoding: "utf8",
    env: { ...process.env, RABIROUTE_TEST_DISTRIBUTION: distribution, RABIROUTE_TEST_ZIP: zip },
  });
  assert.equal(zipped.status, 0, zipped.stderr || zipped.stdout);
  return {
    root, install, zip, helper, taskStore, appData, legacyTaskRecord,
    releaseId: manifest.releaseId, previousReleaseId, previousPointer,
  };
}

function run(fixture, fault = "", {
  autostartScript = fixture.helper,
  autostartEnabled = "false",
  extraEnv = {},
} = {}) {
  const args = ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", transaction,
    "-InstallRoot", fixture.install, "-PortableZip", fixture.zip, "-ExpectedReleaseId", fixture.releaseId,
    "-StopHostScript", fixture.helper, "-LegacyMigrationScript", fixture.helper,
    "-LegacyTaskMigrationScript", legacyTaskMigration, "-TestLegacyTaskStorePath", fixture.taskStore,
    "-AutostartScript", autostartScript, "-AutostartEnabled", autostartEnabled, "-TestSelfTestScript", fixture.helper];
  if (fault) args.push("-FaultPoint", fault);
  return spawnSync(powershell, args, {
    encoding: "utf8",
    env: {
      ...process.env,
      APPDATA: fixture.appData,
      RABIROUTE_INSTALL_TRANSACTION_TEST_MODE: "1",
      ...extraEnv,
    },
    timeout: 30_000,
  });
}

function autostartRestoreFailureWrapper(fixture) {
  const wrapper = path.join(fixture.root, "autostart-restore-failure.ps1");
  fs.writeFileSync(wrapper, `param(
  [string]$InstallRoot,
  [string]$Enabled,
  [switch]$PreflightOnly,
  [switch]$RestoreSnapshot,
  [string]$SnapshotRoot
)
if ($RestoreSnapshot) {
  if ($env:RABIROUTE_TEST_CORRUPT_CURRENT -eq '1') {
    [IO.File]::WriteAllText((Join-Path $InstallRoot 'current.json'), '{"schemaVersion":1,"appId":"io.rabiroute.windows","releaseId":"wrong-release"}')
  }
  exit 87
}
$arguments = @('-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',$env:RABIROUTE_TEST_REAL_AUTOSTART,'-InstallRoot',$InstallRoot,'-Enabled',$Enabled)
if ($PreflightOnly) { $arguments += '-PreflightOnly' }
if ($SnapshotRoot) { $arguments += @('-SnapshotRoot',$SnapshotRoot) }
& powershell.exe @arguments
exit $LASTEXITCODE
`);
  return wrapper;
}

function configureAutostart(fixture, enabled) {
  return spawnSync(powershell, [
    "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", autostartConfigurator,
    "-InstallRoot", fixture.install, "-Enabled", enabled,
  ], { encoding: "utf8", env: { ...process.env, APPDATA: fixture.appData }, timeout: 30_000 });
}

function createShortcut(fixture, shortcutPath, targetPath) {
  const script = [
    "$shell = New-Object -ComObject WScript.Shell",
    "$shortcut = $shell.CreateShortcut($env:RABIROUTE_TEST_SHORTCUT)",
    "$shortcut.TargetPath = $env:RABIROUTE_TEST_TARGET",
    "$shortcut.Arguments = ''",
    "$shortcut.WorkingDirectory = $env:RABIROUTE_TEST_INSTALL",
    "$shortcut.Save()",
  ].join("; ");
  return spawnSync(powershell, ["-NoProfile", "-NonInteractive", "-Command", script], {
    encoding: "utf8",
    env: {
      ...process.env,
      RABIROUTE_TEST_SHORTCUT: shortcutPath,
      RABIROUTE_TEST_TARGET: targetPath,
      RABIROUTE_TEST_INSTALL: fixture.install,
    },
  });
}

function runUninstall(fixture, preflight = true, { failDeleteAt = 0, failStage = "", stopScript = fixture.helper } = {}) {
  const args = ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", uninstallTransaction,
    "-InstallRoot", fixture.install, "-StopHostScript", stopScript,
    "-LegacyTaskMigrationScript", legacyTaskMigration, "-AutostartScript", autostartConfigurator,
    "-TestLegacyTaskStorePath", fixture.taskStore];
  if (preflight) args.push("-PreflightOnly");
  if (failDeleteAt) args.push("-TestFailDeleteAt", String(failDeleteAt));
  if (failStage) args.push("-TestFailStage", failStage);
  return spawnSync(powershell, args, {
    encoding: "utf8",
    env: { ...process.env, APPDATA: fixture.appData, RABIROUTE_INSTALL_TRANSACTION_TEST_MODE: "1" },
    timeout: 30_000,
  });
}

function readLegacyTasks(fixture) {
  return JSON.parse(fs.readFileSync(fixture.taskStore, "utf8")).tasks;
}

function seedLegacyFlatEntries(fixture) {
  const retired = [
    "RabiRoute-Desktop.exe", "RabiRoute-Tray.exe", "RabiRoute-Tray.new.exe",
    "Start-RabiRoute-Tray.bat", "Start-RabiRoute-Health-Watchdog.bat", "Start-RabiRoute-MessageAdapter-Watchdog.bat",
    "scripts/Install-RabiRoute-HealthWatchdogTask.ps1", "scripts/watch-message-adapters.ps1",
    "scripts/watch-rabiroute-desktop-lifecycle.ps1", "scripts/watch-rabiroute-health-hidden.vbs", "scripts/watch-rabiroute-health.ps1",
  ];
  for (const relative of retired) {
    const destination = path.join(fixture.install, ...relative.split("/"));
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.writeFileSync(destination, `legacy:${relative}`);
  }
  fs.writeFileSync(path.join(fixture.install, "RabiRoute-Desktop.exe.backup"), "foreign suffix");
  fs.writeFileSync(path.join(fixture.install, "node.exe"), "legacy root node");
  fs.writeFileSync(path.join(fixture.install, "package.json"), '{"name":"rabiroute"}\n');
  fs.mkdirSync(path.join(fixture.install, "dist"), { recursive: true });
  fs.writeFileSync(path.join(fixture.install, "dist", "manager.js"), "legacy manager");
  return retired;
}

for (const scenario of ["bad-core", "missing-node", "extra-root", "forged-identity"]) {
  test(`transaction rejects ${scenario} before replacing the installed bootstrap`, { skip: process.platform !== "win32" }, () => {
    const fixture = makeFixture(scenario);
    try {
      const result = run(fixture);
      assert.notEqual(result.status, 0);
      assert.equal(fs.readFileSync(path.join(fixture.install, "RabiRouteHost.exe"), "utf8"), "old-bootstrap");
      assert.equal(fs.readFileSync(path.join(fixture.install, "current.json"), "utf8"), fixture.previousPointer);
      assert.equal(readLegacyTasks(fixture).length, 1);
      assert.equal(readLegacyTasks(fixture)[0].state, "Running");
    } finally { fs.rmSync(fixture.root, { recursive: true, force: true }); }
  });
}

for (const fault of ["after-stage", "after-legacy-task-remove", "after-bootstrap", "after-pointer"]) test(`transaction preserves the old version and legacy task across ${fault}`, { skip: process.platform !== "win32" }, () => {
  const fixture = makeFixture();
  try {
    const result = run(fixture, fault);
    assert.notEqual(result.status, 0);
    assert.equal(fs.readFileSync(path.join(fixture.install, "RabiRouteHost.exe"), "utf8"), "old-bootstrap");
    assert.equal(fs.readFileSync(path.join(fixture.install, "current.json"), "utf8"), fixture.previousPointer);
    assert.equal(readLegacyTasks(fixture).length, 1);
    assert.equal(readLegacyTasks(fixture)[0].state, "Running");
  } finally { fs.rmSync(fixture.root, { recursive: true, force: true }); }
});

test("post-autostart install failure restores the prior settings and owned Startup link", { skip: process.platform !== "win32" }, () => {
  const fixture = makeFixture();
  const settingsPath = path.join(fixture.install, "data", "desktop", "settings.json");
  const startupPath = path.join(fixture.appData, "Microsoft", "Windows", "Start Menu", "Programs", "Startup", "RabiRoute.lnk");
  try {
    const seeded = configureAutostart(fixture, "true");
    assert.equal(seeded.status, 0, seeded.stderr || seeded.stdout);
    const settingsBefore = fs.readFileSync(settingsPath);
    const startupBefore = fs.readFileSync(startupPath);

    const failed = run(fixture, "after-autostart", { autostartScript: autostartConfigurator, autostartEnabled: "false" });
    assert.notEqual(failed.status, 0);
    assert.match(failed.stderr, /Injected fault after-autostart/);
    assert.deepEqual(fs.readFileSync(settingsPath), settingsBefore);
    assert.deepEqual(fs.readFileSync(startupPath), startupBefore);
  } finally { fs.rmSync(fixture.root, { recursive: true, force: true }); }
});

test("an autostart rollback failure cannot prevent current pointer and bootstrap restoration", { skip: process.platform !== "win32" }, () => {
  const fixture = makeFixture();
  try {
    const failed = run(fixture, "after-autostart", {
      autostartScript: autostartRestoreFailureWrapper(fixture),
      autostartEnabled: "false",
      extraEnv: {
        RABIROUTE_TEST_REAL_AUTOSTART: autostartConfigurator,
        RABIROUTE_TEST_CORRUPT_CURRENT: "1",
      },
    });
    assert.notEqual(failed.status, 0);
    assert.match(failed.stderr, /Autostart rollback failed with ExitCode=87/);
    assert.equal(fs.readFileSync(path.join(fixture.install, "RabiRouteHost.exe"), "utf8"), "old-bootstrap");
    assert.equal(fs.readFileSync(path.join(fixture.install, "current.json"), "utf8"), fixture.previousPointer);
    assert.equal(JSON.parse(fs.readFileSync(path.join(fixture.install, "current.json"), "utf8")).releaseId, fixture.previousReleaseId);
    const journal = JSON.parse(fs.readFileSync(path.join(fixture.install, ".rabiroute-install-transaction.json"), "utf8"));
    assert.equal(journal.autostartState, "applied");
  } finally { fs.rmSync(fixture.root, { recursive: true, force: true }); }
});

test("power loss after autostart commit restores settings and both owned Startup links on recovery", { skip: process.platform !== "win32" }, () => {
  const fixture = makeFixture();
  const startupDirectory = path.join(fixture.appData, "Microsoft", "Windows", "Start Menu", "Programs", "Startup");
  const settingsPath = path.join(fixture.install, "data", "desktop", "settings.json");
  const startupPath = path.join(startupDirectory, "RabiRoute.lnk");
  const legacyStartupPath = path.join(startupDirectory, "RabiRoute Desktop.lnk");
  try {
    assert.equal(configureAutostart(fixture, "true").status, 0);
    const legacySeed = createShortcut(fixture, legacyStartupPath, path.join(fixture.install, "RabiRoute-Desktop.exe"));
    assert.equal(legacySeed.status, 0, legacySeed.stderr || legacySeed.stdout);
    const before = {
      settings: fs.readFileSync(settingsPath),
      startup: fs.readFileSync(startupPath),
      legacyStartup: fs.readFileSync(legacyStartupPath),
    };

    const interrupted = run(fixture, "after-autostart-before-journal", { autostartScript: autostartConfigurator, autostartEnabled: "false" });
    assert.equal(interrupted.status, 98, interrupted.stderr || interrupted.stdout);
    assert.equal(fs.existsSync(startupPath), false);
    assert.equal(fs.existsSync(legacyStartupPath), false);

    const recovered = run(fixture, "after-recovery", { autostartScript: autostartConfigurator, autostartEnabled: "false" });
    assert.equal(recovered.status, 95, recovered.stderr || recovered.stdout);
    assert.deepEqual(fs.readFileSync(settingsPath), before.settings);
    assert.deepEqual(fs.readFileSync(startupPath), before.startup);
    assert.deepEqual(fs.readFileSync(legacyStartupPath), before.legacyStartup);
    assert.equal(fs.readFileSync(path.join(fixture.install, "RabiRouteHost.exe"), "utf8"), "old-bootstrap");
    assert.equal(fs.readFileSync(path.join(fixture.install, "current.json"), "utf8"), fixture.previousPointer);
    assert.equal(readLegacyTasks(fixture)[0].state, "Running");
  } finally { fs.rmSync(fixture.root, { recursive: true, force: true }); }
});

test("power loss after legacy task removal is recovered before retry and final success retires it", { skip: process.platform !== "win32" }, () => {
  const fixture = makeFixture();
  try {
    const interrupted = run(fixture, "after-legacy-task-remove-before-journal");
    assert.equal(interrupted.status, 96, interrupted.stderr || interrupted.stdout);
    assert.equal(readLegacyTasks(fixture).length, 0);
    const pending = JSON.parse(fs.readFileSync(path.join(fixture.install, ".rabiroute-install-transaction.json"), "utf8"));
    assert.equal(pending.legacyTaskMigrationState, "planned");
    assert.ok(fs.existsSync(path.join(pending.legacyTaskBackupRoot, "task-backup.json")));
    const retry = run(fixture);
    assert.equal(retry.status, 0, retry.stderr || retry.stdout);
    assert.equal(readLegacyTasks(fixture).length, 0);
    assert.equal(fs.existsSync(path.join(fixture.install, ".rabiroute-install-transaction.json")), false);
  } finally { fs.rmSync(fixture.root, { recursive: true, force: true }); }
});

test("foreign same-name wearable task blocks before install mutation", { skip: process.platform !== "win32" }, () => {
  const fixture = makeFixture();
  const store = JSON.parse(fs.readFileSync(fixture.taskStore, "utf8"));
  store.tasks[0].actions[0].arguments = store.tasks[0].actions[0].arguments.replace("127.0.0.1:8790", "127.0.0.1:45678");
  fs.writeFileSync(fixture.taskStore, `${JSON.stringify(store)}\n`, "utf8");
  const before = fs.readFileSync(fixture.taskStore);
  try {
    const result = run(fixture);
    assert.notEqual(result.status, 0);
    assert.deepEqual(fs.readFileSync(fixture.taskStore), before);
    assert.equal(fs.existsSync(path.join(fixture.install, ".rabiroute-install-transaction.json")), false);
    assert.equal(fs.readFileSync(path.join(fixture.install, "RabiRouteHost.exe"), "utf8"), "old-bootstrap");
    assert.equal(fs.readFileSync(path.join(fixture.install, "current.json"), "utf8"), fixture.previousPointer);
  } finally { fs.rmSync(fixture.root, { recursive: true, force: true }); }
});

test("a completed rollback journal is deterministically recovered on retry", { skip: process.platform !== "win32" }, () => {
  const fixture = makeFixture();
  try {
    assert.notEqual(run(fixture, "after-pointer").status, 0);
    const retry = run(fixture);
    assert.equal(retry.status, 0, retry.stderr || retry.stdout);
    assert.equal(JSON.parse(fs.readFileSync(path.join(fixture.install, "current.json"), "utf8")).releaseId, fixture.releaseId);
  } finally { fs.rmSync(fixture.root, { recursive: true, force: true }); }
});

test("power loss after immutable version move is reconciled before retry", { skip: process.platform !== "win32" }, () => {
  const fixture = makeFixture();
  try {
    const interrupted = run(fixture, "after-version-move-before-journal");
    assert.equal(interrupted.status, 97, interrupted.stderr || interrupted.stdout);
    assert.ok(fs.existsSync(path.join(fixture.install, "versions", fixture.releaseId)));
    const retry = run(fixture);
    assert.equal(retry.status, 0, retry.stderr || retry.stdout);
    assert.equal(JSON.parse(fs.readFileSync(path.join(fixture.install, "current.json"), "utf8")).releaseId, fixture.releaseId);
    assert.equal(fs.existsSync(path.join(fixture.install, ".rabiroute-install-transaction.json")), false);
  } finally { fs.rmSync(fixture.root, { recursive: true, force: true }); }
});

test("a colliding immutable version is never removed by rollback recovery", { skip: process.platform !== "win32" }, () => {
  const fixture = makeFixture();
  const collision = path.join(fixture.install, "versions", fixture.releaseId);
  fs.mkdirSync(collision, { recursive: true });
  fs.writeFileSync(path.join(collision, "foreign.keep"), "pre-existing");
  try {
    assert.notEqual(run(fixture).status, 0);
    assert.equal(fs.readFileSync(path.join(collision, "foreign.keep"), "utf8"), "pre-existing");
    assert.notEqual(run(fixture).status, 0);
    assert.equal(fs.readFileSync(path.join(collision, "foreign.keep"), "utf8"), "pre-existing");
  } finally { fs.rmSync(fixture.root, { recursive: true, force: true }); }
});

test("a flat install can migrate to a version pointer without deleting foreign flat files", { skip: process.platform !== "win32" }, () => {
  const fixture = makeFixture();
  fs.rmSync(path.join(fixture.install, "current.json"));
  fs.writeFileSync(path.join(fixture.install, "legacy-flat.keep"), "rollback evidence");
  try {
    const result = run(fixture);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.equal(JSON.parse(fs.readFileSync(path.join(fixture.install, "current.json"), "utf8")).releaseId, fixture.releaseId);
    assert.equal(fs.readFileSync(path.join(fixture.install, "legacy-flat.keep"), "utf8"), "rollback evidence");
  } finally { fs.rmSync(fixture.root, { recursive: true, force: true }); }
});

test("successful migration quarantines exact retired entries and the proven old root node only", { skip: process.platform !== "win32" }, () => {
  const fixture = makeFixture();
  const retired = seedLegacyFlatEntries(fixture);
  try {
    const result = run(fixture);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    for (const relative of retired) assert.equal(fs.existsSync(path.join(fixture.install, ...relative.split("/"))), false, relative);
    assert.equal(fs.existsSync(path.join(fixture.install, "node.exe")), false);
    assert.equal(fs.readFileSync(path.join(fixture.install, "RabiRoute-Desktop.exe.backup"), "utf8"), "foreign suffix");
    const quarantined = fs.readdirSync(path.join(fixture.install, ".rabiroute-quarantine"), { recursive: true }).map(String);
    assert.ok(quarantined.some((entry) => entry.endsWith("RabiRoute-Desktop.exe.retired")));
    assert.ok(quarantined.some((entry) => entry.endsWith("node.exe.retired")));
  } finally { fs.rmSync(fixture.root, { recursive: true, force: true }); }
});

test("post-switch rollback restores every quarantined legacy entry", { skip: process.platform !== "win32" }, () => {
  const fixture = makeFixture();
  const retired = seedLegacyFlatEntries(fixture);
  try {
    const result = run(fixture, "after-pointer");
    assert.notEqual(result.status, 0);
    for (const relative of retired) assert.ok(fs.existsSync(path.join(fixture.install, ...relative.split("/"))), relative);
    assert.equal(fs.readFileSync(path.join(fixture.install, "node.exe"), "utf8"), "legacy root node");
    assert.equal(fs.readFileSync(path.join(fixture.install, "RabiRoute-Desktop.exe.backup"), "utf8"), "foreign suffix");
  } finally { fs.rmSync(fixture.root, { recursive: true, force: true }); }
});

test("an unproven foreign root node blocks migration without mutation", { skip: process.platform !== "win32" }, () => {
  const fixture = makeFixture();
  fs.writeFileSync(path.join(fixture.install, "node.exe"), "foreign node");
  try {
    const result = run(fixture);
    assert.notEqual(result.status, 0);
    assert.equal(fs.readFileSync(path.join(fixture.install, "node.exe"), "utf8"), "foreign node");
    assert.equal(fs.readFileSync(path.join(fixture.install, "RabiRouteHost.exe"), "utf8"), "old-bootstrap");
  } finally { fs.rmSync(fixture.root, { recursive: true, force: true }); }
});

test("power-loss journal restores a move that completed before its status flush", { skip: process.platform !== "win32" }, () => {
  const fixture = makeFixture("bad-core");
  const source = path.join(fixture.install, "RabiRoute-Desktop.exe");
  fs.writeFileSync(source, "legacy desktop");
  const transactionRoot = path.join(fixture.install, ".install-staging", "power-loss-fixture");
  const quarantineRoot = path.join(fixture.install, ".rabiroute-quarantine", "power-loss-fixture", "legacy-runtime");
  const destination = path.join(quarantineRoot, "RabiRoute-Desktop.exe.retired");
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.mkdirSync(transactionRoot, { recursive: true });
  fs.renameSync(source, destination);
  fs.writeFileSync(path.join(fixture.install, ".rabiroute-install-transaction.json"), `${JSON.stringify({
    schemaVersion: 1, appId: "io.rabiroute.windows", state: "quarantining", releaseId: fixture.releaseId,
    transactionRoot, destinationVersion: path.join(fixture.install, "versions", fixture.releaseId),
    versionCommitted: false, hadPointer: true, hadBootstrap: true, quarantineRoot,
    quarantineMoves: [{ relative: "RabiRoute-Desktop.exe", source, destination, status: "planned" }],
  })}\n`);
  try {
    const result = run(fixture);
    assert.notEqual(result.status, 0);
    assert.equal(fs.readFileSync(source, "utf8"), "legacy desktop");
    assert.equal(fs.existsSync(destination), false);
  } finally { fs.rmSync(fixture.root, { recursive: true, force: true }); }
});

test("recovery rejects a journal-controlled quarantine root without moving either file", { skip: process.platform !== "win32" }, () => {
  const fixture = makeFixture("bad-core");
  const source = path.join(fixture.install, "RabiRoute-Desktop.exe");
  const transactionRoot = path.join(fixture.install, ".install-staging", "unsafe-quarantine-fixture");
  const foreignRoot = path.join(fixture.root, "foreign-quarantine");
  const destination = path.join(foreignRoot, "RabiRoute-Desktop.exe.retired");
  fs.mkdirSync(transactionRoot, { recursive: true });
  fs.mkdirSync(foreignRoot, { recursive: true });
  fs.writeFileSync(destination, "foreign evidence");
  fs.writeFileSync(path.join(fixture.install, ".rabiroute-install-transaction.json"), `${JSON.stringify({
    schemaVersion: 1, appId: "io.rabiroute.windows", state: "quarantining", releaseId: fixture.releaseId,
    transactionRoot, destinationVersion: path.join(fixture.install, "versions", fixture.releaseId),
    versionMoveState: "not-started", versionCommitted: false, hadPointer: true, hadBootstrap: true,
    quarantineRoot: foreignRoot,
    quarantineMoves: [{ relative: "RabiRoute-Desktop.exe", source, destination, status: "planned" }],
  })}\n`);
  try {
    const result = run(fixture);
    assert.notEqual(result.status, 0);
    assert.equal(fs.existsSync(source), false);
    assert.equal(fs.readFileSync(destination, "utf8"), "foreign evidence");
  } finally { fs.rmSync(fixture.root, { recursive: true, force: true }); }
});

test("transaction promotes one immutable release and preserves foreign/data entries", { skip: process.platform !== "win32" }, () => {
  const fixture = makeFixture();
  fs.mkdirSync(path.join(fixture.install, "data"));
  fs.writeFileSync(path.join(fixture.install, "foreign.keep"), "owned by user");
  try {
    const result = run(fixture);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const pointer = JSON.parse(fs.readFileSync(path.join(fixture.install, "current.json"), "utf8"));
    assert.equal(pointer.releaseId, fixture.releaseId);
    assert.equal(pointer.versionPath, `versions/${fixture.releaseId}`);
    assert.equal(fs.readFileSync(path.join(fixture.install, "RabiRouteHost.exe"), "utf8"), "candidate-bootstrap");
    assert.equal(readLegacyTasks(fixture).length, 0);
    assert.ok(fs.existsSync(path.join(fixture.install, "data")));
    assert.equal(fs.readFileSync(path.join(fixture.install, "foreign.keep"), "utf8"), "owned by user");
  } finally { fs.rmSync(fixture.root, { recursive: true, force: true }); }
});

test("uninstall validates every manifest byte before deleting owned code", { skip: process.platform !== "win32" }, () => {
  const fixture = makeFixture();
  try {
    assert.equal(run(fixture).status, 0);
    assert.equal(runUninstall(fixture).status, 0);
    const activeFile = path.join(fixture.install, "versions", fixture.releaseId, "dist", "manager.js");
    fs.appendFileSync(activeFile, "tampered");
    const rejected = runUninstall(fixture, false);
    assert.notEqual(rejected.status, 0);
    assert.ok(fs.existsSync(activeFile));
    assert.ok(fs.existsSync(path.join(fixture.install, "current.json")));
    assert.ok(fs.existsSync(path.join(fixture.install, "RabiRouteHost.exe")));
  } finally { fs.rmSync(fixture.root, { recursive: true, force: true }); }
});

test("uninstall removes only a fully validated active version and preserves foreign roots", { skip: process.platform !== "win32" }, () => {
  const fixture = makeFixture();
  try {
    assert.equal(run(fixture).status, 0);
    const stableRuntime = path.join(fixture.install, "runtime", "node.exe");
    fs.mkdirSync(path.dirname(stableRuntime), { recursive: true });
    fs.copyFileSync(path.join(fixture.install, "versions", fixture.releaseId, "node.exe"), stableRuntime);
    fs.mkdirSync(path.join(fixture.install, "data"), { recursive: true });
    fs.writeFileSync(path.join(fixture.install, "foreign.keep"), "user-owned");
    const removed = runUninstall(fixture, false);
    assert.equal(removed.status, 0, removed.stderr || removed.stdout);
    assert.equal(fs.existsSync(path.join(fixture.install, "current.json")), false);
    assert.equal(fs.existsSync(path.join(fixture.install, "RabiRouteHost.exe")), false);
    assert.equal(fs.existsSync(stableRuntime), false);
    assert.ok(fs.existsSync(path.join(fixture.install, "data")));
    assert.equal(fs.readFileSync(path.join(fixture.install, "foreign.keep"), "utf8"), "user-owned");
  } finally { fs.rmSync(fixture.root, { recursive: true, force: true }); }
});

test("uninstall removes the owned Host-only Startup link", { skip: process.platform !== "win32" }, () => {
  const fixture = makeFixture();
  const startupPath = path.join(fixture.appData, "Microsoft", "Windows", "Start Menu", "Programs", "Startup", "RabiRoute.lnk");
  try {
    const installed = run(fixture, "", { autostartScript: autostartConfigurator, autostartEnabled: "true" });
    assert.equal(installed.status, 0, installed.stderr || installed.stdout);
    assert.ok(fs.existsSync(startupPath));

    const removed = runUninstall(fixture, false);
    assert.equal(removed.status, 0, removed.stderr || removed.stdout);
    assert.equal(fs.existsSync(startupPath), false);
  } finally { fs.rmSync(fixture.root, { recursive: true, force: true }); }
});

test("foreign same-name Startup link blocks uninstall before Host stop, task removal, or code mutation", { skip: process.platform !== "win32" }, () => {
  const fixture = makeFixture();
  const startupPath = path.join(fixture.appData, "Microsoft", "Windows", "Start Menu", "Programs", "Startup", "RabiRoute.lnk");
  const stopMarker = path.join(fixture.root, "stop-invoked.txt");
  const recordingStop = path.join(fixture.root, "record-stop.ps1");
  try {
    assert.equal(run(fixture).status, 0);
    fs.mkdirSync(path.dirname(startupPath), { recursive: true });
    const shortcut = createShortcut(fixture, startupPath, path.join(fixture.root, "foreign", "NapCat.exe"));
    assert.equal(shortcut.status, 0, shortcut.stderr || shortcut.stdout);
    fs.writeFileSync(recordingStop, "[IO.File]::WriteAllText($env:RABIROUTE_TEST_STOP_MARKER, 'called')\nexit 0\n", "utf8");

    const store = JSON.parse(fs.readFileSync(fixture.taskStore, "utf8"));
    store.tasks = [fixture.legacyTaskRecord];
    fs.writeFileSync(fixture.taskStore, `${JSON.stringify(store)}\n`, "utf8");
    const taskBefore = fs.readFileSync(fixture.taskStore);
    const activeFile = path.join(fixture.install, "versions", fixture.releaseId, "dist", "manager.js");
    const rejected = spawnSync(powershell, [
      "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", uninstallTransaction,
      "-InstallRoot", fixture.install, "-StopHostScript", recordingStop,
      "-LegacyTaskMigrationScript", legacyTaskMigration, "-AutostartScript", autostartConfigurator,
      "-TestLegacyTaskStorePath", fixture.taskStore,
    ], {
      encoding: "utf8",
      env: {
        ...process.env,
        APPDATA: fixture.appData,
        RABIROUTE_INSTALL_TRANSACTION_TEST_MODE: "1",
        RABIROUTE_TEST_STOP_MARKER: stopMarker,
      },
      timeout: 30_000,
    });
    assert.notEqual(rejected.status, 0);
    assert.equal(fs.existsSync(stopMarker), false);
    assert.deepEqual(fs.readFileSync(fixture.taskStore), taskBefore);
    assert.ok(fs.existsSync(activeFile));
    assert.ok(fs.existsSync(path.join(fixture.install, "current.json")));
    assert.equal(fs.existsSync(path.join(fixture.install, ".rabiroute-uninstall-transaction.json")), false);
  } finally { fs.rmSync(fixture.root, { recursive: true, force: true }); }
});

test("uninstall safely retires a managed legacy wearable task", { skip: process.platform !== "win32" }, () => {
  const fixture = makeFixture();
  try {
    assert.equal(run(fixture).status, 0);
    const store = JSON.parse(fs.readFileSync(fixture.taskStore, "utf8"));
    store.tasks = [fixture.legacyTaskRecord];
    fs.writeFileSync(fixture.taskStore, `${JSON.stringify(store)}\n`, "utf8");
    const removed = runUninstall(fixture, false);
    assert.equal(removed.status, 0, removed.stderr || removed.stdout);
    assert.equal(readLegacyTasks(fixture).length, 0);
    assert.equal(fs.existsSync(path.join(fixture.install, "current.json")), false);
  } finally { fs.rmSync(fixture.root, { recursive: true, force: true }); }
});

test("uninstall resumes after an owned-file deletion interruption and retains the wearable task backup until commit", { skip: process.platform !== "win32" }, () => {
  const fixture = makeFixture();
  try {
    assert.equal(run(fixture).status, 0);
    const store = JSON.parse(fs.readFileSync(fixture.taskStore, "utf8"));
    store.tasks = [fixture.legacyTaskRecord];
    fs.writeFileSync(fixture.taskStore, `${JSON.stringify(store)}\n`, "utf8");

    const interrupted = runUninstall(fixture, false, { failDeleteAt: 2 });
    assert.notEqual(interrupted.status, 0);
    const journalPath = path.join(fixture.install, ".rabiroute-uninstall-transaction.json");
    assert.ok(fs.existsSync(journalPath));
    const journal = JSON.parse(fs.readFileSync(journalPath, "utf8"));
    assert.ok(fs.existsSync(path.join(journal.taskBackupRoot, "task-backup.json")));
    assert.equal(readLegacyTasks(fixture).length, 0);

    const retry = runUninstall(fixture, false);
    assert.equal(retry.status, 0, retry.stderr || retry.stdout);
    assert.equal(fs.existsSync(journalPath), false);
    assert.equal(fs.existsSync(journal.taskBackupRoot), false);
    assert.equal(fs.existsSync(path.join(fixture.install, "current.json")), false);
    assert.equal(fs.existsSync(path.join(fixture.install, "RabiRouteHost.exe")), false);
    assert.equal(fs.existsSync(path.join(fixture.install, "versions", fixture.releaseId)), false);
    assert.equal(readLegacyTasks(fixture).length, 0);
  } finally { fs.rmSync(fixture.root, { recursive: true, force: true }); }
});

for (const stage of ["manifest", "pointer", "bootstrap"]) {
  test(`uninstall retry converges after ${stage} removal is interrupted`, { skip: process.platform !== "win32" }, () => {
    const fixture = makeFixture();
    try {
      assert.equal(run(fixture).status, 0);
      const interrupted = runUninstall(fixture, false, { failStage: stage });
      assert.notEqual(interrupted.status, 0);
      assert.ok(fs.existsSync(path.join(fixture.install, ".rabiroute-uninstall-transaction.json")));

      const retry = runUninstall(fixture, false);
      assert.equal(retry.status, 0, retry.stderr || retry.stdout);
      assert.equal(fs.existsSync(path.join(fixture.install, ".rabiroute-uninstall-transaction.json")), false);
      assert.equal(fs.existsSync(path.join(fixture.install, "current.json")), false);
      assert.equal(fs.existsSync(path.join(fixture.install, "RabiRouteHost.exe")), false);
      assert.equal(fs.existsSync(path.join(fixture.install, "versions", fixture.releaseId)), false);
    } finally { fs.rmSync(fixture.root, { recursive: true, force: true }); }
  });
}

for (const stage of ["cleanup", "cleanup-after-root"]) {
  test(`committed uninstall cleanup resumes after ${stage} interruption without orphaning task backup state`, { skip: process.platform !== "win32" }, () => {
    const fixture = makeFixture();
    try {
      assert.equal(run(fixture).status, 0);
      const interrupted = runUninstall(fixture, false, { failStage: stage });
      assert.notEqual(interrupted.status, 0);
      const journalPath = path.join(fixture.install, ".rabiroute-uninstall-transaction.json");
      assert.ok(fs.existsSync(journalPath));
      const journal = JSON.parse(fs.readFileSync(journalPath, "utf8"));
      assert.equal(journal.state, "committed");
      assert.equal(fs.existsSync(journal.transactionRoot), stage === "cleanup");
      if (stage === "cleanup") assert.ok(fs.existsSync(path.join(journal.taskBackupRoot, "task-backup.json")));

      const retry = runUninstall(fixture, false);
      assert.equal(retry.status, 0, retry.stderr || retry.stdout);
      assert.equal(fs.existsSync(journalPath), false);
      assert.equal(fs.existsSync(journal.transactionRoot), false);
      assert.equal(fs.existsSync(journal.taskBackupRoot), false);
    } finally { fs.rmSync(fixture.root, { recursive: true, force: true }); }
  });
}

for (const stage of ["manifest", "pointer", "bootstrap"]) {
  test(`uninstall retains its journal when ${stage} deletion really fails and the target remains`, { skip: process.platform !== "win32" }, async () => {
    const fixture = makeFixture();
    let lockProcess;
    try {
      assert.equal(run(fixture).status, 0);
      const prepared = runUninstall(fixture, false, { failDeleteAt: 1 });
      assert.notEqual(prepared.status, 0);
      const journalPath = path.join(fixture.install, ".rabiroute-uninstall-transaction.json");
      assert.ok(fs.existsSync(journalPath));
      const target = stage === "manifest"
        ? path.join(fixture.install, "versions", fixture.releaseId, "release-manifest.json")
        : path.join(fixture.install, stage === "pointer" ? "current.json" : "RabiRouteHost.exe");
      const ready = path.join(fixture.root, `${stage}-lock-ready.txt`);
      const lockScript = path.join(fixture.root, `${stage}-lock.ps1`);
      fs.writeFileSync(lockScript, [
        "param([string]$Target, [string]$Ready)",
        "$stream = [IO.FileStream]::new($Target, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::None)",
        "try { [IO.File]::WriteAllText($Ready, 'ready'); Start-Sleep -Seconds 30 } finally { $stream.Dispose() }",
      ].join("\r\n"), "utf8");
      lockProcess = spawn(powershell, [
        "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", lockScript,
        "-Target", target, "-Ready", ready,
      ], { stdio: "ignore", windowsHide: true });
      for (let attempt = 0; attempt < 100 && !fs.existsSync(ready); attempt += 1) await delay(25);
      assert.ok(fs.existsSync(ready), "exclusive file lock did not become ready");

      const rejected = runUninstall(fixture, false);
      assert.notEqual(rejected.status, 0);
      assert.ok(fs.existsSync(target), `${stage} target must remain after the real deletion failure`);
      assert.ok(fs.existsSync(journalPath));
      const journal = JSON.parse(fs.readFileSync(journalPath, "utf8"));
      const flag = stage === "manifest" ? "manifestRemoved" : stage === "pointer" ? "pointerRemoved" : "bootstrapRemoved";
      assert.equal(journal[flag], false);

      lockProcess.kill();
      await once(lockProcess, "exit");
      lockProcess = undefined;
      const retry = runUninstall(fixture, false);
      assert.equal(retry.status, 0, retry.stderr || retry.stdout);
      assert.equal(fs.existsSync(journalPath), false);
      assert.equal(fs.existsSync(target), false);
    } finally {
      if (lockProcess && lockProcess.exitCode === null) {
        lockProcess.kill();
        await Promise.race([once(lockProcess, "exit"), delay(5_000)]);
      }
      fs.rmSync(fixture.root, { recursive: true, force: true });
    }
  });
}

test("foreign same-name wearable task blocks uninstall without task or code mutation", { skip: process.platform !== "win32" }, () => {
  const fixture = makeFixture();
  try {
    assert.equal(run(fixture).status, 0);
    const store = JSON.parse(fs.readFileSync(fixture.taskStore, "utf8"));
    const foreign = structuredClone(fixture.legacyTaskRecord);
    foreign.actions[0].arguments = foreign.actions[0].arguments.replace('"YeYu"', '"Foreign"');
    store.tasks = [foreign];
    fs.writeFileSync(fixture.taskStore, `${JSON.stringify(store)}\n`, "utf8");
    const before = fs.readFileSync(fixture.taskStore);
    const activeFile = path.join(fixture.install, "versions", fixture.releaseId, "dist", "manager.js");
    const rejected = runUninstall(fixture, false);
    assert.notEqual(rejected.status, 0);
    assert.deepEqual(fs.readFileSync(fixture.taskStore), before);
    assert.ok(fs.existsSync(activeFile));
    assert.ok(fs.existsSync(path.join(fixture.install, "current.json")));
  } finally { fs.rmSync(fixture.root, { recursive: true, force: true }); }
});

test("installer embeds the exact portable ZIP and has no flat overwrite or unfenced quit", () => {
  assert.match(installer, /Source: "\{#PortableZip\}"[\s\S]*Flags: dontcopy/);
  assert.doesNotMatch(installer, /SourceDir|recursesubdirs|InstallDelete|allow-unfenced-quit/);
  assert.match(installer, /ResultCode := -1/);
  assert.match(installer, /Exec\([\s\S]*ewWaitUntilTerminated, ResultCode\) and \(ResultCode = 0\)/);
  assert.match(installer, /if not Result then Log\(Format\('[^']*ResultCode=%d/);
  assert.match(installer, /PrepareToInstall[\s\S]*if not InstallTransaction then[\s\S]*安装已 fail-closed/);
  assert.match(installer, /Install-RabiRouteReleaseTransaction\.ps1/);
  assert.match(installer, /Uninstall-RabiRouteReleaseTransaction\.ps1/);
  assert.match(installer, /RunUninstallTransaction[\s\S]*-AutostartScript[\s\S]*Configure-WindowsAutostart\.ps1/);
  assert.match(installer, /Migrate-LegacyWearableHealthTask\.ps1/);
  assert.match(stopContract, /--application-generation-id/);
  assert.doesNotMatch(stopContract, /allow-unfenced-quit|Stop-Process|taskkill/i);
  assert.match(build, /version-payload/);
  assert.match(build, /distribution/);
  assert.match(build, /RabiRouteHost\.Core\.dll/);
  assert.match(build, /versionPath = "versions\/\$\(/);
  for (const retired of [
    "RabiRoute-Desktop.exe", "RabiRoute-Tray.exe", "RabiRoute-Tray.new.exe",
    "Start-RabiRoute-Tray.bat", "Start-RabiRoute-Health-Watchdog.bat", "Start-RabiRoute-MessageAdapter-Watchdog.bat",
    "Install-RabiRoute-HealthWatchdogTask.ps1", "watch-message-adapters.ps1",
    "watch-rabiroute-desktop-lifecycle.ps1", "watch-rabiroute-health-hidden.vbs", "watch-rabiroute-health.ps1",
  ]) assert.ok(transactionContract.includes(retired), retired);
  assert.match(transactionContract, /\.retired/);
  assert.match(transactionContract, /Save-Journal "version-move-planned" "planned"/);
  assert.doesNotMatch(transactionContract, /bootstrap\.replace|pointer\.replace|temporary\.replaced/);
  assert.match(transactionContract, /function Move-DirectoryWithRetry/);
  assert.match(transactionContract, /Move-DirectoryWithRetry \$release\.version \$destinationVersion/);
  assert.match(transactionContract, /NullString\]::Value, \$true\)/);
  assert.match(transactionContract, /after-version-move-before-journal/);
  assert.match(transactionContract, /after-legacy-task-remove-before-journal/);
  assert.match(transactionContract, /legacyTaskMigrationState/);
  assert.match(transactionContract, /Assert-QuarantineJournal/);
  assert.match(uninstallContract, /Read-ValidatedOwnedRelease/);
  assert.match(uninstallContract, /Remove-StableNodeRuntime/);
  assert.match(uninstallContract, /Manifest content mismatch/);
  assert.match(uninstallContract, /Active release file set does not match its manifest/);
});
