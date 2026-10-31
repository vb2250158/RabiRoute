import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { promisify } from "node:util";
import ts from "typescript";
import { getTimeoutMs, readTimeoutOverrides } from "../shared/timeoutSettings.js";
import { EffectScope } from "../plugin-kernel/effectScope.js";
import { PassThrough } from "node:stream";
import test, { type TestContext } from "node:test";
import type { SpeechRuntimeStatus } from "../shared/speechControlContract.js";
import {
  SpeechRuntimeControl,
  SpeechRuntimeControlError
} from "./speechRuntimeControl.js";

function status(state: SpeechRuntimeStatus["state"]): SpeechRuntimeStatus {
  return {
    state,
    checkedAt: "2026-07-30T00:00:00.000Z",
    configuredUrl: "http://127.0.0.1:8781",
    defaults: {},
    providers: { tts: [], asr: [] },
    ...(state === "offline" ? { error: "fetch failed" } : {})
  };
}

const installed = () => true;

test("Windows owner query parses the actual OS script and fails closed for ambiguous or damaged TCP tables", { skip: process.platform !== "win32" }, async () => {
  // Exercise the private helper's actual generated script without a product test hook.
  // Only the TCP-table producer and OS process objects are replaced by controlled data.
  const source = fs.readFileSync(new URL("./speechRuntimeControl.ts", import.meta.url), "utf8");
  const tree = ts.createSourceFile("speechRuntimeControl.ts", source, ts.ScriptTarget.Latest, true);
  const helper = tree.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === "inspectWindowsRuntimeOwner");
  assert.ok(helper);
  let generatedScript = "";
  const emitted = ts.transpileModule(helper.getText(tree), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText;
  const evaluateHelper = new Function("execFileAsync", "process", "SpeechRuntimeControlError", "getTimeoutMs", "readTimeoutOverrides", `${emitted}; return inspectWindowsRuntimeOwner;`);
  const createHelper = (...args: unknown[]) => evaluateHelper(...args, getTimeoutMs, readTimeoutOverrides);
  const inspectOwner = createHelper(async (_command: string, args: string[], options: { timeout: number }) => {
    generatedScript = args.at(-1)!;
    assert.equal(options.timeout, 8_000);
    return { stdout: "null" };
  }, process, SpeechRuntimeControlError) as (port: number, executable: string, hostScript: string) => Promise<unknown>;
  await inspectOwner(54321, "C:/fixture.exe", "C:/fixture-host.py");
  assert.ok(generatedScript.includes("'System32', 'netstat.exe'"));
  assert.ok(!generatedScript.includes("Get-NetTCPConnection"));
  for (const stdout of ["", " ", "broken JSON", '{"pid":0,"owned":true}', '{"pid":"invalid","owned":true}']) {
    const malformed = createHelper(async () => ({ stdout }), process, SpeechRuntimeControlError) as typeof inspectOwner;
    await assert.rejects(malformed(54321, "C:/fixture.exe", "C:/fixture-host.py"));
  }
  const cases = [
    { id: "IPv4", lines: ["Proto Local Address Foreign Address State PID", "TCP 127.0.0.2:54321 0.0.0.0:0 LISTENING 123"], expected: { pid: 123, owned: true } },
    { id: "IPv6", lines: ["Proto Local Address Foreign Address State PID", "TCP [::]:54321 [::]:0 LISTENING 123"], expected: { pid: 123, owned: true } },
    { id: "localized headings", lines: ["活动连接", "协议 本地地址 外部地址 状态 PID", "TCP [::1]:54321 [::]:0 LISTENING 123"], expected: { pid: 123, owned: true } },
    { id: "duplicate dual stack", lines: ["Proto Local Address Foreign Address State PID", "TCP 0.0.0.0:54321 0.0.0.0:0 LISTENING 123", "TCP [::]:54321 [::]:0 LISTENING 123"], expected: { pid: 123, owned: true } },
    { id: "non-listening", lines: ["Proto Local Address Foreign Address State PID", "TCP 127.0.0.2:54321 127.0.0.1:15 ESTABLISHED 123"], expected: null },
    { id: "empty valid table", lines: ["协议 本地地址 外部地址 状态 PID"], expected: null },
    { id: "unrelated port", lines: ["Proto Local Address Foreign Address State PID", "TCP 127.0.0.2:54322 0.0.0.0:0 LISTENING 321"], expected: null },
    { id: "multiple owners", lines: ["Proto Local Address Foreign Address State PID", "TCP 127.0.0.2:54321 0.0.0.0:0 LISTENING 123", "TCP [::]:54321 [::]:0 LISTENING 124"], error: "multiple owners" },
    { id: "unknown state", lines: ["Proto Local Address Foreign Address State PID", "TCP 127.0.0.2:54321 0.0.0.0:0 OTHER 123"], error: "Unknown Windows TCP state" },
    { id: "unknown localized state", lines: ["协议 本地地址 外部地址 状态 PID", "TCP 127.0.0.2:54321 0.0.0.0:0 未识别 123"], error: "Unknown Windows TCP state" },
    { id: "invalid PID", lines: ["Proto Local Address Foreign Address State PID", "TCP 127.0.0.2:54321 0.0.0.0:0 LISTENING invalid"], error: "Invalid Windows TCP listener PID" },
    { id: "zero PID", lines: ["Proto Local Address Foreign Address State PID", "TCP 127.0.0.2:54321 0.0.0.0:0 LISTENING 0"], error: "Invalid Windows TCP listener PID" },
    { id: "overflow PID", lines: ["Proto Local Address Foreign Address State PID", "TCP 127.0.0.2:54321 0.0.0.0:0 LISTENING 9999999999999"], error: "Invalid Windows TCP listener PID" },
    { id: "damaged record", lines: ["Proto Local Address Foreign Address State PID", "TCP 127.0.0.2:54321 LISTENING 123"], error: "Malformed Windows TCP table record" },
    { id: "damaged address", lines: ["Proto Local Address Foreign Address State PID", "TCP invalid:54321 0.0.0.0:0 LISTENING 123"], error: "Invalid Windows TCP local address" },
    { id: "missing header", lines: ["TCP 127.0.0.2:54321 0.0.0.0:0 LISTENING 123"], error: "header is missing" },
    { id: "empty output", lines: [], error: "header is missing" },
    { id: "unknown record", lines: ["Proto Local Address Foreign Address State PID", "damaged data"], error: "Unknown Windows TCP table record" },
    { id: "OS failure", lines: ["Proto Local Address Foreign Address State PID"], exitCode: 1, error: "TCP table query failed" },
    { id: "missing CIM process", lines: ["Proto Local Address Foreign Address State PID", "TCP 127.0.0.2:54321 0.0.0.0:0 LISTENING 123"], missingProcess: true, error: "owner disappeared" },
    { id: "unowned identity", lines: ["Proto Local Address Foreign Address State PID", "TCP 127.0.0.2:54321 0.0.0.0:0 LISTENING 123"], unowned: true, expected: { pid: 123, owned: false } },
    { id: "IPv6-only table", lines: ["Proto Local Address Foreign Address State PID"], ipv6Lines: ["Proto Local Address Foreign Address State PID", "TCP [::1]:54321 [::]:0 LISTENING 123"], expected: { pid: 123, owned: true } },
    { id: "cross-table same PID", lines: ["Proto Local Address Foreign Address State PID", "TCP 0.0.0.0:54321 0.0.0.0:0 LISTENING 123"], ipv6Lines: ["Proto Local Address Foreign Address State PID", "TCP [::]:54321 [::]:0 LISTENING 123"], expected: { pid: 123, owned: true } },
    { id: "cross-table different PID", lines: ["Proto Local Address Foreign Address State PID", "TCP 0.0.0.0:54321 0.0.0.0:0 LISTENING 123"], ipv6Lines: ["Proto Local Address Foreign Address State PID", "TCP [::]:54321 [::]:0 LISTENING 124"], error: "multiple owners" },
    { id: "IPv6 missing header", lines: ["Proto Local Address Foreign Address State PID", "TCP 127.0.0.2:54321 0.0.0.0:0 LISTENING 123"], ipv6Lines: ["TCP [::]:54321 [::]:0 LISTENING 123"], error: "header is missing" },
    { id: "IPv6 empty output", lines: ["Proto Local Address Foreign Address State PID"], ipv6Lines: [], error: "header is missing" },
    { id: "IPv6 OS failure", lines: ["Proto Local Address Foreign Address State PID"], ipv6Lines: ["Proto Local Address Foreign Address State PID"], ipv6ExitCode: 1, error: "TCP table query failed" },
    { id: "IPv6 unknown state", lines: ["Proto Local Address Foreign Address State PID"], ipv6Lines: ["Proto Local Address Foreign Address State PID", "TCP [::1]:54321 [::]:0 OTHER 123"], error: "Unknown Windows TCP state" },
    { id: "exact executable short circuit", lines: ["Proto Local Address Foreign Address State PID", "TCP 127.0.0.2:54321 0.0.0.0:0 LISTENING 123"], nativeExeMatches: true, wmiMustNotRun: true, expected: { pid: 123, owned: true }, nativeDisposals: 1, wmiDisposals: 0 },
    { id: "MainModule access failure keeps host fallback", lines: ["Proto Local Address Foreign Address State PID", "TCP 127.0.0.2:54321 0.0.0.0:0 LISTENING 123"], mainModuleFails: true, hostOnly: true, expected: { pid: 123, owned: true }, nativeDisposals: 1, wmiDisposals: 1 },
    { id: "exited native process", lines: ["Proto Local Address Foreign Address State PID", "TCP 127.0.0.2:54321 0.0.0.0:0 LISTENING 123"], exited: true, error: "owner disappeared", nativeDisposals: 1, wmiDisposals: 0 },
    { id: "WMI read fails and disposes", lines: ["Proto Local Address Foreign Address State PID", "TCP 127.0.0.2:54321 0.0.0.0:0 LISTENING 123"], wmiGetFails: true, error: "Controlled WMI read failure", nativeDisposals: 1, wmiDisposals: 1 },
    { id: "held nonmatching executable only needs command line", lines: ["Proto Local Address Foreign Address State PID", "TCP 127.0.0.2:54321 0.0.0.0:0 LISTENING 123"], hostOnly: true, expectedFields: "CommandLine", expected: { pid: 123, owned: true }, nativeDisposals: 1, wmiDisposals: 1 },
    { id: "unavailable handle preserves WMI executable fallback", lines: ["Proto Local Address Foreign Address State PID", "TCP 127.0.0.2:54321 0.0.0.0:0 LISTENING 123"], handleFails: true, expectedFields: "ExecutablePath,CommandLine", expected: { pid: 123, owned: true }, nativeDisposals: 1, wmiDisposals: 1 },
    { id: "process exits during WMI read", lines: ["Proto Local Address Foreign Address State PID", "TCP 127.0.0.2:54321 0.0.0.0:0 LISTENING 123"], wmiExitsProcess: true, error: "owner disappeared", nativeDisposals: 1, wmiDisposals: 1 },
    { id: "empty WMI identity collection", lines: ["Proto Local Address Foreign Address State PID", "TCP 127.0.0.2:54321 0.0.0.0:0 LISTENING 123"], wmiEmpty: true, error: "owner disappeared", nativeDisposals: 1, wmiDisposals: 1 },
    { id: "unknown native exit state requires full WMI identity", lines: ["Proto Local Address Foreign Address State PID", "TCP 127.0.0.2:54321 0.0.0.0:0 LISTENING 123"], exitStateUnknown: true, nativeExeMatches: true, expectedFields: "ExecutablePath,CommandLine", expected: { pid: 123, owned: true }, nativeDisposals: 1, wmiDisposals: 1 },
    { id: "unknown exit state after WMI preserves verified WMI identity", lines: ["Proto Local Address Foreign Address State PID", "TCP 127.0.0.2:54321 0.0.0.0:0 LISTENING 123"], exitStateUnknownAfterWmi: true, hostOnly: true, expected: { pid: 123, owned: true }, nativeDisposals: 1, wmiDisposals: 1 },
    { id: "unknown exit state and failed WMI remains rejected", lines: ["Proto Local Address Foreign Address State PID", "TCP 127.0.0.2:54321 0.0.0.0:0 LISTENING 123"], exitStateUnknown: true, wmiGetFails: true, error: "Controlled WMI read failure", nativeDisposals: 1, wmiDisposals: 1 }
  ];
  const tableProducer = "$netstatLines = @(& $netstatPath -ano -p $protocol)";
  assert.equal(generatedScript.split(tableProducer).length, 2);
  assert.ok(generatedScript.includes("foreach ($protocol in @('tcp', 'tcpv6'))"));
  const fixturePath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "speech-owner-table-")), "fixtures.json");
  fs.writeFileSync(fixturePath, JSON.stringify(cases));
  const script = [
    "$ErrorActionPreference = 'Stop'",
    "$cases = Get-Content -LiteralPath $env:SPEECH_OWNER_FIXTURES -Raw -Encoding UTF8 | ConvertFrom-Json",
    "function Read-FixtureOwner { param($fixture)",
    "function New-FixtureNativeProcess { if ($fixture.missingProcess) { throw 'Controlled process disappeared' }; $value=[pscustomobject]@{}; $value | Add-Member -MemberType ScriptProperty -Name HasExited -Value { if ($script:currentFixture.exitStateUnknown -or ($script:currentFixture.exitStateUnknownAfterWmi -and $script:wmiRead)) { throw 'Controlled exit state unavailable' }; return [bool]($script:currentFixture.exited -or $script:processExited) }; if ($fixture.handleFails) { $value | Add-Member -MemberType ScriptProperty -Name Handle -Value { throw 'Controlled process handle access failure' } } else { $value | Add-Member -MemberType NoteProperty -Name Handle -Value 123 }; if ($fixture.mainModuleFails) { $value | Add-Member -MemberType ScriptProperty -Name MainModule -Value { throw 'Controlled module access failure' } } else { $exe='C:/other.exe'; if ($fixture.nativeExeMatches) { $exe=$env:RABIROUTE_SPEECH_EXE }; $value | Add-Member -MemberType NoteProperty -Name MainModule -Value ([pscustomobject]@{FileName=$exe}) }; $value | Add-Member -MemberType ScriptMethod -Name Dispose -Value { $script:nativeDisposals++ }; return $value }",
    "function New-FixtureWmiSearcher { param($fields); if ($fixture.wmiMustNotRun) { throw 'Unnecessary WMI query' }; if ($fixture.expectedFields -and $fields -ne $fixture.expectedFields) { throw 'Incorrect WMI property selection' }; $value=[pscustomobject]@{}; $value | Add-Member -MemberType ScriptMethod -Name Get -Value { if ($script:nativeDisposals) { throw 'Native process identity was released before WMI completed' }; if ($script:currentFixture.wmiGetFails) { throw 'Controlled WMI read failure' }; $script:wmiRead=$true; $exe=$env:RABIROUTE_SPEECH_EXE; if ($script:currentFixture.unowned -or $script:currentFixture.hostOnly) { $exe='C:/other.exe' }; $command=[System.IO.Path]::GetFullPath($env:RABIROUTE_SPEECH_HOST_SCRIPT); if ($script:currentFixture.unowned) { $command='other' }; $process=[pscustomobject]@{ExecutablePath=$exe;CommandLine=$command}; $process | Add-Member -MemberType ScriptMethod -Name Dispose -Value { $script:processDisposals++ }; $collection=@($process); if ($script:currentFixture.wmiEmpty) { $collection=@() }; if ($script:currentFixture.wmiExitsProcess) { $script:processExited=$true }; Add-Member -InputObject $collection -MemberType ScriptMethod -Name Dispose -Value { $script:collectionDisposals++ }; return ,$collection }; $value | Add-Member -MemberType ScriptMethod -Name Dispose -Value { $script:wmiDisposals++ }; return $value }",
    generatedScript.replace(tableProducer, "$netstatLines = @($fixture.lines); $LASTEXITCODE = [int]$fixture.exitCode; if ($protocol -eq 'tcpv6') { $netstatLines = @('Proto Local Address Foreign Address State PID'); if ($fixture.PSObject.Properties.Name -contains 'ipv6Lines') { $netstatLines = @($fixture.ipv6Lines) }; $LASTEXITCODE = [int]$fixture.ipv6ExitCode }").replace("Write-Output 'null'; exit 0", "return 'null'")
      .replace("[System.Diagnostics.Process]::GetProcessById($targetPid)", "New-FixtureNativeProcess")
      .replace('[System.Management.ManagementObjectSearcher]::new("SELECT $identityFields FROM Win32_Process WHERE ProcessId=$targetPid")', "New-FixtureWmiSearcher $identityFields"),
    "}",
    "$results = @(); foreach ($fixture in $cases) { $script:currentFixture=$fixture; $script:processExited=$false; $script:wmiRead=$false; $script:nativeDisposals=0; $script:wmiDisposals=0; $script:processDisposals=0; $script:collectionDisposals=0; try { $value = Read-FixtureOwner $fixture; $results += [pscustomobject]@{id=$fixture.id;value=($value | ConvertFrom-Json);nativeDisposals=$script:nativeDisposals;wmiDisposals=$script:wmiDisposals;processDisposals=$script:processDisposals;collectionDisposals=$script:collectionDisposals} } catch { $results += [pscustomobject]@{id=$fixture.id;error=$_.Exception.Message;nativeDisposals=$script:nativeDisposals;wmiDisposals=$script:wmiDisposals;processDisposals=$script:processDisposals;collectionDisposals=$script:collectionDisposals} } }; ConvertTo-Json -InputObject $results -Depth 5 -Compress"
  ].join("\n");
  try {
    const powershell = path.join(process.env.SystemRoot!, "System32/WindowsPowerShell/v1.0/powershell.exe");
    const { stdout } = await promisify(execFile)(powershell, ["-NoProfile", "-NonInteractive", "-Command", script], {
      windowsHide: true, timeout: 8_000,
      env: { SystemRoot: process.env.SystemRoot, SPEECH_OWNER_FIXTURES: fixturePath, RABIROUTE_SPEECH_PORT: "54321", RABIROUTE_SPEECH_EXE: "C:/fixture.exe", RABIROUTE_SPEECH_HOST_SCRIPT: "C:/fixture-host.py" }
    });
    const results = JSON.parse(stdout.trim()) as Array<{ id: string; value?: unknown; error?: string; nativeDisposals: number; wmiDisposals: number; processDisposals: number; collectionDisposals: number }>;
    assert.equal(results.length, cases.length);
    for (const fixture of cases) {
      const actual = results.find(result => result.id === fixture.id)!;
      if (fixture.error) assert.ok(actual.error?.includes(fixture.error), `${fixture.id}: ${JSON.stringify(actual)}`);
      else { assert.equal(actual.error, undefined, fixture.id); assert.deepEqual(actual.value, fixture.expected, fixture.id); }
      if (fixture.nativeDisposals !== undefined) assert.equal(actual.nativeDisposals, fixture.nativeDisposals, fixture.id);
      if (fixture.wmiDisposals !== undefined) assert.equal(actual.wmiDisposals, fixture.wmiDisposals, fixture.id);
      if (actual.wmiDisposals && !fixture.wmiGetFails) {
        assert.equal(actual.processDisposals, fixture.wmiEmpty ? 0 : 1, fixture.id);
        assert.equal(actual.collectionDisposals, 1, fixture.id);
      }
    }
  } finally { fs.rmSync(path.dirname(fixturePath), { recursive: true, force: true }); }
});

