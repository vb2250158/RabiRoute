import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL, fileURLToPath } from "node:url";
import { buildPluginPackages, finalizePluginBuildWebArtifacts } from "./build-plugin-packages.mjs";
import { execFileSync, spawn } from "node:child_process";
import { bundleMessageEndpointRuntime } from "./build-message-endpoint-runtime.mjs";

test("endpoint dependencies follow emitted owner reads and preserve explicit bare initialization imports", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "endpoint-emitted-owners-"));
  try {
    await fs.mkdir(path.join(root, "src/shared"), {recursive: true});
    await fs.writeFile(path.join(root, "src/endpoint.ts"), 'import { unused } from "./shared/unused.js"; import { used } from "./shared/used.js"; import "./shared/initialize.js"; export function run() { return used(); }');
    await fs.writeFile(path.join(root, "src/shared/unused.ts"), 'export const unused = "unrelated owner";');
    await fs.writeFile(path.join(root, "src/shared/used.ts"), 'export function used() { return "source owner must stay external"; }');
    await fs.writeFile(path.join(root, "src/shared/initialize.ts"), 'export const initialized = true;');
    const filename = path.join(root, "runtime.mjs");
    const bundle = await bundleMessageEndpointRuntime(root, {exports: [{source: "src/endpoint.ts", name: "run"}], ownedSources: ["src/endpoint.ts"]}, filename);
    assert.deepEqual(bundle.hostModules, ["shared/initialize", "shared/used"]);
    assert.equal(bundle.contents.includes(root), false, "Published bundle must not expose the build root");
    const relocated = path.join(root, "relocated");
    await fs.cp(path.join(root, "src"), path.join(relocated, "src"), {recursive: true});
    const rebuilt = await bundleMessageEndpointRuntime(relocated, {exports: [{source: "src/endpoint.ts", name: "run"}], ownedSources: ["src/endpoint.ts"]});
    assert.equal(rebuilt.contents, bundle.contents, "Identical endpoint sources must bundle identically across build directories");
    const reads = [];
    const implementation = (await import(pathToFileURL(filename).href)).createImplementation({module(id) {
      reads.push(id);
      if (id === "shared/unused") throw new Error("Unused owner must not initialize.");
      return id === "shared/used" ? {used: () => "injected original singleton"} : {};
    }});
    assert.equal(implementation.run(), "injected original singleton");
    assert.deepEqual(reads.sort(), ["shared/initialize", "shared/used"]);
  } finally {await fs.rm(root, {recursive: true, force: true});}
});

