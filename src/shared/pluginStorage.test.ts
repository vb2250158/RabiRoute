import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { applyPluginStorageMigrations, pluginStorageMigrationFailure, pluginStorageResourceRoot, pluginStorageRoot,
  prepareApplicationPluginStorage, type PluginStorageMigrationDeclaration } from "./pluginStorage.js";
import { loadPluginProfile, PluginPackageCatalog } from "../plugin-kernel/profile.js";
import type { LoadedPluginPackage } from "../plugin-kernel/packageLoader.js";

function fixture(t: test.TestContext) {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "plugin-storage-layout-"));
  t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
  const layout = { stateRoot: path.join(temporary, "state"), packageRoot: path.join(temporary, "application") };
  fs.mkdirSync(layout.stateRoot, { recursive: true });
  return { temporary, layout };
}
function write(filename: string, text: string | Buffer) { fs.mkdirSync(path.dirname(filename), { recursive: true }); fs.writeFileSync(filename, text); }
function declaration(pluginId: string): PluginStorageMigrationDeclaration {
  return JSON.parse(fs.readFileSync(path.join(process.cwd(), "src/plugins", pluginId, "storage-migrations.json"), "utf8"));
}

test("plugin storage topology uses stable owner identities and path lookup performs no writes", t => {
  const { layout } = fixture(t), id = "io.fixture.owner";
  assert.equal(pluginStorageRoot(id, undefined, layout), path.join(layout.stateRoot, "data/plugins", id));
  assert.equal(pluginStorageRoot(id, "manager:first", layout), path.join(layout.stateRoot, "data/plugins", id, "instances", "manager%3Afirst"));
  assert.notEqual(pluginStorageRoot(id, "manager:first", layout), pluginStorageRoot(id, "manager:First", layout));
  assert.equal(pluginStorageResourceRoot(id, "runtime", "runtime", layout), path.join(pluginStorageRoot(id, undefined, layout), "runtime"));
  assert.deepEqual(fs.readdirSync(layout.stateRoot), []);
  const first = path.join(pluginStorageRoot(id, "manager:first", layout), "state.json"), second = path.join(pluginStorageRoot(id, "manager:First", layout), "state.json");
  write(first, "original-lowercase-instance"); write(second, "original-uppercase-instance");
  assert.equal(fs.readFileSync(first, "utf8"), "original-lowercase-instance");
  assert.equal(fs.readFileSync(second, "utf8"), "original-uppercase-instance");
  const windowsIdentities = ["con", "con.txt", "aux", "name", "name.", ".", "..", "CON", "con.", "aux.txt", "NUL", "nul", "com1", "lpt1"];
  const paths = windowsIdentities.map(identity => path.join(pluginStorageRoot(id, identity, layout), "state.json"));
  assert.equal(new Set(paths.map(filename => filename.toLowerCase())).size, windowsIdentities.length);
  windowsIdentities.forEach((identity, index) => write(paths[index]!, identity));
  windowsIdentities.forEach((identity, index) => assert.equal(fs.readFileSync(paths[index]!, "utf8"), identity));
  for (const filename of paths) assert.ok(path.relative(pluginStorageRoot(id, undefined, layout), filename).startsWith(`instances${path.sep}`));
});

test("DSH credentials and protection keys migrate byte-for-byte with private recovery bytes and no later legacy lookup", t => {
  const { layout } = fixture(t), pluginId = "io.rabiroute.agent.dsh";
  const source = path.join(layout.stateRoot, "data/dsh-connections"), raw = '{"schemaVersion":1,"revision":7,"connections":[null]}\r\n';
  const key = Buffer.from([0, 1, 2, 254, 255]);
  write(path.join(source, "connections.json"), raw); write(path.join(source, ".credentials.key"), key);
  const input = { phase: "owners-retired" as const, pluginId, declaration: declaration(pluginId), layout, environment: {} };
  const result = applyPluginStorageMigrations(input), moved = result.find(row => row.migrationId === "connections-layout-0.7")!;
  assert.equal(moved.status, "migrated");
  const target = path.join(pluginStorageRoot(pluginId, undefined, layout), "credentials");
  assert.equal(fs.readFileSync(path.join(target, "connections.json"), "utf8"), raw);
  assert.deepEqual(fs.readFileSync(path.join(target, ".credentials.key")), key);
  assert.equal(fs.readFileSync(path.join(moved.backupPath!, "raw/connections.json"), "utf8"), raw);
  assert.equal(fs.existsSync(source), false);
  const originalStat = fs.lstatSync;
  const probe = t.mock.method(fs, "lstatSync", (...args: Parameters<typeof fs.lstatSync>) => {
    assert.notEqual(String(args[0]), source, "Completed migration must not discover old storage again.");
    return Reflect.apply(originalStat, fs, args);
  });
  assert.ok(applyPluginStorageMigrations(input).every(row => row.status === "unchanged"));
  probe.mock.restore();
});

