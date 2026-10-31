import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { GenerationRuntime } from "../plugin-kernel/generationRuntime.js";
import { loadPluginProfile, PluginPackageCatalog, type LoadedPluginProfile } from "../plugin-kernel/profile.js";
import { PluginProfilePublication } from "./pluginProfilePublication.js";
import { WebPluginModuleRegistry } from "./webPluginModules.js";

async function fixture(t: TestContext, throwAfterCapture = false) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "plugin-profile-publication-"));
  const packages = path.join(root, "packages"), packageDirectory = path.join(packages, "io.test.feature", "1.0.0");
  const profilePath = path.join(root, "profile.json");
  const profile = { schemaVersion: 2, readyRequires: [], instances: [{ id: "feature", package: "io.test.feature", version: "1.0.0",
    enabled: true, config: { value: "original", fail: false }, grants: ["fixture.original"] }] };
  await fs.mkdir(packageDirectory, { recursive: true });
  await fs.writeFile(path.join(packageDirectory, "rabi.plugin.json"), JSON.stringify({ schemaVersion: 2, id: "io.test.feature", version: "1.0.0",
    entries: { manager: { execution: "in_process", module: "./manager.mjs" }, web: { execution: "in_process", module: "./client.mjs" } },
    provides: ["feature@1"], requires: [], optional: [], permissions: [] }));
  await fs.writeFile(path.join(packageDirectory, "manager.mjs"), "export function activate(ctx) { if (ctx.config.fail) throw new Error('config activation failed'); ctx.services.provide('feature@1', ctx.config.value); }\n");
  await fs.writeFile(path.join(packageDirectory, "client.mjs"), "export const value = 'original-client';\n");
  const catalog = new PluginPackageCatalog([packages], { trustedInProcessRoots: [packages] });
  const publication = new PluginProfilePublication(), modules = new WebPluginModuleRegistry();
  let requested: LoadedPluginProfile | undefined, confirmed: LoadedPluginProfile | undefined;
  const capture = () => {
    const snapshot = publication.capture(requested ?? confirmed, runtime.current());
    assert.deepEqual(snapshot.diagnostics, []);
    confirmed = snapshot.profile;
    modules.update(confirmed!, runtime.current());
  };
  const runtime = new GenerationRuntime({ host: "manager", onPublished: () => {
    capture();
    if (throwAfterCapture) throw new Error("observer failed after publication");
  } });
  t.after(async () => { await runtime.dispose(); await catalog.dispose(); await fs.rm(root, { recursive: true, force: true }); });
  const reconcile = async () => {
    await fs.writeFile(profilePath, JSON.stringify(profile));
    const loaded = await loadPluginProfile({ profilePath, packageCatalog: catalog, runtimeRoot: path.join(root, "runtime"), host: "manager", previous: confirmed });
    requested = loaded;
    try {
      await runtime.switch(loaded.candidates, { readyRequires: loaded.profile.readyRequires });
      capture();
      return { requested: loaded, confirmed: confirmed! };
    } finally { requested = undefined; }
  };
  return { root, profile, packageDirectory, runtime, modules, publication, reconcile, confirmed: () => confirmed! };
}

test("activation rejection followed by a missing package retains the actual backend, configuration and Web revision", async t => {
  const app = await fixture(t);
  const first = await app.reconcile();
  const originalCandidate = first.confirmed.candidates[0]!, originalRevision = originalCandidate.revision;
  await fs.writeFile(path.join(app.packageDirectory, "manager.mjs"), "export function activate() { throw new Error('new implementation failed'); }\n");
  await fs.writeFile(path.join(app.packageDirectory, "client.mjs"), "export const value = 'unactivated-client';\n");
  const rejected = await app.reconcile();
  assert.notEqual(rejected.requested.candidates[0]!.revision, originalRevision);
  assert.equal(rejected.confirmed.candidates[0], originalCandidate);
  assert.equal(app.runtime.current().records[0]!.identity.revision, originalRevision);
  assert.equal(app.modules.list()[0]!.rev, originalRevision);
  const current = app.modules.list()[0]!;
  assert.match((await app.modules.read(current.id, current.rev, current.entryPath)).source.toString(), /original-client/);
  app.profile.instances[0]!.version = "2.0.0";
  const missing = await app.reconcile();
  assert.equal(missing.requested.loadFailures[0]!.retainedRevision, originalRevision);
  assert.equal(missing.confirmed.candidates[0], originalCandidate);
  assert.equal(missing.confirmed.packages[0]!.package.revision, originalRevision);
  assert.equal(app.modules.list()[0]!.rev, app.runtime.current().records[0]!.identity.revision);
});

test("a rejected config-only update retains old activation metadata despite an identical package revision", async t => {
  const app = await fixture(t);
  const first = await app.reconcile();
  const activationId = app.runtime.current().records[0]!.identity.activationId;
  app.profile.instances[0]!.config = { value: "unactivated", fail: true };
  app.profile.instances[0]!.grants = [];
  const result = await app.reconcile();
  assert.equal(result.requested.candidates[0]!.revision, first.confirmed.candidates[0]!.revision);
  assert.equal(app.runtime.current().records[0]!.identity.activationId, activationId);
  assert.equal(result.confirmed.candidates[0], first.confirmed.candidates[0]);
  assert.deepEqual(result.confirmed.packages[0]!.instance.config, { value: "original", fail: false });
  assert.deepEqual(result.confirmed.packages[0]!.instance.grants, ["fixture.original"]);
  assert.equal(app.runtime.current().services.services.get("feature@1")!.value, "original");
});

test("completed publication keeps new confirmed metadata even when its observer throws", async t => {
  const app = await fixture(t, true);
  const first = await app.reconcile();
  await fs.writeFile(path.join(app.packageDirectory, "client.mjs"), "export const value = 'published-client';\n");
  app.profile.instances[0]!.config.value = "published";
  const second = await app.reconcile();
  const publishedRevision = app.runtime.current().records[0]!.identity.revision;
  assert.notEqual(publishedRevision, first.confirmed.candidates[0]!.revision);
  assert.equal(second.confirmed.candidates[0]!.revision, publishedRevision);
  assert.equal(app.modules.list()[0]!.rev, publishedRevision);
  app.profile.instances[0]!.version = "missing";
  const retained = await app.reconcile();
  assert.equal(retained.requested.loadFailures[0]!.retainedRevision, publishedRevision);
  assert.equal(retained.confirmed.candidates[0]!.revision, publishedRevision);
});

test("Web registry rejects requested metadata for a different active revision without replacing current resources", async t => {
  const app = await fixture(t);
  await app.reconcile();
  const original = app.modules.list();
  await fs.writeFile(path.join(app.packageDirectory, "manager.mjs"), "export function activate() { throw new Error('candidate failed'); }\n");
  const rejected = await app.reconcile();
  assert.throws(() => app.modules.update(rejected.requested, app.runtime.current()), /does not match its published activation/);
  assert.deepEqual(app.modules.list(), original);
});
