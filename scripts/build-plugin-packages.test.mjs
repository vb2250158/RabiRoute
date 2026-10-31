import assert from "node:assert/strict";
import { createHash } from "node:crypto";
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

async function createSelectionFixture(root) {
  await writeJson(path.join(root, "plugins/profiles/desktop.json"), {
    schemaVersion: 2, readyRequires: [],
    instances: ["one", "two"].map(id => ({ id, package: `io.test.${id}`, version: "1.0.0", enabled: true, config: {}, grants: [] }))
  });
  for (const id of ["one", "two"]) {
    const directory = path.join(root, "plugins/builtin", `io.test.${id}`, "1.0.0");
    await writeJson(path.join(directory, "rabi.plugin.json"), {
      schemaVersion: 2, id: `io.test.${id}`, version: "1.0.0",
      entries: { manager: { execution: "in_process", module: "./manager.mjs" } }, provides: [], requires: [], optional: [], permissions: []
    });
    await fs.writeFile(path.join(directory, "manager.mjs"), 'import { definePlugin } from "@rabiroute/plugin-sdk"; export const activate = definePlugin({ activate() {} }).activate;');
  }
  await fs.mkdir(path.join(root, "plugins/contracts/plugin-sdk"), { recursive: true });
  await fs.writeFile(path.join(root, "plugins/contracts/plugin-sdk/index.mjs"), "export const definePlugin = value => value;");
}

