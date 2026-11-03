import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import test from "node:test";
import ts from "typescript";
import { filterManagedPlugins, parsePluginManagementCatalog, parsePluginInstances, pluginDisplayName, readPluginManagementCatalog, updateManagedPlugin } from "../src/pluginManagementClient";

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
  const code = ts.transpileModule(script + "\nreturn { refresh, togglePlugin, selectPlugin, plugins, selected, query, visiblePlugins, error, loading, saving, rowErrors };", { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText;
  let fail = false, fetches = 0, unmount = () => {}, enabled = true, revision = "revision-1", catalogRefreshes = 0;
  const updates: Array<{ instanceId: string; expectedRevision: string; value: boolean }> = [];
  const route = { query: {} as Record<string, string> };
  const state = vm.runInNewContext(`(function(){${code}})()`, {
    ref: (value: unknown) => ({ value }), computed: (getter: () => unknown) => ({ get value() { return getter(); } }),
    useI18n: () => ({ t: (value: string) => value }), useRoute: () => route,
    useRouter: () => ({ push: (to: { query: Record<string, string> }) => { route.query = to.query; } }),
    onMounted: () => {}, onBeforeUnmount: (callback: () => void) => { unmount = callback; },
    AbortController, filterManagedPlugins, pluginDisplayName, userFacingError: String,
    readPluginManagementCatalog: async () => { fetches++; if (fail) throw new Error("Refresh failed"); return parsePluginInstances(instancesResponse(revision, enabled)); },
    updateManagedPlugin: async (instanceId: string, expectedRevision: string, value: boolean) => {
      updates.push({ instanceId, expectedRevision, value }); if (fail) throw new Error("Toggle failed"); enabled = value; revision = "revision-2";
      return parsePluginInstances(instancesResponse(revision, enabled));
    }, pluginCatalogStore: { refresh: async () => { catalogRefreshes++; } }, refreshWebPluginModulesSafely: async () => {}
  });
  return { state, route, updates, fail: () => { fail = true; }, fetches: () => fetches, catalogRefreshes: () => catalogRefreshes, unmount: () => unmount() };
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
