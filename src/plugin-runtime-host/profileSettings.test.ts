import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { PluginProfileSettings, PluginSettingsConflict } from "./profileSettings.js";

async function fixture(t: test.TestContext) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "plugin-settings-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const profilePath = path.join(root, "profile.json"), settingsRoot = path.join(root, "settings");
  const profile = { schemaVersion: 2, readyRequires: [], instances: ["a", "b"].map(id => ({
    id: `manager:${id}`, package: `io.test.${id}`, version: "1.0.0", enabled: true, config: { original: id }, grants: []
  })) };
  await fs.writeFile(profilePath, JSON.stringify(profile));
  return { root, profilePath, settingsRoot, profile, owner: new PluginProfileSettings({ profilePath, settingsRoot }) };
}

test("plugin enable settings persist without rewriting defaults or a neighboring instance", async t => {
  const f = await fixture(t), original = await fs.readFile(f.profilePath);
  const snapshot = await f.owner.snapshot();
  await f.owner.update("manager:a", { expectedRevision: snapshot.revision, enabled: false });
  const reloaded = await new PluginProfileSettings(f.owner.options).snapshot();
  assert.deepEqual(reloaded.profile.instances.map(row => row.enabled), [false, true]);
  assert.deepEqual(await fs.readFile(f.profilePath), original);
  await assert.rejects(fs.stat(path.join(f.settingsRoot, createHash("sha256").update("manager:b").digest("hex") + ".json")), { code: "ENOENT" });
});

test("host defaults migrate custom profiles from the active package while explicit remote mappings remain authoritative", async t => {
  const f = await fixture(t), previousRoot = process.env.RABIROUTE_PACKAGE_ROOT;
  process.env.RABIROUTE_PACKAGE_ROOT = f.root;
  t.after(() => { if (previousRoot === undefined) delete process.env.RABIROUTE_PACKAGE_ROOT; else process.env.RABIROUTE_PACKAGE_ROOT = previousRoot; });
  const hostMigrations = path.join(f.root, "dist", "plugins", "profiles", "package-migrations.json");
  await fs.mkdir(path.dirname(hostMigrations), { recursive: true });
  const mapping = (toVersion: string) => JSON.stringify({ schemaVersion: 1, packages: [{ packageId: "io.test.a", fromVersions: ["1.0.0"], toVersion }] });
  await fs.writeFile(hostMigrations, mapping("0.1.1"));
  await fs.writeFile(path.join(f.root, "package-migrations.json"), mapping("9.0.0"));
  assert.equal((await f.owner.snapshot()).profile.instances[0]?.version, "0.1.1", "The host owns its mapping even for a custom profile path.");
  const remoteMigrations = path.join(f.root, "remote-package-migrations.json");
  await fs.writeFile(remoteMigrations, mapping("2.0.0"));
  const remote = new PluginProfileSettings({ ...f.owner.options, migrationsPath: remoteMigrations });
  assert.equal((await remote.snapshot()).profile.instances[0]?.version, "2.0.0");
  assert.equal(JSON.parse(await fs.readFile(f.profilePath, "utf8")).instances[0].version, "1.0.0");
});

test("stale plugin edits conflict and revoked writes do not change the accepted setting", async t => {
  const f = await fixture(t), old = await f.owner.snapshot();
  const current = await f.owner.update("manager:a", { expectedRevision: old.revision, enabled: false });
  await assert.rejects(f.owner.update("manager:a", { expectedRevision: old.revision, enabled: true }), PluginSettingsConflict);
  await assert.rejects(f.owner.update("manager:b", { expectedRevision: current.revision, enabled: false }, () => { throw new Error("revoked"); }), /revoked/);
  assert.deepEqual((await f.owner.snapshot()).profile.instances.map(row => row.enabled), [false, true]);
});

test("a malformed instance keeps its raw data and only disables that instance", async t => {
  const f = await fixture(t);
  await fs.mkdir(f.settingsRoot);
  const badPath = path.join(f.settingsRoot, createHash("sha256").update("manager:a").digest("hex") + ".json");
  await fs.writeFile(badPath, "{broken");
  const snapshot = await f.owner.snapshot();
  assert.deepEqual(snapshot.profile.instances.map(row => row.enabled), [false, true]);
  assert.equal(snapshot.diagnostics[0]?.instanceId, "manager:a");
  await f.owner.update("manager:b", { expectedRevision: snapshot.revision, config: { changed: true } });
  assert.equal(await fs.readFile(badPath, "utf8"), "{broken");
  assert.deepEqual((await f.owner.snapshot()).profile.instances[1]?.config, { changed: true });
});

test("new packaged plugins remain available after earlier user overrides", async t => {
  const f = await fixture(t);
  await f.owner.update("manager:a", { expectedRevision: (await f.owner.snapshot()).revision, enabled: false });
  f.profile.instances.push({ ...f.profile.instances[1]!, id: "manager:c", package: "io.test.c" });
  await fs.writeFile(f.profilePath, JSON.stringify(f.profile));
  assert.deepEqual((await f.owner.snapshot()).profile.instances.map(row => row.enabled), [false, true, true]);
});

