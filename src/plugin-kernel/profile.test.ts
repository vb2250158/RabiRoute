import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { loadPluginProfile, parsePluginProfile, PluginPackageCatalog } from "./profile.js";
import { GenerationRuntime, RequiredPluginCapabilitiesUnavailableError } from "./generationRuntime.js";

const profile = {
  schemaVersion: 2,
  readyRequires: ["manager.core@1"],
  instances: [{ id: "test:source", package: "io.test.source", version: "1.0.0", enabled: true, config: {}, grants: ["network.local"] }]
};

test("parsePluginProfile rejects the removed plugins profile shape", () => {
  assert.throws(() => parsePluginProfile({ schemaVersion: 1, plugins: [] }), /unsupported fields/);
  assert.equal(parsePluginProfile(profile).instances[0]?.id, "test:source");
  assert.deepEqual(parsePluginProfile(profile).readyRequires, ["manager.core@1"]);
});

test("parsePluginProfile validates restart and resource policy", () => {
  const parsed = parsePluginProfile({
    ...profile,
    instances: [{
      ...profile.instances[0],
      policy: {
        restart: { mode: "on_failure", maxAttempts: 4, windowMs: 10_000, initialBackoffMs: 100, maximumBackoffMs: 1_000 },
        resources: { maxChildProcesses: 3, shutdownTimeoutMs: 2_000 }
      }
    }]
  });
  assert.equal(parsed.instances[0]?.policy.restart.maxAttempts, 4);
  assert.equal(parsed.instances[0]?.policy.resources.shutdownTimeoutMs, 2_000);
  assert.throws(() => parsePluginProfile({ ...profile, readyRequires: ["manager.core"] }), /name@major/);
  assert.throws(() => parsePluginProfile({
    ...profile,
    instances: [{ ...profile.instances[0], policy: { restart: { mode: "never", maxAttempts: 1 } } }]
  }), /must be 0/);
  assert.throws(() => parsePluginProfile({
    ...profile,
    instances: [{ ...profile.instances[0], policy: { resources: { memoryMb: 256 } } }]
  }), /unsupported fields: memoryMb/);
});

test("loadPluginProfile resolves packages without a central package enum", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rabi-profile-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const packageRoot = path.join(root, "packages", "io.test.source", "1.0.0");
  await fs.mkdir(packageRoot, { recursive: true });
  await fs.writeFile(path.join(packageRoot, "rabi.plugin.json"), JSON.stringify({
    schemaVersion: 2, id: "io.test.source", version: "1.0.0",
    entries: { manager: { execution: "in_process", module: "./manager.mjs" } },
    provides: [], requires: [], optional: [], permissions: ["network.local"]
  }));
  await fs.writeFile(path.join(packageRoot, "manager.mjs"), "export function activate() {}\n");
  const profilePath = path.join(root, "desktop.json");
  await fs.writeFile(profilePath, JSON.stringify(profile));
  const packageCatalogRoot = path.join(root, "packages");
  const untrusted = await loadPluginProfile({
    profilePath, packageCatalog: new PluginPackageCatalog([packageCatalogRoot], { trustedInProcessRoots: [] }),
    runtimeRoot: path.join(root, "runtime-untrusted"), host: "manager"
  });
  assert.deepEqual(untrusted.candidates, []);
  assert.match(untrusted.loadFailures[0]?.error.message ?? "", /RABIROUTE_PLUGIN_IN_PROCESS_ROOTS/);
  const loaded = await loadPluginProfile({
    profilePath,
    packageCatalog: new PluginPackageCatalog([packageCatalogRoot]),
    runtimeRoot: path.join(root, "runtime"), host: "manager"
  });
  assert.equal(loaded.candidates[0]?.manifest.id, "io.test.source");
  assert.deepEqual(loaded.grants({
    applicationGenerationId: "app-generation",
    managerInstanceId: "manager-instance",
    activationId: "activation",
    instanceId: "test:source",
    pluginId: "io.test.source",
    version: "1.0.0",
    revision: "x",
    host: "manager"
  }), ["network.local"]);
});

test("a missing optional package preserves required startup and its explicit failure diagnosis", async t => {
  const fixture = await createProfileFixture(t);
  await fs.writeFile(fixture.profilePath, JSON.stringify({ ...profile, instances: [profile.instances[0], {
    ...profile.instances[0], id: "optional:missing", package: "io.test.missing"
  }] }));
  const loaded = await loadPluginProfile(fixture.input);
  assert.deepEqual(loaded.candidates.map(candidate => candidate.instanceId), ["test:source"]);
  assert.equal(loaded.loadFailures.length, 1);
  assert.equal(loaded.loadFailures[0]?.instanceId, "optional:missing");
  assert.equal(loaded.loadFailures[0]?.error.code, "package_load_failed");
  assert.match(loaded.loadFailures[0]?.error.message ?? "", /not installed/);
  const runtime = new GenerationRuntime({ host: "manager" });
  t.after(() => runtime.dispose());
  const result = await runtime.switch(loaded.candidates, { readyRequires: loaded.profile.readyRequires });
  assert.deepEqual(result.generation.readiness.missingCapabilities, []);
  assert.equal(result.generation.services.services.has("manager.core@1"), true);
});