test("Bilibili bridge identity and WorkBuddy authentication move into the declared owners while custom auth paths stay intact", t => {
  const { layout } = fixture(t), bili = "io.rabiroute.manager.bilibili-history", workbuddy = "io.rabiroute.agent.workbuddy";
  const raw = '{"version":1,"bridge":{"token":"fixture-original"},"jobs":[{"id":"original-job"}]}\n';
  write(path.join(layout.stateRoot, "data/runtime/bilibili-history-bridge.json"), raw);
  const result = applyPluginStorageMigrations({ phase: "owners-retired", pluginId: bili, instanceId: "manager:bilibili-history", declaration: declaration(bili), layout });
  assert.equal(result[0]?.status, "migrated");
  assert.equal(fs.readFileSync(path.join(pluginStorageRoot(bili, "manager:bilibili-history", layout), "bridge.json"), "utf8"), raw);
  const auth = path.join(layout.stateRoot, "data/workbuddy-auth.json"); write(auth, '{"password":"fixture-original"}');
  assert.equal(applyPluginStorageMigrations({ phase: "owners-retired", pluginId: workbuddy, declaration: declaration(workbuddy), layout,
    environment: { RABI_WORKBUDDY_AUTH_FILE: path.join(layout.stateRoot, "explicit-private-auth.json") } })[0]?.status, "custom_path");
  assert.equal(fs.existsSync(auth), true);
  assert.equal(applyPluginStorageMigrations({ phase: "owners-retired", pluginId: workbuddy, declaration: declaration(workbuddy), layout, environment: {} })[0]?.status, "migrated");
  assert.equal(fs.readFileSync(path.join(pluginStorageRoot(workbuddy, undefined, layout), "auth.json"), "utf8"), '{"password":"fixture-original"}');
});

test("existing Xiaomi VM, media, keys and ledgers stay at the actual resource while the namespace adopts one editable binding", t => {
  const { layout, temporary } = fixture(t), localAppDataRoot = path.join(temporary, "local"), id = "io.rabiroute.manager.xiaomi-home";
  const source = path.join(localAppDataRoot, "RabiRoute/XiaomiHome"), video = path.join(source, "artifacts/media/fixture.mp4");
  const ledger = JSON.stringify({ artifactId: "original-artifact", sourceEventId: "original-event", localPath: video }) + "\n";
  write(path.join(source, "artifacts/ledger/2026-11-05.jsonl"), ledger);
  write(path.join(source, "home-assistant-os/home-assistant.vhdx"), "fixture-live-vm");
  write(path.join(source, ".xiaomi-home-credentials.key"), "fixture-private-key"); write(video, "fixture-media");
  const result = applyPluginStorageMigrations({ phase: "owners-retired", pluginId: id, declaration: declaration(id), layout, localAppDataRoot, config: {} });
  assert.equal(result[0]?.status, "migrated");
  assert.equal(pluginStorageResourceRoot(id, "runtime", "runtime", layout), source);
  assert.equal(fs.readFileSync(path.join(source, "artifacts/ledger/2026-11-05.jsonl"), "utf8"), ledger);
  assert.equal(fs.readFileSync(video, "utf8"), "fixture-media");
  assert.equal(fs.readFileSync(path.join(source, "home-assistant-os/home-assistant.vhdx"), "utf8"), "fixture-live-vm");
  assert.equal(fs.existsSync(path.join(pluginStorageRoot(id, undefined, layout), "runtime")), false);
  const binding = path.join(pluginStorageRoot(id, undefined, layout), "resources.json"), selected = path.join(temporary, "user-selected-resource");
  write(binding, JSON.stringify({ schemaVersion: 1, resources: { runtime: selected } }));
  assert.equal(pluginStorageResourceRoot(id, "runtime", "runtime", layout), selected);
});

