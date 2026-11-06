import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { loadPluginProfile, parsePluginProfile, readPluginProfile, PluginPackageCatalog } from "./profile.js";
import { GenerationRuntime, RequiredPluginCapabilitiesUnavailableError } from "./generationRuntime.js";
import type { LoadedPluginPackage } from "./packageLoader.js";

const profile = {
  schemaVersion: 2,
  readyRequires: ["manager.core@1"],
  instances: [{ id: "test:source", package: "io.test.source", version: "1.0.0", enabled: true, config: {}, grants: ["network.local"] }]
};

function cancellationGate() {
  let resolve!: () => void, reject!: (error: Error) => void;
  const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function controlledPackage(id: string): LoadedPluginPackage {
  return { sourceRoot: `C:/synthetic-profile/${id}`, runtimeRoot: `C:/synthetic-runtime/${id}`, revision: id,
    execution: "in_process", entryPath: `C:/synthetic-runtime/${id}/manager.mjs`,
    manifest: { schemaVersion: 2, id, version: "1.0.0", entries: { manager: { execution: "in_process", module: "./manager.mjs" } },
      provides: [], requires: [], optional: [], permissions: [] } };
}

function controlledInput(t: TestContext, names: string[]) {
  const catalog = new PluginPackageCatalog(["C:/synthetic-profile"], { loading: { maxConcurrency: 2 } });
  t.after(() => catalog.dispose());
  return { profilePath: "synthetic-profile.json", runtimeRoot: "C:/synthetic-runtime", host: "manager" as const,
    profile: parsePluginProfile({ schemaVersion: 2, readyRequires: [], instances: names.map(name => ({
      id: name, package: `io.test.${name}`, version: "1.0.0", enabled: true, config: {}, grants: []
    })) }), packageCatalog: catalog };
}

test("a cancelled profile producer enters no package I/O", async t => {
  const input = controlledInput(t, ["one"]), denied = new Error("original lifecycle stopped before metadata");
  t.mock.method(input.packageCatalog, "loadPackage", async () => { assert.fail("cancelled producer cannot begin metadata"); });
  await assert.rejects(loadPluginProfile({ ...input, assertCurrent() { throw denied; } }), error => error === denied);
});

test("host preparation failures retire package-wide or individual old candidates without blocking healthy owners", async t => {
  const input = controlledInput(t, ["one", "two", "independent"]);
  input.profile = parsePluginProfile({ ...input.profile, instances: input.profile.instances.map(row => ({ ...row,
    package: row.id === "independent" ? "io.test.independent" : "io.test.shared" })) });
  t.mock.method(input.packageCatalog, "loadPackage", async (id: string) => controlledPackage(id));
  const previous = await loadPluginProfile(input);
  assert.equal(previous.candidates.length, 3);
  for (const throwing of [false, true]) {
    const next = await loadPluginProfile({ ...input, previous, reuseUnchangedPackages: true,
      preparationFailure(packageId, instanceId) {
        if (packageId !== "io.test.shared" || instanceId !== undefined) return;
        const failure = new Error("shared owner preparation failed");
        if (throwing) throw failure;
        return failure;
      } });
    assert.deepEqual(next.candidates.map(row => row.instanceId), ["independent"]);
    assert.deepEqual(next.loadFailures.map(row => row.instanceId), ["one", "two"]);
    assert.ok(next.loadFailures.every(row => row.retainedRevision === undefined && /shared owner/.test(row.error.message)));
  }
  const next = await loadPluginProfile({ ...input, previous, reuseUnchangedPackages: true,
    preparationFailure: (_packageId, instanceId) => instanceId === "one" ? new Error("one instance preparation failed") : undefined });
  assert.deepEqual(next.candidates.map(row => row.instanceId), ["two", "independent"]);
  assert.equal(next.loadFailures[0]?.instanceId, "one");
  assert.equal(next.loadFailures[0]?.retainedRevision, undefined);
  assert.equal(next.packages.find(row => row.instance.id === "two")?.package, previous.packages.find(row => row.instance.id === "two")?.package);
});

test("profile reads use adjacent migration declarations without an application layout", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "kernel-profile-adjacent-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const profilePath = path.join(root, "profile.json"), original = JSON.stringify(profile);
  await fs.writeFile(profilePath, original);
  await fs.writeFile(path.join(root, "package-migrations.json"), JSON.stringify({ schemaVersion: 1,
    packages: [{ packageId: "io.test.source", fromVersions: ["1.0.0"], toVersion: "0.1.1" }] }));
  assert.equal((await readPluginProfile(profilePath)).instances[0]?.version, "0.1.1");
  assert.equal(await fs.readFile(profilePath, "utf8"), original);
});

