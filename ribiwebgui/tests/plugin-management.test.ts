import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import test from "node:test";
import ts from "typescript";
import { filterManagedPlugins, parsePluginManagementCatalog, parsePluginInstances, pluginDisplayName, readPluginManagementCatalog, updateManagedPlugin, parseAvailablePluginPackages, readAvailablePluginPackages, importPluginPackage, installManagedPlugin, uninstallManagedPlugin } from "../src/pluginManagementClient";

const plugin = (instanceId = "speech", status = "active") => ({ instanceId, pluginId: "io.test.speech", status,
  manifest: { id: "io.test.speech", version: "1.2.0", name: "Speech", description: "Local voice", hosts: ["manager"], capabilities: ["voice.synthesis@1"] }, missingCapabilities: [] });
const response = (plugins = [plugin()]) => ({ code: 0, data: { schemaVersion: 2, generation: "current", plugins } });
const instancesResponse = (revision = "revision-1", enabled = true) => ({ code: 0, data: { revision, instances: [{ ...plugin(), enabled, version: "1.2.0", config: {} }] } });

test("management catalog preserves actual native status, dependency failure and versions while isolating a malformed row", () => {
  const failed = { ...plugin("failed", "failed"), missingCapabilities: ["missing@1"], error: { message: "Unavailable" } };
  const result = parsePluginManagementCatalog(response([plugin(), null as never, failed]));
  assert.deepEqual(result.plugins.map(item => item.instanceId), ["speech", "failed"]);
  assert.equal(result.plugins[1].manifest.version, "1.2.0");
  assert.deepEqual(result.plugins[1].missingCapabilities, ["missing@1"]);
  assert.deepEqual(result.plugins[1].error, { message: "Unavailable" });
  assert.throws(() => parsePluginManagementCatalog({ code: -1, message: "Catalog unavailable" }), /Catalog unavailable/);
});

test("search filters actual names, stable IDs, descriptions and capabilities with status selection", () => {
  const rows = parsePluginManagementCatalog(response([plugin(), plugin("other", "failed")])).plugins;
  assert.equal(filterManagedPlugins(rows, " VOICE.SYNTHESIS ", "active").length, 1);
  assert.equal(filterManagedPlugins(rows, "local voice").length, 2);
  assert.equal(filterManagedPlugins(rows, "other")[0].instanceId, "other");
  assert.equal(filterManagedPlugins(rows, "none").length, 0);
  assert.equal(pluginDisplayName(rows[0]), "Speech");
});

test("plugin management reads the complete native catalog through the authenticated fetch installation", async () => {
  const original = globalThis.fetch;
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  const signal = new AbortController().signal;
  globalThis.fetch = (async (url: string, init?: RequestInit) => { requests.push({ url, init }); return Response.json(url.endsWith("instances") ? instancesResponse() : response()); }) as typeof fetch;
  try {
    assert.equal((await readPluginManagementCatalog(signal)).plugins.length, 1);
    assert.deepEqual(requests.map(item => item.url), ["/api/plugins/instances", "/api/plugins/catalog"]);
    assert.ok(requests[0].init?.signal);
    assert.equal(requests[0].init?.signal?.aborted, false);
    globalThis.fetch = async () => Response.json({ code: -1, message: "Read-only catalog unavailable" }, { status: 503 });
    await assert.rejects(readPluginManagementCatalog(), /Read-only catalog unavailable/);
  } finally { globalThis.fetch = original; }
});

test("configured disabled instances remain visible even when the optional presentation catalog fails", async () => {
  const disabled = instancesResponse("disabled", false); disabled.data.instances[0].status = "disabled";
  const rows = parsePluginInstances(disabled);
  assert.equal(rows.plugins[0].enabled, false);
  assert.equal(rows.plugins[0].status, "disabled");
  assert.equal(filterManagedPlugins(rows.plugins, "", "disabled").length, 1);
  assert.equal(filterManagedPlugins(rows.plugins, "", "inactive").length, 0);
  const original = globalThis.fetch;
  globalThis.fetch = (async (url: string) => url.endsWith("instances") ? Response.json(instancesResponse()) : Response.json({}, { status: 503 })) as typeof fetch;
  try { assert.equal((await readPluginManagementCatalog()).plugins.length, 1); } finally { globalThis.fetch = original; }
});

test("configured disabled does not hide a still-active native activation", () => {
  const rows = parsePluginInstances(instancesResponse("persisted-awaiting-reconciliation", false));
  assert.equal(rows.plugins[0].enabled, false);
  assert.equal(rows.plugins[0].status, "active");
  assert.equal(filterManagedPlugins(rows.plugins, "", "active").length, 1);
});

