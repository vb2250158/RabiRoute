import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { LanAgentReleaseStore, LanAgentReleaseSelectionConflictError, lanAgentReleaseManifestDigest, verifyLanAgentReleaseManifest } from "./lanAgentReleaseStore.js";

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

test("an explicit common publication preserves original signed URLs and survives a different Manager package", () => {
  const root = temporaryDirectory("rabi-common-publication-");
  try {
    const oldRoot = path.join(root, "old-package"), nextRoot = path.join(root, "next-package");
    writeAgent(oldRoot); writeAgent(nextRoot);
    fs.writeFileSync(path.join(nextRoot, "lib/worker.mjs"), "export const nextRelease = true;\n");
    const oldStore = new LanAgentReleaseStore({ rootDir: root, agentRoot: oldRoot });
    oldStore.publication(); // Create the fixture signing identity before capturing its published manifest.
    const original = oldStore.manifest(), digest = lanAgentReleaseManifestDigest(original);
    const nextStore = new LanAgentReleaseStore({ rootDir: root, agentRoot: nextRoot });
    const next = nextStore.manifest();
    assert.notEqual(lanAgentReleaseManifestDigest(next), digest);
    assert.deepEqual(oldStore.publishCommonRelease(digest), { version: original.version, releaseDigest: digest });
    const record = JSON.parse(fs.readFileSync(path.join(root, "data/lan-agent-releases/common.json"), "utf8"));
    assert.equal(record.agentRoot, fs.realpathSync(oldRoot));
    assert.deepEqual(record.manifest, original);
    assert.deepEqual(nextStore.manifest(), original);
    assert.deepEqual(nextStore.manifest("unassigned-node"), original);
    for (const file of original.files) {
      assert.equal(new URL(file.downloadUrl, "http://localhost").search, "");
      assert.deepEqual(nextStore.readAsset(original.version, "node", file.path), fs.readFileSync(path.join(oldRoot, file.path)));
    }
    const selected = nextStore.importRelease(nextRoot);
    assert.notEqual(selected.releaseDigest, digest);
    nextStore.assignRelease("selected-node", selected.releaseDigest, digest);
    assert.equal(nextStore.publication("selected-node").releaseDigest, selected.releaseDigest);
    assert.equal(nextStore.readAsset(original.version, "node", "lib/worker.mjs", "selected-node").toString(), "export const nextRelease = true;\n");
    assert.deepEqual(nextStore.manifest(), original);
    const advanced = nextStore.publishCommonRelease(digest);
    assert.equal(advanced.releaseDigest, lanAgentReleaseManifestDigest(next));
    assert.deepEqual(new LanAgentReleaseStore({ rootDir: root, agentRoot: oldRoot }).manifest(), next);
    assert.equal(nextStore.publication("selected-node").releaseDigest, selected.releaseDigest);
    assert.equal(nextStore.readAsset(next.version, "node", "lib/worker.mjs").toString(), "export const nextRelease = true;\n");
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("common publication CAS and candidate failures never replace the selected original", () => {
  const root = temporaryDirectory("rabi-common-publication-cas-");
  try {
    const oldRoot = path.join(root, "old-package"), nextRoot = path.join(root, "next-package"); writeAgent(oldRoot); writeAgent(nextRoot);
    const store = new LanAgentReleaseStore({ rootDir: root, agentRoot: oldRoot });
    const digest = store.publication().releaseDigest; store.publishCommonRelease(digest);
    const file = path.join(root, "data/lan-agent-releases/common.json"), before = fs.readFileSync(file);
    const nextStore = new LanAgentReleaseStore({ rootDir: root, agentRoot: nextRoot });
    assert.throws(() => nextStore.publishCommonRelease("f".repeat(64)), LanAgentReleaseSelectionConflictError);
    assert.deepEqual(fs.readFileSync(file), before);
    fs.unlinkSync(path.join(nextRoot, "rabi-agent.mjs"));
    assert.throws(() => nextStore.publishCommonRelease(digest), /missing/);
    assert.deepEqual(fs.readFileSync(file), before);
    assert.equal(store.publication().releaseDigest, digest);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("damaged common metadata fails closed without affecting a valid node archive", () => {
  const root = temporaryDirectory("rabi-common-publication-corrupt-");
  try {
    const agentRoot = path.join(root, "package"); writeAgent(agentRoot);
    const store = new LanAgentReleaseStore({ rootDir: root, agentRoot });
    const digest = store.publication().releaseDigest, selected = store.importRelease(agentRoot);
    store.assignRelease("selected-node", selected.releaseDigest, digest); store.publishCommonRelease(digest);
    const file = path.join(root, "data/lan-agent-releases/common.json"), original = fs.readFileSync(file, "utf8"), record = JSON.parse(original);
    for (const bad of ["{truncated", "null", JSON.stringify({ ...record, schemaVersion: 2 }),
      JSON.stringify({ ...record, releaseDigest: "f".repeat(64) }), JSON.stringify({ ...record, agentRoot: "relative/package" }),
      JSON.stringify({ ...record, manifest: { ...record.manifest, signature: "invalid" } })]) {
      fs.writeFileSync(file, bad);
      assert.throws(() => store.manifest()); assert.throws(() => store.publishCommonRelease(digest));
      assert.throws(() => store.readAsset("0.9.1", "node", "rabi-agent.mjs"));
      assert.equal(fs.readFileSync(file, "utf8"), bad);
      assert.equal(store.publication("selected-node").releaseDigest, selected.releaseDigest);
      assert.ok(store.readAsset("0.9.1", "node", "rabi-agent.mjs", "selected-node").length);
    }
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("missing or modified common assets cannot silently advance to a new package", () => {
  const root = temporaryDirectory("rabi-common-publication-assets-");
  try {
    const oldRoot = path.join(root, "old-package"), nextRoot = path.join(root, "next-package"); writeAgent(oldRoot); writeAgent(nextRoot);
    const store = new LanAgentReleaseStore({ rootDir: root, agentRoot: oldRoot });
    const digest = store.publication().releaseDigest; store.publishCommonRelease(digest);
    const file = path.join(root, "data/lan-agent-releases/common.json"), before = fs.readFileSync(file);
    const nextStore = new LanAgentReleaseStore({ rootDir: root, agentRoot: nextRoot });
    fs.writeFileSync(path.join(oldRoot, "lib/worker.mjs"), "changed after publication");
    assert.throws(() => nextStore.readAsset("0.9.1", "node", "lib/worker.mjs"), /integrity/);
    assert.throws(() => nextStore.publishCommonRelease(digest), /integrity/);
    assert.deepEqual(fs.readFileSync(file), before);
    fs.unlinkSync(path.join(oldRoot, "lib/worker.mjs"));
    assert.throws(() => nextStore.publishCommonRelease(digest));
    assert.deepEqual(fs.readFileSync(file), before);
    assert.equal(nextStore.publication().releaseDigest, digest);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("an atomic common selection failure preserves the prior complete record", t => {
  const root = temporaryDirectory("rabi-common-publication-atomic-");
  try {
    const oldRoot = path.join(root, "old-package"), nextRoot = path.join(root, "next-package"); writeAgent(oldRoot); writeAgent(nextRoot);
    fs.writeFileSync(path.join(nextRoot, "lib/worker.mjs"), "next-package");
    const store = new LanAgentReleaseStore({ rootDir: root, agentRoot: oldRoot });
    const digest = store.publication().releaseDigest; store.publishCommonRelease(digest);
    const file = path.join(root, "data/lan-agent-releases/common.json"), before = fs.readFileSync(file);
    const rename = fs.renameSync;
    const mocked = t.mock.method(fs, "renameSync", (source: fs.PathLike, destination: fs.PathLike) => {
      if (String(destination) === file) throw Object.assign(new Error("Injected common publication failure"), { code: "EIO" });
      return rename(source, destination);
    });
    try { assert.throws(() => new LanAgentReleaseStore({ rootDir: root, agentRoot: nextRoot }).publishCommonRelease(digest), /Injected/); }
    finally { mocked.mock.restore(); }
    assert.deepEqual(fs.readFileSync(file), before);
    assert.equal(store.publication().releaseDigest, digest);
    assert.deepEqual(fs.readdirSync(path.dirname(file)).filter(name => name.endsWith(".tmp")), []);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("a frozen common selection never creates another signing identity after key loss", () => {
  const root = temporaryDirectory("rabi-common-publication-key-");
  try {
    const agentRoot = path.join(root, "package"); writeAgent(agentRoot);
    const signingKeyPath = path.join(root, "data/key.json");
    const store = new LanAgentReleaseStore({ rootDir: root, agentRoot, signingKeyPath });
    const digest = store.publication().releaseDigest; store.publishCommonRelease(digest); fs.unlinkSync(signingKeyPath);
    assert.throws(() => store.manifest()); assert.throws(() => store.publishCommonRelease(digest));
    assert.equal(fs.existsSync(signingKeyPath), false);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

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