test("profile cancellation stops future scheduling and fallback but joins both entered metadata lanes before rejecting", async t => {
  const input = controlledInput(t, ["one", "two", "later"]);
  t.mock.method(input.packageCatalog, "loadPackage", async (id: string) => controlledPackage(id));
  const previous = await loadPluginProfile(input);
  const first = cancellationGate(), second = cancellationGate();
  t.after(() => { first.resolve(); second.resolve(); });
  const entered: string[] = [], completed = [false, false];
  t.mock.method(input.packageCatalog, "loadPackage", async (id: string) => {
    entered.push(id);
    const lane = id === "io.test.one" ? 0 : 1;
    assert.notEqual(id, "io.test.later", "shutdown cannot schedule the next package");
    try { await (lane === 0 ? first.promise : second.promise); return controlledPackage(id); }
    finally { completed[lane] = true; }
  });
  t.mock.method(input.packageCatalog, "assertPackageExecutionAllowed", async () => { assert.fail("shutdown must not enter previous-package fallback I/O"); });
  let stopped = false, settled = false, activations = 0;
  const denied = new Error("original Manager shutdown fence");
  const runtime = new GenerationRuntime({ host: "manager", executor: { prepare: async () => ({ activate() { activations++; } }) } });
  t.after(() => runtime.dispose());
  const original = runtime.current();
  const loading = loadPluginProfile({ ...input, previous, assertCurrent() { if (stopped) throw denied; } })
    .then(loaded => runtime.switch(loaded.candidates));
  void loading.then(() => { settled = true; }, () => { settled = true; });
  const rejected = assert.rejects(loading, error => error === denied);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(entered, ["io.test.one", "io.test.two"]);
  stopped = true;
  first.reject(new Error("original metadata job cancelled by its catalog owner"));
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(completed, [true, false]);
  assert.equal(settled, false, "the other lane still owns its original I/O");
  assert.deepEqual(entered, ["io.test.one", "io.test.two"]);
  second.resolve(); await rejected;
  assert.deepEqual(completed, [true, true]);
  assert.equal(activations, 0); assert.equal(runtime.current(), original);
});

test("cancellation during previous-package admission joins that I/O and preserves the lifecycle rejection", async t => {
  const input = controlledInput(t, ["one"]);
  t.mock.method(input.packageCatalog, "loadPackage", async (id: string) => controlledPackage(id));
  const previous = await loadPluginProfile(input);
  const entered = cancellationGate(), admission = cancellationGate();
  t.after(admission.resolve);
  t.mock.method(input.packageCatalog, "loadPackage", async () => { throw new Error("ordinary bad package update"); });
  let completed = false, stopped = false, settled = false;
  t.mock.method(input.packageCatalog, "assertPackageExecutionAllowed", async () => {
    entered.resolve();
    try { await admission.promise; } finally { completed = true; }
  });
  const denied = new Error("original lifecycle stopped during fallback");
  const loading = loadPluginProfile({ ...input, previous, assertCurrent() { if (stopped) throw denied; } });
  void loading.then(() => { settled = true; }, () => { settled = true; });
  const rejected = assert.rejects(loading, error => error === denied);
  await entered.promise; stopped = true;
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(settled, false); assert.equal(completed, false);
  admission.reject(new Error("underlying admission I/O also failed"));
  await rejected;
  assert.equal(completed, true);
});

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
  assert.match(parsePluginProfile({
    ...profile,
    instances: [{ ...profile.instances[0], policy: { restart: { mode: "never", maxAttempts: 1 } } }]
  }).diagnostics?.[0]?.message ?? "", /must be 0/);
  assert.match(parsePluginProfile({
    ...profile,
    instances: [{ ...profile.instances[0], policy: { resources: { memoryMb: 256 } } }]
  }).diagnostics?.[0]?.message ?? "", /unsupported fields: memoryMb/);
});

