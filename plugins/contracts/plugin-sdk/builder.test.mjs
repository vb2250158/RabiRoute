import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { once } from "node:events";
import { Worker } from "node:worker_threads";
import ts from "typescript";
import { buildPluginPackage } from "./builder.mjs";

async function fixture(t, moduleId = "config") {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "rabi-plugin-source-"));
  t.after(() => fs.rm(temporary, { recursive: true, force: true }));
  const source = path.join(temporary, "source");
  await fs.mkdir(source);
  await fs.writeFile(path.join(source, "rabi.plugin.json"), JSON.stringify({ schemaVersion: 2, id: "example.independent", version: "0.1.1", entries: { manager: { execution: "in_process", module: "./manager.mjs" } } }));
  await fs.writeFile(path.join(source, "manager.mjs"), "export function activate() {}\n");
  await fs.writeFile(path.join(source, "feature.ts"), `import { config } from "@rabiroute/host-api/${moduleId}";\nexport function readOriginal() { return config; }\n`);
  await fs.writeFile(path.join(source, "manager-runtime.build.json"), JSON.stringify({ exports: [{ source: "feature.ts", name: "readOriginal" }] }));
  const hostApiPath = path.join(temporary, "host-exports.json");
  await fs.writeFile(hostApiPath, JSON.stringify({ schemaVersion: 1, modules: { config: { exports: ["config"] } } }));
  return { source, hostApiPath, output: path.join(temporary, "candidate") };
}

test("independent source build uses only a published signature and preserves original shared state identity", async t => {
  const f = await fixture(t);
  const evidence = await buildPluginPackage({ pluginRoot: f.source, outputDirectory: f.output, hostApiPath: f.hostApiPath });
  assert.deepEqual(evidence.runtimes[0].hostModules, ["config"]);
  const compiled = await import(pathToFileURL(path.join(f.output, "manager-runtime.mjs")).href);
  const shared = { version: 1 };
  const implementation = compiled.createImplementation({ module(id) { assert.equal(id, "config"); return { config: shared }; } });
  assert.equal(implementation.readOriginal(), shared);
  shared.version = 2;
  assert.equal(implementation.readOriginal().version, 2);
  assert.ok(evidence.runtimes[0].inputs.every(input => !input.includes("host-api/") && !input.includes("host-exports")));
});

test("a descriptor can expose an original shared host value without copying its implementation", async t => {
  const f = await fixture(t);
  await fs.writeFile(path.join(f.source, "manager-runtime.build.json"), JSON.stringify({ exports: [{ hostModule: "config", exportName: "config", name: "readOriginal" }] }));
  const built = await buildPluginPackage({ pluginRoot: f.source, outputDirectory: f.output, hostApiPath: f.hostApiPath });
  const compiled = await import(pathToFileURL(path.join(f.output, "manager-runtime.mjs")).href);
  const shared = { version: 1 };
  assert.equal(compiled.createImplementation({ module: () => ({ config: shared }) }).readOriginal, shared);
  assert.deepEqual(built.runtimes[0].hostModules, ["config"]);
  assert.ok(built.runtimes[0].inputs.every(input => !input.endsWith("feature.ts")));
});

test("an unpublished host dependency fails this candidate and leaves source recoverable", async t => {
  const f = await fixture(t, "unpublished-owner");
  const before = await fs.readFile(path.join(f.source, "feature.ts"), "utf8");
  await assert.rejects(buildPluginPackage({ pluginRoot: f.source, outputDirectory: f.output, hostApiPath: f.hostApiPath }), /Shared host API module is not published/);
  assert.equal(await fs.readFile(path.join(f.source, "feature.ts"), "utf8"), before);
  await assert.rejects(fs.access(f.output), { code: "ENOENT" });
});

