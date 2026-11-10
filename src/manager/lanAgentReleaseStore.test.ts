import assert from "node:assert/strict";
import { createHash, sign, generateKeyPairSync } from "node:crypto";
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

test("signed Agent releases include the three branded native hosts but exclude build caches", () => {
  const root = temporaryDirectory("rabi-native-release-");
  try {
    const agentRoot = path.join(root, "agent"); writeAgent(agentRoot);
    const native = path.join(agentRoot, "dist/native"); fs.mkdirSync(native, { recursive: true });
    const names = ["RabiAgent.Terminal.exe", "RabiAgent.Computer.exe", "RabiAgent.Tray.exe"];
    for (const name of [...names, "unpublished.exe", `tray-${"a".repeat(64)}.exe`]) fs.writeFileSync(path.join(native, name), `fixture:${name}`);
    fs.writeFileSync(path.join(agentRoot, "package-lock.json"), '{"lockfileVersion":3}');
    fs.writeFileSync(path.join(agentRoot, "desktop/start-windows.ps1"), "# Windows source entry");
    fs.mkdirSync(path.join(agentRoot, "windows-runtime"));
    fs.writeFileSync(path.join(agentRoot, "windows-runtime/architecture-specific.mjs"), "must not enter the generic release");
    fs.mkdirSync(path.join(agentRoot, "runtime/backend/src"), { recursive: true });
    fs.writeFileSync(path.join(agentRoot, "runtime/backend/src/worker.js"), "export const generated = true;");
    fs.writeFileSync(path.join(agentRoot, "runtime/agent-profile.json"), '{"instances":[]}');
    const store = new LanAgentReleaseStore({ rootDir: root, agentRoot });
    const manifest = store.manifest();
    assert.deepEqual(manifest.files.filter(file => file.path.endsWith(".exe")).map(file => file.path).sort(), names.map(name => `dist/native/${name}`).sort());
    assert.equal(verifyLanAgentReleaseManifest(manifest, manifest.publicKeySha256), true);
    assert.equal(manifest.files.some(file => file.path.startsWith("windows-runtime/")), false);
    assert.equal(manifest.files.some(file => file.path === "desktop/start-windows.ps1"), true);
    assert.equal(manifest.files.some(file => file.path === "package-lock.json"), true);
    assert.equal(manifest.files.some(file => file.path === "runtime/backend/src/worker.js"), true);
    assert.equal(manifest.files.some(file => file.path === "runtime/agent-profile.json"), true);
    for (const name of names) assert.equal(store.readAsset(manifest.version, "node", `dist/native/${name}`).toString(), `fixture:${name}`);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

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


test("new source releases sign the same projected owner bytes for live, common and immutable assets", () => {
  const root = temporaryDirectory("rabi-plugin-owner-release-");
  try {
    const sourceRoot = path.join(root, "source"), agentRoot = path.join(sourceRoot, "apps/rabi-agent"); writeAgent(agentRoot);
    const source = path.join(sourceRoot, "src/plugins/io.rabiroute.agent.dsh/apps/rabi-agent/lib/dsh.mjs");
    fs.mkdirSync(path.dirname(source), { recursive: true });
    const ownerBytes = Buffer.from("export function normalizeDshBinding(value) { return value; }\n"); fs.writeFileSync(source, ownerBytes);
    const original = 'import { normalizeDshBinding } from "../../../src/plugins/io.rabiroute.agent.dsh/apps/rabi-agent/lib/dsh.mjs";\nexport { normalizeDshBinding };\n';
    fs.writeFileSync(path.join(agentRoot, "lib/instance-agents.mjs"), original);
    const store = new LanAgentReleaseStore({ rootDir: root, agentRoot, pluginSourceRoot: sourceRoot }), manifest = store.manifest();
    const artifact = "lib/plugin-owners/io.rabiroute.agent.dsh/dsh.mjs";
    assert.equal(manifest.files.filter(file => file.path === artifact).length, 1);
    assert.equal(verifyLanAgentReleaseManifest(manifest, manifest.publicKeySha256), true);
    assert.equal(JSON.stringify(manifest).includes(sourceRoot), false);
    for (const file of manifest.files) {
      const bytes = store.readAsset(manifest.version, "node", file.path);
      assert.equal(createHash("sha256").update(bytes).digest("hex"), file.sha256);
      assert.equal(bytes.length, file.size);
    }
    const digest = lanAgentReleaseManifestDigest(manifest); store.publishCommonRelease(digest);
    assert.deepEqual(store.readAsset(manifest.version, "node", artifact), ownerBytes);
    const projected = store.readAsset(manifest.version, "node", "lib/instance-agents.mjs");
    assert.match(projected.toString(), /\.\/plugin-owners\/io\.rabiroute\.agent\.dsh\/dsh\.mjs/);
    const archived = store.importRelease(agentRoot, { pluginSourceRoot: sourceRoot }); store.assignRelease("fixture-owner-node", archived.releaseDigest, digest);
    fs.renameSync(sourceRoot, path.join(root, "source-retired"));
    assert.deepEqual(store.readAsset(manifest.version, "node", artifact, "fixture-owner-node"), ownerBytes);
    assert.deepEqual(store.readAsset(manifest.version, "node", "lib/instance-agents.mjs", "fixture-owner-node"), projected);
    assert.equal(fs.readFileSync(path.join(root, "source-retired/apps/rabi-agent/lib/instance-agents.mjs"), "utf8"), original);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("an already signed common release keeps original bytes before explicit source publication", () => {
  const root = temporaryDirectory("rabi-legacy-common-owner-");
  try {
    const sourceRoot = path.join(root, "source"), agentRoot = path.join(sourceRoot, "apps/rabi-agent"); writeAgent(agentRoot);
    const relative = "lib/instance-agents.mjs"; fs.writeFileSync(path.join(agentRoot, relative), "export const original = true;\n");
    const store = new LanAgentReleaseStore({ rootDir: root, agentRoot, pluginSourceRoot: sourceRoot }), manifest = store.manifest();
    const source = path.join(sourceRoot, "src/plugins/io.rabiroute.agent.dsh/apps/rabi-agent/lib/dsh.mjs");
    fs.mkdirSync(path.dirname(source), { recursive: true }); fs.writeFileSync(source, "export function normalizeDshBinding(value) { return value; }\n");
    const oldBytes = Buffer.from('import { normalizeDshBinding } from "../../../src/plugins/io.rabiroute.agent.dsh/apps/rabi-agent/lib/dsh.mjs";\n');
    // This archived format predates owner projection; its signed bytes are the contract.
    fs.writeFileSync(path.join(agentRoot, relative), oldBytes);
    const entry = manifest.files.find(file => file.path === relative)!;
    entry.sha256 = createHash("sha256").update(oldBytes).digest("hex"); entry.size = oldBytes.length;
    const keys = JSON.parse(fs.readFileSync(path.join(root, "data/lan-agent-release-signing-key.json"), "utf8"));
    manifest.signature = sign(null, Buffer.from(JSON.stringify({ version: manifest.version, platform: manifest.platform, minNodeVersion: manifest.minNodeVersion, files: manifest.files })), keys.privateKey).toString("base64");
    assert.equal(verifyLanAgentReleaseManifest(manifest, manifest.publicKeySha256), true);
    const digest = lanAgentReleaseManifestDigest(manifest), common = path.join(root, "data/lan-agent-releases/common.json");
    fs.mkdirSync(path.dirname(common), { recursive: true });
    fs.writeFileSync(common, JSON.stringify({ schemaVersion: 1, releaseDigest: digest, agentRoot: fs.realpathSync(agentRoot), manifest }));
    const before = fs.readFileSync(common);
    assert.deepEqual(store.manifest(), manifest);
    assert.deepEqual(store.readAsset(manifest.version, "node", relative), oldBytes);
    assert.deepEqual(fs.readFileSync(common), before);
    // The integrity check for an explicit update must also read original bytes.
    assert.doesNotThrow(() => store.publishCommonRelease(digest));
    assert.equal(store.manifest().files.some(file => file.path === "lib/plugin-owners/io.rabiroute.agent.dsh/dsh.mjs"), true);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});


test("importing a materialized legacy package signs its original bytes without source projection", () => {
  const root = temporaryDirectory("rabi-legacy-materialized-import-");
  try {
    const agentRoot = path.join(root, "materialized"); writeAgent(agentRoot);
    const relative = "lib/instance-agents.mjs", bytes = Buffer.from('import { normalizeDshBinding } from "../../../src/plugins/io.rabiroute.agent.dsh/apps/rabi-agent/lib/dsh.mjs";\n');
    fs.writeFileSync(path.join(agentRoot, relative), bytes);
    const store = new LanAgentReleaseStore({ rootDir: root, agentRoot }), manifest = store.manifest();
    assert.equal(manifest.files.some(file => file.path.includes("plugin-owners")), false);
    assert.deepEqual(store.readAsset(manifest.version, "node", relative), bytes);
    const digest = lanAgentReleaseManifestDigest(manifest), archive = store.importRelease(agentRoot);
    store.assignRelease("legacy-materialized-node", archive.releaseDigest, digest);
    fs.renameSync(agentRoot, path.join(root, "materialized-retired"));
    assert.deepEqual(store.readAsset(manifest.version, "node", relative, "legacy-materialized-node"), bytes);
    assert.equal(store.manifest("legacy-materialized-node").files.some(file => file.path.includes("plugin-owners")), false);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("immutable Host release metadata reuses the signed package snapshot without rereading assets, while source mode detects changed bytes", t => {
 const root=temporaryDirectory("rabi-immutable-release-");t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const agentRoot=path.join(root,"agent");writeAgent(agentRoot);const immutable=new LanAgentReleaseStore({rootDir:root,agentRoot,immutablePackage:true});const first=immutable.manifest();
 const read=fs.readFileSync;let assetReads=0;t.mock.method(fs,"readFileSync",((...args:Parameters<typeof fs.readFileSync>)=>{if(String(args[0]).startsWith(agentRoot+path.sep))assetReads++;return (read as (...args:Parameters<typeof fs.readFileSync>)=>ReturnType<typeof fs.readFileSync>)(...args);}) as typeof fs.readFileSync);
 for(let i=0;i<50;i++)assert.equal(immutable.manifest(),first);assert.equal(assetReads,0);
 assert.equal(Object.isFrozen(first.files),true);assert.equal(Object.isFrozen(first.files[0]),true);
 fs.writeFileSync(path.join(agentRoot,"lib/worker.mjs"),"export const changed = true;\n");
 assert.equal(immutable.manifest(),first,"illegal in-place edits do not silently become another signed package");
 assert.throws(()=>immutable.readAsset(first.version,"node","lib/worker.mjs"),/integrity mismatch/);
 const source=new LanAgentReleaseStore({rootDir:root,agentRoot});const changed=source.manifest();assert.notEqual(lanAgentReleaseManifestDigest(changed),lanAgentReleaseManifestDigest(first));
});

test("a signer change during immutable manifest creation cannot label an old signature with a new key stamp",t=>{
 const root=temporaryDirectory("rabi-release-signer-race-");t.after(()=>fs.rmSync(root,{recursive:true,force:true}));const agentRoot=path.join(root,"agent");writeAgent(agentRoot);
 const signingKeyPath=path.join(root,"signer.json");const initial=new LanAgentReleaseStore({rootDir:root,agentRoot,signingKeyPath}).manifest();
 const pair=generateKeyPairSync("ed25519");const nextKeys={publicKey:pair.publicKey.export({type:"spki",format:"pem"}).toString(),privateKey:pair.privateKey.export({type:"pkcs8",format:"pem"}).toString()};
 const stat=fs.statSync;let reads=0;t.mock.method(fs,"statSync",((file:fs.PathLike,...args:unknown[])=>{
  if(String(file)===signingKeyPath && ++reads===2)fs.writeFileSync(signingKeyPath,JSON.stringify(nextKeys));
  return (stat as (...args:unknown[])=>unknown)(file,...args);
 }) as typeof fs.statSync);
 const owner=new LanAgentReleaseStore({rootDir:root,agentRoot,signingKeyPath,immutablePackage:true});const raced=owner.manifest();assert.equal(raced.publicKeySha256,initial.publicKeySha256);
 const fresh=owner.manifest();assert.equal(fresh.publicKey,nextKeys.publicKey.trim());assert.notEqual(fresh,raced);assert.equal(verifyLanAgentReleaseManifest(fresh,fresh.publicKeySha256),true);
 assert.equal(owner.manifest(),fresh);
});