test("malformed profile rows preserve healthy neighbors and report real identities without inventing missing IDs", () => {
  const parsed = parsePluginProfile({ ...profile, instances: [profile.instances[0], null,
    { ...profile.instances[0], id: "optional:bad", enabled: "yes" },
    { ...profile.instances[0], id: "healthy:other" }] });
  assert.deepEqual(parsed.instances.map(row => row.id), ["test:source", "healthy:other"]);
  assert.deepEqual(parsed.diagnostics?.map(row => [row.rowIndex, row.instanceId]), [[1, undefined], [2, "optional:bad"]]);
  assert.throws(() => parsePluginProfile({ ...profile, instances: {} }), /instances must be an array/);
  assert.throws(() => parsePluginProfile({ ...profile, readyRequires: ["invalid"] }), /name@major/);
});

test("duplicate profile identity rejects every ambiguous row while independent instances remain available", () => {
  const parsed = parsePluginProfile({ ...profile, instances: [profile.instances[0],
    { ...profile.instances[0], enabled: false }, { ...profile.instances[0], id: "healthy:other" }] });
  assert.deepEqual(parsed.instances.map(row => row.id), ["healthy:other"]);
  assert.equal(parsed.diagnostics?.length, 2);
  assert.ok(parsed.diagnostics?.every(row => /Duplicate/.test(row.message)));
});

test("readPluginProfile applies only declared exact package migrations in memory and keeps original data", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rabi-profile-migrations-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const profilePath = path.join(root, "custom.json"), migrationsPath = path.join(root, "package-migrations.json");
  const original = JSON.stringify({ ...profile, instances: [profile.instances[0],
    { ...profile.instances[0], id: "unknown:version", version: "5.0.0" },
    { ...profile.instances[0], id: "other:package", package: "io.test.other" }] });
  await fs.writeFile(profilePath, original);
  await fs.writeFile(migrationsPath, JSON.stringify({ schemaVersion: 1, packages: [
    { packageId: "io.test.source", fromVersions: ["1.0.0"], toVersion: "0.1.1" }
  ] }));
  const first = await readPluginProfile(profilePath, { migrationsPath });
  assert.deepEqual(first.instances.map(row => row.version), ["0.1.1", "5.0.0", "1.0.0"]);
  assert.deepEqual(first.instances[0], { ...parsePluginProfile(profile).instances[0], version: "0.1.1" });
  assert.deepEqual(first.migrations, [{ instanceId: "test:source", packageId: "io.test.source", fromVersion: "1.0.0", toVersion: "0.1.1" }]);
  assert.deepEqual(await readPluginProfile(profilePath, { migrationsPath }), first, "reopening is idempotent");
  assert.equal(await fs.readFile(profilePath, "utf8"), original);
  await fs.writeFile(profilePath, JSON.stringify({ ...profile, instances: [{ ...profile.instances[0], version: "0.1.1" }] }));
  assert.equal((await readPluginProfile(profilePath, { migrationsPath })).migrations, undefined);
});

