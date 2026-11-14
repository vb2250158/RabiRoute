import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import test from "node:test";
import { PluginProfileSettings } from "../plugin-runtime-host/profileSettings.js";
import { PluginPackageCatalog, loadPluginProfile } from "../plugin-kernel/profile.js";
import { pluginCatalogFixture } from "./pluginCatalogOperations.fixture.js";
import { createPluginManagement, readPluginManagementManifest } from "./pluginManagement.js";
import { createPluginManagementOperations } from "./pluginManagementOperations.js";
import { PluginPackageStore } from "./pluginPackageStore.js";
import { createPluginCatalogOwner } from "./pluginCatalogOwner.js";
import { IncomingMessage } from "node:http";
import { Socket } from "node:net";

async function fixture(t: test.TestContext, readOnly = false, background = false) {
  const f = await pluginCatalogFixture(t);
  const settings = new PluginProfileSettings({ profilePath: f.profilePath, settingsRoot: path.join(f.root, "settings") });
  const packageRoot = path.join(f.root, "packages"), runtimeRoot = path.join(f.root, "management-runtime");
  const packages = new PluginPackageCatalog([packageRoot], { trustedInProcessRoots: [packageRoot] });
  f.context.management = createPluginManagement({ runtime: f.runtime, settings,
    packages: new PluginPackageStore({ roots: [packageRoot], managedRoot: packageRoot, importRuntimeRoot: path.join(f.root, "imports") }),
    manifest: (id, version) => readPluginManagementManifest(packages, id, version),
    reconcile: async () => {
      const loaded = await loadPluginProfile({ profilePath: f.profilePath, profile: (await settings.snapshot()).profile,
        packageCatalog: packages, runtimeRoot, host: "manager" });
      await f.runtime.switch(loaded.candidates, { readyRequires: loaded.profile.readyRequires, initialization: background ? "background" : "await" });
    }
  });
  const registration = f.registry.registerOperations("host:management", createPluginManagementOperations(f.context, readOnly));
  t.after(() => registration.dispose());
  return { ...f, settings, list: async () => (await (await f.fetch("/api/plugins/instances")).json()).data };
}

test('package HTTP returns a partial diagnostic from the same enumeration while healthy packages remain selectable',async t=>{
 const f=await fixture(t),good=path.join(f.root,'packages'),bad=path.join(f.root,'extra-root-file');await fs.writeFile(bad,'fixture');
 const store=new PluginPackageStore({roots:[bad,good],managedRoot:good,importRuntimeRoot:path.join(f.root,'imports')});let enumerations=0;const original=store.listResult.bind(store);store.listResult=async()=>{enumerations++;return original();};
 f.context.management=createPluginManagement({runtime:f.runtime,settings:f.settings,manifest:async()=>{throw Error('not used by package listing');},packages:store,reconcile:async()=>{}});
 const response=await f.fetch('/api/plugins/packages'),body=await response.json();assert.equal(response.status,200);assert.equal(body.code,0);assert.equal(body.data.partial,true);assert.equal(body.data.diagnostics[0].path,bad);assert.equal(body.data.diagnostics[0].code,'ENOTDIR');assert.ok(body.data.packages.some((p:any)=>p.pluginId==='io.test.catalog'));assert.equal(enumerations,1);
 await assert.rejects(f.context.management!.packages!({assertCurrent(){throw Error('original caller revoked');}}),/caller revoked/);assert.equal(enumerations,1,'caller authority remains enforced before reading roots');
});