for (const host of ["127.0.0.2", "::1"]) {
  test(`Windows native ${host} owner keeps its retirement fence until application shutdown confirms close`, { skip: process.platform !== "win32", timeout: 20_000 }, async t => {
    // Match the canonical path used by the Windows owner query; the ordinary
    // JS realpath keeps an inherited 8.3 TEMP alias in the synthetic argv.
    const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "speech-native-owner-")));
    const packageRoot = path.join(root, "package");
    const hostScript = path.join(packageRoot, "plugin-adapters/rabi-speech/scripts/windows_host.py");
    const child = spawn(process.execPath, ["-e", "const net=require('node:net');const server=net.createServer();server.listen(0,process.argv[1],()=>process.send({port:server.address().port}));", host, hostScript], {
      windowsHide: true, stdio: ["ignore", "ignore", "ignore", "ipc"],
      env: { SystemRoot: process.env.SystemRoot, PATH: path.dirname(process.execPath), HOME: root, USERPROFILE: root, APPDATA: root, LOCALAPPDATA: root }
    });
    const closed = once(child, "close");
    try {
      const [message] = await once(child, "message") as [{ port: number }];
      assert.ok(Number.isInteger(message.port) && message.port > 0);
      assert.notEqual(message.port, 8781, "the fixture must not use the formal Speech port");
      const serviceUrl = `http://${host.includes(":") ? `[${host}]` : host}:${message.port}`;
      const control = new SpeechRuntimeControl({ rootDir: root, packageRoot, serviceUrl: () => serviceUrl });
      const internals = control as unknown as Record<"inspectOwner" | "killProcessTree" | "inspect", (...args: unknown[]) => Promise<unknown>>;
      for (const name of ["inspectOwner", "killProcessTree", "inspect"] as const) {
        const original = internals[name];
        internals[name] = async (...args: unknown[]) => {
          const phaseStarted = performance.now();
          try { return await Reflect.apply(original, control, args); }
          finally { t.diagnostic(JSON.stringify({ host, phase: name, elapsedMs: performance.now() - phaseStarted })); }
        };
      }
      const scope = new EffectScope({ disposalTimeoutMs: 5_000 });
      let actualCleanupCompleted = false;
      scope.adopt(async () => {
        assert.equal((await control.stop()).action, "stopped");
        await closed;
        actualCleanupCompleted = true;
      }, "native Speech runtime and child closure");
      const started = performance.now();
      let ordinaryDisposalTimedOut = false;
      try { await scope.dispose(); }
      catch (error) {
        if (!(error instanceof Error) || !/^Plugin effect disposal timed out: native Speech runtime and child closure after 5000ms\.$/.test(error.message)) throw error;
        ordinaryDisposalTimedOut = true;
        if (!actualCleanupCompleted) assert.equal(scope.retirementConfirmed(), false, "the five-second result must retain the actual unfinished owner fence");
      }
      const ordinaryDisposalMs = performance.now() - started;
      const remainingShutdownMs = Math.floor(15_000 - ordinaryDisposalMs);
      assert.ok(remainingShutdownMs > 0, "ordinary disposal must leave time within the total application shutdown budget");
      await scope.waitForRetirement({ timeoutMs: remainingShutdownMs });
      assert.ok(child.exitCode !== null || child.signalCode !== null, "the exact owned child must actually be closed");
      assert.equal(scope.retirementConfirmed(), true, "application shutdown may succeed only after the actual owned resources are confirmed retired");
      const elapsedMs = performance.now() - started;
      t.diagnostic(JSON.stringify({ host, ordinaryDisposalMs, ordinaryDisposalTimedOut, elapsedMs, confirmedClosed: true }));
      assert.ok(elapsedMs < 15_000, `actual resource retirement exceeded the total application shutdown budget: ${elapsedMs}ms`);
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill();
      await closed;
      assert.ok(root.startsWith(fs.realpathSync.native(os.tmpdir()) + path.sep));
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
}

