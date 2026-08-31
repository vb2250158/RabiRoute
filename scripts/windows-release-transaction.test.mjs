import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { writeManifest } from "./create-windows-release-manifest.mjs";

const transaction = fileURLToPath(new URL("./Install-RabiRouteReleaseTransaction.ps1", import.meta.url));
const transactionContract = fs.readFileSync(transaction, "utf8");
const uninstallTransaction = fileURLToPath(new URL("./Uninstall-RabiRouteReleaseTransaction.ps1", import.meta.url));
const uninstallContract = fs.readFileSync(uninstallTransaction, "utf8");
const legacyTaskMigration = fileURLToPath(new URL("./Migrate-LegacyWearableHealthTask.ps1", import.meta.url));
const stopContract = fs.readFileSync(new URL("./Stop-RabiRouteHostFenced.ps1", import.meta.url), "utf8");
const installer = fs.readFileSync(new URL("../installer/RabiRoute.iss", import.meta.url), "utf8");
const build = fs.readFileSync(new URL("./build-windows-release.ps1", import.meta.url), "utf8");
const powershell = path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");

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
  fs.writeFileSync(path.join(install, "current.json"), '{"old":true}\n');
  const currentSid = "S-1-5-21-1000";
  const runner = "Z:\\DigitalLife\\RabiRoute\\examples\\android-rabi-link-probe\\scripts\\Start-RabiLinkWearableCompanion.ps1";
  const taskStore = path.join(root, "task-store.json");
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
  return { root, install, zip, helper, taskStore, legacyTaskRecord, releaseId: manifest.releaseId };
}

function run(fixture, fault = "") {
  const args = ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", transaction,
    "-InstallRoot", fixture.install, "-PortableZip", fixture.zip, "-ExpectedReleaseId", fixture.releaseId,
    "-StopHostScript", fixture.helper, "-LegacyMigrationScript", fixture.helper,
    "-LegacyTaskMigrationScript", legacyTaskMigration, "-TestLegacyTaskStorePath", fixture.taskStore,
    "-AutostartScript", fixture.helper, "-TestSelfTestScript", fixture.helper];
  if (fault) args.push("-FaultPoint", fault);
  return spawnSync(powershell, args, { encoding: "utf8", env: { ...process.env, RABIROUTE_INSTALL_TRANSACTION_TEST_MODE: "1" }, timeout: 30_000 });
}

function runUninstall(fixture, preflight = true) {
  const args = ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", uninstallTransaction,
    "-InstallRoot", fixture.install, "-StopHostScript", fixture.helper,
    "-LegacyTaskMigrationScript", legacyTaskMigration, "-TestLegacyTaskStorePath", fixture.taskStore];
  if (preflight) args.push("-PreflightOnly");
  return spawnSync(powershell, args, { encoding: "utf8", env: { ...process.env, RABIROUTE_INSTALL_TRANSACTION_TEST_MODE: "1" }, timeout: 30_000 });
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
      assert.equal(fs.readFileSync(path.join(fixture.install, "current.json"), "utf8"), '{"old":true}\n');
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
    assert.equal(fs.readFileSync(path.join(fixture.install, "current.json"), "utf8"), '{"old":true}\n');
    assert.equal(readLegacyTasks(fixture).length, 1);
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
    assert.equal(fs.readFileSync(path.join(fixture.install, "current.json"), "utf8"), '{"old":true}\n');
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
    fs.mkdirSync(path.join(fixture.install, "data"), { recursive: true });
    fs.writeFileSync(path.join(fixture.install, "foreign.keep"), "user-owned");
    const removed = runUninstall(fixture, false);
    assert.equal(removed.status, 0, removed.stderr || removed.stdout);
    assert.equal(fs.existsSync(path.join(fixture.install, "current.json")), false);
    assert.equal(fs.existsSync(path.join(fixture.install, "RabiRouteHost.exe")), false);
    assert.ok(fs.existsSync(path.join(fixture.install, "data")));
    assert.equal(fs.readFileSync(path.join(fixture.install, "foreign.keep"), "utf8"), "user-owned");
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
  assert.match(installer, /Install-RabiRouteReleaseTransaction\.ps1/);
  assert.match(installer, /Uninstall-RabiRouteReleaseTransaction\.ps1/);
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
  assert.match(transactionContract, /after-version-move-before-journal/);
  assert.match(transactionContract, /after-legacy-task-remove-before-journal/);
  assert.match(transactionContract, /legacyTaskMigrationState/);
  assert.match(transactionContract, /Assert-QuarantineJournal/);
  assert.match(uninstallContract, /Read-ValidatedOwnedRelease/);
  assert.match(uninstallContract, /Manifest content mismatch/);
  assert.match(uninstallContract, /Active release file set does not match its manifest/);
});