test("endpoint bundles own frozen implementation, module URL, resources and standalone worker bytes", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "endpoint-bundle-build-"));
  try {
    const plugin = path.join(root, "plugins/builtin/io.test.endpoint/1.0.0");
    await fs.mkdir(plugin, { recursive: true });
    await fs.mkdir(path.join(root, "src/shared"), { recursive: true });
    await fs.mkdir(path.join(root, "resources"), { recursive: true });
    await fs.writeFile(path.join(root, "src/endpoint.ts"), 'import { readShared } from "./shared/owner.js"; export function make() { return { value: readShared(), url: import.meta.url }; }');
    await fs.writeFile(path.join(root, "src/shared/owner.ts"), 'export function readShared() { return "host source must stay external"; }');
    await fs.writeFile(path.join(root, "src/worker.ts"), 'import { version } from "./workerValue.js"; console.log("worker-" + version);');
    await fs.writeFile(path.join(root, "src/workerValue.ts"), 'export const version = "frozen";');
    await fs.writeFile(path.join(root, "resources/install.ps1"), "frozen installer");
    await writeJson(path.join(root, "plugins/profiles/desktop.json"), { schemaVersion: 2, readyRequires: [], instances: [{ id: "endpoint:test", package: "io.test.endpoint", version: "1.0.0", enabled: true, config: {}, grants: [] }] });
    await writeJson(path.join(plugin, "rabi.plugin.json"), { schemaVersion: 2, id: "io.test.endpoint", version: "1.0.0", entries: { manager: { execution: "in_process", module: "./manager.mjs" } }, provides: [], requires: [], optional: [], permissions: [] });
    await fs.writeFile(path.join(plugin, "manager.mjs"), 'export function activate() {}');
    await writeJson(path.join(plugin, "manager-runtime.build.json"), { exports: [{ name: "make", source: "src/endpoint.ts" }],
      resources: [{ source: "resources/install.ps1", target: "resources/install.ps1" }], workers: [{ source: "src/worker.ts", target: "workers/run.mjs" }] });
    await fs.cp(path.resolve("plugins/contracts/plugin-sdk"), path.join(root, "plugins/contracts/plugin-sdk"), { recursive: true });
    const built = await buildPluginPackages(root, { afterInputSnapshot: async () => { await fs.writeFile(path.join(root, "resources/install.ps1"), "later source edit"); await fs.writeFile(path.join(root, "src/workerValue.ts"), 'export const version = "later";'); } });
    const output = path.join(built.packagesRoot, "io.test.endpoint/1.0.0");
    const generatedUrl = pathToFileURL(path.join(output, "manager-runtime.mjs")).href;
    const generated = await import(generatedUrl);
    assert.deepEqual(generated.hostModules, ["shared/owner"]);
    assert.deepEqual(generated.createImplementation({ module: id => { assert.equal(id, "shared/owner"); return { readShared: () => "actual host singleton" }; } }).make(), { value: "actual host singleton", url: generatedUrl });
    assert.equal(await fs.readFile(path.join(output, "resources/install.ps1"), "utf8"), "frozen installer");
    assert.equal(execFileSync(process.execPath, [path.join(output, "workers/run.mjs")], { encoding: "utf8", timeout: 5000, windowsHide: true }).trim(), "worker-frozen");
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

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

import { webPatchInputHash } from "./lib/web-patch-inputs.mjs";
import { inspectPluginBuild } from "./lib/developer-verification.mjs";

const digest = bytes => createHash("sha256").update(bytes).digest("hex");
const sourceScripts = path.dirname(fileURLToPath(import.meta.url));
async function put(filename, text) { await fs.mkdir(path.dirname(filename), { recursive: true }); await fs.writeFile(filename, text); }
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rabi-complete-web-evidence-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  for (const name of ["build-plugin-packages.mjs", "build-message-endpoint-runtime.mjs", "generate-plugin-api-types.mjs", "build-web-patch.mjs", "lib/web-patch-inputs.mjs"]) {
    await put(path.join(root, "scripts", name), await fs.readFile(path.join(sourceScripts, name)));
  }
  await put(path.join(root, "scripts/sync-plugin-web-bundles.mjs"), "// fixture wrapper owner\n");
  await put(path.join(root, "package.json"), '{"type":"module"}');
  await put(path.join(root, "ribiwebgui/src/entry.ts"), "export const view = 'original';\n");
  await put(path.join(root, "plugins/contracts/plugin-sdk/index.mjs"), "export const definePlugin = value => value;\n");
  await put(path.join(root, "plugins/profiles/desktop.json"), JSON.stringify({ schemaVersion: 2, readyRequires: [], instances: [
    { id: "feature", package: "io.test.feature", version: "1.2.3", enabled: true, config: {}, grants: [] }
  ] }));
  const native = path.join(root, "plugins/builtin/io.test.feature/1.2.3");
  await put(path.join(native, "rabi.plugin.json"), JSON.stringify({ schemaVersion: 2, id: "io.test.feature", version: "1.2.3", entries: {
    manager: { execution: "in_process", module: "./manager.mjs" }, web: { execution: "in_process", module: "./web/client.mjs" }
  }, provides: [], requires: [], optional: [], permissions: [] }));
  await put(path.join(native, "manager.mjs"), "export function activate() {}\n");
  const built = await buildPluginPackages(root);
  return { root, output: built.outputRoot, packageRoot: path.join(built.packagesRoot, "io.test.feature/1.2.3") };
}
async function webRevision(f, tag) {
  const entry = `web/assets/plugin-${tag}.js`, asset = `export function activate() { return '${tag}'; }\n`;
  const manifest = { schemaVersion: 1, backend: "a".repeat(64), files: [{ path: entry, size: Buffer.byteLength(asset), sha256: digest(asset) }],
    modules: [{ pluginId: "io.test.feature", version: "1.2.3", entry }] };
  const bytes = JSON.stringify(manifest), revision = digest(bytes), webRoot = path.join(f.root, "dist/web-patches", revision);
  await put(path.join(webRoot, entry), asset); await put(path.join(webRoot, "manifest.json"), bytes);
  await put(path.join(f.packageRoot, "web/client.mjs"), `export { activate } from "/assets/plugin-${tag}.js";\n`);
  return { webRevision: revision, webPatchRoot: webRoot, webSourceInputHash: await webPatchInputHash(f.root) };
}
async function cli(argv, cwd) {
  const child = spawn(process.execPath, argv, { cwd, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "", stderr = ""; child.stdout.on("data", b => { stdout += b; }); child.stderr.on("data", b => { stderr += b; });
  const exitCode = await new Promise((resolve, reject) => { child.once("error", reject); child.once("close", resolve); });
  return { exitCode, stdout, stderr };
}

test("full finalization covers generated wrappers and real CLI verification without weakening exact artifact inspection", async t => {
  const f = await fixture(t), options = await webRevision(f, "one");
  await assert.rejects(inspectPluginBuild(f.output), /contents differ from build evidence/);
  const before = JSON.parse(await fs.readFile(path.join(f.output, "build-evidence.json"), "utf8"));
  assert.ok(before.inputSelections.includes("plugins/contracts/plugin-sdk"));
  assert.ok(before.inputSelections.includes("plugins/builtin/io.test.feature/1.2.3"));
  const complete = await finalizePluginBuildWebArtifacts(f.root, options);
  assert.equal(complete.artifacts.files.length, before.artifacts.files.length + 1);
  assert.equal(complete.web.revision, options.webRevision); assert.equal(complete.web.sourceInputHash, options.webSourceInputHash);
  assert.equal(complete.web.wrappers[0].path, "packages/io.test.feature/1.2.3/web/client.mjs");
  assert.equal(complete.web.parentArtifactSha256, before.artifacts.sha256);
  assert.equal((await inspectPluginBuild(f.output)).candidateSha256, complete.artifacts.sha256);
  const testRoot = path.join(f.root, "behavior");
  await put(path.join(testRoot, "check.test.mjs"), "import fs from 'node:fs';import path from 'node:path';import assert from 'node:assert/strict';const base=path.join(process.env.RABI_PLUGIN_CANDIDATE_ROOT,'packages/io.test.feature/1.2.3');assert.equal(JSON.parse(fs.readFileSync(path.join(base,'rabi.plugin.json'))).version,'1.2.3');assert.match(fs.readFileSync(path.join(base,'web/client.mjs'),'utf8'),/plugin-one/);");
  const config = path.join(f.root, "verification.json");
  await put(config, JSON.stringify({ sourceRoot: testRoot, candidateRoot: f.output, inputs: ["check.test.mjs"], tests: ["check.test.mjs"], deterministic: false, completeInputClosure: false }));
  const result = await cli([path.join(sourceScripts, "verify-plugin-candidate.mjs"), "--config", config], f.root);
  assert.equal(result.exitCode, 0, result.stderr + result.stdout);
  assert.equal(JSON.parse(result.stdout).status, "passed");
  const next = await webRevision(f, "two");
  const updated = await finalizePluginBuildWebArtifacts(f.root, next);
  assert.notEqual(updated.artifacts.sha256, complete.artifacts.sha256);
  assert.equal((await inspectPluginBuild(f.output)).candidateSha256, updated.artifacts.sha256);
  await put(path.join(f.packageRoot, "unexpected-extra.mjs"), "unverified");
  await assert.rejects(inspectPluginBuild(f.output), /contents differ/);
});

test("finalization rejects unrelated additions, backend mutation, wrong module binding and changed source without replacing original evidence", async t => {
  const f = await fixture(t), options = await webRevision(f, "one"), receipt = path.join(f.output, "build-evidence.json");
  const originalReceipt = await fs.readFile(receipt);
  const unchanged = async action => { await action(); assert.deepEqual(await fs.readFile(receipt), originalReceipt); };
  const legacy = JSON.parse(originalReceipt); delete legacy.inputSelections;
  await fs.writeFile(receipt, JSON.stringify(legacy));
  const legacyBytes = await fs.readFile(receipt);
  await assert.rejects(finalizePluginBuildWebArtifacts(f.root, options), /rebuild Native plugins/);
  assert.deepEqual(await fs.readFile(receipt), legacyBytes); await fs.writeFile(receipt, originalReceipt);
  // The original Web workflow remains independent when Native source membership changes.
  await fs.symlink(path.resolve(sourceScripts, "../node_modules"), path.join(f.root, "node_modules"), "junction");
  await put(path.join(f.root, "dist/manager/webPatchCatalog.js"), `import fs from 'node:fs/promises';import path from 'node:path';export const buildWebPatch=async()=> '${options.webRevision}';export async function writeWebPatchJson(file,value){await fs.mkdir(path.dirname(file),{recursive:true});await fs.writeFile(file,JSON.stringify(value));}`);
  const marker = path.join(f.root, "dist/web-patches/latest.json");
  const webCommand = path.join(f.root, "scripts/build-web-patch.mjs");
  for (const relative of ["plugins/contracts/plugin-sdk/added-after-build.mjs", "plugins/builtin/io.test.feature/1.2.3/added-after-build.mjs"]) {
    const added = path.join(f.root, relative); await put(added, "export const added = true;\n");
    const independent = await cli([webCommand], f.root); assert.equal(independent.exitCode, 0, independent.stderr);
    const oldMarker = await fs.readFile(marker);
    const rejected = await cli([webCommand, "--finalize-plugin-build"], f.root);
    assert.equal(rejected.exitCode, 1); assert.match(rejected.stderr, /backend inputs changed/);
    assert.deepEqual(await fs.readFile(marker), oldMarker); assert.deepEqual(await fs.readFile(receipt), originalReceipt);
    await fs.unlink(added);
  }
  const extra = path.join(f.packageRoot, "extra.mjs"); await put(extra, "unverified");
  await unchanged(() => assert.rejects(finalizePluginBuildWebArtifacts(f.root, options), /Unrecorded plugin artifact/)); await fs.unlink(extra);
  const backend = path.join(f.packageRoot, "manager.mjs"), backendBytes = await fs.readFile(backend); await fs.writeFile(backend, "mutated");
  await unchanged(() => assert.rejects(finalizePluginBuildWebArtifacts(f.root, options), /backend artifact changed/)); await fs.writeFile(backend, backendBytes);
  const wrapper = path.join(f.packageRoot, "web/client.mjs"), wrapperBytes = await fs.readFile(wrapper); await fs.writeFile(wrapper, 'export { activate } from "/assets/foreign.js";\n');
  await unchanged(() => assert.rejects(finalizePluginBuildWebArtifacts(f.root, options), /differs from its verified Web module/)); await fs.writeFile(wrapper, wrapperBytes);
  const source = path.join(f.root, "ribiwebgui/src/entry.ts"), sourceBytes = await fs.readFile(source); await fs.writeFile(source, "later source");
  await unchanged(() => assert.rejects(finalizePluginBuildWebArtifacts(f.root, options), /Web sources changed/)); await fs.writeFile(source, sourceBytes);
  await finalizePluginBuildWebArtifacts(f.root, options);
  assert.ok((await inspectPluginBuild(f.output)).candidateSha256);
});

test("independent Web CLI does not require native evidence and full finalization failure preserves the original latest marker", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rabi-web-only-evidence-")); t.after(() => fs.rm(root, { recursive: true, force: true }));
  await put(path.join(root, "package.json"), '{"type":"module"}');
  for (const name of ["build-web-patch.mjs", "lib/web-patch-inputs.mjs"]) await put(path.join(root, "scripts", name), await fs.readFile(path.join(sourceScripts, name)));
  await put(path.join(root, "dist/manager/webPatchCatalog.js"), `import fs from 'node:fs/promises';import path from 'node:path';export const buildWebPatch=async()=> '${"b".repeat(64)}';export async function writeWebPatchJson(file,value){await fs.mkdir(path.dirname(file),{recursive:true});await fs.writeFile(file,JSON.stringify(value));}`);
  const command = path.join(root, "scripts/build-web-patch.mjs"), marker = path.join(root, "dist/web-patches/latest.json");
  const webOnly = await cli([command], root); assert.equal(webOnly.exitCode, 0, webOnly.stderr);
  const previous = await fs.readFile(marker); assert.equal(JSON.parse(previous).revision, "b".repeat(64));
  const complete = await cli([command, "--finalize-plugin-build"], root);
  assert.equal(complete.exitCode, 1); assert.deepEqual(await fs.readFile(marker), previous);
  const packageScripts = JSON.parse(await fs.readFile(new URL("../package.json", import.meta.url), "utf8")).scripts;
  assert.ok(packageScripts.build.endsWith("npm run webgui:build -- --finalize-plugin-build"));
  assert.ok(!packageScripts["webgui:build"].includes("finalize-plugin-build"));
});