test("runtime waits for dependency preparation before launching and reports failure without a spawn", async () => {
  let ready!: () => void, launched = false;
  const preparation = new Promise<void>(resolve => { ready = resolve; });
  const control = new SpeechRuntimeControl({
    rootDir: "C:/RabiRoute", platform: "win32", serviceUrl: () => "http://127.0.0.1:8781", existsSync: installed,
    inspect: async () => status(launched ? "online" : "offline"),
    ensureDependencies: async allowFirstInstall => { assert.equal(allowFirstInstall, true); await preparation; },
    spawnRuntime: () => { launched = true; return { pid: 123, exitCode: null, unref() {} }; }
  });
  const pending = control.start(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(launched, false); ready(); await pending; assert.equal(launched, true);
  const broken = new SpeechRuntimeControl({ rootDir: "C:/RabiRoute", serviceUrl: () => "http://127.0.0.1:8781",
    inspect: async () => status("offline"), ensureDependencies: async () => { throw new Error("dependency validation failed"); },
    spawnRuntime: () => { assert.fail("must not launch"); }
  });
  await assert.rejects(broken.start(), /dependency validation failed/);
});

function fixtureFile(root: string, relative: string): void {
  const filename = path.join(root, relative);
  fs.mkdirSync(path.dirname(filename), { recursive: true });
  fs.writeFileSync(filename, "fixture");
}

function dependencyFixture(root: string): void {
  for (const relative of [
    "fastapi/__init__.py", "uvicorn/__init__.py", "httpx/__init__.py",
    "python_multipart/__init__.py", "numpy/__init__.py", "scipy/__init__.py",
    "soundfile.py", "sounddevice.py"
  ]) fixtureFile(root, relative);
}

function runtimeFixture(t: TestContext) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "speech-runtime-control-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const stateRoot = path.join(root, "state");
  const packageRoot = path.join(root, "versions", "first");
  const serviceRoot = path.join(packageRoot, "plugin-adapters", "rabi-speech");
  for (const relative of ["runtime/RabiSpeech.exe", "scripts/start.ps1", "scripts/windows_host.py"]) {
    fixtureFile(serviceRoot, relative);
  }
  return {
    stateRoot, packageRoot, serviceRoot,
    stableDependencies: path.join(stateRoot, "plugin-adapters", "rabi-speech", ".deps"),
    bundledDependencies: path.join(serviceRoot, ".deps")
  };
}

