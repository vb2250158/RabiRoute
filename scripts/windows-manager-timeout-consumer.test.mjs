import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import test from "node:test";

const resolver = path.join(import.meta.dirname, "Resolve-RabiRouteManagerUrl.ps1").replaceAll("'", "''");
function resolve(overrides, explicitBudget = false) {
  const script = `
. '${resolver}'
$env:RABIROUTE_MANAGER_URL = ''
$env:GATEWAY_MANAGER_URL = ''
$env:RABIROUTE_HOST_EXE = '${resolver}'
function Read-RabiRouteHostStatus {
 param([string]$HostExe, [int]$TimeoutMilliseconds)
 [Console]::WriteLine(('BUDGET=' + $TimeoutMilliseconds))
 return [pscustomobject]@{ExitCode=0; Stdout='{"ok":true,"managerBaseUrl":"http://127.0.0.1:43210","applicationGenerationId":"test-generation","managerInstanceId":"test-instance"}'}
}
Resolve-RabiRouteManagerUrl ${explicitBudget ? '-TimeoutMilliseconds 4321' : ''}
`;
  const result = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")], {
    env: { ...process.env, RABIROUTE_TIMEOUT_OVERRIDES: overrides }, encoding: "utf8", timeout: 15000, windowsHide: true
  });
  assert.equal(result.status, 0, result.stderr || result.error?.message);
  assert.match(result.stdout, /http:\/\/127\.0\.0\.1:43210/);
  return { budget: Number(result.stdout.match(/BUDGET=(\d+)/)?.[1]), warning: (result.stdout + result.stderr).includes("Ignoring invalid environment") };
}

test("PowerShell discovery ignores invalid environment timeout inputs with a diagnostic", { skip: process.platform !== "win32" }, () => {
  for (const value of ['{', '[]', 'null', '{"scripts.manager.ready":true}', '{"scripts.manager.ready":null}', '{"scripts.manager.ready":"7"}', '{"scripts.manager.ready":0}', '{"scripts.manager.ready":1.5}']) {
    const result = resolve(value);
    assert.ok(result.budget > 9000 && result.budget <= 10000, `${value}: ${result.budget}`);
    assert.equal(result.warning, true, value);
  }
});
test("PowerShell discovery preserves valid selected and explicit timeout values", { skip: process.platform !== "win32" }, () => {
  const selected = resolve('{"scripts.manager.ready":7654,"unrelated":false}');
  assert.ok(selected.budget > 7000 && selected.budget <= 7654);
  assert.equal(selected.warning, false);
  const explicit = resolve('{', true);
  assert.ok(explicit.budget > 4000 && explicit.budget <= 4321);
  assert.equal(explicit.warning, false);
});