test("startup storage conflicts block their real package without discarding either raw file or an independent healthy package", async t => {
  const { layout, temporary } = fixture(t), packages = path.join(temporary, "packages"), profilePath = path.join(temporary, "profile.json");
  const broken = "io.fixture.broken", healthy = "io.fixture.healthy";
  for (const id of [broken, healthy]) fs.mkdirSync(path.join(packages, id, "0.1.1"), { recursive: true });
  const migration: PluginStorageMigrationDeclaration = { schemaVersion: 1, scope: "plugin", migrations: [{ id: "move-auth", kind: "file", source: { root: "state", path: "data/old-auth.json" }, target: "auth.json" }] };
  write(path.join(packages, broken, "0.1.1/storage-migrations.json"), JSON.stringify(migration));
  write(path.join(layout.stateRoot, "data/old-auth.json"), "original-raw");
  const target = path.join(pluginStorageRoot(broken, undefined, layout), "auth.json"); write(target, "existing-owner-raw");
  write(profilePath, JSON.stringify({ schemaVersion: 2, readyRequires: [], instances: [broken, healthy].map(id => ({ id, package: id, version: "0.1.1", enabled: true, config: {}, grants: [] })) }));
  const results = await prepareApplicationPluginStorage({ phase: "owners-retired", layout, profilePath, packageRoots: [packages] });
  assert.equal(results[0]?.status, "failed");
  assert.ok(pluginStorageMigrationFailure(broken, layout.stateRoot)); assert.equal(pluginStorageMigrationFailure(healthy, layout.stateRoot), undefined);
  const otherProfile = path.join(temporary, "other-profile.json");
  write(otherProfile, JSON.stringify({ schemaVersion: 2, readyRequires: [], instances: [{ id: healthy, package: healthy, version: "0.1.1", enabled: true, config: {}, grants: [] }] }));
  await prepareApplicationPluginStorage({ phase: "owners-retired", layout, profilePath: otherProfile, packageRoots: [packages] });
  assert.ok(pluginStorageMigrationFailure(broken, layout.stateRoot), "A different subgraph at the same root must not clear this owner's failure.");
  const catalog = new PluginPackageCatalog([packages]); t.after(() => catalog.dispose());
  t.mock.method(catalog, "loadPackage", async (id: string): Promise<LoadedPluginPackage> => ({ sourceRoot: packages, runtimeRoot: packages,
    revision: "fixture-original", execution: "in_process", entryPath: path.join(packages, "fixture.mjs"), manifest: { schemaVersion: 2,
      id, version: "0.1.1", entries: { manager: { execution: "in_process", module: "./fixture.mjs" } }, provides: [], requires: [], optional: [], permissions: [] } }));
  const input = { profilePath, packageCatalog: catalog, runtimeRoot: path.join(temporary, "runtime"), host: "manager" as const };
  const previous = await loadPluginProfile(input);
  const loaded = await loadPluginProfile({ ...input, previous,
    preparationFailure: (packageId, instanceId) => pluginStorageMigrationFailure(packageId, layout.stateRoot, instanceId) });
  assert.deepEqual(loaded.candidates.map(row => row.instanceId), [healthy]);
  assert.match(loaded.loadFailures[0]?.error.message ?? "", /Both legacy and plugin-owned/);
  assert.equal(loaded.loadFailures[0]?.retainedRevision, undefined, "A storage failure cannot retain the previously loaded bad owner.");
  assert.equal(fs.readFileSync(path.join(layout.stateRoot, "data/old-auth.json"), "utf8"), "original-raw");
  assert.equal(fs.readFileSync(target, "utf8"), "existing-owner-raw");
});