test("standard package without an optional speech EXE uses its portable Python and never creates a host in the release", async t => {
  const fixture = runtimeFixture(t);
  dependencyFixture(path.join(fixture.stateRoot, "plugin-adapters/rabi-speech/.deps"));
  fs.unlinkSync(path.join(fixture.serviceRoot, "runtime/RabiSpeech.exe"));
  fixtureFile(fixture.packageRoot, "desktop-runtime/python/python.exe");
  let launched = false;
  const control = new SpeechRuntimeControl({ rootDir: fixture.stateRoot, packageRoot: fixture.packageRoot, platform: "win32",
    serviceUrl: () => "http://127.0.0.1:8781", inspect: async () => status(launched ? "online" : "offline"),
    spawnRuntime: (_command, args, options) => {
      assert.deepEqual(args.slice(-2), ["-Python", path.join(fixture.packageRoot, "desktop-runtime/python/python.exe")]);
      assert.equal(options?.env?.RABISPEECH_HOST_EXECUTABLE, path.join(fixture.stateRoot, "runtime/speech/RabiSpeech.exe"));
      launched = true; return { pid: 123, exitCode: null, unref() {} };
    }
  });
  assert.equal((await control.start()).action, "started");
  assert.equal(fs.existsSync(path.join(fixture.serviceRoot, "runtime/RabiSpeech.exe")), false);
  assert.equal(fs.existsSync(path.join(fixture.stateRoot, "runtime/speech/RabiSpeech.exe")), true);
});

