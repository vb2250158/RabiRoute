import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import test from "node:test";
import { confirmBundledNapcatStopped, napcatStoppedInspectionScript } from "./napcatProcessDriver.js";
import type { NapcatBinding } from "./napcatLifecycleOwner.js";

const execute = promisify(execFile);
const windows = process.platform === "win32";

test("the actual PowerShell inspection classifies bundled-instance absence and incomplete evidence", { skip: !windows }, async t => {
  const directory = "C:\\Rabi QA\\NapCat.Shell";
  const image = (name: string, executable: string | null, commandLine: string | null) => ({ Name: name, ExecutablePath: executable, CommandLine: commandLine });
  const unrelated = image("QQ.exe", "C:\\Other QQ\\QQ.exe", '"C:\\Other QQ\\QQ.exe"');
  const cases = [
    { name: "no target with readable unrelated QQ", processes: [unrelated], listeners: [{ LocalPort: 3333 }], expected: { complete: true, matching: 0, listeners: 0 } },
    { name: "exact bundled descendant path", processes: [unrelated, image("QQ.exe", directory + "\\versions\\QQ.exe", "QQ.exe")], listeners: [], expected: { complete: true, matching: 1, listeners: 0 } },
    { name: "sibling directory is not the bound instance", processes: [image("QQ.exe", directory + ".other\\QQ.exe", "QQ.exe")], listeners: [], expected: { complete: true, matching: 0, listeners: 0 } },
    { name: "command references the bound directory with forward slashes", processes: [image("cmd.exe", "C:\\Windows\\System32\\cmd.exe", 'cmd /c "C:/Rabi QA/NapCat.Shell/napcat.bat"')], listeners: [], expected: { complete: true, matching: 1, listeners: 0 } },
    { name: "HTTP port holder", processes: [unrelated], listeners: [{ LocalPort: 3000 }], expected: { complete: true, matching: 0, listeners: 1 } },
    { name: "WebUI port holder", processes: [unrelated], listeners: [{ LocalPort: 6102 }], expected: { complete: true, matching: 0, listeners: 1 } },
    { name: "unreadable QQ executable", processes: [unrelated, image("QQ.exe", null, "QQ.exe")], listeners: [], expected: { complete: false, matching: 0, listeners: 0 } },
    { name: "unreadable QQ command line", processes: [image("QQ.exe", "C:\\Other QQ\\QQ.exe", null)], listeners: [], expected: { complete: false, matching: 0, listeners: 0 } },
    { name: "unreadable cmd executable", processes: [image("cmd.exe", null, "cmd /c task")], listeners: [], expected: { complete: false, matching: 0, listeners: 0 } },
    { name: "unreadable cmd command line", processes: [image("cmd.exe", "C:\\Windows\\System32\\cmd.exe", null)], listeners: [], expected: { complete: false, matching: 0, listeners: 0 } },
    { name: "unreadable bundled launcher", processes: [image("NapCatWinBootMain.exe", null, "NapCatWinBootMain.exe")], listeners: [], expected: { complete: false, matching: 0, listeners: 0 } },
    { name: "inspection shell command does not falsely reference its environment value", processes: [image("powershell.exe", "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe", "powershell.exe -NoProfile -Command " + napcatStoppedInspectionScript())], listeners: [], expected: { complete: true, matching: 0, listeners: 0 } }
  ];
  // Override discovery only inside this test shell. The production script runs unchanged;
  // no fixture launches QQ, examines real ownership state, or controls a machine process.
  const script = `
    $fixtures=ConvertFrom-Json $env:RABI_NAPCAT_TEST_FIXTURES;
    function Get-CimInstance { param([string]$Query) @($fixture.processes) }
    function Get-NetTCPConnection { param([string]$State) @($fixture.listeners) }
    foreach($fixture in $fixtures) { & { ${napcatStoppedInspectionScript()} } }
  `;
  const { stdout } = await execute("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
    windowsHide: true, timeout: 20000, maxBuffer: 1024 * 1024,
    env: { ...process.env, RABI_NAPCAT_RECOVERY_DIR: directory, RABI_NAPCAT_RECOVERY_PORTS: "3000,6102", RABI_NAPCAT_TEST_FIXTURES: JSON.stringify(cases) }
  });
  const results = stdout.trim().split(/\r?\n/).map(line => JSON.parse(line) as { complete: boolean; matching: number; listeners: number });
  assert.equal(results.length, cases.length);
  for (const [index, item] of cases.entries()) await t.test(item.name, () => {
    assert.deepEqual(results[index], item.expected);
    const admitted = results[index]!.complete && results[index]!.matching === 0 && results[index]!.listeners === 0;
    assert.equal(admitted, item.expected.complete && item.expected.matching === 0 && item.expected.listeners === 0);
  });
});

function bundle(t: test.TestContext) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "napcat-driver-test-"));
  t.after(() => {
    assert.ok(directory.startsWith(path.resolve(os.tmpdir()) + path.sep));
    fs.rmSync(directory, { recursive: true, force: true });
  });
  for (const name of ["QQ.exe", "NapCatWinBootMain.exe", "NapCatWinBootHook.dll"]) fs.writeFileSync(path.join(directory, name), "fixture only");
  const binding: NapcatBinding = { gatewayId: "example-route", instanceId: "example-instance", workingDir: directory, httpUrl: "https://remote.example" };
  return { directory, binding, plan: { cwd: directory, commandPath: path.join(directory, "NapCatWinBootMain.exe") } };
}

test("a different launch executable or cwd cannot reach the inspection runner", { skip: !windows }, async t => {
  const fixture = bundle(t);
  // A valid scope would reject this remote endpoint before spawning PowerShell.
  // Returning undefined proves the mismatched plan was rejected first.
  assert.equal(await confirmBundledNapcatStopped(fixture.binding, { ...fixture.plan, commandPath: path.join(fixture.directory, "other.exe") }), undefined);
  assert.equal(await confirmBundledNapcatStopped(fixture.binding, { ...fixture.plan, cwd: path.dirname(fixture.directory) }), undefined);
});

test("an incomplete bundled QQ layout cannot reach the inspection runner", { skip: !windows }, async t => {
  const fixture = bundle(t);
  fs.unlinkSync(path.join(fixture.directory, "NapCatWinBootHook.dll"));
  assert.equal(await confirmBundledNapcatStopped(fixture.binding, fixture.plan), undefined);
});

test('a junction cannot disguise the executable directory used by absence proof', {skip:!windows},async t=>{
  const fixture=bundle(t),alias=fixture.directory+'-alias';
  fs.symlinkSync(fixture.directory,alias,'junction');
  t.after(()=>{assert.equal(path.dirname(path.resolve(alias)),path.resolve(os.tmpdir()));fs.rmSync(alias,{recursive:true,force:true});});
  assert.equal(await confirmBundledNapcatStopped({...fixture.binding,workingDir:alias},{cwd:alias,commandPath:path.join(alias,'NapCatWinBootMain.exe')}),undefined);
});