test("one conflicting instance migration preserves a healthy candidate from the same package and its private failure across subgraphs", async t => {
  const { layout, temporary } = fixture(t), pluginId = "io.rabiroute.manager.bilibili-history", packages = path.join(temporary, "packages");
  const packageRoot = path.join(packages, pluginId, "0.1.1"), declared = declaration(pluginId);
  write(path.join(packageRoot, "storage-migrations.json"), JSON.stringify(declared));
  write(path.join(packageRoot, "rabi.plugin.json"), JSON.stringify({ schemaVersion: 2, id: pluginId, version: "0.1.1",
    entries: { manager: { execution: "in_process", module: "./manager.mjs" } }, provides: [], requires: [], optional: [], permissions: [] }));
  write(path.join(packageRoot, "manager.mjs"), "export async function activate() {}\n");
  const original = '{"jobs":[{"id":"original-job"}]}', source = path.join(layout.stateRoot, "data/runtime/bilibili-history-bridge.json");
  write(source, original);
  const first = applyPluginStorageMigrations({ phase: "owners-retired", layout, pluginId, instanceId: "bili:bad", declaration: declared })[0]!;
  assert.equal(first.status, "migrated");
  const receiptPath = path.join(first.backupPath!, "receipt.json"), receipt = JSON.parse(fs.readFileSync(receiptPath, "utf8"));
  // Reproduce an interrupted final receipt followed by a conflicting write in only that original instance.
  write(receiptPath, JSON.stringify({ ...receipt, status: "prepared" }));
  write(first.target!, "conflicting-instance-private-bytes");
  const instances = ["bili:bad", "bili:healthy"].map(id => ({ id, package: pluginId, version: "0.1.1", enabled: true, config: {}, grants: [] }));
  const profilePath = path.join(temporary, "profile.json"); write(profilePath, JSON.stringify({ schemaVersion: 2, readyRequires: [], instances }));
  const results = await prepareApplicationPluginStorage({ phase: "owners-retired", layout, profilePath, packageRoots: [packages] });
  assert.deepEqual(results.map(row => [row.instanceId, row.status]), [["bili:bad", "failed"], ["bili:healthy", "unchanged"]]);
  assert.equal(pluginStorageMigrationFailure(pluginId, layout.stateRoot), undefined);
  assert.ok(pluginStorageMigrationFailure(pluginId, layout.stateRoot, "bili:bad"));
  assert.equal(pluginStorageMigrationFailure(pluginId, layout.stateRoot, "bili:healthy"), undefined);
  const otherProfile = path.join(temporary, "healthy-only.json");
  write(otherProfile, JSON.stringify({ schemaVersion: 2, readyRequires: [], instances: [instances[1]] }));
  await prepareApplicationPluginStorage({ phase: "owners-retired", layout, profilePath: otherProfile, packageRoots: [packages] });
  assert.ok(pluginStorageMigrationFailure(pluginId, layout.stateRoot, "bili:bad"), "Preparing a sibling instance does not clear this original owner's failure.");
  const catalog = new PluginPackageCatalog([packages]);
  try {
    const input = { profilePath, packageCatalog: catalog, runtimeRoot: path.join(temporary, "runtime"), host: "manager" as const };
    const previous = await loadPluginProfile(input);
    const loaded = await loadPluginProfile({ ...input, previous,
      preparationFailure: (packageId, instanceId) => pluginStorageMigrationFailure(packageId, layout.stateRoot, instanceId) });
    assert.deepEqual(loaded.candidates.map(row => row.instanceId), ["bili:healthy"]);
    assert.equal(loaded.loadFailures.length, 1);
    assert.equal(loaded.loadFailures[0]?.instanceId, "bili:bad");
    assert.equal(loaded.loadFailures[0]?.retainedRevision, undefined, "Only the bad instance retires; shared package availability cannot retain it.");
    assert.match(loaded.loadFailures[0]?.error.message ?? "", /Published storage conflicts/);
  } finally { await catalog.dispose(); }
  assert.equal(fs.readFileSync(first.target!, "utf8"), "conflicting-instance-private-bytes");
  assert.equal(fs.readFileSync(path.join(first.backupPath!, "raw"), "utf8"), original);
});

test("read-only startup reports the affected storage owner without creating a target or recovery directory", t => {
  const { layout } = fixture(t), id = "io.fixture.readonly", source = path.join(layout.stateRoot, "data/original.json");
  write(source, "original-private-bytes");
  const result = applyPluginStorageMigrations({ phase: "owners-retired", pluginId: id, layout, readOnly: true,
    declaration: { schemaVersion: 1, scope: "plugin", migrations: [{ id: "move", kind: "file", source: { root: "state", path: "data/original.json" }, target: "state.json" }] } });
  assert.equal(result[0]?.status, "failed");
  assert.equal(fs.readFileSync(source, "utf8"), "original-private-bytes");
  assert.equal(fs.existsSync(pluginStorageRoot(id, undefined, layout)), false);
  assert.equal(fs.existsSync(path.join(layout.stateRoot, "data/.runtime")), false);
});