async function launchFixture(stateRoot: string, packageRoot: string): Promise<NodeJS.ProcessEnv> {
  let launched = false;
  let launchEnv: NodeJS.ProcessEnv | undefined;
  const control = new SpeechRuntimeControl({
    rootDir: stateRoot,
    packageRoot,
    serviceUrl: () => "http://127.0.0.1:8781",
    platform: "win32",
    inspect: async () => status(launched ? "online" : "offline"),
    spawnRuntime: (_command, _args, options) => {
      launched = true;
      launchEnv = options?.env;
      assert.equal(options?.cwd, path.join(packageRoot, "plugin-adapters", "rabi-speech"));
      return { pid: 123, exitCode: null, unref() {} };
    }
  });
  assert.equal((await control.start()).action, "started");
  assert.ok(launchEnv);
  return launchEnv;
}

test("packaged speech runtime uses the dependencies written by the current package installer", async t => {
  const fixture = runtimeFixture(t);
  dependencyFixture(fixture.bundledDependencies);
  const env = await launchFixture(fixture.stateRoot, fixture.packageRoot);
  assert.equal(env.RABISPEECH_DEPS_ROOT, fixture.bundledDependencies);
  const executable = path.join(fixture.stateRoot, "runtime", "speech", "RabiSpeech.exe");
  assert.equal(env.RABISPEECH_HOST_EXECUTABLE, executable);
  assert.equal(fs.readFileSync(executable, "utf8"), "fixture");
  assert.equal(fs.existsSync(fixture.stableDependencies), false);
});

