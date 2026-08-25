import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { ManagerPluginDefinition } from "../runtime/managerPluginRuntime.js";
import {
  BUILTIN_MANAGER_PLUGIN_PACKAGE_ID,
  MANAGER_PLUGIN_PROFILE_RELATIVE_PATH,
  migrateManagerPluginProfile,
  resolveManagerPluginProfile
} from "./managerPluginConfig.js";

function definition(instanceId: string): ManagerPluginDefinition {
  return {
    instanceId,
    manifest: { id: `builtin:${instanceId}`, name: instanceId, version: "0.2.1", kind: "builtin", hosts: ["manager"] },
    scope: "global",
    contributions: []
  };
}

const definitions = [definition("manager:core"), definition("manager:desktop")];

async function writeBaseBundle(root: string): Promise<void> {
  const directory = path.join(root, "plugins", "packages", BUILTIN_MANAGER_PLUGIN_PACKAGE_ID, "0.2.1");
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(path.join(directory, "rabi.plugin.json"), JSON.stringify({
    schemaVersion: 1,
    id: BUILTIN_MANAGER_PLUGIN_PACKAGE_ID,
    version: "0.2.1",
    hosts: ["manager"],
    entry: "./index.mjs"
  }), "utf8");
  await fs.writeFile(path.join(directory, "index.mjs"), "export const createPlugin = context => context.services.createBuiltinManagerPluginDefinition(context);", "utf8");
}

test("Manager plugin profile migrates old enabled values only once into the base Bundle profile", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rabiroute-manager-profile-"));
  const profile = await migrateManagerPluginProfile(root, definitions, { "manager:desktop": { enabled: false }, "manager:core": { enabled: false } });
  assert.deepEqual(profile.plugins.map(item => [item.id, item.package, item.enabled]), [
    ["manager:core", BUILTIN_MANAGER_PLUGIN_PACKAGE_ID, true],
    ["manager:desktop", BUILTIN_MANAGER_PLUGIN_PACKAGE_ID, false]
  ]);
  const saved = JSON.parse(await fs.readFile(path.join(root, MANAGER_PLUGIN_PROFILE_RELATIVE_PATH), "utf8"));
  assert.equal(saved.schemaVersion, 1);
  assert.equal(saved.plugins.length, 2);
});

test("Manager plugin profile applies patches before loading Bundle definitions", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rabiroute-manager-profile-"));
  await writeBaseBundle(root);
  await migrateManagerPluginProfile(root, definitions);
  const patchDirectory = path.join(root, "data", "plugins", "manager", "profile.d");
  await fs.mkdir(patchDirectory, { recursive: true });
  await fs.writeFile(path.join(patchDirectory, "10-remove.json"), JSON.stringify({ schemaVersion: 1, operations: [{ op: "remove", id: "manager:desktop" }] }), "utf8");
  const resolved = await resolveManagerPluginProfile({ rootDir: root, builtinDefinitions: definitions, createServices: () => ({}) });
  assert.deepEqual(resolved.desired.map(item => item.definition.instanceId), ["manager:core"]);
  assert.equal(resolved.desired[0]?.definition.manifest.kind, "package");
  assert.deepEqual(resolved.diagnostics, []);
});

test("Manager core cannot be disabled by a Profile patch", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rabiroute-manager-profile-"));
  await writeBaseBundle(root);
  await migrateManagerPluginProfile(root, definitions);
  const patchDirectory = path.join(root, "data", "plugins", "manager", "profile.d");
  await fs.mkdir(patchDirectory, { recursive: true });
  await fs.writeFile(path.join(patchDirectory, "10-disable.json"), JSON.stringify({ schemaVersion: 1, operations: [{ op: "upsert", plugin: { id: "manager:core", package: BUILTIN_MANAGER_PLUGIN_PACKAGE_ID, version: "0.2.1", enabled: false } }] }), "utf8");
  const resolved = await resolveManagerPluginProfile({ rootDir: root, builtinDefinitions: definitions, createServices: () => ({}) });
  assert.equal(resolved.desired[0]?.enabled, true);
  assert.deepEqual(resolved.diagnostics, [{
    code: "core_cannot_disable",
    instanceId: "manager:core",
    message: "Required Manager plugin cannot be disabled: manager:core"
  }]);
});

test("existing builtin profile rows migrate to the base Bundle package", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rabiroute-manager-profile-"));
  const profilePath = path.join(root, MANAGER_PLUGIN_PROFILE_RELATIVE_PATH);
  await fs.mkdir(path.dirname(profilePath), { recursive: true });
  await fs.writeFile(profilePath, JSON.stringify({
    schemaVersion: 1,
    plugins: [{ id: "manager:core", package: "rabi.manager.builtin", version: "0.2.1", enabled: true, config: {} }]
  }), "utf8");
  const profile = await migrateManagerPluginProfile(root, definitions);
  assert.equal(profile.plugins[0]?.package, BUILTIN_MANAGER_PLUGIN_PACKAGE_ID);
});
