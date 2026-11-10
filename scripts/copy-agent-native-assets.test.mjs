import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, copyFile, readdir, readFile, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const quote = value => "'" + value.replaceAll("'", "''") + "'";
function powershell(command) {
  return spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(command, "utf16le").toString("base64")],
    { encoding: "utf8", windowsHide: true, timeout: 60000 });
}

test("release copies source-matched assemblies and all branded native hosts with exact bytes", { skip: process.platform !== "win32", timeout: 90000 }, async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "rabi-native-release-"));
  const agent = path.join(temp, "agent"), payload = path.join(temp, "payload");
  try {
    for (const relative of ["terminal/host.ps1", "desktop/computer.ps1", "desktop/computer-native.cs", "desktop/tray.ps1", "desktop/rabi-agent.ico", "package.json", "desktop/tracking/asset-spec.json", "desktop/tracking/RabiAgent.Computer.Tracking.csproj", "desktop/tracking/Engine.cs", "desktop/tracking/packages.lock.json", "desktop/tracking/THIRD-PARTY-NOTICES.txt"]) {
      await mkdir(path.dirname(path.join(agent, relative)), { recursive: true });
      await copyFile(path.join(root, "apps/rabi-agent", relative), path.join(agent, relative));
    }
    const builder = path.join(root, "scripts/build-agent-native-assets.ps1");
    const helper = path.join(root, "scripts/lib/copy-agent-native-assets.ps1");
    const result = powershell(`$ErrorActionPreference='Stop'; & ${quote(builder)} -AgentRoot ${quote(agent)}; . ${quote(helper)}; Copy-AgentNativeAssets -AgentRoot ${quote(agent)} -PayloadRoot ${quote(payload)}`);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const native = path.join(agent, "dist/native");
    const requiredHosts = ["RabiAgent.Computer.exe", "RabiAgent.Terminal.exe", "RabiAgent.Tray.exe"];
    const tracking = JSON.parse(await readFile(path.join(native, "computer-tracking-assets.json"), "utf8"));
    const trackingFiles = ["computer-tracking-assets.json", ...tracking.files.map(file => file.path)];
    const built = (await readdir(native)).filter(name => /^(terminal|computer|tray)-[a-f0-9]{64}\.dll$/.test(name) || requiredHosts.includes(name) || trackingFiles.includes(name)).sort();
    const copied = (await readdir(path.join(payload, "apps/rabi-agent/dist/native"))).sort();
    assert.equal(built.length, 6 + trackingFiles.length);
    assert.deepEqual(copied, built);
    for (const name of built) {
      assert.deepEqual(await readFile(path.join(payload, "apps/rabi-agent/dist/native", name)), await readFile(path.join(native, name)), name);
    }
    assert.equal((await readdir(native)).filter(name => /^(terminal|computer|tray)-[a-f0-9]{64}\.exe$/.test(name)).length, 3, "the builder cache must not enter the payload");
    for (const name of requiredHosts) {
      const bytes = await readFile(path.join(native, name));
      await rm(path.join(native, name));
      const failure = powershell(`$ErrorActionPreference='Stop'; . ${quote(helper)}; Copy-AgentNativeAssets -AgentRoot ${quote(agent)} -PayloadRoot ${quote(path.join(temp, "missing-" + name))}`);
      assert.notEqual(failure.status, 0, name);
      assert.ok(failure.stderr.includes(`Native release asset missing: ${name}`), failure.stderr || failure.stdout);
      await writeFile(path.join(native, name), bytes);
    }
    const invalidHost = path.join(native, requiredHosts[0]);
    const originalHost = await readFile(invalidHost);
    await writeFile(invalidHost, "not a managed native host");
    const invalid = powershell(`$ErrorActionPreference='Stop'; . ${quote(helper)}; Copy-AgentNativeAssets -AgentRoot ${quote(agent)} -PayloadRoot ${quote(path.join(temp, "invalid"))}`);
    assert.notEqual(invalid.status, 0, "an invalid executable must fail the existing assembly contract");
    assert.match(invalid.stderr, /GetAssemblyName|BadImageFormat|assembly manifest/i);
    await writeFile(invalidHost, originalHost);
    const sourceMatchedDll = built.find(name => /^(terminal|computer|tray)-[a-f0-9]{64}\.dll$/.test(name));
    await rm(path.join(native, sourceMatchedDll));
    const failure = powershell(`$ErrorActionPreference='Stop'; . ${quote(helper)}; Copy-AgentNativeAssets -AgentRoot ${quote(agent)} -PayloadRoot ${quote(path.join(temp, "missing-dll"))}`);
    assert.notEqual(failure.status, 0);
    assert.match(failure.stderr, /Native release asset missing/);
    await copyFile(path.join(payload,"apps/rabi-agent/dist/native",sourceMatchedDll),path.join(native,sourceMatchedDll));
    await rm(path.join(native,"OpenCvSharp.dll"));
    const trackingMissing=powershell(`$ErrorActionPreference='Stop'; . ${quote(helper)}; Copy-AgentNativeAssets -AgentRoot ${quote(agent)} -PayloadRoot ${quote(path.join(temp,"missing-tracking"))}`);
    assert.notEqual(trackingMissing.status,0);assert.match(trackingMissing.stderr,/Computer tracking release asset missing: OpenCvSharp.dll/);

  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});
