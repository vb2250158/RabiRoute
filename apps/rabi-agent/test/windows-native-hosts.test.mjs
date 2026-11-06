import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const packageRoot = fileURLToPath(new URL("..", import.meta.url));
const repository = path.resolve(packageRoot, "../..");
const powershell = path.join(process.env.SystemRoot || "C:\\Windows", "System32/WindowsPowerShell/v1.0/powershell.exe");
const names = ["Terminal", "Computer", "Tray"];
function build(root) {
  return spawnSync(powershell, ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", path.join(repository, "scripts/build-agent-native-assets.ps1"), "-AgentRoot", root], { encoding: "utf8", windowsHide: true, timeout: 60_000 });
}
function hashes(root) {
  return Object.fromEntries(fs.readdirSync(root).sort().map(name => [name, createHash("sha256").update(fs.readFileSync(path.join(root, name))).digest("hex")]));
}
function iconImages(file) {
  const bytes = fs.readFileSync(file), pe = bytes.readUInt32LE(0x3c), optional = pe + 24;
  const resourceRva = bytes.readUInt32LE(optional + (bytes.readUInt16LE(optional) === 0x20b ? 112 : 96) + 16);
  const sections = pe + 24 + bytes.readUInt16LE(pe + 20);
  const offset = rva => {
    for (let n = 0; n < bytes.readUInt16LE(pe + 6); n++) {
      const start = sections + n * 40, address = bytes.readUInt32LE(start + 12);
      if (rva >= address && rva < address + Math.max(bytes.readUInt32LE(start + 8), bytes.readUInt32LE(start + 16)))
        return rva - address + bytes.readUInt32LE(start + 20);
    }
    throw new Error("PE resource RVA is outside all sections");
  };
  const base = offset(resourceRva);
  const directory = relative => {
    const start = base + relative, count = bytes.readUInt16LE(start + 12) + bytes.readUInt16LE(start + 14);
    return Array.from({ length: count }, (_, n) => ({ id: bytes.readUInt32LE(start + 16 + n * 8), value: bytes.readUInt32LE(start + 20 + n * 8) & 0x7fffffff }));
  };
  const resources = directory(0), groups = resources.find(item => item.id === 14), icons = resources.find(item => item.id === 3);
  assert.equal(directory(groups.value).length, 1, "one product icon group is embedded");
  return directory(icons.value).flatMap(item => directory(item.value).map(language => {
    const data = base + language.value, start = offset(bytes.readUInt32LE(data));
    return bytes.subarray(start, start + bytes.readUInt32LE(data + 4)).toString("hex");
  })).sort();
}

test("native Windows hosts carry product names and icons; failed builds preserve the complete prior set", { skip: process.platform !== "win32", timeout: 90_000 }, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rabi-native-hosts-"));
  try {
    for (const relative of ["package.json", "desktop/tray.ps1", "desktop/computer.ps1", "desktop/rabi-agent.ico", "terminal/host.ps1"]) {
      fs.mkdirSync(path.dirname(path.join(root, relative)), { recursive: true });
      fs.copyFileSync(path.join(packageRoot, relative), path.join(root, relative));
    }
    const built = build(root);
    assert.equal(built.status, 0, built.stderr || built.stdout);
    const native = path.join(root, "dist/native");
    const metadata = spawnSync(powershell, ["-NoProfile", "-NonInteractive", "-Command", `
$records = foreach ($name in @('Terminal','Computer','Tray')) {
  $file = Join-Path $env:RABI_NATIVE_TEST_ROOT ('dist/native/RabiAgent.'+$name+'.exe')
  $v = [Diagnostics.FileVersionInfo]::GetVersionInfo($file)
  @{ name=$name;description=$v.FileDescription;product=$v.ProductName }
}
ConvertTo-Json -InputObject @($records) -Compress
`], { env: { ...process.env, RABI_NATIVE_TEST_ROOT: root }, encoding: "utf8", windowsHide: true, timeout: 15_000 });
    assert.equal(metadata.status, 0, metadata.stderr || metadata.stdout);
    assert.deepEqual(JSON.parse(metadata.stdout), names.map(name => ({ name, description: `Rabi Agent ${name}`, product: "RabiRoute" })));
    const ico = fs.readFileSync(path.join(root, "desktop/rabi-agent.ico"));
    const expectedImages = Array.from({ length: ico.readUInt16LE(4) }, (_, n) => {
      const start = 6 + n * 16, offset = ico.readUInt32LE(start + 12);
      return ico.subarray(offset, offset + ico.readUInt32LE(start + 8)).toString("hex");
    }).sort();
    for (const name of names) assert.deepEqual(iconImages(path.join(native, `RabiAgent.${name}.exe`)), expectedImages);
    const before = hashes(native);
    const source = path.join(root, "desktop/computer.ps1"), original = fs.readFileSync(source, "utf8");
    fs.writeFileSync(source, original.replace("public static class RabiComputer", "invalid native source\npublic static class RabiComputer"));
    const failed = build(root);
    assert.notEqual(failed.status, 0);
    assert.deepEqual(hashes(native), before, "no partial native set is published");
    assert.deepEqual(fs.readdirSync(path.join(root, "dist")).filter(name => name.startsWith(".native-")), []);
    fs.writeFileSync(source, original);
    fs.writeFileSync(path.join(root, "release-identity.json"), JSON.stringify({ digest: "fixture-frozen" }));
    const frozen = build(root);
    assert.notEqual(frozen.status, 0);
    assert.match(frozen.stderr + frozen.stdout, /installed signed release is immutable/);
    assert.deepEqual(hashes(native), before);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
