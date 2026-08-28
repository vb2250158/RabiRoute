import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { loadPluginProfile, parsePluginProfile, PluginPackageCatalog } from "./profile.js";

const profile = {
  schemaVersion: 1,
  instances: [{ id: "test:source", package: "io.test.source", version: "1.0.0", enabled: true, config: {}, grants: ["network.local"] }]
};

test("parsePluginProfile rejects the removed plugins profile shape", () => {
  assert.throws(() => parsePluginProfile({ schemaVersion: 1, plugins: [] }), /unsupported fields/);
  assert.equal(parsePluginProfile(profile).instances[0]?.id, "test:source");
});

test("loadPluginProfile resolves packages without a central package enum", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rabi-profile-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const packageRoot = path.join(root, "packages", "io.test.source", "1.0.0");
  await fs.mkdir(packageRoot, { recursive: true });
  await fs.writeFile(path.join(packageRoot, "rabi.plugin.json"), JSON.stringify({
    schemaVersion: 1, id: "io.test.source", version: "1.0.0", entries: { manager: "./manager.mjs" },
    provides: [], requires: [], optional: [], permissions: ["network.local"]
  }));
  await fs.writeFile(path.join(packageRoot, "manager.mjs"), "export function activate() {}\n");
  const profilePath = path.join(root, "desktop.json");
  await fs.writeFile(profilePath, JSON.stringify(profile));
  const loaded = await loadPluginProfile({
    profilePath, packageCatalog: new PluginPackageCatalog([path.join(root, "packages")]),
    runtimeRoot: path.join(root, "runtime"), host: "manager"
  });
  assert.equal(loaded.candidates[0]?.manifest.id, "io.test.source");
  assert.deepEqual(loaded.grants({ instanceId: "test:source", pluginId: "io.test.source", version: "1.0.0", revision: "x", host: "manager" }), ["network.local"]);
});
