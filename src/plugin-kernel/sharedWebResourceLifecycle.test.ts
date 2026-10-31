import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { GenerationRuntime } from "./generationRuntime.js";
import { loadPluginProfile, PluginPackageCatalog, type LoadedPluginProfile } from "./profile.js";
import { PluginProfilePublication } from "../manager/pluginProfilePublication.js";
import { WebPluginModuleRegistry } from "../manager/webPluginModules.js";

async function fixture(t: TestContext, withWeb = true) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "shared-web-resource-"));
  const packages = path.join(root, "packages"), packageDirectory = path.join(packages, "io.test.shared", "1.0.0");
  const profilePath = path.join(root, "profile.json");
  const entry = (id: string) => ({ id, package: "io.test.shared", version: "1.0.0", enabled: true, config: { fail: false, value: id }, grants: [] });
  const profile = { schemaVersion: 2, readyRequires: [], instances: [entry("a"), entry("b")] };
  await fs.mkdir(packageDirectory, { recursive: true });
  await fs.writeFile(path.join(packageDirectory, "rabi.plugin.json"), JSON.stringify({ schemaVersion: 2, id: "io.test.shared", version: "1.0.0",
    entries: { manager: { execution: "in_process", module: "./manager.mjs" },
      ...(withWeb ? { web: { execution: "in_process", module: "./client.mjs" } } : {}) },
    provides: [], requires: [], optional: [], permissions: [] }));
  const writeRevision = async (revision: string) => {
    await fs.writeFile(path.join(packageDirectory, "manager.mjs"), `export function activate(ctx) {
      if (ctx.config.fail) throw new Error('one instance failed');
      ctx.contributions.register({kind:'fixture',id:ctx.identity.instanceId,value:{revision:'${revision}',value:ctx.config.value}});
    }`);
    await fs.writeFile(path.join(packageDirectory, "client.mjs"), `export const revision = '${revision}';`);
  };
  await writeRevision("one");
  const catalog = new PluginPackageCatalog([packages], { trustedInProcessRoots: [packages] });
  const publication = new PluginProfilePublication(), modules = new WebPluginModuleRegistry();
  const runtime = new GenerationRuntime({ host: "manager" });
  let confirmed: LoadedPluginProfile | undefined;
  t.after(async () => { await runtime.dispose(); await catalog.dispose(); await fs.rm(root, { recursive: true, force: true }); });
  const load = async () => {
    await fs.writeFile(profilePath, JSON.stringify(profile));
    return loadPluginProfile({ profilePath, packageCatalog: catalog, runtimeRoot: path.join(root, "runtime"), host: "manager", previous: confirmed });
  };
  const reconcile = async () => {
    const requested = await load();
    const result = await runtime.switch(requested.candidates);
    const metadata = publication.capture(requested, result.generation);
    assert.deepEqual(metadata.diagnostics, []);
    confirmed = metadata.profile;
    modules.update(confirmed!, result.generation);
    return { requested, generation: result.generation, confirmed: confirmed! };
  };
  return { profile, packageDirectory, runtime, modules, publication, writeRevision, load, reconcile, entry };
}

test("a failed instance rolls back its shared Web package upgrade for every existing and new instance", async t => {
  const app = await fixture(t);
  const first = await app.reconcile();
  const previousActivations = new Map(first.generation.records.map(record => [record.identity.instanceId, record.identity.activationId]));
  const originalRevision = first.generation.records[0]!.identity.revision;
  await app.writeRevision("two");
  app.profile.instances[1]!.config.fail = true;
  app.profile.instances.push(app.entry("new"));
  const rejected = await app.reconcile();
  for (const id of ["a", "b"]) {
    const record = rejected.generation.records.find(value => value.identity.instanceId === id)!;
    assert.equal(record.identity.activationId, previousActivations.get(id));
    assert.equal(record.identity.revision, originalRevision);
    assert.equal(record.status, "active");
  }
  assert.equal(rejected.generation.records.find(value => value.identity.instanceId === "new")!.status, "failed");
  assert.equal(app.modules.list().length, 1);
  assert.equal(app.modules.list()[0]!.rev, originalRevision);
  assert.deepEqual(app.modules.list()[0]!.instances.map(value => value.instanceId), ["a", "b"]);
  for (const contribution of rejected.generation.contributions.contributions) assert.equal((contribution.value as { revision: string }).revision, "one");
  app.profile.instances[1]!.config.fail = false;
  const repaired = await app.reconcile();
  assert.equal(repaired.generation.records.every(record => record.status === "active"), true);
  assert.equal(new Set(repaired.generation.records.map(record => record.identity.revision)).size, 1);
  assert.notEqual(app.modules.list()[0]!.rev, originalRevision);
  assert.equal(app.modules.list()[0]!.rev, repaired.generation.records[0]!.identity.revision);
});