test("failed publication retains raw and backup, cleans its candidate, and safely resumes the proven original receipt", t => {
  const { layout } = fixture(t), id = "io.fixture.publish-failure", source = path.join(layout.stateRoot, "data/original.json");
  write(source, "original-private-bytes\r\n");
  const target = path.join(pluginStorageRoot(id, undefined, layout), "state.json"), originalRename = fs.renameSync;
  const blocked = t.mock.method(fs, "renameSync", (from: fs.PathLike, to: fs.PathLike) => {
    if (String(to) === target) throw Object.assign(new Error("fixture publication denied"), { code: "EIO" });
    return originalRename(from, to);
  });
  const migration: PluginStorageMigrationDeclaration = { schemaVersion: 1, scope: "plugin", migrations: [{ id: "move", kind: "file", source: { root: "state", path: "data/original.json" }, target: "state.json" }] };
  const input = { phase: "owners-retired" as const, pluginId: id, layout, declaration: migration };
  const failed = applyPluginStorageMigrations(input)[0]!;
  blocked.mock.restore();
  assert.equal(failed.status, "failed");
  assert.equal(fs.readFileSync(source, "utf8"), "original-private-bytes\r\n");
  assert.equal(fs.readFileSync(path.join(failed.backupPath!, "raw"), "utf8"), "original-private-bytes\r\n");
  assert.deepEqual(fs.readdirSync(pluginStorageRoot(id, undefined, layout)), []);
  assert.equal(applyPluginStorageMigrations(input)[0]?.status, "migrated");
  assert.equal(pluginStorageMigrationFailure(id, layout.stateRoot), undefined);
  assert.equal(fs.readFileSync(target, "utf8"), "original-private-bytes\r\n");
  assert.equal(fs.existsSync(source), false);
  assert.equal(fs.readFileSync(path.join(failed.backupPath!, "raw"), "utf8"), "original-private-bytes\r\n");
});

test("a verified already-published migration completes its original receipt, while a conflicting source remains untouched", t => {
  const { layout } = fixture(t);
  for (const conflict of [false, true]) {
    const id = `io.fixture.published-${conflict}`, relative = `data/original-${conflict}.json`, source = path.join(layout.stateRoot, relative);
    write(source, "original-private-bytes");
    const input = { phase: "owners-retired" as const, pluginId: id, layout, declaration: { schemaVersion: 1 as const, scope: "plugin" as const,
      migrations: [{ id: "move", kind: "file" as const, source: { root: "state" as const, path: relative }, target: "state.json" }] } };
    const originalRemove = fs.rmSync;
    const remove = t.mock.method(fs, "rmSync", (filename: fs.PathLike, options?: fs.RmOptions) => {
      if (String(filename) === source) throw Object.assign(new Error("fixture owner retirement interrupted"), { code: "EIO" });
      return originalRemove(filename, options);
    });
    assert.equal(applyPluginStorageMigrations(input)[0]?.status, "failed");
    remove.mock.restore();
    if (conflict) write(source, "conflicting-private-bytes");
    const recovered = applyPluginStorageMigrations(input)[0]!;
    assert.equal(recovered.status, conflict ? "failed" : "migrated");
    assert.equal(fs.readFileSync(path.join(pluginStorageRoot(id, undefined, layout), "state.json"), "utf8"), "original-private-bytes");
    if (conflict) assert.equal(fs.readFileSync(source, "utf8"), "conflicting-private-bytes");
    else assert.equal(fs.existsSync(source), false);
  }
});

test("an explicitly supplied original generation root migrates only that owner, without scanning or choosing the current root", t => {
  const { layout, temporary } = fixture(t), legacyStateRoot = path.join(temporary, "publisher-recorded-generation"), id = "io.fixture.exact-legacy";
  write(path.join(legacyStateRoot, "data/auth.json"), "actual-old-owner");
  write(path.join(layout.stateRoot, "data/auth.json"), "unrelated-current-file");
  const result = applyPluginStorageMigrations({ phase: "owners-retired", pluginId: id, layout, legacyStateRoot,
    declaration: { schemaVersion: 1, scope: "plugin", migrations: [{ id: "move", kind: "file", source: { root: "state", path: "data/auth.json" }, target: "auth.json" }] } });
  assert.equal(result[0]?.status, "migrated");
  assert.equal(fs.readFileSync(path.join(pluginStorageRoot(id, undefined, layout), "auth.json"), "utf8"), "actual-old-owner");
  assert.equal(fs.readFileSync(path.join(layout.stateRoot, "data/auth.json"), "utf8"), "unrelated-current-file");
  assert.equal(fs.existsSync(path.join(legacyStateRoot, "data/auth.json")), false);
});

