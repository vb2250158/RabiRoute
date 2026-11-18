import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

const transaction = path.resolve('scripts/Install-RabiRouteReleaseTransaction.ps1');
const stop = path.resolve('scripts/Stop-RabiRouteHostFenced.ps1');
const ps = value => `'${String(value).replaceAll("'", "''")}'`;
function extract(file, names) {
  return `$ast = [System.Management.Automation.Language.Parser]::ParseFile(${ps(file)}, [ref]$null, [ref]$null)
foreach ($name in @(${names.map(ps).join(',')})) {
  $fn = $ast.Find({ param($n) $n -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq $name }, $true)
  if (-not $fn) { throw "Missing function: $name" }
  . ([scriptblock]::Create($fn.Extent.Text))
}`;
}
function run(script) {
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(`$ErrorActionPreference = 'Stop'\n${script}`, 'utf16le').toString('base64')], { encoding: 'utf8', timeout: 30000 });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return JSON.parse(result.stdout.trim());
}

test('Invoke-Checked preserves Windows argv, exit semantics and private failure evidence', { skip: process.platform !== 'win32' }, () => {
  const root = mkdtempSync(path.join(tmpdir(), 'rabi checked space '));
  try {
    const child = path.join(root, 'native child.cjs');
    const args = ['', 'two words', 'a"b', 'one\\"two', 'ends with space\\', '\\', 'x\\\\"y', 'tab\tvalue', '中文 路径\\', 'literal & | > %PATH%'];
    writeFileSync(child, `process.stdout.write(JSON.stringify(process.argv.slice(2))); process.stderr.write('PRIVATE_TEST_STDERR'); process.exitCode = process.argv.includes('fail') ? 23 : 0;`);
    const result = run(`${extract(transaction, ['Repair-ChildProcessEnvironment', 'ConvertTo-WindowsArgument', 'Invoke-Checked'])}
$transactionRoot = ${ps(root)}
$values = @(${[child, ...args].map(ps).join(',')})
Invoke-Checked ${ps(process.execPath)} $values 'success'
$first = @(Get-ChildItem -LiteralPath $transactionRoot -Filter '*.stdout.txt')[0].FullName
$success = [IO.File]::ReadAllText($first)
$failure = ''
try { Invoke-Checked ${ps(process.execPath)} @(${ps(child)}, 'fail') 'failure' } catch { $failure = $_.Exception.Message }
$launch = ''
try { Invoke-Checked (Join-Path $transactionRoot 'missing.exe') @() 'launch' } catch { $launch = $_.Exception.Message }
@{ success=$success; failure=$failure; launch=$launch } | ConvertTo-Json -Compress`);
    assert.deepEqual(JSON.parse(result.success), args);
    assert.match(result.failure, /failure failed with ExitCode=23\./);
    assert.doesNotMatch(result.failure + result.launch, /PRIVATE_TEST_STDERR/);
    const files = readdirSync(root);
    assert.equal(files.filter(file => file.endsWith('.launch-error.txt')).length, 1);
    const evidence = files.filter(file => file.endsWith('.stderr.txt')).map(file => readFileSync(path.join(root, file), 'utf8'));
    assert.equal(evidence.filter(text => text.includes('PRIVATE_TEST_STDERR')).length, 2);
    assert.ok(readFileSync(path.join(root, files.find(file => file.endsWith('.launch-error.txt'))), 'utf8').length > 0);
    assert.match(result.launch, /launchError=/);
    for (const match of result.failure.matchAll(/(?:stdout|stderr)=([^;]+)/g)) assert.ok(files.includes(path.basename(match[1])));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('Invoke-HostJson retains failed stdout/stderr, rejects invalid JSON, cleans success', { skip: process.platform !== 'win32' }, () => {
  const root = mkdtempSync(path.join(tmpdir(), 'rabi host evidence '));
  try {
    const child = path.join(root, 'fake host.cjs');
    writeFileSync(child, `const mode = process.argv[2]; process.stdout.write(mode === 'invalid' ? 'PRIVATE_INVALID' : JSON.stringify({ok: mode === 'success', detail: 'PRIVATE_JSON'})); process.stderr.write('PRIVATE_STDERR'); process.exitCode = mode === 'fail' ? 17 : 0;`);
    const result = run(`${extract(stop, ['Repair-ChildProcessEnvironment', 'Invoke-HostJson'])}
$work = ${ps(root)}
$child = ${ps('"' + child + '"')}
$messages = @()
foreach ($mode in @('fail', 'invalid', 'rejected')) {
  try { Invoke-HostJson ${ps(process.execPath)} @($child, $mode) $work | Out-Null } catch { $messages += $_.Exception.Message }
}
$before = @(Get-ChildItem -LiteralPath $work -Filter '*.txt').Count
$ok = Invoke-HostJson ${ps(process.execPath)} @($child, 'success') $work
$after = @(Get-ChildItem -LiteralPath $work -Filter '*.txt').Count
$launch = ''
try { Invoke-HostJson (Join-Path $work 'missing.exe') @('--json') $work | Out-Null } catch { $launch = $_.Exception.Message }
@{ messages=$messages; before=$before; after=$after; ok=$ok.ok; launch=$launch } | ConvertTo-Json -Compress`);
    assert.equal(result.ok, true);
    assert.equal(result.before, 6);
    assert.equal(result.after, 6);
    assert.match(result.launch, /launchError=/);
    const launchFiles = readdirSync(root).filter(file => file.endsWith('.launch-error.txt'));
    assert.equal(launchFiles.length, 1);
    assert.ok(readFileSync(path.join(root, launchFiles[0]), 'utf8').length > 0);
    assert.match(result.messages[0], /ExitCode=17/);
    assert.match(result.messages[1], /invalid JSON/);
    assert.match(result.messages[2], /ok:true/);
    assert.doesNotMatch(result.messages.join('\n'), /PRIVATE_/);
    assert.ok(readdirSync(root).filter(file => file.endsWith('.stdout.txt')).some(file => readFileSync(path.join(root, file), 'utf8').includes('PRIVATE_JSON')));
    assert.equal(readdirSync(root).filter(file => file.endsWith('.stderr.txt')).filter(file => readFileSync(path.join(root, file), 'utf8').includes('PRIVATE_STDERR')).length, 3);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('transaction creates evidence root before first checked process without moving recovery gate', () => {
  const source = readFileSync(transaction, 'utf8');
  const body = source.slice(source.indexOf('$install = Full $InstallRoot'));
  assert.ok(body.indexOf('Assert-RecoveryOwnership $previous') < body.indexOf('$transactionRoot = Join-Path'));
  assert.ok(body.indexOf('[IO.Directory]::CreateDirectory($candidate)') < body.indexOf('Invoke-BootstrapSelfTest $release.bootstrap'));
  assert.ok(body.indexOf('Invoke-BootstrapSelfTest $release.bootstrap') < body.indexOf('"Fenced Host stop"'));
});


test('generation exit verification accepts exited processes and refuses live ones', { skip: process.platform !== 'win32' }, () => {
  const finished = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 2000)'], { windowsHide: true, stdio: 'ignore' });
  const live = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 20000)'], { windowsHide: true, stdio: 'ignore' });
  try {
    const result = run(`${extract(stop, ['Wait-OriginalHostProcesses'])}
$completedInfo = Get-CimInstance Win32_Process -Filter 'ProcessId=${finished.pid}' -ErrorAction Stop
$stillRunningInfo = Get-CimInstance Win32_Process -Filter 'ProcessId=${live.pid}' -ErrorAction Stop
if (-not $completedInfo -or -not $stillRunningInfo) { throw 'Owned fixture process exited before identity capture.' }
$completed = [pscustomobject]@{ processId=${finished.pid}; creationDate=([datetime]$completedInfo.CreationDate).ToUniversalTime().Ticks }
$stillRunning = [pscustomobject]@{ processId=${live.pid}; creationDate=([datetime]$stillRunningInfo.CreationDate).ToUniversalTime().Ticks }
Wait-OriginalHostProcesses @($completed) 8000
$blocked = $false
try { Wait-OriginalHostProcesses @($stillRunning) 100 } catch { $blocked = $_.Exception.Message -match 'did not exit after fenced quit' }
$completedAfter = Get-CimInstance Win32_Process -Filter 'ProcessId=${finished.pid}' -ErrorAction Stop
$stillRunningAfter = Get-CimInstance Win32_Process -Filter 'ProcessId=${live.pid}' -ErrorAction Stop
@{ completed=($null -eq $completedAfter); rejectedLive=$blocked; stillRunning=($null -ne $stillRunningAfter) } | ConvertTo-Json -Compress`);
    assert.deepEqual(result, { completed: true, rejectedLive: true, stillRunning: true });
  } finally { if (finished.exitCode === null) finished.kill(); if (live.exitCode === null) live.kill(); }
});

test('recovery skips identical verified files but still restores changed files', { skip: process.platform !== 'win32' }, () => {
  const root = mkdtempSync(path.join(tmpdir(), 'rabi equal recovery '));
  try {
    const result = run(`${extract(transaction, ['Get-Sha256File', 'Test-RecoveryFileEqual', 'Restore-Previous'])}
function Write-Durable([string]$Path, [byte[]]$Bytes) { throw 'CONTROLLED_WRITE_REQUIRED' }
$root = ${ps(root)}
$backup = Join-Path $root 'backup'; [IO.Directory]::CreateDirectory($backup) | Out-Null
foreach ($name in @('current.json', 'RabiRouteHost.exe')) {
  [IO.File]::WriteAllText((Join-Path $root $name), 'same'); [IO.File]::WriteAllText((Join-Path $backup $name), 'same')
}
$pointer = Join-Path $backup 'current.json'; $hostBackup = Join-Path $backup 'RabiRouteHost.exe'
Restore-Previous $root $pointer $hostBackup $true $true
[IO.File]::WriteAllText((Join-Path $root 'current.json'), 'changed')
$requiresWrite = $false
try { Restore-Previous $root $pointer $hostBackup $true $true } catch { $requiresWrite = $_.Exception.Message -match 'CONTROLLED_WRITE_REQUIRED' }
@{ identicalSkipped=$true; changedRequiresWrite=$requiresWrite } | ConvertTo-Json -Compress`);
    assert.deepEqual(result, { identicalSkipped: true, changedRequiresWrite: true });
  } finally { rmSync(root, { recursive: true, force: true }); }
});