test("owned imports declare their direct dependency while third-party internals resolve inside that package", async t => {
  const f = await fixture(t);
  await fs.writeFile(path.join(f.source, "feature.ts"), 'import { value } from "example-dependency"; export const readOriginal = () => value;');
  const dependency = path.join(f.source, "node_modules/example-dependency");
  await fs.mkdir(dependency, { recursive: true });
  await fs.writeFile(path.join(dependency, "package.json"), JSON.stringify({ name: "example-dependency", type: "module", main: "index.js" }));
  await fs.writeFile(path.join(dependency, "index.js"), 'export { value } from "./value.js";');
  await fs.writeFile(path.join(dependency, "value.js"), 'export const value = 42;');
  await assert.rejects(buildPluginPackage({ pluginRoot: f.source, outputDirectory: f.output, hostApiPath: f.hostApiPath }), /Declare direct plugin dependency.*example-dependency/);
  await assert.rejects(fs.access(f.output), { code: "ENOENT" });
  await fs.writeFile(path.join(f.source, "package.json"), JSON.stringify({ dependencies: { "example-dependency": "1.0.0" } }));
  await buildPluginPackage({ pluginRoot: f.source, outputDirectory: f.output, hostApiPath: f.hostApiPath });
  const compiled = await import(pathToFileURL(path.join(f.output, "manager-runtime.mjs")).href);
  assert.equal(compiled.createImplementation({}).readOriginal(), 42);
});

test("an existing candidate is preserved and requires an explicit fresh output", async t => {
  const f = await fixture(t);
  await fs.mkdir(f.output);
  await fs.writeFile(path.join(f.output, "receipt.txt"), "original candidate");
  await assert.rejects(buildPluginPackage({ pluginRoot: f.source, outputDirectory: f.output, hostApiPath: f.hostApiPath }), /output already exists/);
  assert.equal(await fs.readFile(path.join(f.output, "receipt.txt"), "utf8"), "original candidate");
});

test("absolute owned sources build while absolute and worker source escapes are rejected", async t => {
  const f = await fixture(t);
  const helper = path.join(f.source, "owned-helper.ts");
  const outside = path.join(path.dirname(f.source), "outside-owner.ts");
  await fs.writeFile(helper, "export const value = 7;");
  await fs.writeFile(outside, "export const value = 42;");
  const feature = file => `import { value } from ${JSON.stringify(file)}; export const readOriginal = () => value;`;
  await fs.writeFile(path.join(f.source, "feature.ts"), feature(helper));
  await buildPluginPackage({ pluginRoot: f.source, outputDirectory: f.output, hostApiPath: f.hostApiPath });
  const good = await fs.readFile(path.join(f.output, "manager-runtime.mjs"), "utf8");
  await fs.writeFile(path.join(f.source, "feature.ts"), feature(outside));
  await assert.rejects(buildPluginPackage({ pluginRoot: f.source, outputDirectory: f.output, hostApiPath: f.hostApiPath }), /outside its source folder/);
  assert.equal(await fs.readFile(path.join(f.output, "manager-runtime.mjs"), "utf8"), good);
  await fs.writeFile(path.join(f.source, "feature.ts"), feature(helper));
  await fs.writeFile(path.join(f.source, "worker.ts"), 'import "../outside-owner.ts";');
  await fs.writeFile(path.join(f.source, "manager-runtime.build.json"), JSON.stringify({ exports: [{ source: "feature.ts", name: "readOriginal" }],
    workers: [{ source: "worker.ts", target: "workers/probe.mjs" }] }));
  await assert.rejects(buildPluginPackage({ pluginRoot: f.source, outputDirectory: f.output, hostApiPath: f.hostApiPath }), /outside its source folder/);
  assert.equal(await fs.readFile(path.join(f.output, "manager-runtime.mjs"), "utf8"), good);
});