test("updater-provided exact per-resource sources keep separate DSH and WorkBuddy original generations distinct", t => {
  const { layout, temporary } = fixture(t), dsh = "io.rabiroute.agent.dsh", workbuddy = "io.rabiroute.agent.workbuddy";
  const credentialDirectory = path.join(temporary, "original-dsh-generation/protected-connections");
  const dshAuth = path.join(temporary, "original-dsh-generation/auth.json"), workbuddyAuth = path.join(temporary, "different-workbuddy-generation/auth.json");
  write(path.join(credentialDirectory, "connections.json"), "original-dsh-connections");
  write(path.join(credentialDirectory, ".credentials.key"), "original-dsh-key");
  write(dshAuth, "original-dsh-auth"); write(workbuddyAuth, "original-workbuddy-auth");
  const legacySources = [
    { pluginId: dsh, migrationId: "connections-layout-0.7", sourcePath: credentialDirectory },
    { pluginId: dsh, migrationId: "auth-layout-0.7", sourcePath: dshAuth },
    { pluginId: workbuddy, migrationId: "auth-layout-0.7", sourcePath: workbuddyAuth }
  ];
  for (const pluginId of [dsh, workbuddy]) {
    const result = applyPluginStorageMigrations({ phase: "owners-retired", pluginId, layout, legacySources, environment: {},
      legacyStateRoot: path.join(temporary, "unused-shared-legacy-root"), declaration: declaration(pluginId) });
    assert.ok(result.every(row => row.status === "migrated"));
  }
  assert.equal(fs.readFileSync(path.join(pluginStorageRoot(dsh, undefined, layout), "credentials/.credentials.key"), "utf8"), "original-dsh-key");
  assert.equal(fs.readFileSync(path.join(pluginStorageRoot(dsh, undefined, layout), "auth.json"), "utf8"), "original-dsh-auth");
  assert.equal(fs.readFileSync(path.join(pluginStorageRoot(workbuddy, undefined, layout), "auth.json"), "utf8"), "original-workbuddy-auth");
});

test("later exact owner metadata can adopt an unused fresh namespace but never overwrite newly saved state", t => {
  const { layout, temporary } = fixture(t);
  for (const conflict of [false, true]) {
    const pluginId = `io.fixture.late-source-${conflict}`, original = path.join(temporary, `original-${conflict}/auth.json`);
    const input = { phase: "owners-retired" as const, pluginId, layout, declaration: { schemaVersion: 1 as const, scope: "plugin" as const,
      migrations: [{ id: "auth", kind: "file" as const, source: { root: "state" as const, path: `data/absent-${conflict}.json` }, target: "auth.json" }] } };
    assert.equal(applyPluginStorageMigrations(input)[0]?.status, "unchanged");
    write(original, "original-owner-private-bytes");
    const target = path.join(pluginStorageRoot(pluginId, undefined, layout), "auth.json");
    if (conflict) write(target, "newly-saved-private-bytes");
    const result = applyPluginStorageMigrations({ ...input, legacySources: [{ pluginId, migrationId: "auth", sourcePath: original }] });
    assert.equal(result[0]?.status, conflict ? "failed" : "migrated");
    assert.equal(fs.readFileSync(target, "utf8"), conflict ? "newly-saved-private-bytes" : "original-owner-private-bytes");
    if (conflict) assert.equal(fs.readFileSync(original, "utf8"), "original-owner-private-bytes");
    else assert.equal(fs.existsSync(original), false);
  }
});

test("an ambiguous old Bilibili queue is never cloned into multiple new instance owners", async t => {
  const { layout, temporary } = fixture(t), pluginId = "io.rabiroute.manager.bilibili-history", packages = path.join(temporary, "packages");
  write(path.join(packages, pluginId, "0.1.1/storage-migrations.json"), JSON.stringify(declaration(pluginId)));
  const source = path.join(layout.stateRoot, "data/runtime/bilibili-history-bridge.json"), original = '{"jobs":[{"id":"original-job"}]}';
  write(source, original);
  const profilePath = path.join(temporary, "profile.json");
  write(profilePath, JSON.stringify({ schemaVersion: 2, readyRequires: [], instances: ["first", "second"].map(id => ({ id, package: pluginId, version: "0.1.1", enabled: true, config: {}, grants: [] })) }));
  const result = await prepareApplicationPluginStorage({ phase: "owners-retired", layout, profilePath, packageRoots: [packages] });
  assert.equal(result[0]?.status, "failed");
  assert.match(result[0]?.message ?? "", /unambiguous instance owner/);
  assert.equal(fs.readFileSync(source, "utf8"), original);
  assert.equal(fs.existsSync(pluginStorageRoot(pluginId, undefined, layout)), false);
});