test("actual management HTTP uninstalls and reinstalls the original plugin instance with its stored config", async t => {
  const f = await fixture(t), original = await fs.readFile(f.profilePath);
  let value = await f.list();
  let response = await f.fetch("/api/plugins/instances/manager%3Acatalog", { method: "DELETE", headers: { "content-type": "application/json" }, body: JSON.stringify({ expectedRevision: value.revision }) });
  assert.equal(response.status, 200, await response.clone().text());
  value = await f.list();
  assert.equal(value.instances.length, 0);
  assert.equal(f.runtime.current().records.length, 0);
  response = await f.fetch("/api/plugins/instances", { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ expectedRevision: value.revision, pluginId: "io.test.catalog", version: "1.0.0" }) });
  assert.equal(response.status, 200, await response.clone().text());
  value = await f.list();
  assert.equal(value.instances[0]?.instanceId, "manager:catalog");
  assert.equal(value.instances[0]?.status, "active");
  assert.deepEqual(await fs.readFile(f.profilePath), original);
});

test("actual HTTP package import and available package listing use the original immutable package owner", async t => {
  const f = await fixture(t);
  const response = await f.fetch("/api/plugins/packages", { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ sourceDirectory: path.join(f.root, "packages", "io.test.catalog", "1.0.0") }) });
  assert.equal(response.status, 200, await response.clone().text());
  const imported = await response.json();
  assert.equal(imported.data.importedPackage.id, 'io.test.catalog');
  assert.equal(imported.data.importedPackage.version, '1.0.0');
  assert.match(imported.data.importedPackage.revision, /^[a-f0-9]{64}$/);
  const available = await (await f.fetch("/api/plugins/packages")).json();
  assert.equal(available.data.packages[0]?.pluginId, "io.test.catalog");
  assert.deepEqual(available.data.packages[0]?.instanceIds, ["manager:catalog"]);
});

test('new package actions provide exact discovery while preserving conflict status and unknown mutation outcomes', async t => {
  const f = await fixture(t), initial = await f.list();
  const owner = createPluginCatalogOwner(f.context);
  const stale = await owner.prepare(new IncomingMessage(new Socket()), 'instances.install').execute({ pluginId: 'io.test.catalog', version: '1.0.0', expectedRevision: 'a'.repeat(64) });
  assert.equal(stale.status, 409); assert.equal(stale.mutationOutcome, 'unknown');
  const body = stale.body as any; assert.equal(body.errorCode, 'PLUGIN_SETTINGS_REVISION_CONFLICT'); assert.equal(body.field, 'body.expectedRevision');
  assert.equal(body.help.path, '/api/agent/help?operationId=manager.plugins.instances.install'); assert.match(body.repair, /GET \/api\/plugins\/instances/);
  const missing = await f.fetch('/api/plugins/instances/missing-instance', { method: 'DELETE', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ expectedRevision: initial.revision }) });
  assert.equal(missing.status, 404); const absent = await missing.json(); assert.equal(absent.errorCode, 'PLUGIN_INSTANCE_NOT_FOUND'); assert.equal(absent.field, 'path.id');
  assert.match(absent.repair, /Fully retired instances may be absent/);
  const source = path.join(f.root, 'local-source');
  await fs.cp(path.join(f.root, 'packages', 'io.test.catalog', '1.0.0'), source, { recursive: true });
  await f.context.management!.importPackage!(source, { assertCurrent() {} });
  await fs.writeFile(path.join(source, 'manager.mjs'), 'export function activate(){ /* distinct immutable version bytes */ }');
  const conflict = await f.fetch('/api/plugins/packages', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sourceDirectory: source }) });
  assert.equal(conflict.status, 409); const detail = await conflict.json(); assert.equal(detail.errorCode, 'PLUGIN_PACKAGE_VERSION_CONFLICT'); assert.equal(detail.field, 'body.sourceDirectory');
  assert.equal(detail.help.path, '/api/agent/help?operationId=manager.plugins.packages.import'); assert.match(detail.repair, /GET \/api\/plugins\/packages/);
  assert.equal((await f.settings.snapshot()).revision, initial.revision);
});