test("private and self imports use their actual owner while aliased third-party imports still require a dependency", async t => {
  const f = await fixture(t);
  const metadata = { name: "example.independent", type: "module", imports: { "#owned": "./owned-helper.ts", "#third": "example-dependency", "#node": "node:path" },
    exports: { "./helper": "./owned-helper.ts" } };
  await fs.writeFile(path.join(f.source, "package.json"), JSON.stringify(metadata));
  await fs.writeFile(path.join(f.source, "owned-helper.ts"), "export const value = 7;");
  await fs.writeFile(path.join(f.source, "feature.ts"), 'import { value as privateValue } from "#owned"; import { value as selfValue } from "example.independent/helper"; import { basename } from "#node"; export const readOriginal = () => privateValue + selfValue + (basename("fixture/name") === "name" ? 0 : 1);');
  await buildPluginPackage({ pluginRoot: f.source, outputDirectory: f.output, hostApiPath: f.hostApiPath });
  const compiled = await import(pathToFileURL(path.join(f.output, "manager-runtime.mjs")).href);
  assert.equal(compiled.createImplementation({}).readOriginal(), 14);
  const dependency = path.join(f.source, "node_modules/example-dependency");
  await fs.mkdir(dependency, { recursive: true });
  await fs.writeFile(path.join(dependency, "package.json"), JSON.stringify({ name: "example-dependency", type: "module", main: "index.js" }));
  await fs.writeFile(path.join(dependency, "index.js"), "export const value = 42;");
  await fs.writeFile(path.join(f.source, "feature.ts"), 'import { value } from "#third"; export const readOriginal = () => value;');
  await assert.rejects(buildPluginPackage({ pluginRoot: f.source, outputDirectory: f.output, hostApiPath: f.hostApiPath }), /Declare direct plugin dependency.*example-dependency/);
  await fs.writeFile(path.join(f.source, "package.json"), JSON.stringify({ ...metadata, dependencies: { "example-dependency": "1.0.0" } }));
  await buildPluginPackage({ pluginRoot: f.source, outputDirectory: f.output, hostApiPath: f.hostApiPath });
  const rebuilt = await import(pathToFileURL(path.join(f.output, "manager-runtime.mjs")).href + "?aliased-third-party");
  assert.equal(rebuilt.createImplementation({}).readOriginal(), 42);
});

test("native modules and independent bundles resolve owned assets and descriptor-mapped workers", async t => {
  const f = await fixture(t);
  await fs.mkdir(path.join(f.source, "src"));
  await fs.mkdir(path.join(f.source, "assets"));
  await fs.writeFile(path.join(f.source, "assets/value.txt"), "original resource bytes");
  await fs.writeFile(path.join(f.source, "package.json"), JSON.stringify({ type: "module" }));
  const feature = 'import { readFileSync } from "node:fs"; export function readAsset() { return readFileSync(new URL("../assets/value.txt", import.meta.url), "utf8"); } export function workerUrl() { return new URL(import.meta.url.endsWith(".ts") ? "./worker.ts" : "./worker.js", import.meta.url).href; } export function sourcePaths() { return { url: import.meta.url, filename: import.meta.filename, dirname: import.meta.dirname, ts: import.meta.url.endsWith(".ts") }; } export const literal = "import.meta.url";';
  const workerSource = 'import { parentPort } from "node:worker_threads"; import { readFileSync } from "node:fs"; parentPort.postMessage(readFileSync(new URL("../assets/value.txt", import.meta.url), "utf8"));';
  for (const [name, source] of [["feature", feature], ["worker", workerSource]]) {
    await fs.writeFile(path.join(f.source, "src", name + ".ts"), source);
    await fs.writeFile(path.join(f.source, "src", name + ".js"), ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText);
  }
  const native = await import(pathToFileURL(path.join(f.source, "src/feature.js")).href);
  assert.equal(native.readAsset(), "original resource bytes");
  assert.equal(native.literal, "import.meta.url");
  await fs.writeFile(path.join(f.source, "manager-runtime.build.json"), JSON.stringify({ exports: ["readAsset", "workerUrl", "sourcePaths", "literal"].map(name => ({ source: "src/feature.ts", name })), workers: [{ source: "src/worker.ts", target: "workers/probe.mjs" }] }));
  await buildPluginPackage({ pluginRoot: f.source, outputDirectory: f.output, hostApiPath: f.hostApiPath });
  const bundled = await import(pathToFileURL(path.join(f.output, "manager-runtime.mjs")).href);
  const implementation = bundled.createImplementation({ module() { throw new Error("Resource fixture needs no host modules."); } });
  assert.equal(implementation.readAsset(), native.readAsset());
  assert.equal(implementation.literal, "import.meta.url");
  assert.equal(implementation.sourcePaths().ts, false);
  assert.equal(implementation.sourcePaths().filename, path.join(f.output, "src/feature.js"));
  assert.equal(implementation.sourcePaths().dirname, path.join(f.output, "src"));
  assert.match(implementation.workerUrl(), /\/workers\/probe\.mjs$/);
  const worker = new Worker(new URL(implementation.workerUrl()));
  const [[message], [exitCode]] = await Promise.all([once(worker, "message"), once(worker, "exit")]);
  assert.equal(message, "original resource bytes");
  assert.equal(exitCode, 0);
});

