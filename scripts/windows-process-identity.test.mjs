import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repository = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const windows = { skip: process.platform !== "win32", timeout: 120_000 };
function run(executable, args, options = {}) {
  const result = spawnSync(executable, args, { encoding: "utf8", windowsHide: true, timeout: 90_000, ...options });
  assert.equal(result.status, 0, result.stderr || result.stdout || String(result.error));
  return result.stdout.trim();
}
function metadata(file) {
  return JSON.parse(run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
    "$v=[Diagnostics.FileVersionInfo]::GetVersionInfo($env:RABI_IDENTITY_TEST_EXE); " +
    "@{description=$v.FileDescription;product=$v.ProductName;version=$v.FileVersion;productVersion=$v.ProductVersion;copyright=$v.LegalCopyright;" +
    "original=$v.OriginalFilename;signature=[string](Get-AuthenticodeSignature -LiteralPath $env:RABI_IDENTITY_TEST_EXE).Status}|ConvertTo-Json -Compress"],
    { env: { ...process.env, RABI_IDENTITY_TEST_EXE: file,
      PSModulePath: path.join(process.env.SystemRoot, "System32/WindowsPowerShell/v1.0/Modules") } }));
}

const iconCheck = `import pefile,struct,sys
p=pefile.PE(sys.argv[1]); ico=open(sys.argv[2],'rb').read(); expected=[]
for n in range(struct.unpack_from('<H',ico,4)[0]):
 size,offset=struct.unpack_from('<II',ico,6+16*n+8); expected.append(ico[offset:offset+size])
groups=[x for x in p.DIRECTORY_ENTRY_RESOURCE.entries if x.id==14]
assert len(groups)==1 and len(groups[0].directory.entries)==1
icons=[x for x in p.DIRECTORY_ENTRY_RESOURCE.entries if x.id==3][0]
actual=[]
for x in icons.directory.entries:
 for lang in x.directory.entries:
  d=lang.data.struct; actual.append(p.get_data(d.OffsetToData,d.Size))
assert sorted(actual)==sorted(expected), 'old vendor icons or missing product icons'
print('icon images matched:',len(actual))`;

test("Windows runtime has product metadata, the exact product icons, and working inherited fork identity", windows, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rabi-process-identity-"));
  const sourceHash = fs.readFileSync(process.execPath);
  try {
    const executable = path.join(root, "RabiRoute.Runtime.exe");
    run("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File",
      path.join(repository, "scripts/Set-WindowsExecutableIdentity.ps1"), "-Source", process.execPath,
      "-Destination", executable, "-Description", "RabiRoute Runtime"]);
    const original = metadata(process.execPath), actual = metadata(executable);
    assert.equal(actual.description, "RabiRoute Runtime");
    assert.equal(actual.product, "RabiRoute");
    assert.equal(actual.original, "RabiRoute.Runtime.exe");
    assert.equal(actual.version, original.version);
    assert.equal(actual.copyright, original.copyright);
    assert.equal(actual.signature, "NotSigned", "modified executables cannot claim the upstream signature");
    assert.deepEqual(fs.readFileSync(process.execPath), sourceHash, "the original interpreter is unchanged");
    const childScript = path.join(root, "child.cjs");
    fs.writeFileSync(childScript, "process.send({execPath:process.execPath});process.disconnect();");
    const parentScript = path.join(root, "parent.cjs");
    fs.writeFileSync(parentScript, "const {fork}=require('node:child_process');const c=fork(process.argv[2],[],{windowsHide:true});c.once('message',m=>console.log(JSON.stringify({parent:process.execPath,child:m.execPath})));c.once('exit',code=>process.exitCode=code);");
    const identity = JSON.parse(run(executable, [parentScript, childScript]));
    assert.equal(identity.parent.toLowerCase(), executable.toLowerCase());
    assert.equal(identity.child.toLowerCase(), executable.toLowerCase());
    run("py.exe", ["-3.10", "-c", iconCheck, executable, path.join(repository, "assets/rabiroute-icon.ico")],
      { env: { ...process.env, PYTHONPATH: path.join(process.env.LOCALAPPDATA, "RabiRoute/build-cache/executable-identity-pyinstaller-6.16.0") } });
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("Speech launcher preserves its interpreter version and copyright with the original runtime probe", windows, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rabi-speech-identity-"));
  const source = path.join(root, "speech"), dependencies = path.join(source, ".deps");
  try {
    for (const relative of ["scripts/build-windows-host.ps1", "scripts/windows_host.py", "config.example.json"]) {
      const target = path.join(source, relative);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.copyFileSync(path.join(repository, "src/plugins/rabi-speech", relative), target);
    }
    fs.mkdirSync(dependencies);
    const environment = { ...process.env,
      HOME: path.join(root, "home"), USERPROFILE: path.join(root, "home"),
      APPDATA: path.join(root, "appdata"), LOCALAPPDATA: path.join(root, "localappdata"),
      TEMP: path.join(root, "temp"), TMP: path.join(root, "temp"),
      RABISPEECH_ROOT: source, RABISPEECH_DEPS_ROOT: dependencies,
      RABISPEECH_DATA_ROOT: path.join(root, "settings"), RABISPEECH_CONFIG: path.join(root, "settings/config.json"),
      PYTHONDONTWRITEBYTECODE: "1", PYTHONNOUSERSITE: "1",
      PYTHONPATH: path.join(process.env.LOCALAPPDATA, "RabiRoute/build-cache/executable-identity-pyinstaller-6.16.0") };
    delete environment.PYTHONHOME;
    for (const value of [environment.HOME, environment.APPDATA, environment.LOCALAPPDATA, environment.TEMP]) fs.mkdirSync(value, { recursive: true });
    const interpreter = JSON.parse(run("py.exe", ["-3.10", "-c", "import sys,json; print(json.dumps(dict(executable=sys.executable,home=sys.base_prefix,version=sys.version)))"], { env: environment }));
    const originalBytes = fs.readFileSync(interpreter.executable);
    run("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File",
      path.join(source, "scripts/build-windows-host.ps1"), "-ApplicationRoot", repository, "-Python", "py -3.10"], { env: environment });
    const executable = path.join(source, "runtime/RabiSpeech.exe");
    const original = metadata(interpreter.executable), actual = metadata(executable);
    assert.equal(actual.description, "RabiSpeech");
    assert.equal(actual.product, "RabiRoute");
    assert.equal(actual.original, "RabiSpeech.exe");
    assert.equal(actual.version, original.version);
    assert.equal(actual.productVersion, original.productVersion);
    assert.equal(actual.copyright, original.copyright);
    assert.equal(actual.signature, "NotSigned");
    assert.deepEqual(fs.readFileSync(interpreter.executable), originalBytes);
    const runtimeEnvironment = { ...environment, PYTHONHOME: interpreter.home,
      PATH: interpreter.home + path.delimiter + environment.PATH };
    const probe = JSON.parse(run(executable, [path.join(source, "scripts/windows_host.py"), "--probe"], { env: runtimeEnvironment }));
    assert.equal(probe.service_root, source);
    assert.equal(probe.dependencies, dependencies);
    assert.equal(probe.config, environment.RABISPEECH_CONFIG);
    assert.equal(probe.executable, executable);
    assert.equal(run(executable, ["-c", "import sys; print(sys.version)"], { env: runtimeEnvironment }), interpreter.version);
    run("py.exe", ["-3.10", "-c", iconCheck, executable, path.join(repository, "assets/rabiroute-icon.ico")], { env: environment });
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
