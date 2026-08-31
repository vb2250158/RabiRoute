import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { GenerationRuntime, loadPluginProfile, PluginPackageCatalog } from "../plugin-kernel/index.js";
import { WebPluginModuleRegistry } from "./webPluginModules.js";

type ProfileEntry = Readonly<{ id: string; enabled?: boolean }>;

async function fixture(): Promise<Readonly<{
  root: string;
  packageDirectory: string;
  profilePath: string;
  packageCatalog: PluginPackageCatalog;
}>> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rabiroute-web-modules-"));
  const packageDirectory = path.join(root, "packages", encodeURIComponent("example.web"), "1.0.0");
  const profilePath = path.join(root, "profile.json");
  await fs.mkdir(path.join(packageDirectory, "web"), { recursive: true });
  await fs.writeFile(path.join(packageDirectory, "rabi.plugin.json"), JSON.stringify({
    schemaVersion: 2,
    id: "example.web",
    version: "1.0.0",
    entries: {
      manager: { execution: "in_process", module: "./manager.mjs" },
      web: { execution: "in_process", module: "./web/client.mjs" }
    },
    provides: [],
    requires: [],
    optional: [],
    permissions: []
  }), "utf8");
  await fs.writeFile(path.join(packageDirectory, "manager.mjs"), "export function activate() {}\n", "utf8");
  await fs.writeFile(path.join(packageDirectory, "web", "client.mjs"), "export function activate() {}\n", "utf8");
  const packageRoot = path.join(root, "packages");
  return Object.freeze({
    root,
    packageDirectory,
    profilePath,
    packageCatalog: new PluginPackageCatalog([packageRoot], {
      trustedInProcessRoots: [packageRoot]
    })
  });
}

async function load(value: Awaited<ReturnType<typeof fixture>>, entries: readonly ProfileEntry[]) {
  await fs.writeFile(value.profilePath, JSON.stringify({
    schemaVersion: 2,
    readyRequires: [],
    instances: entries.map(entry => ({
      id: entry.id,
      package: "example.web",
      version: "1.0.0",
      enabled: entry.enabled ?? true,
      config: {},
      grants: []
    }))
  }), "utf8");
  return loadPluginProfile({
    profilePath: value.profilePath,
    packageCatalog: value.packageCatalog,
    runtimeRoot: path.join(value.root, "runtime"),
    host: "manager"
  });
}

test("Web module registry groups active instances by package revision and retains old revisions", async t => {
  const value = await fixture();
  t.after(() => fs.rm(value.root, { recursive: true, force: true }));
  const registry = new WebPluginModuleRegistry();
  const runtime = new GenerationRuntime({ host: "manager" });
  t.after(() => runtime.dispose());
  const instanceIds = ["manager:example-web-a", "manager:example-web-b"];

  const firstLoaded = await load(value, instanceIds.map(id => ({ id })));
  const firstGeneration = await runtime.switch(firstLoaded.candidates);
  registry.update(firstLoaded, firstGeneration.generation);
  const [first] = registry.list();
  assert.ok(first);
  assert.equal(registry.list().length, 1);
  assert.match(first.id, /^web-[a-f0-9]{32}$/);
  assert.deepEqual(first.instances.map(instance => instance.instanceId), instanceIds);
  assert.match((await registry.read(first.id, first.rev, first.entryPath)).source.toString("utf8"), /activate/);

  await fs.writeFile(path.join(value.packageDirectory, "web", "client.mjs"), "export function activate() { return 'two'; }\n", "utf8");
  const secondLoaded = await load(value, instanceIds.map(id => ({ id })));
  const secondGeneration = await runtime.switch(secondLoaded.candidates);
  registry.update(secondLoaded, secondGeneration.generation);
  const [second] = registry.list();
  assert.ok(second);
  assert.equal(second.id, first.id);
  assert.notEqual(second.rev, first.rev);
  assert.deepEqual(second.instances.map(instance => instance.instanceId), instanceIds);
  assert.match((await registry.read(second.id, second.rev, second.entryPath)).source.toString("utf8"), /return 'two'/);
  assert.match((await registry.read(first.id, first.rev, first.entryPath)).source.toString("utf8"), /activate/);
});

test("Web module registry publishes only active instances and removes an empty graph", async t => {
  const value = await fixture();
  t.after(() => fs.rm(value.root, { recursive: true, force: true }));
  const registry = new WebPluginModuleRegistry();
  const runtime = new GenerationRuntime({ host: "manager" });
  t.after(() => runtime.dispose());

  const loaded = await load(value, [
    { id: "manager:example-web-active" },
    { id: "manager:example-web-disabled", enabled: false }
  ]);
  const generation = await runtime.switch(loaded.candidates);
  registry.update(loaded, generation.generation);
  assert.deepEqual(registry.list()[0]?.instances.map(instance => instance.instanceId), ["manager:example-web-active"]);

  const empty = await load(value, [{ id: "manager:example-web-active", enabled: false }]);
  const emptyGeneration = await runtime.switch(empty.candidates);
  registry.update(empty, emptyGeneration.generation);
  assert.deepEqual(registry.list(), []);
});