test("native manifest presentation and isolated settings errors preserve valid instances", () => {
  const snapshot = instancesResponse();
  snapshot.data.instances[0] = { ...snapshot.data.instances[0], enabled: false, status: "settings_error",
    manifest: { ...snapshot.data.instances[0].manifest, displayName: "Voice service", icon: "mdi-microphone" } } as typeof snapshot.data.instances[0];
  const result = parsePluginInstances(snapshot);
  assert.equal(result.plugins[0].status, "settings_error");
  assert.equal(pluginDisplayName(result.plugins[0]), "Voice service");
  assert.equal(result.plugins[0].manifest.icon, "mdi-microphone");
  assert.equal(filterManagedPlugins(result.plugins, "", "settings_error").length, 1);
});

test("toggle uses the original instance ID and profile revision without replacing configuration or retrying a conflict", async () => {
  const original = globalThis.fetch;
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  globalThis.fetch = (async (url: string, init?: RequestInit) => { calls.push({ url, init }); return Response.json(instancesResponse("revision-2", false)); }) as typeof fetch;
  try {
    assert.equal((await updateManagedPlugin("manager:speech/one", "revision-1", false)).plugins[0].enabled, false);
    assert.equal(calls[0].url, "/api/plugins/instances/manager%3Aspeech%2Fone");
    assert.deepEqual(JSON.parse(String(calls[0].init?.body)), { expectedRevision: "revision-1", enabled: false });
    globalThis.fetch = async () => { calls.push({ url: "conflict" }); return Response.json({ code: -1, message: "Profile changed" }, { status: 409 }); };
    await assert.rejects(updateManagedPlugin("speech", "revision-1", true), /Profile changed/);
    assert.equal(calls.length, 2);
  } finally { globalThis.fetch = original; }
});

