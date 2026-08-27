import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  BUILTIN_MANAGER_PLUGIN_PACKAGE_ID,
  initializeManagerPluginProfile,
  MANAGER_PLUGIN_PROFILE_RELATIVE_PATH,
  resolveManagerPluginProfile
} from "./managerPluginConfig.js";

function packageSource(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "plugins", "packages", BUILTIN_MANAGER_PLUGIN_PACKAGE_ID, "0.2.1");
}

async function installBaseBundle(root: string): Promise<void> {
  const target = path.join(root, "plugins", "packages", encodeURIComponent(BUILTIN_MANAGER_PLUGIN_PACKAGE_ID), "0.2.1");
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.cp(packageSource(), target, { recursive: true });
}

function baseServices() {
  return { activate: async () => {} };
}

test("post-listener profile initialization migrates legacy enabled values once into Bundle-owned defaults", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rabiroute-manager-profile-"));
  await installBaseBundle(root);
  const initialized = await initializeManagerPluginProfile(root, {
    "manager:desktop": { enabled: false },
    "manager:core": { enabled: false }
  });
  assert.equal(initialized.wroteConfiguration, true);
  assert.equal(initialized.profile.plugins.length, 26);
  assert.deepEqual(
    initialized.profile.plugins
      .filter(item => item.id === "manager:core" || item.id === "manager:desktop")
      .map(item => [item.id, item.package, item.enabled]),
    [
      ["manager:core", BUILTIN_MANAGER_PLUGIN_PACKAGE_ID, true],
      ["manager:desktop", BUILTIN_MANAGER_PLUGIN_PACKAGE_ID, false]
    ]
  );
  const saved = JSON.parse(await fs.readFile(path.join(root, MANAGER_PLUGIN_PROFILE_RELATIVE_PATH), "utf8"));
  assert.equal(saved.schemaVersion, 1);
  assert.equal(saved.plugins.length, 26);
});

test("an existing Profile stays authoritative over startup-only managerPlugins values", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rabiroute-manager-profile-"));
  await installBaseBundle(root);
  await initializeManagerPluginProfile(root);
  const resolved = await resolveManagerPluginProfile({
    rootDir: root,
    bootstrapLegacyManagerPlugins: { "manager:desktop": { enabled: false } },
    createServices: () => baseServices()
  });
  assert.equal(resolved.desired.find(item => item.definition.instanceId === "manager:desktop")?.enabled, true);
});

test("normal reconciliation reads only the Profile and never writes its bootstrap compatibility data", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rabiroute-manager-profile-"));
  await installBaseBundle(root);
  const first = await resolveManagerPluginProfile({
    rootDir: root,
    bootstrapLegacyManagerPlugins: { "manager:desktop": { enabled: false } },
    createServices: () => baseServices()
  });
  assert.equal(first.profile.plugins.length, 26);
  assert.equal(first.desired.find(item => item.definition.instanceId === "manager:desktop")?.enabled, false);
  await assert.rejects(() => fs.stat(path.join(root, MANAGER_PLUGIN_PROFILE_RELATIVE_PATH)), { code: "ENOENT" });

  await initializeManagerPluginProfile(root);
  const profilePath = path.join(root, MANAGER_PLUGIN_PROFILE_RELATIVE_PATH);
  const before = await fs.readFile(profilePath, "utf8");
  const resolved = await resolveManagerPluginProfile({ rootDir: root, createServices: () => baseServices() });
  assert.equal(resolved.desired.length, 26);
  assert.equal(await fs.readFile(profilePath, "utf8"), before);
});