test("a second owned build replaces its output and a failed rebuild preserves the last good bytes", async t => {
  const f = await fixture(t);
  const options = { pluginRoot: f.source, outputDirectory: f.output, hostApiPath: f.hostApiPath };
  await buildPluginPackage(options);
  await fs.writeFile(path.join(f.output, "stale-artifact.txt"), "old");
  await fs.appendFile(path.join(f.source, "feature.ts"), "\nexport const newValue = 2;\n");
  await buildPluginPackage(options);
  await assert.rejects(fs.access(path.join(f.output, "stale-artifact.txt")), { code: "ENOENT" });
  const good = await fs.readFile(path.join(f.output, "manager-runtime.mjs"), "utf8");
  await fs.writeFile(path.join(f.source, "feature.ts"), 'import { secret } from "@rabiroute/host-api/unpublished-owner"; export const readOriginal = secret;');
  await assert.rejects(buildPluginPackage(options), /Shared host API module is not published/);
  assert.equal(await fs.readFile(path.join(f.output, "manager-runtime.mjs"), "utf8"), good);
  assert.equal(JSON.parse(await fs.readFile(path.join(f.output, "build-evidence.json"), "utf8")).packageId, "example.independent");
});

test("an explicit scanner worker factory exports owned scans using only its process-local host ports", async t => {
  const f = await fixture(t);
  await fs.mkdir(path.join(f.source, "src"));
  await fs.writeFile(path.join(f.source, "src/scanner.ts"), 'import { config } from "@rabiroute/host-api/config"; export function scanOwned(context, options) { return { context, options, original: config, url: import.meta.url }; }');
  await fs.writeFile(path.join(f.source, "manager-runtime.build.json"), JSON.stringify({
    exports: [{ source: "feature.ts", name: "readOriginal" }],
    workers: [{ source: "src/scanner.ts", target: "workers/scan.mjs", mode: "host-factory" }]
  }));
  const evidence = await buildPluginPackage({ pluginRoot: f.source, outputDirectory: f.output, hostApiPath: f.hostApiPath });
  const worker = await import(pathToFileURL(path.join(f.output, "workers/scan.mjs")).href);
  assert.deepEqual(worker.hostModules, ["config"]);
  const workerState = { process: "worker-only" };
  const own = worker.createImplementation({ module(id) { assert.equal(id, "config"); return { config: workerState }; } });
  const context = { rootDir: "fixture" }, options = { query: "probe" };
  const result = own.scanOwned(context, options);
  assert.equal(result.context, context); assert.equal(result.options, options); assert.equal(result.original, workerState);
  assert.equal(result.url, pathToFileURL(path.join(f.output, "src/scanner.js")).href);
  assert.equal(evidence.runtimes[1].descriptor, "manager-runtime.build.json#workers/scan.mjs");
});


test("published plugin catalogs remain readable while account and runtime records stay private", async t => {
  const f = await fixture(t);
  const catalog = { schemaVersion: 1, capabilities: ["fixture-video"] };
  await fs.writeFile(path.join(f.source, "catalog.json"), JSON.stringify(catalog));
  await fs.writeFile(path.join(f.source, "manager.mjs"), 'import { readFileSync } from "node:fs"; export function activate() { return JSON.parse(readFileSync(new URL("./catalog.json", import.meta.url), "utf8")); }');
  await fs.writeFile(path.join(f.source, "credentials.json"), JSON.stringify({ fixture: true }));
  await fs.mkdir(path.join(f.source, "data"));
  await fs.writeFile(path.join(f.source, "data/catalog.json"), JSON.stringify({ fixture: true }));
  await buildPluginPackage({ pluginRoot: f.source, outputDirectory: f.output, hostApiPath: f.hostApiPath });
  const manager = await import(pathToFileURL(path.join(f.output, "manager.mjs")).href);
  assert.deepEqual(manager.activate(), catalog);
  assert.deepEqual(await fs.readFile(path.join(f.output, "catalog.json")), await fs.readFile(path.join(f.source, "catalog.json")));
  await assert.rejects(fs.access(path.join(f.output, "credentials.json")), { code: "ENOENT" });
  await assert.rejects(fs.access(path.join(f.output, "data/catalog.json")), { code: "ENOENT" });
});


