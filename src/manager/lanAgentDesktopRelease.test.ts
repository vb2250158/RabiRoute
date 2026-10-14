import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { LanAgentReleaseStore, verifyLanAgentReleaseManifest } from "./lanAgentReleaseStore.js";

test("signed remote release includes its owned tray asset and rejects unrelated PowerShell files", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rabi-tray-release-"));
  try {
    const agentRoot = path.join(root, "agent");
    fs.mkdirSync(path.join(agentRoot, "desktop"), { recursive: true });
    fs.mkdirSync(path.join(agentRoot, "terminal"), { recursive: true });
    fs.mkdirSync(path.join(agentRoot, "dist/native"), { recursive: true });
    fs.writeFileSync(path.join(agentRoot, "package.json"), JSON.stringify({ version: "0.2.1" }));
    fs.writeFileSync(path.join(agentRoot, "rabi-agent.mjs"), "export const agent = true;");
    fs.copyFileSync(path.resolve("apps/rabi-agent/desktop/tray.ps1"), path.join(agentRoot, "desktop/tray.ps1"));
    fs.copyFileSync(path.resolve("apps/rabi-agent/desktop/computer.ps1"), path.join(agentRoot, "desktop/computer.ps1"));
    fs.copyFileSync(path.resolve("apps/rabi-agent/terminal/host.ps1"), path.join(agentRoot, "terminal/host.ps1"));
    const nativePath = `dist/native/terminal-${"a".repeat(64)}.dll`;
    fs.writeFileSync(path.join(agentRoot, nativePath), Buffer.from([0x4d,0x5a,1,2]));
    fs.writeFileSync(path.join(agentRoot,"dist/native/unrelated.dll"),"not a native helper");
    fs.writeFileSync(path.join(agentRoot, "desktop/other.ps1"), "throw 'not a release asset'");
    const store = new LanAgentReleaseStore({ rootDir: root, agentRoot });
    const manifest = store.manifest();
    assert.equal(verifyLanAgentReleaseManifest(manifest, manifest.publicKeySha256), true);
    assert.deepEqual(manifest.files.map(file => file.path), ["desktop/computer.ps1", "desktop/tray.ps1", nativePath, "package.json", "rabi-agent.mjs", "terminal/host.ps1"]);
    assert.deepEqual(store.readAsset("0.2.1","node",nativePath),Buffer.from([0x4d,0x5a,1,2]));
    assert.throws(()=>store.readAsset("0.2.1","node","dist/native/unrelated.dll"));
    assert.deepEqual(store.readAsset("0.2.1", "node", "desktop/tray.ps1"), fs.readFileSync(path.join(agentRoot, "desktop/tray.ps1")));
    const digest = store.publication().releaseDigest;
    fs.appendFileSync(path.join(agentRoot, "desktop/tray.ps1"), "\n# changed");
    assert.notEqual(store.publication().releaseDigest, digest);
    assert.throws(() => store.readAsset("0.2.1", "node", "desktop/other.ps1"));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
