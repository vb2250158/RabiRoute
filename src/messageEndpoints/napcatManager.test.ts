import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { resolveNapcatLaunchPlan } from "./napcatManager.js";

function createOuterShellFixture(): { root: string; shellDir: string; launcher: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-napcat-"));
  const shellDir = path.join(root, "NapCat.44498.Shell");
  const innerDir = path.join(shellDir, "versions", "9.9.26-44498", "resources", "app", "napcat");
  fs.mkdirSync(innerDir, { recursive: true });
  fs.writeFileSync(path.join(shellDir, "napcat.bat"), "@echo off\r\nNapCatWinBootMain.exe\r\n", "utf8");
  fs.writeFileSync(path.join(shellDir, "NapCatWinBootMain.exe"), "", "utf8");
  const launcher = path.join(innerDir, "launcher-user.bat");
  fs.writeFileSync(launcher, "@echo off\r\n", "utf8");
  return { root, shellDir, launcher };
}

test("NapCat launch plan redirects outer Shell to inner launcher with bot quick login", () => {
  const fixture = createOuterShellFixture();
  try {
    const plan = resolveNapcatLaunchPlan({
      id: "bot",
      name: "QQ bot",
      gatewayPort: 8789,
      httpUrl: "http://127.0.0.1:3001",
      webuiUrl: "http://127.0.0.1:6099/webui",
      launchCommand: "napcat.bat",
      workingDir: fixture.shellDir,
      botUserId: "10000"
    }, fixture.root);

    assert.equal(plan.redirectedFromOuterShell, true);
    assert.equal(plan.commandPath, fixture.launcher);
    assert.deepEqual(plan.args, ["-q", "10000"]);
    assert.match(plan.commandLine, /launcher-user\.bat/);
    assert.match(plan.commandLine, /10000/);
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("NapCat launch plan keeps existing quick login argument when redirecting", () => {
  const fixture = createOuterShellFixture();
  try {
    const plan = resolveNapcatLaunchPlan({
      id: "bot",
      gatewayPort: 8789,
      httpUrl: "http://127.0.0.1:3001",
      launchCommand: "napcat.bat -q 10000",
      workingDir: fixture.shellDir,
      botUserId: "10000"
    }, fixture.root);

    assert.equal(plan.commandPath, fixture.launcher);
    assert.deepEqual(plan.args, ["-q", "10000"]);
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});
