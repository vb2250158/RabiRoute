import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { buildPluginPackages } from "./build-plugin-packages.mjs";

test("route-control package includes the Manager and independently generated Web command entry", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rabiroute-route-control-build-"));
  try {
    const pluginId = "io.rabiroute.manager.route-control";
    const source = path.resolve(import.meta.dirname, "../plugins/builtin", pluginId, "1.0.0");
    const packageRoot = path.join(root, "plugins", "builtin", pluginId, "1.0.0");
    await fs.cp(source, packageRoot, { recursive: true });
    await fs.mkdir(path.join(packageRoot, "web"), { recursive: true });
    await fs.writeFile(path.join(packageRoot, "web", "client.mjs"), "export function activate(api) { return () => {}; }\n");
    await fs.cp(path.resolve(import.meta.dirname, "../plugins/contracts/plugin-sdk"), path.join(root, "plugins", "contracts", "plugin-sdk"), { recursive: true });
    await writeJson(path.join(root, "plugins", "profiles", "desktop.json"), {
      schemaVersion: 2, readyRequires: [],
      instances: [{ id: "manager:route-control", package: pluginId, version: "1.0.0", enabled: true, config: {}, grants: [] }]
    });
    const built = await buildPluginPackages(root);
    const output = path.join(built.packagesRoot, pluginId, "1.0.0");
    const manifest = JSON.parse(await fs.readFile(path.join(output, "rabi.plugin.json"), "utf8"));
    assert.deepEqual(Object.keys(manifest.entries), ["manager", "web"]);
    assert.deepEqual(manifest.entries.web, { execution: "in_process", module: "./web/client.mjs" });
    assert.equal(typeof (await import(pathToFileURL(path.join(output, "web", "client.mjs")).href)).activate, "function");
    assert.match(await fs.readFile(path.join(output, "manager.mjs"), "utf8"), /\.rabi-deps\/plugin-sdk\/index\.mjs/);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

async function writeJson(target, value) {
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, JSON.stringify(value, null, 2) + "\n", "utf8");
}

test("plugin package builds preserve watched roots and remove stale packages", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rabiroute-plugin-build-"));
  try {
    const packageRoot = path.join(root, "plugins", "builtin", "io.test.plugin", "1.0.0");
    await writeJson(path.join(root, "plugins", "profiles", "desktop.json"), {
      schemaVersion: 2,
      readyRequires: [],
      instances: [{ id: "manager:test", package: "io.test.plugin", version: "1.0.0", enabled: true, config: {}, grants: [] }]
    });
    await writeJson(path.join(packageRoot, "rabi.plugin.json"), {
      schemaVersion: 2,
      id: "io.test.plugin",
      version: "1.0.0",
      entries: { manager: { execution: "in_process", module: "./manager.mjs" } },
      provides: ["test.plugin@1"],
      requires: [],
      optional: [],
      permissions: []
    });
    await fs.writeFile(path.join(packageRoot, "manager.mjs"), "import { definePlugin } from \"@rabiroute/plugin-sdk\"; export const activate = definePlugin({ activate() {} }).activate;\n", "utf8");
    await fs.writeFile(path.join(packageRoot, "README.md"), "test\n", "utf8");
    await fs.writeFile(path.join(packageRoot, "README_en.md"), "test\n", "utf8");
    await fs.mkdir(path.join(root, "plugins", "contracts", "plugin-sdk"), { recursive: true });
    await fs.writeFile(path.join(root, "plugins", "contracts", "plugin-sdk", "index.mjs"), "export const definePlugin = value => value;\n", "utf8");

    const watchedRoot = path.join(root, "dist", "plugins", "packages");
    await fs.mkdir(path.join(watchedRoot, "stale.plugin", "1.0.0"), { recursive: true });
    await fs.writeFile(path.join(watchedRoot, "watcher-marker.txt"), "keep", "utf8");
    const before = await fs.stat(watchedRoot);

    await buildPluginPackages(root);
    const after = await fs.stat(watchedRoot);
    assert.equal(after.ino, before.ino);
    assert.equal(await fs.readFile(path.join(watchedRoot, "watcher-marker.txt"), "utf8"), "keep");
    await assert.rejects(fs.access(path.join(watchedRoot, "stale.plugin")));
    const builtPackage = path.join(watchedRoot, "io.test.plugin", "1.0.0");
    const builtEntry = await fs.readFile(path.join(builtPackage, "manager.mjs"), "utf8");
    assert.match(builtEntry, /\.rabi-deps\/plugin-sdk\/index\.mjs/);
    assert.doesNotMatch(builtEntry, /@rabiroute\/plugin-sdk/);
    const materializedPackage = path.join(root, "separate-state", "runtime", "io.test.plugin", "1.0.0");
    await fs.mkdir(path.dirname(materializedPackage), { recursive: true });
    await fs.cp(builtPackage, materializedPackage, { recursive: true });
    const runtimeModule = await import(pathToFileURL(path.join(materializedPackage, "manager.mjs")).href);
    assert.equal(typeof runtimeModule.activate, "function");

    await fs.writeFile(path.join(packageRoot, "manager.mjs"), "export const activate = () => 'updated';\n", "utf8");
    await buildPluginPackages(root);
    assert.equal((await fs.stat(watchedRoot)).ino, before.ino);
    assert.match(await fs.readFile(path.join(watchedRoot, "io.test.plugin", "1.0.0", "manager.mjs"), "utf8"), /updated/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("plugin package publication restores the complete previous tree after a mid-commit failure", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rabiroute-plugin-build-rollback-"));
  try {
    const packageRoot = path.join(root, "plugins", "builtin", "io.test.plugin", "1.0.0");
    await writeJson(path.join(root, "plugins", "profiles", "desktop.json"), {
      schemaVersion: 2,
      readyRequires: [],
      instances: [{ id: "manager:test", package: "io.test.plugin", version: "1.0.0", enabled: true, config: {}, grants: [] }]
    });
    await writeJson(path.join(packageRoot, "rabi.plugin.json"), {
      schemaVersion: 2,
      id: "io.test.plugin",
      version: "1.0.0",
      entries: { manager: { execution: "in_process", module: "./manager.mjs" } },
      provides: ["test.plugin@1"],
      requires: [],
      optional: [],
      permissions: []
    });
    await fs.writeFile(path.join(packageRoot, "manager.mjs"), "export const activate = () => 'v1';\n", "utf8");
    await fs.mkdir(path.join(root, "plugins", "contracts", "plugin-sdk"), { recursive: true });
    await fs.writeFile(path.join(root, "plugins", "contracts", "plugin-sdk", "index.mjs"), "export const version = 'v1';\n", "utf8");
    await buildPluginPackages(root);

    const outputRoot = path.join(root, "dist", "plugins");
    async function snapshotTree(directory) {
      const rows = [];
      async function walk(current, relative = "") {
        for (const entry of (await fs.readdir(current, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
          const nextRelative = path.join(relative, entry.name);
          const full = path.join(current, entry.name);
          if (entry.isDirectory()) await walk(full, nextRelative);
          else rows.push(`${nextRelative.replaceAll("\\", "/")}\0${await fs.readFile(full, "utf8")}`);
        }
      }
      await walk(directory);
      return rows;
    }
    const before = await snapshotTree(outputRoot);
    await fs.writeFile(path.join(packageRoot, "manager.mjs"), "export const activate = () => 'v2';\n", "utf8");
    await fs.writeFile(path.join(root, "plugins", "contracts", "plugin-sdk", "index.mjs"), "export const version = 'v2';\n", "utf8");

    await assert.rejects(
      buildPluginPackages(root, {
        beforePublishStep({ step }) {
          if (step === 2) throw new Error("injected publish failure");
        }
      }),
      /injected publish failure/
    );
    assert.deepEqual(await snapshotTree(outputRoot), before);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
