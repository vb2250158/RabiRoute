import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import http from "node:http";
import { promisify } from "node:util";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

test("HA OS ownership accepts its checkpoint chain and rejects foreign or cyclic disks", { skip: process.platform !== "win32" }, () => {
  const source = fileURLToPath(new URL("./Install-HomeAssistantOs.ps1", import.meta.url));
  const script = `
$ErrorActionPreference = 'Stop'
$tokens=$null; $errors=$null
$ast=[System.Management.Automation.Language.Parser]::ParseFile('${source.replaceAll("'", "''")}',[ref]$tokens,[ref]$errors)
$function=$ast.Find({param($node) $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Test-InstallationDisk'},$true)
Invoke-Expression $function.Extent.Text
function Get-VHD($Path) { @{ ParentPath = $parents[$Path] } }
$parents=@{'C:\\haos\\checkpoint.avhdx'='C:\\haos\\home-assistant.vhdx';'C:\\haos\\cycle.avhdx'='C:\\haos\\cycle.avhdx';'C:\\haos\\foreign.avhdx'='C:\\other\\base.vhdx'}
$base='C:\\haos\\home-assistant.vhdx'
if(-not (Test-InstallationDisk $base $base)){throw 'Base disk rejected'}
if(-not (Test-InstallationDisk 'C:\\haos\\checkpoint.avhdx' $base)){throw 'Owned checkpoint rejected'}
if(Test-InstallationDisk 'C:\\haos\\cycle.avhdx' $base){throw 'Cycle accepted'}
if(Test-InstallationDisk 'C:\\haos\\foreign.avhdx' $base){throw 'Foreign disk accepted'}
if(Test-InstallationDisk 'C:\\other\\checkpoint.avhdx' $base){throw 'External checkpoint accepted'}
`;
  execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")], { windowsHide: true });
});

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

test("HA OS download reports actual bytes and rejects truncated responses", { skip: process.platform !== "win32" }, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "haos-download-test-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const server = http.createServer((request, response) => {
    response.writeHead(200);
    response.write(Buffer.alloc(1024));
    setTimeout(() => {
      response.write(Buffer.alloc(1024));
      setTimeout(() => response.end(request.url === "/short" ? undefined : Buffer.alloc(1024)), 600);
    }, 600);
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const source = fileURLToPath(new URL("./Install-HomeAssistantOs.ps1", import.meta.url));
  const literal = value => `'${value.replaceAll("'", "''")}'`;
  const script = `
$ErrorActionPreference='Stop'
$tokens=$null; $errors=$null
$ast=[System.Management.Automation.Language.Parser]::ParseFile(${literal(source)},[ref]$tokens,[ref]$errors)
if($errors.Count){throw 'Installer syntax errors'}
foreach($name in @('Write-Status','Save-ImageDownload')) {
  $function=$ast.Find({param($node) $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq $name},$true)
  Invoke-Expression $function.Extent.Text
}
$Root=${literal(root)}
$statusPath=Join-Path $Root 'status.json'
Save-ImageDownload 'http://127.0.0.1:${server.address().port}/full' (Join-Path $Root 'download.zip') 3072 'test'
Copy-Item -LiteralPath $statusPath -Destination (Join-Path $Root 'complete.json')
$rejected=$false
try { Save-ImageDownload 'http://127.0.0.1:${server.address().port}/short' (Join-Path $Root 'short.zip') 3072 'test' }
catch { $rejected=$true }
if(-not $rejected){throw 'Truncated response accepted'}
`;
  await promisify(execFile)("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")], { windowsHide: true, timeout: 15000 });
  const complete = JSON.parse(fs.readFileSync(path.join(root, "complete.json"), "utf8"));
  assert.deepEqual(complete.progress, { phase: "download", percent: 100, completedBytes: 3072, totalBytes: 3072 });
  const incomplete = JSON.parse(fs.readFileSync(path.join(root, "status.json"), "utf8"));
  assert.equal(incomplete.progress.completedBytes, 2048);
  assert.equal(incomplete.progress.percent, 66);
  assert.equal(fs.statSync(path.join(root, "download.zip")).size, 3072);
});