test("stable speech dependencies take precedence and survive a package release change", async t => {
  const fixture = runtimeFixture(t);
  dependencyFixture(fixture.stableDependencies);
  dependencyFixture(fixture.bundledDependencies);
  const first = await launchFixture(fixture.stateRoot, fixture.packageRoot);
  const nextPackage = path.join(path.dirname(fixture.packageRoot), "second");
  const nextService = path.join(nextPackage, "plugin-adapters", "rabi-speech");
  for (const relative of ["runtime/RabiSpeech.exe", "scripts/start.ps1", "scripts/windows_host.py"]) {
    fixtureFile(nextService, relative);
  }
  const second = await launchFixture(fixture.stateRoot, nextPackage);
  assert.equal(first.RABISPEECH_DEPS_ROOT, fixture.stableDependencies);
  assert.equal(second.RABISPEECH_DEPS_ROOT, fixture.stableDependencies);
  assert.equal(first.RABISPEECH_HOST_EXECUTABLE, second.RABISPEECH_HOST_EXECUTABLE);
  assert.equal(fs.existsSync(path.join(nextService, ".deps")), false);
});

test("an empty stable dependency target does not shadow the complete package dependencies", async t => {
  const fixture = runtimeFixture(t);
  fs.mkdirSync(fixture.stableDependencies, { recursive: true });
  dependencyFixture(fixture.bundledDependencies);
  const env = await launchFixture(fixture.stateRoot, fixture.packageRoot);
  assert.equal(env.RABISPEECH_DEPS_ROOT, fixture.bundledDependencies);
});

for (const partial of [false, true]) {
  test(`speech runtime rejects ${partial ? "partially populated" : "empty"} pip targets before spawning`, async t => {
    const fixture = runtimeFixture(t);
    fs.mkdirSync(fixture.stableDependencies, { recursive: true });
    fs.mkdirSync(fixture.bundledDependencies, { recursive: true });
    if (partial) {
      dependencyFixture(fixture.bundledDependencies);
      fs.rmSync(path.join(fixture.bundledDependencies, "sounddevice.py"));
    }
    let launches = 0;
    const control = new SpeechRuntimeControl({
      rootDir: fixture.stateRoot,
      packageRoot: fixture.packageRoot,
      serviceUrl: () => "http://127.0.0.1:8781",
      platform: "win32",
      inspect: async () => status("offline"),
      spawnRuntime: () => {
        launches += 1;
        throw new Error("must not spawn an incomplete installation");
      }
    });
    await assert.rejects(() => control.start(), (error: unknown) => {
      assert.ok(error instanceof SpeechRuntimeControlError);
      assert.equal(error.status, 409);
      assert.match(error.message, /尚未安装依赖/);
      return true;
    });
    assert.equal(launches, 0);
    assert.equal(fs.existsSync(path.join(fixture.stateRoot, "runtime", "speech")), false);
  });
}

