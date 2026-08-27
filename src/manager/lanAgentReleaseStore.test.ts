import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { LanAgentReleaseStore, verifyLanAgentReleaseManifest } from "./lanAgentReleaseStore.js";

function temporaryDirectory(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function writeAgent(root: string): void {
  fs.mkdirSync(path.join(root, "lib"), { recursive: true });
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "rabi-agent", version: "0.9.1" }));
  fs.writeFileSync(path.join(root, "rabi-agent.mjs"), "export const version = '0.9.1';\n");
  fs.writeFileSync(path.join(root, "lib", "worker.mjs"), "export const worker = true;\n");
  fs.writeFileSync(path.join(root, "ignored.txt"), "ignored\n");
}

test("LAN Agent release manifest signs the published Node resources", () => {
  const root = temporaryDirectory("rabiroute-lan-agent-release-");
  try {
    const agentRoot = path.join(root, "agent");
    writeAgent(agentRoot);
    const store = new LanAgentReleaseStore({ rootDir: root, agentRoot, signingKeyPath: path.join(root, "data", "signing.json") });
    const manifest = store.manifest();
    assert.equal(manifest.version, "0.9.1");
    assert.equal(manifest.platform, "node");
    assert.equal(manifest.minNodeVersion, "22.0.0");
    assert.deepEqual(manifest.files.map(file => file.path), ["lib/worker.mjs", "package.json", "rabi-agent.mjs"]);
    assert.match(manifest.publicKeySha256, /^[a-f0-9]{64}$/);
    assert.equal(verifyLanAgentReleaseManifest(manifest, manifest.publicKeySha256), true);
    const entry = manifest.files.find(file => file.path === "rabi-agent.mjs");
    assert.ok(entry);
    assert.equal(entry.sha256, createHash("sha256").update("export const version = '0.9.1';\n").digest("hex"));
    assert.equal(store.readAsset("0.9.1", "node", "rabi-agent.mjs").toString("utf8"), "export const version = '0.9.1';\n");
    assert.throws(() => store.readAsset("0.9.0", "node", "rabi-agent.mjs"), /not available/);
    assert.throws(() => store.readAsset("0.9.1", "node", "../secret.mjs"), /Invalid|not available/);

    const replacementStore = new LanAgentReleaseStore({
      rootDir: root,
      agentRoot,
      signingKeyPath: path.join(root, "data", "replacement-signing.json")
    });
    const replacementManifest = replacementStore.manifest();
    assert.notEqual(replacementManifest.publicKeySha256, manifest.publicKeySha256);
    assert.equal(verifyLanAgentReleaseManifest(replacementManifest, manifest.publicKeySha256), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