test("invalid migration rows and conflicting mappings remain local", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rabi-profile-migration-isolation-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const profilePath = path.join(root, "profile.json"), migrationsPath = path.join(root, "migrations.json");
  await fs.writeFile(profilePath, JSON.stringify({ ...profile, instances: [profile.instances[0],
    { ...profile.instances[0], id: "other:healthy", package: "io.test.other" }] }));
  await fs.writeFile(migrationsPath, JSON.stringify({ schemaVersion: 1, packages: [null,
    { packageId: "io.test.source", fromVersions: ["1.0.0"], toVersion: "0.1.1" },
    { packageId: "io.test.source", fromVersions: ["1.0.0"], toVersion: "2.0.0" }] }));
  const parsed = await readPluginProfile(profilePath, { migrationsPath });
  assert.deepEqual(parsed.instances.map(row => row.id), ["other:healthy"]);
  assert.equal(parsed.diagnostics?.length, 2);
  assert.equal(parsed.diagnostics?.[0]?.source, "package-migrations");
  assert.match(parsed.diagnostics?.[1]?.message ?? "", /Conflicting/);
  await fs.writeFile(profilePath, "{broken");
  await assert.rejects(readPluginProfile(profilePath, { migrationsPath }), SyntaxError);
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

test("profile row isolation reaches package loading and preserves strict required readiness", async t => {
  const fixture = await createProfileFixture(t);
  t.after(() => fixture.input.packageCatalog.dispose());
  await fs.writeFile(fixture.profilePath, JSON.stringify({ ...profile, instances: [null, profile.instances[0],
    { ...profile.instances[0], id: "optional:bad", grants: "invalid" }] }));
  const loaded = await loadPluginProfile(fixture.input);
  assert.deepEqual(loaded.candidates.map(candidate => candidate.instanceId), ["test:source"]);
  assert.deepEqual(loaded.loadFailures.map(row => [row.rowIndex, row.instanceId, row.error.code]), [
    [0, undefined, "profile_instance_invalid"], [2, "optional:bad", "profile_instance_invalid"]
  ]);
  const runtime = new GenerationRuntime({ host: "manager" });
  t.after(() => runtime.dispose());
  const result = await runtime.switch(loaded.candidates, { readyRequires: loaded.profile.readyRequires });
  assert.equal(result.generation.services.services.has("manager.core@1"), true);
  await fs.writeFile(fixture.profilePath, JSON.stringify({ ...profile, instances: [{ ...profile.instances[0], enabled: "invalid" }] }));
  const missingRequired = await loadPluginProfile(fixture.input);
  await assert.rejects(runtime.switch(missingRequired.candidates, { readyRequires: missingRequired.profile.readyRequires }),
    error => error instanceof RequiredPluginCapabilitiesUnavailableError && error.missingCapabilities.includes("manager.core@1"));
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


test("enable settings reuse healthy immutable siblings, while re-enabling prepares only the missing owner", async t => {
  const input = controlledInput(t, ["one", "two"]), loads: string[] = [];
  t.mock.method(input.packageCatalog, "loadPackage", async (id: string) => { loads.push(id); return controlledPackage(id); });
  const previous = await loadPluginProfile(input);
  loads.length = 0;
  const disabled = parsePluginProfile({ ...input.profile, instances: input.profile.instances.map(instance =>
    instance.id === "one" ? { ...instance, enabled: false } : instance) });
  const next = await loadPluginProfile({ ...input, profile: disabled, previous, reuseUnchangedPackages: true });
  assert.deepEqual(loads, []);
  assert.deepEqual(next.candidates.map(candidate => candidate.instanceId), ["two"]);
  assert.equal(next.packages[0]?.package, previous.packages[1]?.package);
  const restored = await loadPluginProfile({ ...input, previous: next, reuseUnchangedPackages: true });
  assert.deepEqual(loads, ["io.test.one"]);
  assert.equal(restored.packages[1]?.package, previous.packages[1]?.package);
  loads.length = 0;
  await loadPluginProfile({ ...input, previous: restored });
  assert.deepEqual(loads.sort(), ["io.test.one", "io.test.two"], "ordinary source/manual loading keeps full validation");
});

test("changed package identity, config, grants or policy cannot borrow an unchanged settings proof", async t => {
  const input = controlledInput(t, ["one"]), loads: string[] = [];
  t.mock.method(input.packageCatalog, "loadPackage", async (id: string) => { loads.push(id); return controlledPackage(id); });
  const previous = await loadPluginProfile(input);
  const original = input.profile.instances[0]!;
  for (const change of [{ package: "io.test.changed" }, { version: "2.0.0" }, { config: { value: "new" } },
    { grants: ["network.local"] }, { policy: { ...original.policy, resources: { ...original.policy.resources, maxChildProcesses: 3 } } }]) {
    loads.length = 0;
    const desired = parsePluginProfile({ ...input.profile, instances: [{ ...original, ...change }] });
    await loadPluginProfile({ ...input, profile: desired, previous, reuseUnchangedPackages: true });
    assert.equal(loads.length, 1, JSON.stringify(change));
  }
  const removed = await loadPluginProfile({ ...input, profile: { ...input.profile, instances: [] }, previous, reuseUnchangedPackages: true });
  assert.deepEqual(removed.candidates, []);
});

test("a shared package/version group uses one consistent preparation when any instance changes", async t => {
  const input = controlledInput(t, ["one"]), original = input.profile.instances[0]!;
  input.profile = parsePluginProfile({ ...input.profile, instances: [original, { ...original, id: "second" }] });
  let loads = 0;
  t.mock.method(input.packageCatalog, "loadPackage", async (id: string) => { loads++; return controlledPackage(id); });
  const previous = await loadPluginProfile(input);
  assert.equal(loads, 1);
  loads = 0;
  const desired = parsePluginProfile({ ...input.profile, instances: [original, { ...original, id: "second", config: { changed: true } }] });
  const next = await loadPluginProfile({ ...input, profile: desired, previous, reuseUnchangedPackages: true });
  assert.equal(loads, 1);
  assert.equal(next.packages[0]?.package, next.packages[1]?.package);
});

test("settings reuse rechecks execution admission once and never retains a revoked owner", async t => {
  const input = controlledInput(t, ["one"]);
  t.mock.method(input.packageCatalog, "loadPackage", async (id: string) => controlledPackage(id));
  const previous = await loadPluginProfile(input);
  let admissions = 0;
  t.mock.method(input.packageCatalog, "loadPackage", async () => { assert.fail("unchanged settings do not prepare source again"); });
  t.mock.method(input.packageCatalog, "assertPackageExecutionAllowed", async () => { admissions++; throw new Error("execution root revoked"); });
  const next = await loadPluginProfile({ ...input, previous, reuseUnchangedPackages: true });
  assert.equal(admissions, 1);
  assert.deepEqual(next.candidates, []);
  assert.match(next.loadFailures[0]?.error.message ?? "", /execution root revoked/);
  assert.equal(next.loadFailures[0]?.retainedRevision, undefined);
});

test("new revision admission failure does not borrow that result for a different published revision", async t => {
  const input = controlledInput(t, ["one"]);
  const original = controlledPackage("io.test.one"), updated = { ...original, revision: "updated-same-version" };
  t.mock.method(input.packageCatalog, "loadPackage", async () => original);
  const previous = await loadPluginProfile(input);
  const admitted: string[] = [];
  t.mock.method(input.packageCatalog, "assertPackageExecutionAllowed", async (owner: LoadedPluginPackage) => {
    admitted.push(owner.revision);
    if (owner === updated) throw new Error("new revision is unavailable");
  });
  t.mock.method(input.packageCatalog, "loadPackage", async () => {
    await input.packageCatalog.assertPackageExecutionAllowed(updated); return updated;
  });
  const next = await loadPluginProfile({ ...input, previous });
  assert.deepEqual(admitted, [updated.revision, original.revision]);
  assert.equal(next.packages[0]?.package, original);
  assert.equal(next.loadFailures[0]?.retainedRevision, original.revision);
});

test("cancellation joins reused owner admission and admits no later package or fallback", async t => {
  const input = controlledInput(t, ["one", "two", "later"]);
  t.mock.method(input.packageCatalog, "loadPackage", async (id: string) => controlledPackage(id));
  const previous = await loadPluginProfile(input), first = cancellationGate(), second = cancellationGate();
  t.after(() => { first.resolve(); second.resolve(); });
  const entered: string[] = []; let stopped = false, settled = false;
  t.mock.method(input.packageCatalog, "loadPackage", async () => { assert.fail("reuse must not enter source I/O"); });
  t.mock.method(input.packageCatalog, "assertPackageExecutionAllowed", async (owner: LoadedPluginPackage) => {
    entered.push(owner.manifest.id); assert.notEqual(owner.manifest.id, "io.test.later");
    await (owner.manifest.id === "io.test.one" ? first.promise : second.promise);
  });
  const denied = new Error("original settings lifecycle stopped");
  const loading = loadPluginProfile({ ...input, previous, reuseUnchangedPackages: true, assertCurrent() { if (stopped) throw denied; } });
  void loading.then(() => { settled = true; }, () => { settled = true; });
  const rejected = assert.rejects(loading, error => error === denied);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(entered, ["io.test.one", "io.test.two"]); stopped = true; first.resolve();
  await new Promise(resolve => setImmediate(resolve)); assert.equal(settled, false);
  second.resolve(); await rejected;
  assert.deepEqual(entered, ["io.test.one", "io.test.two"]);
});

test("settings switches preserve published bytes; ordinary same-version source updates and bad-update recovery remain explicit", async t => {
  const fixture = await createProfileFixture(t); t.after(() => fixture.input.packageCatalog.dispose());
  const original = await loadPluginProfile(fixture.input), old = original.packages[0]!.package;
  await fs.writeFile(path.join(fixture.packageRoot, "manager.mjs"), "export function activate(ctx) { ctx.services.provide('manager.core@1', { updated: true }); }\n");
  const settings = await loadPluginProfile({ ...fixture.input, previous: original, reuseUnchangedPackages: true });
  assert.equal(settings.packages[0]?.package, old);
  const updated = await loadPluginProfile({ ...fixture.input, previous: settings });
  assert.notEqual(updated.packages[0]?.package.revision, old.revision);
  await fs.writeFile(path.join(fixture.packageRoot, "rabi.plugin.json"), "invalid replacement");
  const desired = parsePluginProfile({ ...profile, instances: [{ ...profile.instances[0], config: { unaccepted: true }, grants: [] }] });
  const retained = await loadPluginProfile({ ...fixture.input, profile: desired, previous: updated, reuseUnchangedPackages: true });
  assert.equal(retained.packages[0]?.package, updated.packages[0]?.package);
  assert.deepEqual(retained.candidates[0]?.config, {});
  assert.deepEqual(retained.grants({ instanceId: "test:source" } as Parameters<typeof retained.grants>[0]), ["network.local"]);
  const disabled = await loadPluginProfile({ ...fixture.input, profile: parsePluginProfile({ ...desired,
    instances: desired.instances.map(instance => ({ ...instance, enabled: false })) }), previous: retained, reuseUnchangedPackages: true });
  assert.deepEqual(disabled.candidates, []);
});


function requiredFixturePackage(name: string, requires: string[] = [], optional: string[] = []): LoadedPluginPackage {
  const value = controlledPackage(`io.test.${name}`);
  return { ...value, manifest: { ...value.manifest, provides: [name === "core" ? "manager.core@1" : `fixture.${name}@1`], requires, optional } };
}

test("required-first does not enter slow or broken optional preparation before required services publish", async t => {
  const input = controlledInput(t, ["core", "dependency", "slow", "bad"]);
  input.profile = parsePluginProfile({ ...input.profile, readyRequires: ["manager.core@1"] });
  const owners = new Map([
    ["io.test.core", requiredFixturePackage("core", ["fixture.dependency@1", "host.shared@1"], ["fixture.slow@1"])],
    ["io.test.dependency", requiredFixturePackage("dependency")],
    ["io.test.slow", requiredFixturePackage("slow", ["manager.core@1"])]
  ]);
  const release = cancellationGate(), entered = cancellationGate();
  const loads: string[] = [];
  t.mock.method(input.packageCatalog, "loadPackage", async (id: string) => {
    loads.push(id);
    if (id === "io.test.slow") { entered.resolve(); await release.promise; }
    if (id === "io.test.bad") throw new Error("broken optional package");
    return owners.get(id)!;
  });
  const readyOnly = { hostCapabilities: ["host.shared@1"], readManifest: async (id: string) => {
    if (id === "io.test.bad") throw new Error("broken optional manifest");
    return owners.get(id)!.manifest;
  } };
  const loading = loadPluginProfile({ ...input, readyOnly });
  const runtime = new GenerationRuntime({ host: "manager", hostServices: [{ capability: "host.shared@1", value: true }], executor: {
    prepare: async candidate => ({ activate(ctx) { for (const capability of candidate.manifest.provides) ctx.services.provide(capability, true); } })
  } });
  t.after(async () => { release.resolve(); await Promise.allSettled([loading]); await runtime.dispose(); });
  const required = await Promise.race([loading, entered.promise.then(() => { throw new Error("optional preparation entered before required READY"); })]);
  assert.deepEqual(loads.sort(), ["io.test.core", "io.test.dependency"]);
  assert.deepEqual(required.profile.instances.map(row => row.id), ["core", "dependency"]);
  assert.deepEqual(input.profile.instances.map(row => row.id), ["core", "dependency", "slow", "bad"], "full desired settings remain authoritative");
  assert.equal(required.loadFailures[0]?.instanceId, "bad");
  const ready = await runtime.switch(required.candidates, { readyRequires: required.profile.readyRequires });
  assert.deepEqual(ready.generation.readiness.missingCapabilities, []);
  assert.equal(ready.generation.services.services.get("manager.core@1")?.value, true);
  const completeLoading = loadPluginProfile({ ...input, previous: required, reuseUnchangedPackages: true });
  await entered.promise;
  assert.equal(runtime.current().services.services.get("manager.core@1")?.value, true, "required API remains live while optional is pending");
  release.resolve(); const complete = await completeLoading;
  assert.equal(loads.filter(id => id === "io.test.slow").length, 1);
  assert.equal(loads.filter(id => id === "io.test.core").length, 1);
  assert.equal(loads.filter(id => id === "io.test.bad").length, 1);
  await runtime.switch(complete.candidates, { readyRequires: complete.profile.readyRequires });
  assert.equal(runtime.current().services.services.get("fixture.slow@1")?.value, true);
});

test("required-first missing metadata and changed prepared manifests retain original readiness errors", async t => {
  for (const changed of [false, true]) {
    const input = controlledInput(t, ["core", "unrelated"]);
    input.profile = parsePluginProfile({ ...input.profile, readyRequires: ["manager.core@1"] });
    const core = requiredFixturePackage("core");
    t.mock.method(input.packageCatalog, "loadPackage", async () => ({ ...core, manifest: { ...core.manifest, requires: ["missing.real.dependency@1"] } }));
    const loaded = await loadPluginProfile({ ...input, readyOnly: { hostCapabilities: [], readManifest: async id => {
      if (!changed || id !== "io.test.core") throw new Error("manifest unavailable");
      return core.manifest;
    } } });
    const runtime = new GenerationRuntime({ host: "manager", executor: { prepare: async () => ({ activate() { assert.fail("missing dependencies cannot activate"); } }) } });
    t.after(() => runtime.dispose());
    await assert.rejects(runtime.switch(loaded.candidates, { readyRequires: loaded.profile.readyRequires }), error =>
      error instanceof RequiredPluginCapabilitiesUnavailableError && error.missingCapabilities.includes("manager.core@1"));
  }
});

test("required-first cancellation joins entered metadata and never schedules package preparation", async t => {
  const input = controlledInput(t, ["one", "two", "later"]), first = cancellationGate(), second = cancellationGate();
  const entered: string[] = []; let stopped = false, settled = false;
  const denied = new Error("original startup lifecycle stopped");
  t.mock.method(input.packageCatalog, "loadPackage", async () => { assert.fail("cancelled metadata cannot prepare executable packages"); });
  const loading = loadPluginProfile({ ...input, assertCurrent() { if (stopped) throw denied; }, readyOnly: { hostCapabilities: [], readManifest: async id => {
    entered.push(id); await (id === "io.test.one" ? first.promise : second.promise); return requiredFixturePackage("one").manifest;
  } } });
  void loading.then(() => { settled = true; }, () => { settled = true; });
  const rejected = assert.rejects(loading, error => error === denied);
  t.after(() => { first.resolve(); second.resolve(); });
  await new Promise(resolve => setImmediate(resolve)); assert.deepEqual(entered, ["io.test.one", "io.test.two"]);
  stopped = true; first.resolve(); await new Promise(resolve => setImmediate(resolve)); assert.equal(settled, false);
  second.resolve(); await rejected;
  assert.deepEqual(entered, ["io.test.one", "io.test.two"]);
});