test("speech runtime start launches once and waits for real health", async () => {
  const states = [status("offline"), status("offline"), status("online")];
  let launches = 0;
  let launchCommand = "";
  let launchArgs: string[] = [];
  let detached: boolean | undefined;
  let launchEnv: NodeJS.ProcessEnv | undefined;
  const control = new SpeechRuntimeControl({
    rootDir: "C:/RabiRoute",
    serviceUrl: () => "http://127.0.0.1:8781",
    platform: "win32",
    existsSync: installed,
    inspect: async () => states.shift() ?? status("online"),
    spawnRuntime: (command, args, options) => {
      launches += 1;
      launchCommand = command;
      launchArgs = args;
      detached = options?.detached;
      launchEnv = options?.env;
      return { pid: 123, exitCode: null, unref() {} };
    },
    wait: async () => {}
  });

  const result = await control.start();
  assert.equal(result.action, "started");
  assert.equal(result.status.state, "online");
  assert.equal(launches, 1);
  assert.equal(launchCommand, "powershell.exe");
  assert.equal(detached, false);
  assert.equal(launchEnv?.PYTHONUTF8, "1");
  assert.equal(launchEnv?.PYTHONIOENCODING, "utf-8");
  assert.deepEqual(launchArgs.slice(0, 4), ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass"]);
  assert.match(launchArgs.at(-1) || "", /scripts[\\/]start\.ps1$/i);
});

test("speech runtime bind failure reports the port from the launch log", async () => {
  const stderr = new PassThrough();
  const control = new SpeechRuntimeControl({
    rootDir: "C:/RabiRoute",
    serviceUrl: () => "http://127.0.0.1:8781",
    platform: "win32",
    existsSync: installed,
    inspect: async () => status("offline"),
    spawnRuntime: () => {
      queueMicrotask(() => stderr.end(
        "OSError: [WinError 10048] error while attempting to bind on address ('0.0.0.0', 8782)"
      ));
      return { pid: 123, exitCode: 3, stderr, unref() {} };
    },
    inspectOwner: async () => null,
    wait: async () => {}
  });

  await assert.rejects(
    () => control.start(),
    (error: unknown) => {
      assert.ok(error instanceof SpeechRuntimeControlError);
      assert.match(error.detail, /8782/);
      assert.match(error.resolution, /8782/);
      assert.doesNotMatch(error.resolution, /8781/);
      return true;
    }
  );
});

test("speech runtime start replaces a stale owned runtime blocking the remote audio port", async () => {
  const killed: number[] = [];
  let launches = 0;
  const control = new SpeechRuntimeControl({
    rootDir: "C:/RabiRoute",
    serviceUrl: () => "http://127.0.0.1:8781",
    platform: "win32",
    existsSync: installed,
    inspect: async () => status(launches >= 2 ? "online" : "offline"),
    spawnRuntime: () => {
      launches += 1;
      if (launches === 1) {
        const stderr = new PassThrough();
        queueMicrotask(() => stderr.end(
          "OSError: [WinError 10048] error while attempting to bind on address ('0.0.0.0', 8782)"
        ));
        return { pid: 123, exitCode: 3, stderr, unref() {} };
      }
      return { pid: 789, exitCode: null, unref() {} };
    },
    inspectOwner: async port => port === 8782 ? { pid: 456, owned: true } : null,
    killProcessTree: async pid => { killed.push(pid); },
    wait: async () => {}
  });

  const result = await control.start();
  assert.equal(result.action, "started");
  assert.equal(result.status.state, "online");
  assert.equal(launches, 2);
  assert.deepEqual(killed, [456]);
});

test("speech runtime default startup budget covers a slow cold source scan", async () => {
  let now = 0;
  let launched = false;
  const control = new SpeechRuntimeControl({
    rootDir: "C:/RabiRoute",
    serviceUrl: () => "http://127.0.0.1:8781",
    platform: "win32",
    existsSync: installed,
    inspect: async () => status(launched && now >= 60_500 ? "online" : "offline"),
    spawnRuntime: () => {
      launched = true;
      return { pid: 123, exitCode: null, unref() {} };
    },
    wait: async milliseconds => { now += milliseconds; },
    now: () => now
  });

  const result = await control.start();
  assert.equal(result.action, "started");
  assert.equal(result.status.state, "online");
});

test("speech runtime timeout returns the last concrete failure and a recovery action", async () => {
  const offline = status("offline");
  offline.error = "health request timed out after 5000 ms";
  const control = new SpeechRuntimeControl({
    rootDir: "C:/RabiRoute",
    serviceUrl: () => "http://127.0.0.1:8781",
    platform: "win32",
    existsSync: installed,
    inspect: async () => offline,
    spawnRuntime: () => ({ pid: 123, exitCode: null, unref() {} }),
    wait: async () => {},
    startTimeoutMs: 0
  });

  await assert.rejects(
    () => control.start(),
    (error: unknown) => {
      assert.ok(error instanceof SpeechRuntimeControlError);
      assert.match(error.detail, /health request timed out after 5000 ms/);
      assert.match(error.resolution, /重新启动|启动日志/);
      return true;
    }
  );
});

test("speech runtime start reuses an already healthy service", async () => {
  let launches = 0;
  const control = new SpeechRuntimeControl({
    rootDir: "C:/RabiRoute",
    serviceUrl: () => "http://127.0.0.1:8781",
    platform: "win32",
    existsSync: installed,
    inspect: async () => status("online"),
    spawnRuntime: () => {
      launches += 1;
      return { pid: 123, exitCode: null, unref() {} };
    }
  });

  const result = await control.start();
  assert.equal(result.action, "already_online");
  assert.equal(launches, 0);
});

test("speech runtime stop is already offline without optional dependencies or runtime files", async () => {
  const control = new SpeechRuntimeControl({
    rootDir: "C:/RabiRoute", platform: "win32", serviceUrl: () => "http://127.0.0.1:8781",
    existsSync: () => false, inspect: async () => status("offline"),
    inspectOwner: async () => null,
    killProcessTree: async () => { assert.fail("offline runtime must not be killed"); }
  });
  assert.equal((await control.stop()).action, "already_offline");
  await assert.rejects(control.start(), /尚未安装依赖/);
});

test("speech runtime stop still stops its verified owner after installation files disappear", async () => {
  const killed: number[] = [];
  const control = new SpeechRuntimeControl({
    rootDir: "C:/RabiRoute", platform: "win32", serviceUrl: () => "http://127.0.0.1:8781",
    existsSync: () => false, inspect: async () => status("offline"),
    inspectOwner: async () => ({ pid: 456, owned: true }),
    killProcessTree: async pid => { killed.push(pid); }
  });
  assert.equal((await control.stop()).action, "stopped");
  assert.deepEqual(killed, [456]);
});

test("speech runtime stop without dependencies still rejects an unrelated owner", async () => {
  const control = new SpeechRuntimeControl({
    rootDir: "C:/RabiRoute", platform: "win32", serviceUrl: () => "http://127.0.0.1:8781",
    existsSync: () => false, inspect: async () => status("online"),
    inspectOwner: async () => ({ pid: 999, owned: false }),
    killProcessTree: async () => { assert.fail("unrelated runtime must not be killed"); }
  });
  await assert.rejects(control.stop(), /拒绝停止/);
});

test("speech runtime stop cannot confirm offline while an unverified service remains online", async () => {
  const control = new SpeechRuntimeControl({
    rootDir: "C:/RabiRoute", platform: "win32", serviceUrl: () => "http://127.0.0.1:8781",
    existsSync: () => false, inspect: async () => status("online"), inspectOwner: async () => null,
    killProcessTree: async () => { assert.fail("an unverified runtime must not be killed"); }
  });
  await assert.rejects(control.stop(), /无法确认 RabiSpeech 已停止/);
});

test("speech runtime stop preserves a real owner termination failure", async () => {
  const control = new SpeechRuntimeControl({
    rootDir: "C:/RabiRoute", platform: "win32", serviceUrl: () => "http://127.0.0.1:8781",
    existsSync: () => false, inspect: async () => status("online"), inspectOwner: async () => ({ pid: 456, owned: true }),
    killProcessTree: async () => { throw new Error("Controlled runtime termination failure."); }
  });
  await assert.rejects(control.stop(), /Controlled runtime termination failure/);
});

test("speech runtime stop remains unconfirmed if the service is online after its owner termination", async () => {
  let clock = 0;
  const control = new SpeechRuntimeControl({
    rootDir: "C:/RabiRoute", platform: "win32", serviceUrl: () => "http://127.0.0.1:8781",
    existsSync: () => false, inspect: async () => status("online"), inspectOwner: async () => ({ pid: 456, owned: true }),
    killProcessTree: async () => {}, stopTimeoutMs: 1, now: () => clock, wait: async milliseconds => { clock += milliseconds; }
  });
  await assert.rejects(control.stop(), /停止超时/);
});

test("speech runtime stop verifies an external port owner before killing", async () => {
  const states = [status("offline")];
  const killed: number[] = [];
  const control = new SpeechRuntimeControl({
    rootDir: "C:/RabiRoute",
    serviceUrl: () => "http://127.0.0.1:8781",
    platform: "win32",
    existsSync: installed,
    inspect: async () => states.shift() ?? status("offline"),
    inspectOwner: async () => ({ pid: 456, owned: true }),
    killProcessTree: async pid => { killed.push(pid); },
    wait: async () => {}
  });

  const result = await control.stop();
  assert.equal(result.action, "stopped");
  assert.deepEqual(killed, [456]);
});

test("speech runtime stop fails closed for an unrelated port owner", async () => {
  const control = new SpeechRuntimeControl({
    rootDir: "C:/RabiRoute",
    serviceUrl: () => "http://127.0.0.1:8781",
    platform: "win32",
    existsSync: installed,
    inspect: async () => status("online"),
    inspectOwner: async () => ({ pid: 999, owned: false }),
    killProcessTree: async () => { throw new Error("must not kill"); }
  });

  await assert.rejects(
    () => control.stop(),
    (error: unknown) => error instanceof SpeechRuntimeControlError && error.status === 409
  );
});

test("speech runtime control serializes competing transitions", async () => {
  const actions: string[] = [];
  let online = false;
  const control = new SpeechRuntimeControl({
    rootDir: "C:/RabiRoute",
    serviceUrl: () => "http://127.0.0.1:8781",
    platform: "win32",
    existsSync: installed,
    inspect: async () => status(online ? "online" : "offline"),
    spawnRuntime: () => {
      actions.push("start");
      online = true;
      return { pid: 123, exitCode: null, unref() {} };
    },
    killProcessTree: async () => {
      actions.push("stop");
      online = false;
    },
    wait: async () => {}
  });

  const start = control.start();
  const stop = control.stop();
  await Promise.all([start, stop]);
  assert.deepEqual(actions, ["start", "stop"]);
});


test("remote speech configuration never starts or terminates a same-port local process", async () => {
  const control = new SpeechRuntimeControl({ rootDir: "C:/RabiRoute", platform: "win32",
    serviceUrl: () => "https://speech.example.test:8781", existsSync: installed,
    inspectOwner: async () => { assert.fail("Do not query a local port for a remote service"); },
    spawnRuntime: () => { assert.fail("Do not spawn a local replacement for a remote service"); },
    killProcessTree: async () => { assert.fail("Do not terminate a local process for a remote service"); }
  });
  await assert.rejects(control.start(), /来源电脑的 Manager/);
  await assert.rejects(control.stop(), /来源电脑的 Manager/);
});
