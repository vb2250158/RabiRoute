import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

async function runPowerShell(scriptPath, args) {
  const executable = path.join(
    process.env.SystemRoot || "C:\\Windows",
    "System32", "WindowsPowerShell", "v1.0", "powershell.exe"
  );
  const child = spawn(executable, [
    "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", scriptPath, ...args
  ], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
  child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
  const exitCode = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", resolve);
  });
  return { exitCode, stdout, stderr };
}

function makeRoot(desiredState, parentDir = os.tmpdir()) {
  const root = fs.mkdtempSync(path.join(parentDir, ".tmp-rabiroute-desktop-supervisor-"));
  const scriptsDir = path.join(root, "scripts");
  fs.mkdirSync(scriptsDir, { recursive: true });
  fs.copyFileSync(
    fileURLToPath(new URL("./watch-rabiroute-desktop-lifecycle.ps1", import.meta.url)),
    path.join(scriptsDir, "watch-rabiroute-desktop-lifecycle.ps1")
  );
  const intentPath = path.join(root, "data", "runtime", "desktop-lifecycle-intent.json");
  fs.mkdirSync(path.dirname(intentPath), { recursive: true });
  fs.writeFileSync(intentPath, `${JSON.stringify({
    schemaVersion: 1,
    desiredState,
    updatedAt: new Date().toISOString(),
    source: "windows-desktop"
  }, null, 2)}\n`, "utf8");
  return root;
}

test("desktop lifecycle supervisor fails closed after an explicit stop intent", async () => {
  const root = makeRoot("stopped");
  try {
    const script = path.join(root, "scripts", "watch-rabiroute-desktop-lifecycle.ps1");
    const result = await runPowerShell(script, ["-Once", "-FailureThreshold", "1"]);
    assert.equal(result.exitCode, 0, `${result.stdout}\n${result.stderr}`);
    const logPath = path.join(root, "data", "route", "default-main", "logs", "desktop-lifecycle-supervisor.jsonl");
    const record = JSON.parse(fs.readFileSync(logPath, "utf8").trim());
    assert.equal(record.status, "stopped");
    assert.equal(record.desiredState, "stopped");
    assert.equal(fs.existsSync(path.join(root, "repair-receipt.txt")), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("desktop lifecycle supervisor invokes the non-recursive launcher when the tray is missing", async () => {
  const root = makeRoot("running");
  const launcher = path.join(root, "Start-RabiRoute-Desktop.bat");
  fs.writeFileSync(launcher, "@echo off\r\necho %* > \"%~dp0repair-receipt.txt\"\r\nexit /b 0\r\n", "utf8");
  const server = http.createServer((request, response) => {
    response.setHeader("content-type", "application/json");
    if (request.url === "/meta") response.end(JSON.stringify({ version: "test" }));
    else { response.statusCode = 404; response.end(); }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("mock Manager did not bind");
  try {
    const script = path.join(root, "scripts", "watch-rabiroute-desktop-lifecycle.ps1");
    const result = await runPowerShell(script, [
      "-ManagerUrl", `http://127.0.0.1:${address.port}`,
      "-Once", "-FailureThreshold", "1"
    ]);
    assert.equal(result.exitCode, 0, `${result.stdout}\n${result.stderr}`);
    const receipt = fs.readFileSync(path.join(root, "repair-receipt.txt"), "utf8");
    assert.match(receipt, /-NoDesktopSupervisor/);
    assert.match(receipt, /-ReuseHealthyManager/);
    const logPath = path.join(root, "data", "route", "default-main", "logs", "desktop-lifecycle-supervisor.jsonl");
    const record = JSON.parse(fs.readFileSync(logPath, "utf8").trim());
    assert.equal(record.repairAttempted, true);
    assert.equal(record.managerConnected, true);
    assert.equal(record.managerPresent, true);
    assert.equal(record.desktopShellCount, 0);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("desktop lifecycle supervisor repairs an unresponsive Manager even while its process remains present", async () => {
  const root = makeRoot("running", process.cwd());
  const distManager = path.join(root, "dist", "manager.js");
  const helper = path.join(root, "keep-alive.cjs");
  const trayMain = path.join(root, "desktop", "tray-task-window", "main.py");
  const launcher = path.join(root, "Start-RabiRoute-Desktop.bat");
  fs.mkdirSync(path.dirname(distManager), { recursive: true });
  fs.mkdirSync(path.dirname(trayMain), { recursive: true });
  fs.writeFileSync(distManager, "setInterval(() => {}, 1000);\n", "utf8");
  fs.writeFileSync(helper, "setInterval(() => {}, 1000);\n", "utf8");
  fs.writeFileSync(trayMain, "# process identity marker\n", "utf8");
  fs.writeFileSync(launcher, "@echo off\r\necho %* > \"%~dp0repair-receipt.txt\"\r\nexit /b 0\r\n", "utf8");
  const manager = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)", distManager], { windowsHide: true, stdio: "ignore" });
  const tray = spawn(process.execPath, [helper, trayMain], { windowsHide: true, stdio: "ignore" });
  try {
    await new Promise((resolve) => setTimeout(resolve, 300));
    const script = path.join(root, "scripts", "watch-rabiroute-desktop-lifecycle.ps1");
    const result = await runPowerShell(script, [
      "-ManagerUrl", "http://127.0.0.1:1",
      "-Once", "-FailureThreshold", "1"
    ]);
    assert.equal(result.exitCode, 0, `${result.stdout}\n${result.stderr}`);
    const receipt = fs.readFileSync(path.join(root, "repair-receipt.txt"), "utf8");
    assert.match(receipt, /-NoDesktopSupervisor/);
    assert.match(receipt, /-ReuseHealthyManager/);
    const logPath = path.join(root, "data", "route", "default-main", "logs", "desktop-lifecycle-supervisor.jsonl");
    const record = JSON.parse(fs.readFileSync(logPath, "utf8").trim());
    assert.equal(record.managerConnected, false);
    assert.equal(record.managerPresent, true);
    assert.equal(record.managerFailureCount, 1);
    assert.notEqual(record.managerProbeError, "");
    assert.equal(record.desktopShellCount > 0, true);
    assert.equal(record.repairAttempted, true);
  } finally {
    manager.kill();
    tray.kill();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