test("wrong instance identity and invalid values stay local and cannot escape the settings root", async t => {
  const f = await fixture(t);
  await fs.mkdir(f.settingsRoot);
  await fs.writeFile(path.join(f.settingsRoot, createHash("sha256").update("manager:a").digest("hex") + ".json"), JSON.stringify({ schemaVersion: 1, instanceId: "manager:b", enabled: false }));
  const snapshot = await f.owner.snapshot();
  assert.equal(snapshot.diagnostics.length, 1);
  assert.equal(snapshot.profile.instances[1]?.enabled, true);
  await assert.rejects(f.owner.update("../elsewhere", { expectedRevision: snapshot.revision, enabled: false }), /not found/);
  await assert.rejects(f.owner.update("manager:b", { expectedRevision: snapshot.revision, enabled: "false" as never }), /boolean/);
});

test("settings IDs that differ only by case stay distinct on Windows", async t => {
  const f = await fixture(t);
  f.profile.instances[1]!.id = "manager:A";
  await fs.writeFile(f.profilePath, JSON.stringify(f.profile));
  await f.owner.update("manager:a", { expectedRevision: (await f.owner.snapshot()).revision, enabled: false });
  assert.deepEqual((await f.owner.snapshot()).profile.instances.map(row => row.enabled), [false, true]);
});

test("enable changes never overwrite broken or foreign instance settings", async t => {
  const f = await fixture(t);
  await fs.mkdir(f.settingsRoot);
  const file = path.join(f.settingsRoot, createHash("sha256").update("manager:a").digest("hex") + ".json");
  for (const raw of ["{broken", JSON.stringify({ schemaVersion: 1, instanceId: "manager:b", config: { account: "foreign" } })]) {
    await fs.writeFile(file, raw);
    await assert.rejects(f.owner.update("manager:a", { expectedRevision: (await f.owner.snapshot()).revision, enabled: true }), /Repair/);
    assert.equal(await fs.readFile(file, "utf8"), raw);
    assert.deepEqual((await f.owner.snapshot()).profile.instances[1]?.config, { original: "b" });
  }
});

test("a bad profile row remains diagnostic while a healthy instance can save its own settings", async t => {
  const f = await fixture(t);
  const brokenProfile = JSON.stringify({ ...f.profile, instances: [null, f.profile.instances[0],
    { ...f.profile.instances[1], enabled: "invalid" }] });
  await fs.writeFile(f.profilePath, brokenProfile);
  const snapshot = await f.owner.snapshot();
  assert.deepEqual(snapshot.profile.instances.map(row => row.id), ["manager:a"]);
  assert.deepEqual(snapshot.diagnostics.map(row => [row.rowIndex, row.instanceId]), [[0, undefined], [2, "manager:b"]]);
  await f.owner.update("manager:a", { expectedRevision: snapshot.revision, enabled: false });
  assert.equal((await f.owner.snapshot()).profile.instances[0]?.enabled, false);
  assert.equal(await fs.readFile(f.profilePath, "utf8"), brokenProfile);
  await assert.rejects(f.owner.update("manager:b", { expectedRevision: (await f.owner.snapshot()).revision, enabled: true }), /Repair/);
});

test("package migration and old version fields preserve stable instance settings and business files on reopening", async t => {
  const f = await fixture(t);
  const migrationsPath = path.join(f.root, "package-migrations.json");
  await fs.writeFile(migrationsPath, JSON.stringify({ schemaVersion: 1, packages: [
    { packageId: "io.test.a", fromVersions: ["1.0.0"], toVersion: "0.1.1" }
  ] }));
  await fs.mkdir(f.settingsRoot);
  const settingsPath = path.join(f.settingsRoot, createHash("sha256").update("manager:a").digest("hex") + ".json");
  const oldOverlay = JSON.stringify({ schemaVersion: 1, instanceId: "manager:a", package: "io.test.a", version: "1.0.0",
    enabled: false, config: { account: "kept", customPath: "unchanged" } });
  await fs.writeFile(settingsPath, oldOverlay);
  const ledgerPath = path.join(f.root, "business-ledger.jsonl"), ledger = '{"deliveryId":"original","status":"uncertain"}\n';
  await fs.writeFile(ledgerPath, ledger);
  const owner = new PluginProfileSettings({ ...f.owner.options, migrationsPath });
  const first = await owner.snapshot();
  assert.equal(first.profile.instances[0]?.version, "0.1.1");
  assert.equal(first.profile.instances[0]?.enabled, false);
  assert.deepEqual(first.profile.instances[0]?.config, { account: "kept", customPath: "unchanged" });
  assert.deepEqual(first.profile.migrations, [{ instanceId: "manager:a", packageId: "io.test.a", fromVersion: "1.0.0", toVersion: "0.1.1" }]);
  assert.deepEqual(await new PluginProfileSettings(owner.options).snapshot(), first);
  assert.equal(await fs.readFile(settingsPath, "utf8"), oldOverlay);
  await owner.update("manager:b", { expectedRevision: first.revision, enabled: false });
  assert.equal(await fs.readFile(settingsPath, "utf8"), oldOverlay);
  assert.equal(await fs.readFile(ledgerPath, "utf8"), ledger);
  assert.equal((JSON.parse(await fs.readFile(f.profilePath, "utf8"))).instances[0].version, "1.0.0");
});
