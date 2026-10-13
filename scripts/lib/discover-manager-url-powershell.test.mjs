import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const helper = fileURLToPath(new URL("../Resolve-RabiRouteManagerUrl.ps1", import.meta.url));
const powershell = path.join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
const windows = { skip: process.platform !== "win32" };
const quote = value => `'${value.replaceAll("'", "''")}'`;
const ready = { ok: true, state: "healthy", managerBaseUrl: "http://127.0.0.1:51234", applicationGenerationId: "fixture-generation", managerInstanceId: "fixture-instance" };

function runScript(body) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rabi-discovery-"));
  try {
    const script = path.join(root, "probe.ps1");
    fs.writeFileSync(script, `$ErrorActionPreference = 'Stop'\nSet-StrictMode -Version Latest\n. ${quote(helper)}\n` +
      `$env:RABIROUTE_MANAGER_URL = ''\n$env:GATEWAY_MANAGER_URL = ''\n$env:RABIROUTE_HOST_EXE = ${quote(process.execPath)}\n` +
      `$fixtureRoot = ${quote(root)}\ntry {\n${body}\n} catch { [Console]::Error.WriteLine($_.Exception.Message); exit 3 }\n`, "utf8");
    return spawnSync(powershell, ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", script], {
      encoding: "utf8", windowsHide: true, timeout: 20000
    });
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}

function mockStatuses(statuses) {
  return `$script:answers = @(${statuses.map(status => quote(JSON.stringify(status))).join(",")})\n$script:reads = 0\n` +
    `function Read-RabiRouteHostStatus { param($HostExe, $TimeoutMilliseconds)\n` +
    `$index = [Math]::Min($script:reads++, $script:answers.Count - 1)\n` +
    `return [pscustomobject]@{ ExitCode = 0; Stdout = $script:answers[$index] }\n}\n`;
}

test("PowerShell discovers complete Host identities independently of aggregate state", windows, () => {
  const result = runScript(mockStatuses([ready, { ...ready, state: "degraded" }, { ...ready, state: "starting" }]) +
    `@(1..3 | ForEach-Object { Resolve-RabiRouteManagerUrl }) | ConvertTo-Json -Compress`);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), [ready.managerBaseUrl, ready.managerBaseUrl, ready.managerBaseUrl]);
});

test("PowerShell waits through missing publication without failing under StrictMode", windows, () => {
  const result = runScript(mockStatuses([{ ok: true, state: "starting" }, ready]) +
    `$url = Resolve-RabiRouteManagerUrl -PollIntervalMilliseconds 1\n` +
    `[pscustomobject]@{url=$url;reads=$script:reads} | ConvertTo-Json -Compress`);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { url: ready.managerBaseUrl, reads: 2 });
  const pending = runScript(mockStatuses([{ ok: true, state: "starting" }]) + `Resolve-RabiRouteManagerUrl -TimeoutMilliseconds 100 -PollIntervalMilliseconds 10`);
  assert.equal(pending.status, 3);
  assert.match(pending.stderr, /within 100 ms.*state=starting.*still pending/);
});

test("PowerShell retains explicit/environment priority and distinct status failures", windows, () => {
  const priority = runScript(`function Read-RabiRouteHostStatus { throw 'must not query Host' }\n` +
    `$env:RABIROUTE_MANAGER_URL = 'http://localhost:51235'\n$env:GATEWAY_MANAGER_URL = 'http://localhost:51236'\n` +
    `@((Resolve-RabiRouteManagerUrl), (Resolve-RabiRouteManagerUrl -ExplicitUrl 'http://localhost:51237')) | ConvertTo-Json -Compress`);
  assert.equal(priority.status, 0, priority.stderr);
  assert.deepEqual(JSON.parse(priority.stdout), ["http://localhost:51235", "http://localhost:51237"]);
  for (const [body, expected] of [
    ["return [pscustomobject]@{ExitCode=1;Stdout=''}", /offline.*exit=1/],
    ["return [pscustomobject]@{ExitCode=0;Stdout='not-json'}", /invalid status JSON/],
    ["return [pscustomobject]@{ExitCode=0;Stdout='{\"ok\":false}'}", /status is unavailable/],
    ["throw 'RabiRoute Host status query timed out.'", /query timed out/]
  ]) {
    const result = runScript(`function Read-RabiRouteHostStatus { ${body} }\nResolve-RabiRouteManagerUrl`);
    assert.equal(result.status, 3);
    assert.match(result.stderr, expected);
  }
});

test("PowerShell captures GUI status output and bounds a stalled status-query child", windows, () => {
  const result = runScript(`$fixtureExe = Join-Path $fixtureRoot 'StatusFixture.exe'\n` +
    `Add-Type -OutputAssembly $fixtureExe -OutputType WindowsApplication -TypeDefinition @'\n` +
    `using System; public static class StatusFixture { public static void Main(string[] args) {\n` +
    `if (String.Join(" ", args) != "--command status --json") { Environment.Exit(9); }\n` +
    `System.Threading.Thread.Sleep(Environment.GetEnvironmentVariable("RABI_FIXTURE_STALL") == "1" ? 5000 : 70); Console.Error.WriteLine("fixture diagnostic");\n` +
    `Console.WriteLine(@"${JSON.stringify(ready).replaceAll('"', '""')}");\n} }\n'@\n` +
    `$env:RABIROUTE_HOST_EXE = $fixtureExe\n$url = Resolve-RabiRouteManagerUrl\n` +
    `$env:RABI_FIXTURE_STALL = '1'\n$timeoutError = ''\n` +
    `try { Resolve-RabiRouteManagerUrl -TimeoutMilliseconds 100 | Out-Null } catch { $timeoutError = $_.Exception.Message }\n` +
    `[pscustomobject]@{url=$url;timeoutError=$timeoutError} | ConvertTo-Json -Compress`);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { url: ready.managerBaseUrl, timeoutError: "RabiRoute Host status query timed out." });
});
