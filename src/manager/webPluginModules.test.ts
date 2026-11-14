import nativeFs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { GenerationRuntime, loadPluginProfile, PluginPackageCatalog } from "../plugin-kernel/index.js";
import { WebPluginModuleRegistry, retainedWebPackageCatalog } from "./webPluginModules.js";
import { PluginPackageStore } from "./pluginPackageStore.js";

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


test("self-contained package resources retain their original revision URLs and resource marker", async t => {
  const value = await fixture(); t.after(() => fs.rm(value.root, { recursive: true, force: true }));
  const entry = await fs.readFile(path.join(value.packageDirectory, 'web/client.mjs'));
  const resource = (name: string, bytes: Buffer, contentType: string) => ({ path: name, size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), contentType });
  await fs.writeFile(path.join(value.packageDirectory, 'web/module.json'), JSON.stringify({ schemaVersion: 1, kind: 'rabi-plugin-web', pluginId: 'example.web', version: '1.0.0', entry: 'client.mjs',
    backend: { pluginId: 'example.web', version: '1.0.0' }, runtime: { abi: 'rabi-web-runtime/1', imports: [] }, styles: [],
    files: [resource('client.mjs', entry, 'text/javascript; charset=utf-8'), resource('font.woff2', Buffer.from([1, 2, 3]), 'font/woff2')] }));
  await fs.writeFile(path.join(value.packageDirectory, 'web/font.woff2'), Buffer.from([1, 2, 3]));
  const registry = new WebPluginModuleRegistry(), runtime = new GenerationRuntime({ host: 'manager' }); t.after(() => runtime.dispose());
  const loaded = await load(value, [{ id: 'manager:self-web' }]), activated = await runtime.switch(loaded.candidates);
  let declarationReads = 0;
  const readFile = nativeFs.readFileSync;
  const declaredNames = new Set(['web/client.mjs', 'web/font.woff2'].map(name => path.join(loaded.packages[0]!.package.runtimeRoot, name)));
  const read = t.mock.method(nativeFs, 'readFileSync', ((...args: Parameters<typeof nativeFs.readFileSync>) => {
    if (declaredNames.has(String(args[0]))) declarationReads++;
    return readFile(...args);
  }) as typeof nativeFs.readFileSync);
  syncBuiltinESMExports();
  try { for (let index = 0; index < 30; index++) registry.update(loaded, activated.generation); }
  finally { read.mock.restore(); syncBuiltinESMExports(); }
  assert.equal(declarationReads, 2, 'the same immutable revision verifies its two declared files once across repeated publication');
  const descriptor = registry.list()[0]!; assert.equal(descriptor.resourceMode, 'package');
  assert.deepEqual((await registry.read(descriptor.id, descriptor.rev, 'web/font.woff2')).source, Buffer.from([1, 2, 3]));
  registry.update({ ...loaded, packages: [] }, { ...activated.generation, records: [] });
  assert.deepEqual((await registry.read(descriptor.id, descriptor.rev, 'web/font.woff2')).source, Buffer.from([1, 2, 3]));
});