test("config-only updates remain independent when the shared Web code revision is unchanged", async t => {
  const app = await fixture(t);
  const first = await app.reconcile();
  const a = first.generation.records.find(record => record.identity.instanceId === "a")!, b = first.generation.records.find(record => record.identity.instanceId === "b")!;
  app.profile.instances[0]!.config.value = "updated-config";
  app.profile.instances[1]!.config.fail = true;
  const updated = await app.reconcile();
  assert.notEqual(updated.generation.records.find(record => record.identity.instanceId === "a")!.identity.activationId, a.identity.activationId);
  assert.equal(updated.generation.records.find(record => record.identity.instanceId === "b")!.identity.activationId, b.identity.activationId);
  assert.equal(updated.generation.records.every(record => record.identity.revision === a.identity.revision), true);
  assert.equal(app.modules.list()[0]!.rev, a.identity.revision);
});

test("unavailable dependencies in a Web code upgrade keep the confirmed shared package active", async t => {
  const app = await fixture(t);
  const first = await app.reconcile();
  await app.writeRevision("two");
  const manifestPath = path.join(app.packageDirectory, "rabi.plugin.json");
  const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
  manifest.requires = ["unavailable.feature@1"];
  await fs.writeFile(manifestPath, JSON.stringify(manifest));
  const blocked = await app.reconcile();
  assert.equal(blocked.generation.records.every(record => record.status === "active"), true);
  assert.deepEqual(blocked.generation.records.map(record => record.identity.activationId), first.generation.records.map(record => record.identity.activationId));
  assert.match(blocked.generation.records[0]!.error?.message ?? "", /dependencies are unavailable/);
  assert.equal(app.modules.list()[0]!.rev, first.generation.records[0]!.identity.revision);
});

test("mixed requested Web revisions retain the confirmed resource rather than selecting an arbitrary new revision", async t => {
  const app = await fixture(t);
  const first = await app.reconcile();
  await app.writeRevision("two");
  const requested = await app.load();
  const result = await app.runtime.switch([first.confirmed.candidates[0]!, requested.candidates[1]!]);
  assert.equal(result.generation.records.every(record => record.identity.revision === first.generation.records[0]!.identity.revision), true);
  assert.match(result.generation.records.find(record => record.identity.instanceId === "b")!.error?.message ?? "", /Shared Web resource has conflicting revisions/);
  const metadata = app.publication.capture(requested, result.generation);
  app.modules.update(metadata.profile!, result.generation);
  assert.equal(app.modules.list()[0]!.rev, first.generation.records[0]!.identity.revision);
});

test("code updates without shared Web resources do not group independent instances", async t => {
  const app = await fixture(t, false);
  const first = await app.reconcile();
  await app.writeRevision("two");
  app.profile.instances[1]!.config.fail = true;
  const result = await app.reconcile();
  assert.notEqual(result.generation.records.find(record => record.identity.instanceId === "a")!.identity.revision, first.generation.records[0]!.identity.revision);
  assert.equal(result.generation.records.find(record => record.identity.instanceId === "b")!.identity.revision, first.generation.records[0]!.identity.revision);
  assert.deepEqual(app.modules.list(), []);
});