test("plugin source export excludes local runtime and executable-resource build dependencies", async t => {
  const f = await fixture(t);
  for (const name of [".deps", ".builddeps"]) {
    await fs.mkdir(path.join(f.source, name));
    await fs.writeFile(path.join(f.source, name, "fixture-helper.py"), "fixture = True\n");
  }
  await buildPluginPackage({ pluginRoot: f.source, outputDirectory: f.output, hostApiPath: f.hostApiPath });
  for (const name of [".deps", ".builddeps"]) {
    await assert.rejects(fs.access(path.join(f.output, name)), { code: "ENOENT" });
  }
});

test("standalone runtime copying excludes development tests without changing public source export", async t => {
  const f = await fixture(t);
  const blocked = ["src/relay.test.ts", "src/feature.spec.mjs", "entry.fixture.mjs", "src/__tests__/helper.ts", "src/__tests__/证据.ts", "test/helper.mjs", "tests/helper.ts", "__fixtures__/helper.mjs", "test_media.py", "helpers_test.py", "conftest.py", "Invoke-Plugin.Tests.ps1"];
  const publicFiles = ["src/auth/authorize.ts", "src/auth/catalog.ts", "src/test-policy.ts", "assets/fixtures/catalog.json", "catalog.json", "config.schema.json"];
  for (const name of [...blocked, ...publicFiles]) { const file = path.join(f.source, name); await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, name); }
  await buildPluginPackage({ pluginRoot: f.source, outputDirectory: f.output, hostApiPath: f.hostApiPath });
  for (const name of blocked) await assert.rejects(fs.access(path.join(f.output, name)), { code: "ENOENT" }, name);
  for (const name of publicFiles) assert.equal(await fs.readFile(path.join(f.output, name), "utf8"), name);
  const { copyPluginPublicSource } = await import("./public-source.mjs");
  const exported = path.join(path.dirname(f.source), "exported");
  await copyPluginPublicSource(f.source, exported);
  for (const name of [...blocked, ...publicFiles]) assert.equal(await fs.readFile(path.join(exported, name), "utf8"), name);
});


test("runtime entries load the embedded SDK from root and nested entry folders", async t => {
  const f = await fixture(t);
  const manifest = JSON.parse(await fs.readFile(path.join(f.source, "rabi.plugin.json"), "utf8"));
  manifest.entries.gateway = { execution: "in_process", module: "./nested/gateway.mjs" };
  await fs.mkdir(path.join(f.source, "nested"));
  const entry = 'import { definePlugin } from "@rabiroute/plugin-sdk"; export const activate = definePlugin({ activate() { return "embedded SDK loaded"; } }).activate;\n';
  await fs.writeFile(path.join(f.source, "manager.mjs"), entry);
  await fs.writeFile(path.join(f.source, "nested/gateway.mjs"), entry);
  await fs.writeFile(path.join(f.source, "rabi.plugin.json"), JSON.stringify(manifest));
  await buildPluginPackage({ pluginRoot: f.source, outputDirectory: f.output, hostApiPath: f.hostApiPath });
  for (const name of ["manager.mjs", "nested/gateway.mjs"]) {
    const module = await import(pathToFileURL(path.join(f.output, name)).href);
    assert.equal(module.activate(), "embedded SDK loaded");
  }
  assert.match(await fs.readFile(path.join(f.output, "manager.mjs"), "utf8"), /["']\.\/\.rabi-deps\/plugin-sdk\/index\.mjs["']/);
});