test("a missing required package still rejects publication with the original required capability", async t => {
  const fixture = await createProfileFixture(t);
  await fs.writeFile(fixture.profilePath, JSON.stringify({ ...profile, instances: [{ ...profile.instances[0], package: "io.test.missing" }] }));
  const loaded = await loadPluginProfile(fixture.input);
  const runtime = new GenerationRuntime({ host: "manager" });
  t.after(() => runtime.dispose());
  await assert.rejects(runtime.switch(loaded.candidates, { readyRequires: loaded.profile.readyRequires }),
    error => error instanceof RequiredPluginCapabilitiesUnavailableError && error.missingCapabilities.includes("manager.core@1"));
  assert.equal(loaded.loadFailures.length, 1);
  assert.deepEqual(runtime.current().records, []);
});

test("a failed package update retains its previous immutable bytes, config and policy until repaired", async t => {
  const fixture = await createProfileFixture(t);
  const previous = await loadPluginProfile(fixture.input);
  const first = previous.candidates[0]!;
  await fs.writeFile(fixture.profilePath, JSON.stringify({ ...profile, instances: [{ ...profile.instances[0],
    version: "2.0.0", config: { unexpected: true }, grants: [], policy: { resources: { shutdownTimeoutMs: 200 } } }] }));
  const retained = await loadPluginProfile({ ...fixture.input, previous });
  assert.equal(retained.candidates[0], first);
  assert.equal(retained.packages[0]?.package, previous.packages[0]?.package);
  assert.deepEqual(retained.candidates[0]?.config, {});
  assert.equal(retained.candidates[0]?.policy?.resources.shutdownTimeoutMs, 5000);
  assert.equal(retained.loadFailures[0]?.retainedRevision, first.revision);
  assert.deepEqual(retained.grants({ instanceId: "test:source", applicationGenerationId: "fixture-application",
    managerInstanceId: "fixture-manager", activationId: "fixture-activation", pluginId: "io.test.source", version: "1.0.0",
    revision: first.revision, host: "manager" }), ["network.local"]);
  await fs.writeFile(fixture.profilePath, JSON.stringify({ ...profile, instances: [{ ...profile.instances[0], enabled: false }] }));
  const disabled = await loadPluginProfile({ ...fixture.input, previous: retained });
  assert.deepEqual(disabled.candidates, []);
  assert.deepEqual(disabled.loadFailures, []);
  await fs.writeFile(fixture.profilePath, JSON.stringify(profile));
  const repaired = await loadPluginProfile({ ...fixture.input, previous: retained });
  assert.equal(repaired.candidates.length, 1);
  assert.deepEqual(repaired.loadFailures, []);
});

async function createProfileFixture(t: TestContext) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rabi-profile-isolation-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const packages = path.join(root, "packages"), packageRoot = path.join(packages, "io.test.source", "1.0.0");
  await fs.mkdir(packageRoot, { recursive: true });
  await fs.writeFile(path.join(packageRoot, "rabi.plugin.json"), JSON.stringify({
    schemaVersion: 2, id: "io.test.source", version: "1.0.0", entries: { manager: { execution: "in_process", module: "./manager.mjs" } },
    provides: ["manager.core@1"], requires: [], optional: [], permissions: []
  }));
  await fs.writeFile(path.join(packageRoot, "manager.mjs"), "export function activate(ctx) { ctx.services.provide('manager.core@1', {}); }\n");
  const profilePath = path.join(root, "profile.json");
  await fs.writeFile(profilePath, JSON.stringify(profile));
  return { root, packageRoot, profilePath, input: { profilePath,
    packageCatalog: new PluginPackageCatalog([packages], { trustedInProcessRoots: [packages] }), runtimeRoot: path.join(root, "runtime"), host: "manager" as const } };
}