test("uninstalled HTTP instance remains visibly stopping until its actual asynchronous disposer finishes", async t => {
  const f = await fixture(t, false, true);
  const key = `__rabi_plugin_stop_${Date.now()}`;
  let release!: () => void;
  const stopped = new Promise<void>(resolve => { release = resolve; });
  (globalThis as unknown as Record<string, unknown>)[key] = stopped;
  try {
    const filename = path.join(f.root, "packages", "io.test.catalog", "1.0.0", "manager.mjs");
    const source = await fs.readFile(filename, "utf8");
    await fs.writeFile(filename, source.replace('context.services.provide', `context.effects.add(() => async () => { await globalThis[${JSON.stringify(key)}]; });\ncontext.services.provide`));
    const saved = await f.list();
    await f.context.management!.update("manager:catalog", { expectedRevision: saved.revision, enabled: true }, { assertCurrent() {} });
    await f.runtime.settle();
    const current = await f.list();
    const response = await f.fetch("/api/plugins/instances/manager%3Acatalog", { method: "DELETE", headers: { "content-type": "application/json" }, body: JSON.stringify({ expectedRevision: current.revision }) });
    assert.equal(response.status, 200, await response.clone().text());
    const retiring = await f.list();
    assert.equal(retiring.instances[0]?.installed, false);
    assert.equal(retiring.instances[0]?.status, "stopping");
    assert.equal(retiring.instances[0]?.retiringActivations.length, 1);
    release();
    await f.runtime.settle("manager:catalog");
    assert.equal((await f.list()).instances.length, 0);
  } finally { release(); delete (globalThis as unknown as Record<string, unknown>)[key]; }
});

test("new install APIs keep the original read-only and revision contracts", async t => {
  const f = await fixture(t, true), snapshot = await f.list();
  const response = await f.fetch("/api/plugins/instances/manager%3Acatalog", { method: "DELETE", headers: { "content-type": "application/json" }, body: JSON.stringify({ expectedRevision: snapshot.revision }) });
  assert.equal(response.status, 403);
  assert.equal((await f.list()).revision, snapshot.revision);
});

test("host management can disable a real package and remains reachable to reenable it", async t => {
  const f = await fixture(t), initial = await f.list();
  assert.equal(initial.applicationGenerationId, f.runtime.current().applicationGenerationId);
  assert.equal(initial.managerInstanceId, f.runtime.current().managerInstanceId);
  assert.equal(initial.instances[0].status, "active");
  const update = await f.fetch("/api/plugins/instances/manager%3Acatalog", { method: "PATCH", headers: { "content-type": "application/json" },
    body: JSON.stringify({ expectedRevision: initial.revision, enabled: false }) });
  assert.equal(update.status, 200, await update.clone().text());
  const disabled = await f.list();
  assert.equal(disabled.applicationGenerationId, initial.applicationGenerationId);
  assert.equal(disabled.managerInstanceId, initial.managerInstanceId);
  assert.equal(disabled.instances[0].enabled, false);
  assert.equal(disabled.instances[0].status, "disabled");
  assert.equal(f.runtime.current().records.filter(row => row.status === "active").length, 0);
  assert.equal("config" in disabled.instances[0], false, "raw configuration is never disclosed");
  const restored = await f.fetch("/api/plugins/instances/manager%3Acatalog", { method: "PATCH", headers: { "content-type": "application/json" },
    body: JSON.stringify({ expectedRevision: disabled.revision, enabled: true }) });
  assert.equal(restored.status, 200, await restored.clone().text());
  assert.equal((await f.list()).instances[0].status, "active");
});