test("new instance owners with different package versions use their own declarations without requiring an old shared queue", async t => {
  const { layout, temporary } = fixture(t), pluginId = "io.fixture.new-instances", packages = path.join(temporary, "packages");
  const instances = ["0.1.1", "2.0.0"].map((version, index) => ({ id: `instance-${index}`, package: pluginId, version, enabled: true, config: {}, grants: [] }));
  for (const [index, instance] of instances.entries()) {
    write(path.join(packages, pluginId, instance.version, "storage-migrations.json"), JSON.stringify({ schemaVersion: 1, scope: "instance", migrations: [
      { id: "queue", kind: "file", source: { root: "state", path: "data/absent-shared-queue.json" }, target: `queue-${index}.json` }
    ] }));
    write(path.join(pluginStorageRoot(pluginId, instance.id, layout), `queue-${index}.json`), `original-instance-${index}-jobs`);
  }
  const profilePath = path.join(temporary, "profile.json"); write(profilePath, JSON.stringify({ schemaVersion: 2, readyRequires: [], instances }));
  const result = await prepareApplicationPluginStorage({ phase: "owners-retired", layout, profilePath, packageRoots: [packages] });
  assert.deepEqual(result.map(row => row.status), ["unchanged", "unchanged"]);
  assert.equal(pluginStorageMigrationFailure(pluginId, layout.stateRoot), undefined);
  for (const [index, instance] of instances.entries()) {
    assert.equal(fs.readFileSync(path.join(pluginStorageRoot(pluginId, instance.id, layout), `queue-${index}.json`), "utf8"), `original-instance-${index}-jobs`);
    assert.ok(result[index]?.target?.endsWith(`queue-${index}.json`));
  }
});

test("startup prepares a selected package found only in the managed package root", async t => {
  const { layout, temporary } = fixture(t), pluginId = "io.fixture.managed-storage";
  const packages = path.join(layout.stateRoot, "data", "plugins", "packages");
  write(path.join(packages, pluginId, "1.0.0/storage-migrations.json"), JSON.stringify({ schemaVersion: 1, scope: "plugin", migrations: [
    { id: "move", kind: "file", source: { root: "state", path: "data/managed-original.json" }, target: "state.json" }
  ] }));
  write(path.join(packages, "io.fixture.unselected", "1.0.0/storage-migrations.json"), "invalid unselected declaration");
  const source = path.join(layout.stateRoot, "data/managed-original.json");
  write(source, "managed-owner-data");
  const profilePath = path.join(temporary, "managed-profile.json");
  write(profilePath, JSON.stringify({ schemaVersion: 2, readyRequires: [], instances: [
    { id: "managed-instance", package: pluginId, version: "1.0.0", enabled: true, config: {}, grants: [] }
  ] }));
  const result = await prepareApplicationPluginStorage({ phase: "owners-retired", layout, profilePath, environment: {} });
  assert.equal(result.length, 1);
  assert.equal(result[0]?.status, "migrated");
  assert.equal(fs.readFileSync(path.join(pluginStorageRoot(pluginId, undefined, layout), "state.json"), "utf8"), "managed-owner-data");
  assert.equal(fs.existsSync(source), false);
  assert.equal(fs.existsSync(pluginStorageRoot("io.fixture.unselected", undefined, layout)), false);
});

test("explicit package roots exclude the default managed and environment package roots", async t => {
  const { layout, temporary } = fixture(t), pluginId = "io.fixture.excluded-storage";
  const managed = path.join(layout.stateRoot, "data", "plugins", "packages"), external = path.join(temporary, "environment-packages");
  for (const packages of [managed, external]) {
    write(path.join(packages, pluginId, "1.0.0/storage-migrations.json"), JSON.stringify({ schemaVersion: 1, scope: "plugin", migrations: [
      { id: "move", kind: "file", source: { root: "state", path: "data/excluded-original.json" }, target: "state.json" }
    ] }));
  }
  const source = path.join(layout.stateRoot, "data/excluded-original.json");
  write(source, "excluded-owner-data");
  const profilePath = path.join(temporary, "excluded-profile.json");
  write(profilePath, JSON.stringify({ schemaVersion: 2, readyRequires: [], instances: [
    { id: "excluded-instance", package: pluginId, version: "1.0.0", enabled: true, config: {}, grants: [] }
  ] }));
  await assert.rejects(prepareApplicationPluginStorage({ phase: "owners-retired", layout, profilePath, packageRoots: [],
    environment: { RABIROUTE_PLUGIN_PACKAGE_ROOTS: external } }), /At least one plugin package root is required/);
  const result = await prepareApplicationPluginStorage({ phase: "owners-retired", layout, profilePath,
    packageRoots: [path.join(temporary, "explicit-packages")], environment: { RABIROUTE_PLUGIN_PACKAGE_ROOTS: external } });
  assert.equal(result.length, 1);
  assert.equal(result[0]?.status, "failed");
  assert.equal(fs.readFileSync(source, "utf8"), "excluded-owner-data");
  assert.equal(fs.existsSync(pluginStorageRoot(pluginId, undefined, layout)), false);
});