test("selected package output matches full build and preserves unrelated candidates without claiming a complete profile", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rabi-selected-build-"));
  try {
    await createSelectionFixture(root);
    const full = await buildPluginPackages(root);
    const outputDirectory = path.join(root, "candidates/one");
    await fs.mkdir(path.join(outputDirectory, "packages/unrelated/old"), { recursive: true });
    await fs.writeFile(path.join(outputDirectory, "packages/unrelated/old/keep.txt"), "keep");
    const built = await buildPluginPackages(root, { packages: ["io.test.one"], outputDirectory });
    assert.deepEqual(built.copied, ["io.test.one@1.0.0"]);
    assert.deepEqual(await fs.readFile(path.join(built.packagesRoot, "io.test.one/1.0.0/manager.mjs")), await fs.readFile(path.join(full.packagesRoot, "io.test.one/1.0.0/manager.mjs")));
    assert.equal(await fs.readFile(path.join(outputDirectory, "packages/unrelated/old/keep.txt"), "utf8"), "keep");
    await assert.rejects(fs.access(path.join(built.profilesRoot, "desktop.json")));
    await assert.rejects(fs.access(path.join(built.packagesRoot, "io.test.two")));
    const evidence = JSON.parse(await fs.readFile(path.join(outputDirectory, "build-evidence.json"), "utf8"));
    assert.equal(evidence.scope, "selected-packages");
    assert.ok(evidence.timing.totalMs >= evidence.timing.preparedMs);
    assert.ok(evidence.artifacts.files.every(file => !file.path.includes("unrelated")));
    assert.match(evidence.verification, /build-only/);
    const loaded = await import(pathToFileURL(path.join(built.packagesRoot, "io.test.one/1.0.0/manager.mjs")));
    assert.equal(typeof loaded.activate, "function");
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test("selected builds track changed and removed package files and SDK inputs", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rabi-build-evidence-"));
  try {
    await createSelectionFixture(root);
    const options = { packages: ["io.test.one"], outputDirectory: path.join(root, "candidate") };
    const source = path.join(root, "plugins/builtin/io.test.one/1.0.0/resource.txt");
    async function hash() {
      await buildPluginPackages(root, options);
      return JSON.parse(await fs.readFile(path.join(options.outputDirectory, "build-evidence.json"))).inputs.sha256;
    }
    await fs.writeFile(source, "a");
    const first = await hash();
    await fs.writeFile(source, "b");
    const second = await hash();
    assert.notEqual(first, second);
    await fs.rm(source);
    const third = await hash();
    assert.notEqual(second, third);
    await assert.rejects(fs.access(path.join(options.outputDirectory, "packages/io.test.one/1.0.0/resource.txt")));
    await fs.appendFile(path.join(root, "plugins/contracts/plugin-sdk/index.mjs"), "\n// SDK change");
    assert.notEqual(third, await hash());
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test("target selection cannot replace the full output or source tree", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rabi-build-paths-"));
  try {
    await createSelectionFixture(root);
    for (const outputDirectory of [undefined, "dist/plugins", "dist", "plugins", "src/generated"]) {
      await assert.rejects(buildPluginPackages(root, { packages: ["io.test.one"], outputDirectory }), /separate|source inputs/);
    }
    await assert.rejects(buildPluginPackages(root, { packages: ["missing"], outputDirectory: "candidate" }), /not in the build profile/);
    await writeJson(path.join(root, "old-full/profiles/desktop.json"), { keep: true });
    await assert.rejects(buildPluginPackages(root, { packages: ["io.test.one"], outputDirectory: "old-full" }), /full profile/);
    assert.deepEqual(JSON.parse(await fs.readFile(path.join(root, "old-full/profiles/desktop.json"))), { keep: true });
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test("API type generation writes staged SDK without changing source files", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rabi-build-generated-"));
  try {
    await createSelectionFixture(root);
    const contract = path.resolve(import.meta.dirname, "../src/manager/apiOperationContract.ts");
    await fs.mkdir(path.join(root, "src/manager"), { recursive: true });
    await fs.copyFile(contract, path.join(root, "src/manager/apiOperationContract.ts"));
    const sourceTypes = path.join(root, "plugins/contracts/plugin-sdk/api-operation-contract.d.ts");
    await fs.writeFile(sourceTypes, "original source remains");
    const built = await buildPluginPackages(root, { packages: ["io.test.one"], outputDirectory: "candidate" });
    assert.equal(await fs.readFile(sourceTypes, "utf8"), "original source remains");
    assert.match(await fs.readFile(path.join(built.outputRoot, "contracts/plugin-sdk/api-operation-contract.d.ts"), "utf8"), /export type ApiMethod/);
    const evidence = JSON.parse(await fs.readFile(path.join(built.outputRoot, "build-evidence.json")));
    assert.ok(evidence.inputs.files.some(file => file.path === "src/manager/apiOperationContract.ts"));
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});


test("linked output ancestors cannot redirect a build into source inputs", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rabi-build-links-"));
  try {
    await createSelectionFixture(root);
    await fs.mkdir(path.join(root, "src"));
    await fs.writeFile(path.join(root, "src/keep.txt"), "source");
    await fs.symlink(path.join(root, "src"), path.join(root, "source-link"), "junction");
    await assert.rejects(buildPluginPackages(root, { packages: ["io.test.one"], outputDirectory: "source-link/nested/output" }), /source inputs/);
    assert.equal(await fs.readFile(path.join(root, "src/keep.txt"), "utf8"), "source");
    await assert.rejects(fs.access(path.join(root, "src/nested")));
    await fs.mkdir(path.join(root, "owned-output"));
    await fs.symlink(path.join(root, "owned-output"), path.join(root, "safe-link"), "junction");
    const result = await buildPluginPackages(root, { packages: ["io.test.one"], outputDirectory: "safe-link/candidate" });
    const evidence = JSON.parse(await fs.readFile(path.join(result.outputRoot, "build-evidence.json")));
    assert.match(evidence.toolchain.typescript, /^\d+\./);
    await fs.symlink(path.join(root, "src"), path.join(result.packagesRoot, "outside"), "junction");
    await assert.rejects(buildPluginPackages(root, { packages: ["io.test.one"], outputDirectory: "safe-link/candidate" }), /escapes its owned directory/);
    assert.equal(await fs.readFile(path.join(root, "src/keep.txt"), "utf8"), "source");
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});


test("input evidence follows frozen bytes while editable sources change and return", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rabi-build-frozen-"));
  try {
    await createSelectionFixture(root);
    const relative = "plugins/builtin/io.test.one/1.0.0/resource.txt";
    const source = path.join(root, relative);
    await fs.writeFile(source, "A");
    const built = await buildPluginPackages(root, {
      packages: ["io.test.one"], outputDirectory: "candidate",
      async afterInputSnapshot() { await fs.writeFile(source, "B"); },
      async beforePublishStep() { await fs.writeFile(source, "A"); }
    });
    const artifact = await fs.readFile(path.join(built.packagesRoot, "io.test.one/1.0.0/resource.txt"));
    assert.equal(artifact.toString(), "A");
    const evidence = JSON.parse(await fs.readFile(path.join(built.outputRoot, "build-evidence.json")));
    assert.equal(evidence.inputs.files.find(file => file.path === relative).sha256, createHash("sha256").update(artifact).digest("hex"));
    assert.equal(await fs.readFile(source, "utf8"), "A");
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
