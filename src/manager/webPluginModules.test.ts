import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { loadManagerPluginProfile } from "./managerPluginPackageLoader.js";
import { parseRabiPluginProfile } from "./pluginProfile.js";
import { WebPluginModuleRegistry } from "./webPluginModules.js";

type ProfileEntry = Readonly<{ id: string; enabled?: boolean }>;

async function fixture(): Promise<Readonly<{ root: string; packageDirectory: string }>> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rabiroute-web-modules-"));
  const packageDirectory = path.join(root, "packages", encodeURIComponent("example.web"), "1.0.0");
  await fs.mkdir(packageDirectory, { recursive: true });
  await fs.writeFile(path.join(packageDirectory, "rabi.plugin.json"), JSON.stringify({ schemaVersion: 1, id: "example.web", version: "1.0.0", hosts: ["manager", "web"], entry: "./index.mjs", webEntry: "./client.mjs" }), "utf8");
  await fs.writeFile(path.join(packageDirectory, "index.mjs"), `
export function createPlugin(context) {
  return { instanceId: context.instanceId, manifest: { id: context.bundle.id, name: "Example", version: context.bundle.version, kind: "package", hosts: ["manager", "web"] }, scope: "global", contributions: [] };
}`, "utf8");
  await fs.writeFile(path.join(packageDirectory, "client.mjs"), "export function activate() {}", "utf8");
  return Object.freeze({ root, packageDirectory });
}

async function load(root: string, entries: readonly ProfileEntry[]) {
  return loadManagerPluginProfile({
    packageRoot: path.join(root, "packages"),
    runtimeRoot: path.join(root, "runtime"),
    profile: parseRabiPluginProfile({
      schemaVersion: 1,
      plugins: entries.map(entry => ({ id: entry.id, package: "example.web", version: "1.0.0", enabled: entry.enabled ?? true }))
    }),
    createServices: () => ({})
  });
}

test("Web module registry loads one Bundle graph for all active instances of one package revision", async () => {
  const value = await fixture();
  const registry = new WebPluginModuleRegistry(path.join(value.root, "runtime"));
  const instanceIds = ["manager:example-web-a", "manager:example-web-b"];
  const firstLoaded = await load(value.root, instanceIds.map(id => ({ id })));
  await registry.updateFromReconciliation(firstLoaded, { state: "idle", active: instanceIds });

  const [first] = registry.list();
  assert.ok(first);
  assert.equal(registry.list().length, 1);
  assert.match(first.id, /^web-[a-f0-9]{32}$/);
  assert.deepEqual(first.instances.map(instance => instance.instanceId), instanceIds);
  assert.match((await registry.read(first.id, first.rev, first.entryPath)).source.toString("utf8"), /activate/);

  await fs.writeFile(path.join(value.packageDirectory, "client.mjs"), "export function activate() { throw new Error('new revision failed'); }", "utf8");
  const changedLoaded = await load(value.root, instanceIds.map(id => ({ id })));
  await registry.updateFromReconciliation(changedLoaded, { state: "failed", active: instanceIds });
  assert.deepEqual(registry.list(), [first]);

  await registry.updateFromReconciliation(changedLoaded, { state: "idle", active: instanceIds });
  const [second] = registry.list();
  assert.ok(second);
  assert.equal(registry.list().length, 1);
  assert.equal(second.id, first.id);
  assert.notEqual(second.rev, first.rev);
  assert.deepEqual(second.instances.map(instance => instance.instanceId), instanceIds);
  assert.match((await registry.read(second.id, second.rev, second.entryPath)).source.toString("utf8"), /new revision failed/);
  assert.match((await registry.read(first.id, first.rev, first.entryPath)).source.toString("utf8"), /activate/);
});

test("Web module registry publishes only active instances and removes an empty Bundle graph", async () => {
  const value = await fixture();
  const registry = new WebPluginModuleRegistry(path.join(value.root, "runtime"));
  const loaded = await load(value.root, [
    { id: "manager:example-web-active" },
    { id: "manager:example-web-disabled", enabled: false }
  ]);
  await registry.updateFromReconciliation(loaded, { state: "idle", active: ["manager:example-web-active"] });
  assert.equal(registry.list().length, 1);
  assert.deepEqual(registry.list()[0]?.instances.map(instance => instance.instanceId), ["manager:example-web-active"]);

  await registry.updateFromReconciliation(loaded, { state: "idle", active: [] });
  assert.deepEqual(registry.list(), []);
});