test("restart resolves retained version resources through the original catalog once; physical removal stays local", async t => {
  const value = await fixture(); t.after(() => fs.rm(value.root, { recursive: true, force: true }));
  const first = await load(value, [{ id: 'manager:retained' }]), runtime = new GenerationRuntime({ host: 'manager' }); t.after(() => runtime.dispose());
  const original = new WebPluginModuleRegistry(), initial = await runtime.switch(first.candidates); original.update(first, initial.generation);
  const old = original.list()[0]!;
  const nextRoot = path.join(value.root, 'packages/example.web/2.0.0'); await fs.cp(value.packageDirectory, nextRoot, { recursive: true });
  const nextManifest = JSON.parse(await fs.readFile(path.join(nextRoot, 'rabi.plugin.json'), 'utf8')); nextManifest.version = '2.0.0';
  await fs.writeFile(path.join(nextRoot, 'rabi.plugin.json'), JSON.stringify(nextManifest));
  await fs.writeFile(path.join(nextRoot, 'web/client.mjs'), 'export function activate() { return "new version"; }');
  await fs.writeFile(value.profilePath, JSON.stringify({ schemaVersion: 2, readyRequires: [], instances: [{ id: 'manager:retained', package: 'example.web', version: '2.0.0', enabled: true, config: {}, grants: [] }] }));
  const latest = await loadPluginProfile({ profilePath: value.profilePath, packageCatalog: value.packageCatalog, runtimeRoot: path.join(value.root, 'runtime'), host: 'manager' });
  const generation = await runtime.switch(latest.candidates), restarted = new WebPluginModuleRegistry(); restarted.update(latest, generation.generation);
  let lists = 0, loads = 0;
  const store = new PluginPackageStore({ roots: [path.join(value.root, 'packages')], managedRoot: path.join(value.root, 'packages'), importRuntimeRoot: path.join(value.root, 'imports') });
  const retained = retainedWebPackageCatalog({ packages: store, catalog: value.packageCatalog, runtimeRoot: path.join(value.root, 'runtime') });
  restarted.setPackageCatalog({ list: async () => { lists++; return retained.list(); }, load: async (id, version, revision) => {
    loads++; return retained.load(id, version, revision);
  } });
  const reads = await Promise.all(Array.from({ length: 12 }, () => restarted.read(old.id, old.rev, old.entryPath)));
  assert(reads.every(row => row.source.toString().includes('activate'))); assert.equal(lists, 1); assert.equal(loads, 1);
  await restarted.read(old.id, old.rev, old.entryPath); assert.equal(lists, 1); assert.equal(loads, 1, 'cached revision reads never reload or hash the package');
  assert.equal(restarted.list()[0]!.version, '2.0.0', 'reading old resources never activates or lists an old plugin');
  await fs.rm(value.packageDirectory, { recursive: true, force: true });
  await assert.rejects(restarted.read(old.id, old.rev, old.entryPath), error => (error as NodeJS.ErrnoException).code === 'ENOENT');
  const current = restarted.list()[0]!; assert.match((await restarted.read(current.id, current.rev, current.entryPath)).source.toString(), /new version/);
  restarted.invalidatePackageCatalog(); await assert.rejects(restarted.read('missing-module', 'f'.repeat(64), 'web/client.mjs'), error => (error as NodeJS.ErrnoException).code === 'ENOENT');
  assert.equal(lists, 2); assert.equal(loads, 1);
});


test("restart can verify an older immutable snapshot of a retained development package revision", async t => {
  const value = await fixture(); t.after(() => fs.rm(value.root, { recursive: true, force: true }));
  const runtime = new GenerationRuntime({ host: 'manager' }); t.after(() => runtime.dispose());
  const initial = await load(value, [{ id: 'manager:development' }]), generation = await runtime.switch(initial.candidates);
  const original = new WebPluginModuleRegistry(); original.update(initial, generation.generation); const old = original.list()[0]!;
  await fs.writeFile(path.join(value.packageDirectory, 'web/client.mjs'), 'export function activate() { return "updated revision"; }');
  const latest = await load(value, [{ id: 'manager:development' }]), updated = await runtime.switch(latest.candidates);
  const restarted = new WebPluginModuleRegistry(); restarted.update(latest, updated.generation);
  const store = new PluginPackageStore({ roots: [path.join(value.root, 'packages')], managedRoot: path.join(value.root, 'packages'), importRuntimeRoot: path.join(value.root, 'imports') });
  restarted.setPackageCatalog(retainedWebPackageCatalog({ packages: store, catalog: value.packageCatalog, runtimeRoot: path.join(value.root, 'runtime') }));
  assert.notEqual(restarted.list()[0]!.rev, old.rev);
  const restored = await restarted.read(old.id, old.rev, old.entryPath);
  assert.equal(restored.source.toString(), 'export function activate() {}\n');
  assert.equal(restored.module.rev, old.rev); assert.equal(restarted.list()[0]!.rev, latest.packages[0]!.package.revision);
});