test("startup reads exact version migrations from its explicit application package root and leaves the original profile unchanged", async t => {
  const { layout, temporary } = fixture(t), id = "io.fixture.old-version", packages = path.join(temporary, "packages");
  fs.mkdirSync(path.join(packages, id, "0.1.1"), { recursive: true });
  write(path.join(packages, id, "0.1.1/storage-migrations.json"), JSON.stringify({ schemaVersion: 1, scope: "plugin", migrations: [
    { id: "move", kind: "file", source: { root: "state", path: "data/original.json" }, target: "state.json" }
  ] }));
  write(path.join(layout.stateRoot, "data/original.json"), "original-owner-data");
  const profilePath = path.join(temporary, "custom-profile.json"), original = JSON.stringify({ schemaVersion: 2, readyRequires: [], instances: [
    { id: "original-instance", package: id, version: "2.0.0", enabled: true, config: {}, grants: [] }
  ] });
  write(profilePath, original);
  write(path.join(layout.packageRoot, "dist/plugins/profiles/package-migrations.json"), JSON.stringify({ schemaVersion: 1, packages: [
    { packageId: id, fromVersions: ["2.0.0"], toVersion: "0.1.1" }
  ] }));
  const result = await prepareApplicationPluginStorage({ phase: "owners-retired", layout, profilePath, packageRoots: [packages] });
  assert.equal(result[0]?.status, "migrated");
  assert.equal(fs.readFileSync(profilePath, "utf8"), original);
  assert.equal(fs.readFileSync(path.join(pluginStorageRoot(id, undefined, layout), "state.json"), "utf8"), "original-owner-data");
  assert.equal((await prepareApplicationPluginStorage({ phase: "owners-retired", layout, profilePath, packageRoots: [packages] }))[0]?.status, "unchanged");
});

test("real scoped Agent bundles select their own DSH and WorkBuddy storage without changing process environment", async t => {
  const { temporary, layout } = fixture(t), projectRoot = process.cwd();
  const { bundleMessageEndpointRuntime } = await import(pathToFileURL(path.join(projectRoot, "scripts/build-message-endpoint-runtime.mjs")).href);
  const output = path.join(temporary, "scoped-agent.mjs");
  await bundleMessageEndpointRuntime(projectRoot, { scopedEnvironment: true,
    ownedPrefixes: ["src/plugins/io.rabiroute.agent.dsh/", "src/plugins/io.rabiroute.agent.workbuddy/"],
    exports: [{ source: "src/plugins/io.rabiroute.agent.dsh/src/dshConnectionStore.ts", name: "dshConnectionFile" },
      { source: "src/plugins/io.rabiroute.agent.workbuddy/src/workbuddyHttpAuth.ts", name: "workbuddyCredentialFilePath" }]
  }, output);
  const { createImplementation, hostModules } = await import(pathToFileURL(output).href);
  const modules: Record<string, unknown> = {};
  for (const id of hostModules as string[]) modules[id] = await import(new URL(`../${id}.js`, import.meta.url).href);
  const originalStateRoot = process.env.RABIROUTE_STATE_ROOT;
  const owner = (stateRoot: string) => createImplementation({ environment: {
    RABIROUTE_PACKAGE_ROOT: layout.packageRoot, RABIROUTE_STATE_ROOT: stateRoot,
    RABI_WORKBUDDY_AUTH_FILE: undefined
  }, module(id: string) { assert.ok(id in modules, `Unexpected shared owner ${id}`); return modules[id]; } });
  const firstRoot = path.join(temporary, "first-node"), secondRoot = path.join(temporary, "second-node");
  const first = owner(firstRoot), second = owner(secondRoot);
  assert.equal(first.dshConnectionFile(), path.join(firstRoot, "data/plugins/io.rabiroute.agent.dsh/credentials/connections.json"));
  assert.equal(second.dshConnectionFile(), path.join(secondRoot, "data/plugins/io.rabiroute.agent.dsh/credentials/connections.json"));
  assert.equal(first.workbuddyCredentialFilePath(), path.join(firstRoot, "data/plugins/io.rabiroute.agent.workbuddy/auth.json"));
  assert.equal(second.workbuddyCredentialFilePath(), path.join(secondRoot, "data/plugins/io.rabiroute.agent.workbuddy/auth.json"));
  assert.equal(first.dshConnectionFile(), path.join(firstRoot, "data/plugins/io.rabiroute.agent.dsh/credentials/connections.json"));
  assert.equal(process.env.RABIROUTE_STATE_ROOT, originalStateRoot);
  assert.equal(fs.existsSync(firstRoot), false);
  assert.equal(fs.existsSync(secondRoot), false);
});
