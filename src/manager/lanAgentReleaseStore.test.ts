import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { LanAgentReleaseStore, LanAgentReleaseSelectionConflictError, verifyLanAgentReleaseManifest } from "./lanAgentReleaseStore.js";

function temporaryDirectory(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function writeAgent(root: string): void {
  fs.mkdirSync(path.join(root, "lib"), { recursive: true });
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "rabi-agent", version: "0.9.1" }));
  fs.writeFileSync(path.join(root, "rabi-agent.mjs"), "export const version = '0.9.1';\n");
  fs.writeFileSync(path.join(root, "lib", "worker.mjs"), "export const worker = true;\n");
  fs.writeFileSync(path.join(root, "ignored.txt"), "ignored\n");
  fs.mkdirSync(path.join(root, "desktop"));
  fs.copyFileSync(new URL("../../apps/rabi-agent/desktop/rabi-agent.ico", import.meta.url), path.join(root, "desktop", "rabi-agent.ico"));
  fs.writeFileSync(path.join(root, "desktop", "unpublished.ico"), "not a release asset");
}

test("LAN Agent release manifest signs the published Node resources", () => {
  const root = temporaryDirectory("rabiroute-lan-agent-release-");
  try {
    const agentRoot = path.join(root, "agent");
    writeAgent(agentRoot);
    const store = new LanAgentReleaseStore({ rootDir: root, agentRoot, signingKeyPath: path.join(root, "data", "signing.json") });
    const manifest = store.manifest();
    assert.equal(manifest.version, "0.9.1");
    const publication = store.publication();
    assert.equal(publication.version, manifest.version);
    assert.match(publication.releaseDigest, /^[a-f0-9]{64}$/);
    assert.deepEqual(store.publication(), publication);
    fs.writeFileSync(path.join(agentRoot, "lib", "worker.mjs"), "export const worker = false;\n");
    assert.notEqual(store.publication().releaseDigest, publication.releaseDigest);
    fs.writeFileSync(path.join(agentRoot, "lib", "worker.mjs"), "export const worker = true;\n");
    assert.equal(manifest.platform, "node");
    assert.equal(manifest.minNodeVersion, "22.13.0");
    assert.deepEqual(manifest.files.map(file => file.path), ["desktop/rabi-agent.ico", "lib/worker.mjs", "package.json", "rabi-agent.mjs"]);
    assert.deepEqual(store.readAsset("0.9.1", "node", "desktop/rabi-agent.ico"), fs.readFileSync(path.join(agentRoot, "desktop", "rabi-agent.ico")));
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

test("installed releases read immutable package assets while keeping the signing identity in private data", () => {
  const root = temporaryDirectory("rabi-instance-packaged-release-");
  try {
    const agentRoot = path.join(root, "immutable", "apps", "rabi-agent");
    writeAgent(agentRoot);
    fs.mkdirSync(path.join(agentRoot, "runtime"));
    fs.writeFileSync(path.join(agentRoot, "runtime", "management.mjs"), "export const bundled = true;");
    const privateRoot = path.join(root, "private");
    const store = new LanAgentReleaseStore({ rootDir: privateRoot, agentRoot });
    const manifest = store.manifest();
    assert.ok(manifest.files.some(file => file.path === "runtime/management.mjs"));
    assert.equal(fs.existsSync(path.join(privateRoot, "data", "lan-agent-release-signing-key.json")), true);
    assert.equal(fs.existsSync(path.join(agentRoot, "data")), false);
    assert.equal(verifyLanAgentReleaseManifest(manifest, manifest.publicKeySha256), true);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("node release selection preserves the common signed bytes, freezes candidates and survives restart", () => {
  const root = temporaryDirectory("rabi-selected-release-");
  try {
    const agentRoot = path.join(root, "common"), candidate = path.join(root, "candidate");
    writeAgent(agentRoot); writeAgent(candidate);
    fs.writeFileSync(path.join(candidate, "lib", "worker.mjs"), "export const isolatedFix = true;\n");
    const store = new LanAgentReleaseStore({ rootDir: root, agentRoot });
    const original = store.publication(), common = store.manifest();
    const selected = store.importRelease(candidate);
    assert.equal(selected.version, original.version); assert.notEqual(selected.releaseDigest, original.releaseDigest);
    assert.deepEqual(store.manifest(), common); assert.deepEqual(store.publication("node-other"), original);
    assert.deepEqual(store.assignRelease("node-selected", selected.releaseDigest, original.releaseDigest), selected);
    const manifest = store.manifest("node-selected");
    assert.equal(verifyLanAgentReleaseManifest(manifest, common.publicKeySha256), true);
    assert.deepEqual(store.publication("node-selected"), selected);
    assert.deepEqual(store.manifest("node-other"), common);
    // Incoming candidate files are no longer authoritative after import.
    fs.writeFileSync(path.join(candidate, "lib", "worker.mjs"), "changed after import");
    assert.equal(store.readAsset(selected.version, "node", "lib/worker.mjs", "node-selected").toString(), "export const isolatedFix = true;\n");
    const restored = new LanAgentReleaseStore({ rootDir: root, agentRoot });
    assert.deepEqual(restored.publication("node-selected"), selected);
    const entry = manifest.files.find(file => file.path === "lib/worker.mjs"); assert.ok(entry);
    const snapshot = new URL(entry.downloadUrl, "http://localhost").searchParams.get("release"); assert.ok(snapshot);
    assert.deepEqual(restored.assignRelease("node-selected", null, selected.releaseDigest), original);
    // An already downloaded signed manifest keeps identifying its original bytes.
    assert.equal(restored.readAsset(selected.version, "node", entry.path, "node-selected", snapshot).toString(), "export const isolatedFix = true;\n");
    assert.deepEqual(restored.manifest("node-selected"), common);
    assert.throws(() => restored.assignRelease("node-selected", selected.releaseDigest, selected.releaseDigest), LanAgentReleaseSelectionConflictError);
    assert.deepEqual(restored.publication("node-selected"), original);
    assert.throws(() => restored.assignRelease("node-selected", "f".repeat(64), original.releaseDigest));
    assert.deepEqual(restored.publication("node-selected"), original);
    assert.throws(() => restored.readAsset(selected.version, "node", "../secret", undefined, snapshot));
    assert.throws(() => restored.readAsset(selected.version, "node", entry.path, undefined, "../../outside"));
    assert.deepEqual(restored.manifest("constructor"), common);
    assert.deepEqual(restored.importRelease(path.join(root, "common")), restored.importRelease(path.join(root, "common")));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("failed release registration or signing leaves node selections and common publication intact", () => {
  const root = temporaryDirectory("rabi-selected-release-failure-");
  try {
    const agentRoot = path.join(root, "common"), candidate = path.join(root, "candidate"); writeAgent(agentRoot); writeAgent(candidate);
    const store = new LanAgentReleaseStore({ rootDir: root, agentRoot });
    const original = store.publication(); const selected = store.importRelease(candidate);
    store.assignRelease("node-selected", selected.releaseDigest, original.releaseDigest);
    const pointer = fs.readFileSync(path.join(root, "data/lan-agent-releases/selections.json"));
    const bad = new LanAgentReleaseStore({ rootDir: root, agentRoot, signingKeyPath: path.join(root, "invalid-key.json") });
    fs.writeFileSync(path.join(root, "invalid-key.json"), JSON.stringify({ publicKey: "invalid", privateKey: "invalid" }));
    assert.throws(() => bad.importRelease(candidate));
    assert.deepEqual(fs.readFileSync(path.join(root, "data/lan-agent-releases/selections.json")), pointer);
    const entry = store.manifest("node-selected").files[0]!;
    const snapshot = new URL(entry.downloadUrl, "http://localhost").searchParams.get("release")!;
    fs.writeFileSync(path.join(root, "data/lan-agent-releases/snapshots", snapshot, "assets", entry.path), "corrupt");
    assert.throws(() => store.readAsset(selected.version, "node", entry.path, "node-selected"), /integrity/);
    assert.throws(() => store.assignRelease("node-other", selected.releaseDigest, original.releaseDigest), /integrity/);
    assert.throws(() => store.importRelease(candidate), /integrity/);
    assert.deepEqual(fs.readFileSync(path.join(root, "data/lan-agent-releases/selections.json")), pointer);
    assert.deepEqual(store.publication("node-other"), original);
    assert.equal(fs.readdirSync(path.join(root, "data/lan-agent-releases")).some(name => name.startsWith(".prepare-")), false);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
