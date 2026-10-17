import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import http from "node:http";
import { promisify } from "node:util";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

test("the registered HA OS recovery action hides PowerShell without changing its fixed command", { skip: process.platform !== "win32" }, () => {
  const source = fileURLToPath(new URL("./Install-HomeAssistantOs.ps1", import.meta.url));
  const script = `
$ErrorActionPreference='Stop'; $tokens=$null; $errors=$null
$ast=[System.Management.Automation.Language.Parser]::ParseFile('${source.replaceAll("'", "''")}',[ref]$tokens,[ref]$errors)
if($errors.Count){throw 'Installer syntax errors'}
$assignment=$ast.Find({param($node) $node -is [System.Management.Automation.Language.AssignmentStatementAst] -and $node.Left.Extent.Text -eq '$recoveryArguments'},$true)
$recoveryCommand="Write-Output 'test-only-fixed-recovery'"
Invoke-Expression $assignment.Extent.Text
$action=New-ScheduledTaskAction -Execute "$env:SystemRoot\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" -Argument $recoveryArguments
$action | Select-Object Execute,Arguments | ConvertTo-Json -Compress
`;
  const action = JSON.parse(execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")], { windowsHide: true, encoding: "utf8" }));
  assert.match(action.Arguments, /(?:^| )-WindowStyle Hidden(?: |$)/);
  assert.match(action.Arguments, /-NoProfile -NonInteractive/);
  const encoded = action.Arguments.split("-EncodedCommand ")[1];
  assert.equal(Buffer.from(encoded, "base64").toString("utf16le"), "Write-Output 'test-only-fixed-recovery'");
});

test("recovery task ownership accepts Windows-normalized account names and rejects other identities", { skip: process.platform !== "win32" }, () => {
  const source = fileURLToPath(new URL("./Install-HomeAssistantOs.ps1", import.meta.url));
  const script = `
$ErrorActionPreference='Stop'; $tokens=$null; $errors=$null
$ast=[System.Management.Automation.Language.Parser]::ParseFile('${source.replaceAll("'", "''")}',[ref]$tokens,[ref]$errors)
if($errors.Count){throw 'Installer syntax errors'}
$function=$ast.Find({param($node) $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Test-RecoveryTaskUser'},$true)
Invoke-Expression $function.Extent.Text
$identity=[Security.Principal.WindowsIdentity]::GetCurrent()
if(-not(Test-RecoveryTaskUser $identity.User.Value $identity.User.Value)){throw 'SID rejected'}
if(-not(Test-RecoveryTaskUser $identity.Name $identity.User.Value)){throw 'Normalized account rejected'}
if(Test-RecoveryTaskUser 'S-1-1-0' $identity.User.Value){throw 'Other identity accepted'}
if(Test-RecoveryTaskUser 'test-only-no-such-account' $identity.User.Value){throw 'Unresolvable account accepted'}
`;
  execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")], { windowsHide: true });
});

test("unapproved background recovery fails without changing status or requesting elevation", { skip: process.platform !== "win32" }, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "haos-recovery-test-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const status = JSON.stringify({ state: "installed", message: "test-only-existing-state" });
  fs.writeFileSync(path.join(root, "status.json"), status);
  const source = fileURLToPath(new URL("./Install-HomeAssistantOs.ps1", import.meta.url));
  await assert.rejects(promisify(execFile)("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", source,
    "-Operation", "Recover", "-Root", root, "-AutoStart", "yes"], { windowsHide: true, timeout: 15000, cwd: process.env.SystemRoot }), /Background recovery needs one foreground Start/);
  assert.equal(fs.readFileSync(path.join(root, "status.json"), "utf8"), status);
});

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