function pageFixture() {
  const source = fs.readFileSync(new URL("../src/pages/PluginsPage.vue", import.meta.url), "utf8");
  const script = source.match(/<script setup lang="ts">([\s\S]*?)<\/script>/)![1].replace(/^import .*;\r?\n/gm, "");
  const code = ts.transpileModule(script + "\nreturn { refresh, togglePlugin, selectPlugin, plugins, selected, query, visiblePlugins, error, loading, saving, rowErrors, importDirectory, installPackage, uninstallPlugin, packages, sourceDirectory, packageError, packageNotice, installing, importing };", { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText;
  let fail = false, fetches = 0, unmount = () => {}, enabled = true, revision = "revision-1", catalogRefreshes = 0;
  const updates: Array<{ instanceId: string; expectedRevision: string; value: boolean }> = [];
  const route = { query: {} as Record<string, string> };
  const lifecycle = { installs: [] as Array<{ pluginId: string; instanceId: string; revision: string }>, uninstalls: [] as string[],
    imports: [] as string[], created: [] as Array<{ instanceId: string; pluginId: string; version: string; enabled: boolean; status: string; installed: boolean; manifest: ReturnType<typeof plugin>["manifest"]; config: object }>,
    pendingStop: false, uncertainInstall: false };
  const nativeSnapshot = () => {
    const value = instancesResponse(revision, enabled);
    value.data.instances.push(...lifecycle.created);
    return parsePluginInstances(value);
  };
  const state = vm.runInNewContext(`(function(){${code}})()`, {
    watch: () => {}, crypto: { randomUUID: () => "synthetic-install-id" },
    ref: (value: unknown) => ({ value }), computed: (getter: () => unknown) => ({ get value() { return getter(); } }),
    useI18n: () => ({ t: (value: string) => value }), useRoute: () => route,
    useRouter: () => ({ push: (to: { query: Record<string, string> }) => { route.query = to.query; } }),
    onMounted: () => {}, onBeforeUnmount: (callback: () => void) => { unmount = callback; },
    AbortController, filterManagedPlugins, pluginDisplayName, userFacingError: String,
    readAvailablePluginPackages: async () => [], importPluginPackage: async (directory: string) => { lifecycle.imports.push(directory); return []; },
    installManagedPlugin: async (pack: { pluginId: string; version: string }, expected: string, instanceId: string) => {
      lifecycle.installs.push({ pluginId: pack.pluginId, instanceId, revision: expected });
      lifecycle.created.push({ ...plugin(instanceId), pluginId: pack.pluginId, version: pack.version, config: {}, enabled: true, installed: true, status: "initializing" });
      revision = "revision-installed";
      if (lifecycle.uncertainInstall) throw new Error("Synthetic response lost after commit");
      return nativeSnapshot();
    },
    uninstallManagedPlugin: async (instanceId: string) => {
      lifecycle.uninstalls.push(instanceId);
      lifecycle.created = lifecycle.pendingStop ? lifecycle.created.map(row => row.instanceId === instanceId ? { ...row, installed: false, enabled: false, status: "stopping" } : row) : lifecycle.created.filter(row => row.instanceId !== instanceId);
      revision = "revision-removed"; return nativeSnapshot();
    },
    readPluginManagementCatalog: async () => { fetches++; if (fail) throw new Error("Refresh failed"); return nativeSnapshot(); },
    updateManagedPlugin: async (instanceId: string, expectedRevision: string, value: boolean) => {
      updates.push({ instanceId, expectedRevision, value }); if (fail) throw new Error("Toggle failed"); enabled = value; revision = "revision-2";
      return parsePluginInstances(instancesResponse(revision, enabled));
    }, pluginCatalogStore: { contributions: { value: [] }, refresh: async () => { catalogRefreshes++; } }, refreshWebPluginModulesSafely: async () => {}
  });
  return { state, route, updates, lifecycle, fail: () => { fail = true; }, fetches: () => fetches, catalogRefreshes: () => catalogRefreshes, unmount: () => unmount() };
}

test("plugin list opens stable instance details and preserves useful results after a failed refresh", async () => {
  const f = pageFixture();
  await f.state.refresh();
  assert.equal(f.state.plugins.value.length, 1);
  f.state.selectPlugin(f.state.plugins.value[0]);
  assert.equal(f.route.query.instance, "speech");
  assert.equal(f.state.selected.value.manifest.version, "1.2.0");
  f.state.query.value = null;
  assert.equal(f.state.visiblePlugins.value.length, 1);
  f.fail(); await f.state.refresh();
  assert.match(f.state.error.value, /Refresh failed/);
  assert.equal(f.state.plugins.value.length, 1);
  assert.equal(f.state.loading.value, false);
  f.state.selectPlugin(); assert.equal(f.state.selected.value, undefined);
  f.unmount();
});

test("page confirms a toggle through independent owner readback and keeps errors local on failure", async () => {
  const f = pageFixture(); await f.state.refresh();
  const pending = f.state.togglePlugin(f.state.plugins.value[0], false);
  assert.equal(f.state.saving.value.has("speech"), true);
  await pending;
  assert.equal(f.state.plugins.value[0].enabled, false);
  assert.equal(f.state.saving.value.size, 0);
  assert.deepEqual(f.updates, [{ instanceId: "speech", expectedRevision: "revision-1", value: false }]);
  assert.equal(f.fetches(), 2); assert.equal(f.catalogRefreshes(), 1);
  f.fail(); await f.state.togglePlugin(f.state.plugins.value[0], true);
  assert.equal(f.state.plugins.value[0].enabled, false);
  assert.match(f.state.rowErrors.value.speech, /Toggle failed/);
  assert.equal(f.state.error.value, ""); assert.equal(f.state.saving.value.size, 0);
});


test("independent plugin versions distinguish configured upgrade from retained running owner", () => {
  const configured = instancesResponse();
  configured.data.instances[0].version = "2.0.0";
  const catalog = parsePluginManagementCatalog(response());
  const retained = parsePluginInstances(configured, catalog).plugins[0];
  assert.equal(retained.manifest.version, "2.0.0");
  assert.equal(retained.runningVersion, undefined, "an older catalog cannot prove current execution");
  const authoritative = { ...configured, data: { ...configured.data, instances: [
    { ...configured.data.instances[0], runningVersion: "1.1.0" },
    { ...configured.data.instances[0], instanceId: "other", pluginId: "io.test.other", version: "4.3.2", status: "disabled" }
  ] } };
  const rows = parsePluginInstances(authoritative, catalog).plugins;
  assert.equal(rows[0].runningVersion, "1.1.0");
  assert.equal(rows[1].manifest.version, "4.3.2");
  assert.equal(rows[1].runningVersion, undefined);
  for (const status of ["disabled", "inactive", "failed", "active"]) {
    const current = { ...configured, data: { ...configured.data, instances: [
      { ...configured.data.instances[0], enabled: status === "active", status }
    ] } };
    assert.equal(parsePluginInstances(current, catalog).plugins[0].runningVersion, undefined,
      "a parallel stale catalog must not invent a running version, even for the same package/instance");
  }
});

test("available package parser keeps valid rows without exposing source paths", () => {
  const rows = parseAvailablePluginPackages({ code: 0, data: { packages: [null, { pluginId: "io.test.theme", version: "0.1.1", source: "local", sourceDirectory: "private-input", instanceIds: [], manifest: { displayName: "Theme", entries: { desktop: {} } } }] } });
  assert.equal(rows.length, 1); assert.deepEqual(rows[0]!.manifest.hosts, ["desktop"]); assert.equal("sourceDirectory" in rows[0]!, false);
});
test("package import and instance install or uninstall use exact original endpoints and stable intent", async () => {
  const original = globalThis.fetch, calls: Array<{ url: string; init?: RequestInit }> = [];
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    calls.push({ url, init }); return Response.json(url.endsWith("packages") ? { code: 0, data: { packages: [] } } : instancesResponse());
  }) as typeof fetch;
  try {
    await readAvailablePluginPackages(); await importPluginPackage("C:/fixture/runtime-plugin");
    await installManagedPlugin({ pluginId: "io.test.theme", version: "0.1.1" }, "revision-1", "one-stable-intent");
    await uninstallManagedPlugin("one-stable-intent", "revision-2");
    assert.deepEqual(calls.map(call => [call.url, call.init?.method ?? "GET"]), [["/api/plugins/packages", "GET"], ["/api/plugins/packages", "POST"], ["/api/plugins/instances", "POST"], ["/api/plugins/instances/one-stable-intent", "DELETE"]]);
    assert.deepEqual(JSON.parse(String(calls[1]!.init?.body)), { sourceDirectory: "C:/fixture/runtime-plugin" });
    assert.deepEqual(JSON.parse(String(calls[2]!.init?.body)), { expectedRevision: "revision-1", pluginId: "io.test.theme", version: "0.1.1", instanceId: "one-stable-intent" });
    assert.deepEqual(JSON.parse(String(calls[3]!.init?.body)), { expectedRevision: "revision-2" });
  } finally { globalThis.fetch = original; }
});

