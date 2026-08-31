import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { loadPluginProfile, parsePluginProfile, PluginPackageCatalog } from "./profile.js";

const profile = {
  schemaVersion: 2,
  readyRequires: ["manager.core@1"],
  instances: [{ id: "test:source", package: "io.test.source", version: "1.0.0", enabled: true, config: {}, grants: ["network.local"] }]
};

test("parsePluginProfile rejects the removed plugins profile shape", () => {
  assert.throws(() => parsePluginProfile({ schemaVersion: 1, plugins: [] }), /unsupported fields/);
  assert.equal(parsePluginProfile(profile).instances[0]?.id, "test:source");
  assert.deepEqual(parsePluginProfile(profile).readyRequires, ["manager.core@1"]);
});

test("parsePluginProfile validates restart and resource policy", () => {
  const parsed = parsePluginProfile({
    ...profile,
    instances: [{
      ...profile.instances[0],
      policy: {
        restart: { mode: "on_failure", maxAttempts: 4, windowMs: 10_000, initialBackoffMs: 100, maximumBackoffMs: 1_000 },
        resources: { maxChildProcesses: 3, shutdownTimeoutMs: 2_000 }
      }
    }]
  });
  assert.equal(parsed.instances[0]?.policy.restart.maxAttempts, 4);
  assert.equal(parsed.instances[0]?.policy.resources.shutdownTimeoutMs, 2_000);
  assert.throws(() => parsePluginProfile({ ...profile, readyRequires: ["manager.core"] }), /name@major/);
  assert.throws(() => parsePluginProfile({
    ...profile,
    instances: [{ ...profile.instances[0], policy: { restart: { mode: "never", maxAttempts: 1 } } }]
  }), /must be 0/);
  assert.throws(() => parsePluginProfile({
    ...profile,
    instances: [{ ...profile.instances[0], policy: { resources: { memoryMb: 256 } } }]
  }), /unsupported fields: memoryMb/);
});

test("loadPluginProfile resolves packages without a central package enum", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rabi-profile-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const packageRoot = path.join(root, "packages", "io.test.source", "1.0.0");
  await fs.mkdir(packageRoot, { recursive: true });
  await fs.writeFile(path.join(packageRoot, "rabi.plugin.json"), JSON.stringify({
    schemaVersion: 2, id: "io.test.source", version: "1.0.0",
    entries: { manager: { execution: "in_process", module: "./manager.mjs" } },
    provides: [], requires: [], optional: [], permissions: ["network.local"]
  }));
  await fs.writeFile(path.join(packageRoot, "manager.mjs"), "export function activate() {}\n");
  const profilePath = path.join(root, "desktop.json");
  await fs.writeFile(profilePath, JSON.stringify(profile));
  const packageCatalogRoot = path.join(root, "packages");
  await assert.rejects(() => loadPluginProfile({
    profilePath, packageCatalog: new PluginPackageCatalog([packageCatalogRoot]),
    runtimeRoot: path.join(root, "runtime-untrusted"), host: "manager"
  }), /not trusted for in_process execution/);
  const loaded = await loadPluginProfile({
    profilePath,
    packageCatalog: new PluginPackageCatalog([packageCatalogRoot], {
      trustedInProcessRoots: [packageCatalogRoot]
    }),
    runtimeRoot: path.join(root, "runtime"), host: "manager"
  });
  assert.equal(loaded.candidates[0]?.manifest.id, "io.test.source");
  assert.deepEqual(loaded.grants({
    applicationGenerationId: "app-generation",
    managerInstanceId: "manager-instance",
    activationId: "activation",
    instanceId: "test:source",
    pluginId: "io.test.source",
    version: "1.0.0",
    revision: "x",
    host: "manager"
  }), ["network.local"]);
});

test("PluginPackageCatalog rejects trust grants for roots outside the catalog", () => {
  assert.throws(() => new PluginPackageCatalog(["catalog-root"], {
    trustedInProcessRoots: ["different-root"]
  }), /not present in the package catalog/);
});
