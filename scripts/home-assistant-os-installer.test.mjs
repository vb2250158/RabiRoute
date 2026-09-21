import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

test("Windows PowerShell can atomically replace HA OS progress more than once", { skip: process.platform !== "win32" }, t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "haos-status-test-"));
  t.after(() => {
    assert.equal(path.dirname(root), fs.realpathSync(os.tmpdir()));
    fs.rmSync(root, { recursive: true, force: true });
  });
  const source = fileURLToPath(new URL("./Install-HomeAssistantOs.ps1", import.meta.url));
  const literal = value => `'${value.replaceAll("'", "''")}'`;
  const script = `
$ErrorActionPreference = 'Stop'
$tokens=$null; $errors=$null
$ast=[System.Management.Automation.Language.Parser]::ParseFile(${literal(source)},[ref]$tokens,[ref]$errors)
if($errors.Count){throw 'Installer syntax errors'}
$function=$ast.Find({param($node) $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Write-Status'},$true)
Invoke-Expression $function.Extent.Text
$Root=${literal(root)}
$statusPath=Join-Path $Root 'status.json'
Write-Status 'installing' 'first'
Write-Status 'installing' 'second'
Write-Status 'reboot_required' 'third'
`;
  execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")], { windowsHide: true });
  const result = JSON.parse(fs.readFileSync(path.join(root, "status.json"), "utf8"));
  assert.equal(result.state, "reboot_required");
  assert.equal(result.message, "third");
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, "status.previous.json"), "utf8")).message, "second");
});
