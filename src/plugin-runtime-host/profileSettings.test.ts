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