test("native management rejects stale revisions and invalid booleans without changing settings", async t => {
  const f = await fixture(t), snapshot = await f.list();
  const update = (body: unknown) => f.fetch("/api/plugins/instances/manager%3Acatalog", { method: "PATCH",
    headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const stale = await update({ expectedRevision: "a".repeat(64), enabled: false });
  assert.equal(stale.status, 409); const detail = await stale.json();
  assert.equal(detail.errorCode, 'PLUGIN_SETTINGS_REVISION_CONFLICT'); assert.equal(detail.field, 'body.expectedRevision');
  assert.match(detail.repair, /GET \/api\/plugins\/instances/); assert.equal(detail.retryable, false);
  assert.equal((await update({ expectedRevision: snapshot.revision, enabled: "false" })).status, 400);
  assert.equal((await f.list()).instances[0].enabled, true);
  const missing = await f.fetch('/api/plugins/instances/missing-instance', { method: 'PATCH', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ expectedRevision: snapshot.revision, enabled: false }) });
  assert.equal(missing.status, 404); const absent = await missing.json(); assert.equal(absent.field, 'path.id');
  assert.equal(absent.errorCode, 'PLUGIN_INSTANCE_NOT_FOUND'); assert.match(absent.repair, /complete instance ID/);
  assert.equal((await f.settings.snapshot()).revision, snapshot.revision);
});

test("inactive plugin metadata stays readable without copying or executing its unavailable entry", async t => {
  const f = await fixture(t), initial = await f.list();
  const response = await f.fetch("/api/plugins/instances/manager%3Acatalog", { method: "PATCH", headers: { "content-type": "application/json" },
    body: JSON.stringify({ expectedRevision: initial.revision, enabled: false }) });
  assert.equal(response.status, 200);
  const packages = new PluginPackageCatalog([path.join(f.root, "packages")]);
  const source = await packages.resolve("io.test.catalog", "1.0.0");
  const filename = path.join(source.sourceRoot, "rabi.plugin.json");
  const manifest = JSON.parse(await fs.readFile(filename, "utf8"));
  manifest.entries.manager.module = "./missing-entry.mjs";
  await fs.writeFile(filename, JSON.stringify(manifest));
  assert.equal((await readPluginManagementManifest(packages, "io.test.catalog", "1.0.0")).id, "io.test.catalog");
  const listed = await f.list();
  assert.equal(listed.instances[0].status, "disabled");
  assert.equal(listed.instances[0].manifest.id, "io.test.catalog");
  manifest.id = "io.test.other";
  await fs.writeFile(filename, JSON.stringify(manifest));
  await assert.rejects(readPluginManagementManifest(packages, "io.test.catalog", "1.0.0"), /identity/);
  await fs.writeFile(filename, "private-manifest-sentinel-17fa");
  await assert.rejects(readPluginManagementManifest(packages, "io.test.catalog", "1.0.0"), { message: "Installed plugin manifest is invalid JSON." });
  await packages.dispose();
});

test("read-only acceptance permits plugin listing while refusing all enable writes", async t => {
  const f = await fixture(t, true), snapshot = await f.list();
  const response = await f.fetch("/api/plugins/instances/manager%3Acatalog", { method: "PATCH", headers: { "content-type": "application/json" },
    body: JSON.stringify({ expectedRevision: snapshot.revision, enabled: false }) });
  assert.equal(response.status, 403);
  assert.equal((await f.settings.snapshot()).revision, snapshot.revision);
});

test("listing reuses active manifests and distinguishes saved settings from actual execution", async t => {
  const f = await fixture(t);
  let metadataReads = 0;
  const management = createPluginManagement({ runtime: f.runtime, settings: f.settings,
    manifest: async () => { metadataReads++; throw new Error("must reuse published metadata"); }, reconcile: async () => {} });
  const invocation = { assertCurrent() {} };
  const initial = await f.settings.snapshot();
  await f.settings.update("manager:catalog", { expectedRevision: initial.revision, enabled: false });
  const result = await management.list(invocation) as { instances: { enabled: boolean; status: string }[] };
  assert.equal(result.instances[0]?.enabled, false);
  assert.equal(result.instances[0]?.status, "active", "an accepted setting is not proof of retirement");
  assert.equal(metadataReads, 0);
});

