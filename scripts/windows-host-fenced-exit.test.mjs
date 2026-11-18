import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const stopPath = process.env.RABIROUTE_TEST_STOP_SCRIPT ?? new URL('./Stop-RabiRouteHostFenced.ps1', import.meta.url);
const stop = fs.readFileSync(stopPath, 'utf8');
const powershell = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
const psQuote = value => `'${String(value).replaceAll("'", "''")}'`;

function runFixture(scenario) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rabiroute-fenced-exit-'));
  const host = path.join(root, 'RabiRouteHost.exe');
  fs.writeFileSync(host, 'fixture-only');
  const main = stop.indexOf('$install = [IO.Path]::GetFullPath($InstallRoot)');
  assert.ok(main > 0);
  // Replace only OS/process boundaries. The real script's fence selection,
  // capture, exit waiting and main sequence run in Windows PowerShell 5.1.
  const mocks = `
$script:scenario = ${psQuote(scenario)}
$script:quit = $false
$script:calls = @()
$script:statusCalls = 0
$script:polls = 0
function Invoke-HostJson([string]$HostPath, [string[]]$Arguments, [string]$Work) {
    $script:calls += $Arguments[1]
    if ($Arguments[1] -eq 'status') {
        $script:statusCalls++
        if ($script:quit) { throw 'Host command failed (ExitCode=2). status query timed out after pipe exit.' }
        if ($script:scenario -eq 'initial-exit2') { throw 'Host command failed (ExitCode=2). initial status query timed out.' }
        $state = if ($script:scenario -eq 'initial-unknown') { 'unknown' } elseif ($script:scenario -like 'faulted-*') { 'faulted' } else { 'healthy' }
        $generation = if ($script:statusCalls -gt 1 -and $script:scenario -eq 'generation-changed') { 'replacement-generation' } else { 'original-generation' }
        if ($script:scenario -eq 'faulted-control-only') { $generation=$null }
        $managerId = if ($script:statusCalls -gt 1 -and $script:scenario -eq 'manager-changed') { 201 } else { 101 }
        return [pscustomobject]@{ ok=$true; state=$state; applicationGenerationId=$generation; controlFenceGenerationId='original-generation'; managerPid=$managerId; trayPid=102 }
    }
    if ($Arguments[1] -ne 'quit' -or $Arguments[3] -ne 'original-generation') { throw 'Wrong original quit fence.' }
    $script:quit = $true
    if ($script:scenario -eq 'quit-rejected') { return [pscustomobject]@{ ok=$true; state='faulted' } }
    return [pscustomobject]@{ ok=$true; state='stopped' }
}
function Get-CimInstance([string]$ClassName, [string]$Filter, [string]$ErrorAction) {
    if ($script:scenario -eq 'cim-query-error') { throw 'Original process query failed.' }
    if ($ClassName -ne 'Win32_Process' -or $Filter -notmatch '^ProcessId = (\\d+)$') { throw 'Unexpected unbounded process query.' }
    $processId = [int]$Matches[1]
    if ($processId -notin @(100,101,102)) { throw 'Unexpected process identity.' }
    if ($script:quit) {
        $script:polls++
        if ($script:scenario -eq 'pid-reused') {
            return [pscustomobject]@{ ProcessId=$processId; CreationDate=[datetime]'2026-11-19T02:00:00Z' }
        }
        if ($script:scenario -eq 'delayed-exit' -and $script:polls -gt 3) { return $null }
        if ($script:scenario -notin @('still-running','delayed-exit')) { return $null }
    }
    if ($script:scenario -eq 'faulted-child-missing' -and $processId -eq 102) { return $null }
    if ($script:scenario -eq 'faulted-no-parent-proof') { return $null }
    $parent = if ($processId -eq 100) { 50 } else { 100 }
    if ($script:scenario -eq 'different-parents' -and $processId -eq 102) { $parent=200 }
    $image = if ($script:scenario -eq 'path-unreadable') { $null } else { ${psQuote(host)} }
    if ($script:scenario -eq 'foreign-host') { $image='C:\\foreign\\RabiRouteHost.exe' }
    $command = if ($script:scenario -eq 'path-unreadable') { $null } else { 'RabiRouteHost.exe' }
    if ($script:scenario -eq 'command-host') { $command='RabiRouteHost.exe --command status --json' }
    return [pscustomobject]@{ ProcessId=$processId; ParentProcessId=$parent; Name='RabiRouteHost.exe'; ExecutablePath=$image; CommandLine=$command; CreationDate=[datetime]'2026-11-19T01:00:00Z' }
}
function Start-Sleep { param([int]$Milliseconds) }
`;
  const script = stop.slice(0, main) + mocks + stop.slice(main).replace(
    'Wait-OriginalHostProcesses $originalProcesses',
    'Wait-OriginalHostProcesses $originalProcesses -TimeoutMilliseconds 25',
  ) + `
if (($script:calls -join ',') -ne 'status,status,quit') { throw ('Unexpected Host calls: ' + ($script:calls -join ',')) }
`;
  const fixture = path.join(root, 'fixture.ps1');
  fs.writeFileSync(fixture, script, 'utf8');
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.toLowerCase() === 'psmodulepath') delete env[key];
  try {
    return spawnSync(powershell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', fixture, '-InstallRoot', root], {
      encoding: 'utf8', env, windowsHide: true,
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

for (const scenario of ['pipe-gone', 'delayed-exit', 'pid-reused', 'path-unreadable', 'faulted-child-missing', 'faulted-control-only']) {
  test(`fenced quit confirms original process exit with ${scenario}`, { skip: process.platform !== 'win32' }, () => {
    const result = runFixture(scenario);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const report = JSON.parse(result.stdout);
    assert.equal(report.state, 'stopped');
    assert.equal(report.applicationGenerationId, 'original-generation');
    assert.equal(report.originalProcesses.length, scenario === 'faulted-child-missing' ? 2 : 3);
    if (scenario === 'path-unreadable') assert.equal(report.originalProcesses[0].identityMethod, 'status-child-parent-and-name');
    if (scenario === 'faulted-control-only') assert.equal(report.fenceSource, 'controlFenceGenerationId');
  });
}

for (const [scenario, expected] of [
  ['still-running', /Original Host generation processes did not exit/],
  ['initial-unknown', /Unsupported Host state/],
  ['initial-exit2', /initial status query timed out/],
  ['different-parents', /shared original Host parent/],
  ['foreign-host', /Cannot identify the original Host process/],
  ['command-host', /Cannot identify the original Host process/],
  ['quit-rejected', /Fenced quit did not reach state=stopped/],
  ['generation-changed', /Host generation changed while capturing/],
  ['manager-changed', /Host generation changed while capturing/],
  ['cim-query-error', /Original process query failed/],
  ['faulted-no-parent-proof', /shared original Host parent/],
]) {
  test(`fenced quit rejects ${scenario}`, { skip: process.platform !== 'win32' }, () => {
    const result = runFixture(scenario);
    assert.notEqual(result.status, 0, result.stdout);
    assert.match(result.stderr, expected);
  });
}
