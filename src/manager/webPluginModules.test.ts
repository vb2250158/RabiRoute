import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { loadManagerPluginProfile } from "./managerPluginPackageLoader.js";
import { parseRabiPluginProfile } from "./pluginProfile.js";
import { WebPluginModuleRegistry } from "./webPluginModules.js";

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

async function load(root: string, enabled = true) {
  return loadManagerPluginProfile({
    packageRoot: path.join(root, "packages"),
    runtimeRoot: path.join(root, "runtime"),
    profile: parseRabiPluginProfile({ schemaVersion: 1, plugins: [{ id: "manager:example-web", package: "example.web", version: "1.0.0", enabled }] }),
    createServices: () => ({})
  });
}

test("Web module registry publishes only successfully active Bundle revisions", async () => {
  const value = await fixture();
  const registry = new WebPluginModuleRegistry(path.join(value.root, "runtime"));
  const firstLoaded = await load(value.root);
  await registry.updateFromReconciliation(firstLoaded, { state: "idle", active: ["manager:example-web"] });
  const first = registry.list()[0]!;
  assert.match(first.rev, /^[a-f0-9]{64}$/);
  assert.match((await registry.read(first.id, first.rev)).source.toString("utf8"), /activate/);

  await fs.writeFile(path.join(value.packageDirectory, "client.mjs"), "export function activate() { throw new Error('new revision failed'); }", "utf8");
  const changedLoaded = await load(value.root);
  await registry.updateFromReconciliation(changedLoaded, { state: "failed", active: ["manager:example-web"] });
  assert.deepEqual(registry.list(), [first]);
  assert.match((await registry.read(first.id, first.rev)).source.toString("utf8"), /activate/);

  await registry.updateFromReconciliation(changedLoaded, { state: "idle", active: ["manager:example-web"] });
  const second = registry.list()[0]!;
  assert.notEqual(second.rev, first.rev);
  assert.match((await registry.read(second.id, second.rev)).source.toString("utf8"), /new revision failed/);
  assert.match((await registry.read(first.id, first.rev)).source.toString("utf8"), /activate/);
});

test("Web module registry excludes disabled and waiting Manager instances", async () => {
  const value = await fixture();
  const registry = new WebPluginModuleRegistry(path.join(value.root, "runtime"));
  const disabled = await load(value.root, false);
  await registry.updateFromReconciliation(disabled, { state: "idle", active: [] });
  assert.deepEqual(registry.list(), []);
});
