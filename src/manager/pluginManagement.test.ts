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

async function fixture(t: test.TestContext, readOnly = false) {
  const f = await pluginCatalogFixture(t);
  const settings = new PluginProfileSettings({ profilePath: f.profilePath, settingsRoot: path.join(f.root, "settings") });
  const packageRoot = path.join(f.root, "packages"), runtimeRoot = path.join(f.root, "management-runtime");
  const packages = new PluginPackageCatalog([packageRoot], { trustedInProcessRoots: [packageRoot] });
  f.context.management = createPluginManagement({ runtime: f.runtime, settings,
    manifest: (id, version) => readPluginManagementManifest(packages, id, version),
    reconcile: async () => {
      const loaded = await loadPluginProfile({ profilePath: f.profilePath, profile: (await settings.snapshot()).profile,
        packageCatalog: packages, runtimeRoot, host: "manager" });
      await f.runtime.switch(loaded.candidates, { readyRequires: loaded.profile.readyRequires });
    }
  });
  const registration = f.registry.registerOperations("host:management", createPluginManagementOperations(f.context, readOnly));
  t.after(() => registration.dispose());
  return { ...f, settings, list: async () => (await (await f.fetch("/api/plugins/instances")).json()).data };
}

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
  assert.equal((await update({ expectedRevision: "a".repeat(64), enabled: false })).status, 409);
  assert.equal((await update({ expectedRevision: snapshot.revision, enabled: "false" })).status, 400);
  assert.equal((await f.list()).instances[0].enabled, true);
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
  await f.context.management!.update("manager:catalog", { expectedRevision: initial.revision, enabled: false }, { assertCurrent() {} });
  const stopped = f.runtime.current();
  f.runtime.current = () => ({ ...stopped, cleanupDiagnostics: [{ instanceId: "manager:catalog", activationId: "prior-owner", phase: "superseded", message: "Controlled owner exit remains unconfirmed." }] });
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
