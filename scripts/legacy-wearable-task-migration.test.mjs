import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("./Migrate-LegacyWearableHealthTask.ps1", import.meta.url));
const powershell = path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
const currentSid = "S-1-5-21-1000";
const runner = "Z:\\DigitalLife\\RabiRoute\\examples\\android-rabi-link-probe\\scripts\\Start-RabiLinkWearableCompanion.ps1";
const workingDirectory = path.win32.dirname(runner);
const legacyArguments = `-NoLogo -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "${runner}" -ManagerUrl "http://127.0.0.1:8790" -RoleId "YeYu"`;

function managedTask(overrides = {}) {
  const task = {
    taskName: "RabiLinkWearableHealthCompanion",
    taskPath: "\\",
    principal: { userId: currentSid, logonType: "InteractiveToken", runLevel: "Limited" },
    triggers: [{ type: "Logon", userId: currentSid }],
    actions: [{ execute: "C:\\Program Files\\PowerShell\\7\\pwsh.exe", arguments: legacyArguments, workingDirectory }],
    description: "RabiLink 小米手表/手环健康 ADB Companion；配置真源在手机端。",
    state: "Running",
    xml: "<Task version=\"1.4\"><RegistrationInfo><Description>RabiLink legacy</Description></RegistrationInfo></Task>",
  };
  return {
    ...task,
    ...overrides,
    principal: { ...task.principal, ...(overrides.principal ?? {}) },
    actions: overrides.actions ?? task.actions,
    triggers: overrides.triggers ?? task.triggers,
  };
}

function fixture(tasks = [managedTask()]) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-legacy-wearable-task-"));
  const store = path.join(root, "task-store.json");
  fs.writeFileSync(store, `${JSON.stringify({ schemaVersion: 1, currentSid, tasks })}\n`, "utf8");
  return { root, store, backup: path.join(root, "backup") };
}

function run(target, mode, { backup = false, testMode = true } = {}) {
  const args = ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", script, "-Mode", mode, "-TaskStorePath", target.store];
  if (backup) args.push("-BackupRoot", target.backup);
  return spawnSync(powershell, args, {
    encoding: "utf8",
    env: { ...process.env, RABIROUTE_INSTALL_TRANSACTION_TEST_MODE: testMode ? "1" : "0" },
    timeout: 20_000,
  });
}

function readTasks(target) {
  return JSON.parse(fs.readFileSync(target.store, "utf8")).tasks;
}

test("managed legacy task is backed up, retired, and restored with its running state", { skip: process.platform !== "win32" }, () => {
  const target = fixture();
  try {
    const removed = run(target, "Remove", { backup: true });
    assert.equal(removed.status, 0, removed.stderr || removed.stdout);
    assert.deepEqual(readTasks(target), []);
    assert.ok(fs.existsSync(path.join(target.backup, "task.xml")));
    const restored = run(target, "Restore", { backup: true });
    assert.equal(restored.status, 0, restored.stderr || restored.stdout);
    assert.equal(readTasks(target).length, 1);
    assert.equal(readTasks(target)[0].state, "Running");
    assert.equal(readTasks(target)[0].xml, managedTask().xml);
  } finally { fs.rmSync(target.root, { recursive: true, force: true }); }
});

test("absent legacy task has an idempotent durable backup and restore", { skip: process.platform !== "win32" }, () => {
  const target = fixture([]);
  try {
    assert.equal(run(target, "Remove", { backup: true }).status, 0);
    assert.deepEqual(readTasks(target), []);
    const metadata = JSON.parse(fs.readFileSync(path.join(target.backup, "task-backup.json"), "utf8"));
    assert.equal(metadata.wasPresent, false);
    assert.equal(run(target, "Restore", { backup: true }).status, 0);
    assert.deepEqual(readTasks(target), []);
  } finally { fs.rmSync(target.root, { recursive: true, force: true }); }
});

const foreignCases = {
  "different SID": managedTask({ principal: { userId: "S-1-5-21-2000" } }),
  "non-interactive principal": managedTask({ principal: { logonType: "Password" } }),
  "different trigger SID": managedTask({ triggers: [{ type: "Logon", userId: "S-1-5-21-2000" }] }),
  "multiple actions": managedTask({ actions: [...managedTask().actions, managedTask().actions[0]] }),
  "local runner": managedTask({ actions: [{ ...managedTask().actions[0], arguments: legacyArguments.replace(runner, "C:\\temp\\Start-RabiLinkWearableCompanion.ps1"), workingDirectory: "C:\\temp" }] }),
  "local DigitalLife lookalike": managedTask({ actions: [{ ...managedTask().actions[0], arguments: legacyArguments.replace(runner, "C:\\DigitalLife\\RabiRoute\\examples\\android-rabi-link-probe\\scripts\\Start-RabiLinkWearableCompanion.ps1"), workingDirectory: "C:\\DigitalLife\\RabiRoute\\examples\\android-rabi-link-probe\\scripts" }] }),
  "different Manager URL": managedTask({ actions: [{ ...managedTask().actions[0], arguments: legacyArguments.replace("127.0.0.1:8790", "127.0.0.1:12345") }] }),
  "different RoleId": managedTask({ actions: [{ ...managedTask().actions[0], arguments: legacyArguments.replace('"YeYu"', '"Rabi"') }] }),
};

for (const [name, task] of Object.entries(foreignCases)) {
  test(`foreign same-name task is fail-closed without mutation: ${name}`, { skip: process.platform !== "win32" }, () => {
    const target = fixture([task]);
    try {
      const before = fs.readFileSync(target.store);
      const result = run(target, "Remove", { backup: true });
      assert.notEqual(result.status, 0);
      assert.deepEqual(fs.readFileSync(target.store), before);
      assert.equal(fs.existsSync(target.backup), false);
    } finally { fs.rmSync(target.root, { recursive: true, force: true }); }
  });
}

test("fake task store is rejected outside explicit transaction test mode", { skip: process.platform !== "win32" }, () => {
  const target = fixture();
  try {
    const before = fs.readFileSync(target.store);
    const result = run(target, "Inspect", { testMode: false });
    assert.notEqual(result.status, 0);
    assert.deepEqual(fs.readFileSync(target.store), before);
  } finally { fs.rmSync(target.root, { recursive: true, force: true }); }
});