test("actual page lifecycle imports a directory and preserves stable installed identity through uncertain readback", async () => {
  const f = pageFixture(); await f.state.refresh();
  f.state.sourceDirectory.value = " C:/fixture/runtime-plugin "; await f.state.importDirectory();
  assert.deepEqual(f.lifecycle.imports, ["C:/fixture/runtime-plugin"]); assert.equal(f.state.sourceDirectory.value, "");
  f.lifecycle.uncertainInstall = true;
  await f.state.installPackage({ pluginId: "io.test.theme", version: "0.1.1", source: "local", instanceIds: [], manifest: { hosts: [] } });
  assert.equal(f.lifecycle.installs.length, 1); assert.equal(f.lifecycle.installs[0]!.instanceId, "plugin:synthetic-install-id");
  const installed = f.state.plugins.value.find((item: { instanceId: string }) => item.instanceId === "plugin:synthetic-install-id");
  assert.ok(installed); assert.equal(installed.status, "initializing"); assert.equal(f.state.installing.value.size, 0);
  assert.match(f.state.packageNotice.value, /已读取到/);
});
test("actual uninstall handler keeps stopping owner visible until the authoritative row disappears", async () => {
  const f = pageFixture(); await f.state.refresh();
  await f.state.installPackage({ pluginId: "io.test.theme", version: "0.1.1", source: "local", instanceIds: [], manifest: { hosts: [] } });
  const installed = f.state.plugins.value.find((item: { instanceId: string }) => item.instanceId === "plugin:synthetic-install-id");
  f.lifecycle.pendingStop = true; await f.state.uninstallPlugin(installed);
  const stopping = f.state.plugins.value.find((item: { instanceId: string }) => item.instanceId === installed.instanceId);
  assert.ok(stopping); assert.equal(stopping.installed, false); assert.equal(stopping.status, "stopping");
  assert.match(f.state.packageNotice.value, /正在停止/); assert.doesNotMatch(f.state.packageNotice.value, /已卸载/);
  await f.state.uninstallPlugin(stopping); assert.equal(f.lifecycle.uninstalls.length, 1, "a saved removal is not replayed");
  f.lifecycle.created = []; await f.state.refresh();
  assert.equal(f.state.plugins.value.some((item: { instanceId: string }) => item.instanceId === installed.instanceId), false);
});
test("initializing update and old retirement metadata retain distinct activation identities", () => {
  const value = instancesResponse() as unknown as { code: number; data: { revision: string; instances: Record<string, unknown>[] } };
  value.data.instances[0] = { ...value.data.instances[0], installed: true, status: "active", runningVersion: "1.0.0",
    initialization: { state: "initializing", identity: { activationId: "new-owner", version: "2.0.0" } },
    retiringActivations: [{ identity: { activationId: "old-owner", version: "1.0.0" }, status: "stopping" }] };
  const row = parsePluginInstances(value).plugins[0]!;
  assert.equal(row.status, "active"); assert.equal(row.runningVersion, "1.0.0"); assert.equal(row.initialization?.identity.activationId, "new-owner");
  assert.equal(row.retiringActivations?.[0]?.identity.activationId, "old-owner");
});