test("legacy base package rows boot in memory, then leave both Profile and Patch sources after listener initialization", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rabiroute-manager-profile-"));
  await installBaseBundle(root);
  const profilePath = path.join(root, MANAGER_PLUGIN_PROFILE_RELATIVE_PATH);
  const patchDirectory = path.join(root, "data", "plugins", "manager", "profile.d");
  const patchPath = path.join(patchDirectory, "20-legacy-package.json");
  await fs.mkdir(patchDirectory, { recursive: true });
  await fs.writeFile(profilePath, JSON.stringify({
    schemaVersion: 1,
    plugins: [{ id: "manager:core", package: "rabi.manager.builtin", version: "0.2.1", enabled: true, config: {} }]
  }), "utf8");
  await fs.writeFile(patchPath, JSON.stringify({
    schemaVersion: 1,
    operations: [{ op: "upsert", plugin: { id: "manager:desktop", package: "rabi.manager.builtin", version: "0.2.1", enabled: false, config: {} } }]
  }), "utf8");

  const beforeProfile = await fs.readFile(profilePath, "utf8");
  const beforePatch = await fs.readFile(patchPath, "utf8");
  const booted = await resolveManagerPluginProfile({ rootDir: root, createServices: () => baseServices() });
  assert.deepEqual(booted.profile.plugins.map(item => [item.id, item.package, item.version]), [
    ["manager:core", BUILTIN_MANAGER_PLUGIN_PACKAGE_ID, "0.2.1"],
    ["manager:desktop", BUILTIN_MANAGER_PLUGIN_PACKAGE_ID, "0.2.1"]
  ]);
  assert.equal(await fs.readFile(profilePath, "utf8"), beforeProfile);
  assert.equal(await fs.readFile(patchPath, "utf8"), beforePatch);

  const initialized = await initializeManagerPluginProfile(root);
  assert.equal(initialized.wroteConfiguration, true);
  assert.equal(initialized.profile.plugins[0]?.package, BUILTIN_MANAGER_PLUGIN_PACKAGE_ID);
  assert.equal(initialized.profile.plugins[0]?.version, "0.2.1");
  assert.doesNotMatch(await fs.readFile(profilePath, "utf8"), /rabi\.manager\.builtin/);
  assert.doesNotMatch(await fs.readFile(patchPath, "utf8"), /rabi\.manager\.builtin/);
});

test("a base Bundle source revision changes the Manager desired revision", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rabiroute-manager-profile-"));
  await installBaseBundle(root);
  await initializeManagerPluginProfile(root);
  const first = await resolveManagerPluginProfile({ rootDir: root, createServices: () => baseServices() });
  const firstRevision = first.desired.find(item => item.definition.instanceId === "manager:core")!.revision;
  const entry = path.join(root, "plugins", "packages", encodeURIComponent(BUILTIN_MANAGER_PLUGIN_PACKAGE_ID), "0.2.1", "index.mjs");
  await fs.appendFile(entry, "\n// revision test\n", "utf8");
  const second = await resolveManagerPluginProfile({ rootDir: root, createServices: () => baseServices() });
  assert.notEqual(second.desired.find(item => item.definition.instanceId === "manager:core")!.revision, firstRevision);
});

test("Manager core cannot be disabled by a Profile patch", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rabiroute-manager-profile-"));
  await installBaseBundle(root);
  await initializeManagerPluginProfile(root);
  const patchDirectory = path.join(root, "data", "plugins", "manager", "profile.d");
  await fs.mkdir(patchDirectory, { recursive: true });
  await fs.writeFile(path.join(patchDirectory, "10-disable.json"), JSON.stringify({
    schemaVersion: 1,
    operations: [{ op: "upsert", plugin: { id: "manager:core", package: BUILTIN_MANAGER_PLUGIN_PACKAGE_ID, version: "0.2.1", enabled: false } }]
  }), "utf8");
  const resolved = await resolveManagerPluginProfile({ rootDir: root, createServices: () => baseServices() });
  assert.equal(resolved.desired.find(item => item.definition.instanceId === "manager:core")?.enabled, true);
  assert.deepEqual(resolved.diagnostics, [{
    code: "core_cannot_disable",
    instanceId: "manager:core",
    message: "Required Manager plugin cannot be disabled: manager:core"
  }]);
});