test("unknown optional roots are skipped while matching roots and explicit empty restrictions remain effective", async t => {
  const fixture = await createProfileFixture(t);
  const root = path.dirname(path.dirname(fixture.packageRoot));
  const other = path.join(fixture.root, "other-packages"), entry = path.join(other, "io.test.other", "1.0.0");
  await fs.mkdir(entry, { recursive: true });
  await fs.writeFile(path.join(entry, "rabi.plugin.json"), JSON.stringify({ schemaVersion: 2, id: "io.test.other", version: "1.0.0", entries: { manager: { execution: "in_process", module: "./manager.mjs" } }, provides: [], requires: [], optional: [], permissions: [] }));
  await fs.writeFile(path.join(entry, "manager.mjs"), "export function activate() {}\n");
  await fs.writeFile(fixture.profilePath, JSON.stringify({ ...profile, instances: [...profile.instances, { ...profile.instances[0], id: "test:other", package: "io.test.other", grants: [] }] }));
  for (const scenario of [
    { name: "unknown-only", trusted: ["different-root"], active: ["test:other", "test:source"], failed: [], diagnostics: 1 },
    { name: "partial-known", trusted: [root, "different-root"], active: ["test:source"], failed: ["test:other"], diagnostics: 1 },
    { name: "explicit-empty", trusted: [], active: [], failed: ["test:other", "test:source"], diagnostics: 0 }
  ]) {
    const catalog = new PluginPackageCatalog([root, other], { trustedInProcessRoots: scenario.trusted });
    t.after(() => catalog.dispose());
    const loaded = await loadPluginProfile({ ...fixture.input, runtimeRoot: path.join(fixture.root, scenario.name), packageCatalog: catalog });
    assert.deepEqual(loaded.candidates.map(candidate => candidate.instanceId).sort(), scenario.active, scenario.name);
    assert.deepEqual(loaded.loadFailures.map(failure => failure.instanceId).sort(), scenario.failed, scenario.name);
    assert.equal(catalog.snapshot().configurationDiagnostics.length, scenario.diagnostics, scenario.name);
    if (scenario.diagnostics) assert.match(catalog.snapshot().configurationDiagnostics[0]?.message ?? "", /RABIROUTE_PLUGIN_IN_PROCESS_ROOTS.*trustedInProcessRoots/);
  }
});

test("explicit directory restrictions do not retain a previously allowed in-process revision", async t => {
  const fixture = await createProfileFixture(t);
  const previous = await loadPluginProfile(fixture.input);
  const restricted = new PluginPackageCatalog([path.dirname(path.dirname(fixture.packageRoot))], { trustedInProcessRoots: [] });
  t.after(() => restricted.dispose());
  const denied = await loadPluginProfile({ ...fixture.input, packageCatalog: restricted, previous });
  assert.deepEqual(denied.candidates, []);
  assert.deepEqual(denied.packages, []);
  assert.equal(denied.loadFailures[0]?.retainedRevision, undefined);
  assert.match(denied.loadFailures[0]?.error.message ?? "", /Previous revision was not retained:.*RABIROUTE_PLUGIN_IN_PROCESS_ROOTS/);

  // A new revision failing to read is not permission to revive the now-disabled old one.
  await fs.writeFile(fixture.profilePath, JSON.stringify({ ...profile, instances: [{ ...profile.instances[0], version: "2.0.0" }] }));
  const missing = await loadPluginProfile({ ...fixture.input, packageCatalog: restricted, previous });
  assert.deepEqual(missing.candidates, []);
  assert.equal(missing.loadFailures[0]?.retainedRevision, undefined);
  assert.match(missing.loadFailures[0]?.error.message ?? "", /not installed.*Previous revision was not retained:.*RABIROUTE_PLUGIN_IN_PROCESS_ROOTS/);
});

test("previous package admission uses the current canonical target of a catalog junction", async t => {
  const fixture = await createProfileFixture(t);
  const alias = path.join(fixture.root, "catalog-alias");
  const source = path.dirname(path.dirname(fixture.packageRoot));
  await fs.symlink(source, alias, process.platform === "win32" ? "junction" : "dir");
  const catalog = new PluginPackageCatalog([alias], { trustedInProcessRoots: [alias] });
  t.after(() => catalog.dispose());
  const previous = await loadPluginProfile({ ...fixture.input, packageCatalog: catalog });
  assert.equal(previous.packages[0]?.package.sourceRoot, await fs.realpath(fixture.packageRoot));
  await fs.writeFile(fixture.profilePath, JSON.stringify({ ...profile, instances: [{ ...profile.instances[0], version: "2.0.0" }] }));
  const retained = await loadPluginProfile({ ...fixture.input, packageCatalog: catalog, previous });
  assert.equal(retained.candidates[0], previous.candidates[0]);

  const replacement = path.join(fixture.root, "replacement");
  await fs.mkdir(replacement);
  await fs.unlink(alias);
  await fs.symlink(replacement, alias, process.platform === "win32" ? "junction" : "dir");
  const changedRoot = await loadPluginProfile({ ...fixture.input, packageCatalog: catalog, previous });
  assert.deepEqual(changedRoot.candidates, []);
  assert.match(changedRoot.loadFailures[0]?.error.message ?? "", /Previous revision was not retained/);
});

test("Windows catalog restriction paths accept the same directory with different casing", { skip: process.platform !== "win32" }, async t => {
  const fixture = await createProfileFixture(t);
  const root = path.dirname(path.dirname(fixture.packageRoot));
  const catalog = new PluginPackageCatalog([root], { trustedInProcessRoots: [root.toUpperCase()] });
  t.after(() => catalog.dispose());
  const loaded = await loadPluginProfile({ ...fixture.input, packageCatalog: catalog });
  assert.equal(loaded.candidates.length, 1);
  await catalog.assertPackageExecutionAllowed({ ...loaded.packages[0]!.package, sourceRoot: loaded.packages[0]!.package.sourceRoot.toUpperCase() });
});
