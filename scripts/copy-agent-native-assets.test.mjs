import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, copyFile, readdir, rm } from "node:fs/promises";
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

test("release copies only source-matched native assemblies and rejects a missing one", { skip: process.platform !== "win32", timeout: 90000 }, async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "rabi-native-release-"));
  const agent = path.join(temp, "agent"), payload = path.join(temp, "payload");
  try {
    for (const relative of ["terminal/host.ps1", "desktop/computer.ps1", "desktop/tray.ps1"]) {
      await mkdir(path.dirname(path.join(agent, relative)), { recursive: true });
      await copyFile(path.join(root, "apps/rabi-agent", relative), path.join(agent, relative));
    }
    const builder = path.join(root, "scripts/build-agent-native-assets.ps1");
    const helper = path.join(root, "scripts/lib/copy-agent-native-assets.ps1");
    const result = powershell(`$ErrorActionPreference='Stop'; & ${quote(builder)} -AgentRoot ${quote(agent)}; . ${quote(helper)}; Copy-AgentNativeAssets -AgentRoot ${quote(agent)} -PayloadRoot ${quote(payload)}`);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const built = (await readdir(path.join(agent, "dist/native"))).sort();
    const copied = (await readdir(path.join(payload, "apps/rabi-agent/dist/native"))).sort();
    assert.equal(built.length, 3);
    assert.deepEqual(copied, built);
    await rm(path.join(agent, "dist/native", built[0]));
    const failure = powershell(`$ErrorActionPreference='Stop'; . ${quote(helper)}; Copy-AgentNativeAssets -AgentRoot ${quote(agent)} -PayloadRoot ${quote(path.join(temp, "missing"))}`);
    assert.notEqual(failure.status, 0);
    assert.match(failure.stderr, /Native release asset missing/);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});