test("committed settings reconcile even if the HTTP caller leaves before publication", async t => {
  const f = await fixture(t);
  let revoked = false;
  const snapshot = await f.settings.snapshot(), original = f.settings.update.bind(f.settings);
  f.settings.update = async (...args) => { const saved = await original(...args); revoked = true; return saved; };
  await assert.rejects(f.context.management!.update("manager:catalog", { expectedRevision: snapshot.revision, enabled: false }, {
    assertCurrent() { if (revoked) throw new Error("caller left"); }
  }), /caller left/);
  assert.equal((await f.settings.snapshot()).profile.instances[0]?.enabled, false);
  assert.equal(f.runtime.current().records.filter(row => row.status === "active").length, 0);
});

test("an unconfirmed native retirement is never reported as a stopped plugin", async t => {
  const f = await fixture(t), initial = await f.settings.snapshot();
  const identity = f.runtime.current().records[0]!.identity;
  await f.context.management!.update("manager:catalog", { expectedRevision: initial.revision, enabled: false }, { assertCurrent() {} });
  const stopped = f.runtime.current();
  f.runtime.current = () => ({ ...stopped, cleanupDiagnostics: [{ instanceId: "manager:catalog", activationId: "prior-owner", phase: "superseded", message: "Controlled owner exit remains unconfirmed." }] });
  f.runtime.pendingRetirements = () => [{ identity, status: "retirement_unconfirmed" }];
  const result = await f.list();
  assert.equal(result.instances[0].enabled, false);
  assert.equal(result.instances[0].status, "retirement_unconfirmed");
  assert.match(result.instances[0].error, /unconfirmed/);
});

test("malformed private instance settings never echo their credential bytes in management responses", async t => {
  const f = await fixture(t);
  const raw = "rabi-private-credential-sentinel-82bb";
  await fs.mkdir(f.settings.options.settingsRoot, { recursive: true });
  const filename = path.join(f.settings.options.settingsRoot, createHash("sha256").update("manager:catalog").digest("hex") + ".json");
  await fs.writeFile(filename, raw);
  const snapshot = await f.list();
  assert.equal(snapshot.instances[0].enabled, false);
  assert.equal(snapshot.instances[0].error, "Invalid JSON in this instance settings file.");
  assert.equal(JSON.stringify(snapshot).includes(raw), false);
  assert.equal(await fs.readFile(filename, "utf8"), raw);
});

test("an invalid base profile reports its syntax failure without echoing source bytes or rewriting it", async t => {
  const f = await fixture(t), raw = "private-base-profile-sentinel-21fa";
  await fs.writeFile(f.profilePath, raw);
  const response = await f.fetch("/api/plugins/instances");
  const body = await response.text();
  assert.equal(response.status, 500);
  assert.match(body, /Plugin profile is invalid JSON/);
  assert.equal(body.includes(raw), false);
  assert.equal(await fs.readFile(f.profilePath, "utf8"), raw);
});


test("configured package upgrade reports the original running version until native replacement", async t => {
  const f = await fixture(t);
  const original = f.runtime.current().records[0]!;
  const profile = JSON.parse(await fs.readFile(f.profilePath, "utf8"));
  profile.instances[0].version = "2.0.0";
  await fs.writeFile(f.profilePath, JSON.stringify(profile));
  const management = createPluginManagement({ runtime: f.runtime, settings: f.settings,
    manifest: async () => ({ ...original.manifest, version: "2.0.0" }), reconcile: async () => {} });
  const result = await management.list({ assertCurrent() {} }) as {
    instances: { version: string; runningVersion?: string; status: string }[]
  };
  assert.equal(result.instances[0]?.version, "2.0.0");
  assert.equal(result.instances[0]?.runningVersion, original.identity.version);
  assert.equal(result.instances[0]?.runningVersion, "1.0.0");
  assert.equal(result.instances[0]?.status, "active");
  assert.equal(f.runtime.current().records[0]?.identity.activationId, original.identity.activationId);
});
