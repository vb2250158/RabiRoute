import assert from "node:assert/strict";
import test from "node:test";
import { agentAdapterCatalog, configuredAgentRows } from "../src/agentAdapters/agentAdapterCatalog";
import { registerAgentAdapterRenderer } from "../src/agentAdapters/registerAgentAdapterRenderer";
import { registerTrustedWebSettingsRenderer, resolveWebSettingsCatalog } from "../src/pluginRenderers";
import type { WebPluginCatalogPlugin } from "../src/pluginCatalogClient";
import type { AgentAdapterType } from "../src/types";
import { resolvePrimaryAgentTarget } from "../../src/shared/routeAgentTargets";

function fixture(type: AgentAdapterType = "codex", slug = "codex") {
  const instanceId = `agent:${slug}`, pluginId = `io.rabiroute.agent.${slug}`, capability = `agent.adapter.${slug}@1`;
  const dispose = registerAgentAdapterRenderer({ registerSettingsRenderer: input => registerTrustedWebSettingsRenderer({ ...input, instanceId, pluginId }) },
    type, async () => ({ render: () => null }));
  const settings = { instanceId, pluginId, id: `agent.${type}.settings`, kind: "agent-adapter-settings", hosts: ["web"],
    surface: "route.adapters", slot: type, agentType: type, capability,
    rendererId: `agent.${type}.card.v1`, schemaId: `agent.${type}.route.v1`, readCommandId: `agent.${type}.route.read`, writeCommandId: `agent.${type}.route.write`,
    catalog: { title: type, note: "Owned configuration", icon: "mdi-robot", location: "local", hasCwd: true, hasThread: true, order: 10 } };
  const provider = { instanceId, pluginId, id: `agent.${type}.provider`, kind: "agent-adapter", type, capability,
    manifest: { type, label: type, maturity: "experimental", transport: { protocol: "owner", mode: "native" }, capabilities: { managedTasks: { hooks: true } } } };
  const plugin: WebPluginCatalogPlugin = { instanceId, pluginId, status: "active", manifest: { id: pluginId, hosts: ["manager", "gateway", "web"], capabilities: [capability] } };
  return { dispose, settings, provider, plugin };
}

test("an installed Web renderer alone cannot claim a native Agent; owner, publication and explicit capability must agree", t => {
  const f = fixture("copilotCli", "copilot-cli"); t.after(f.dispose);
  const renderers = resolveWebSettingsCatalog([f.settings]);
  assert.equal(renderers.length, 1);
  assert.equal(agentAdapterCatalog([f.plugin], [f.provider], renderers)[0]?.manifest.capabilities.managedTasks?.hooks, true);
  assert.deepEqual(agentAdapterCatalog([f.plugin], [], renderers), []);
  assert.deepEqual(agentAdapterCatalog([{ ...f.plugin, status: "inactive" }], [f.provider], renderers), []);
  assert.deepEqual(agentAdapterCatalog([f.plugin], [{ ...f.provider, instanceId: "agent:other" }], renderers), []);
  assert.deepEqual(agentAdapterCatalog([f.plugin], [{ ...f.provider, pluginId: "io.test.other" }], renderers), []);
  assert.deepEqual(agentAdapterCatalog([f.plugin], [{ ...f.provider, capability: "agent.adapter.copilotCli@1" }], renderers), []);
  assert.deepEqual(agentAdapterCatalog([{ ...f.plugin, manifest: { ...f.plugin.manifest, capabilities: [] } }], [f.provider], renderers), []);
  assert.deepEqual(agentAdapterCatalog([f.plugin], [f.provider, f.provider], renderers), []);
});

test("a broken Agent settings contribution is local and saved unavailable targets keep the primary and every original field", t => {
  const f = fixture(); t.after(f.dispose);
  const bad = { ...f.settings, catalog: { ...f.settings.catalog, location: "guessed" } };
  assert.deepEqual(resolveWebSettingsCatalog([bad]), []);
  const catalog = agentAdapterCatalog([f.plugin], [f.provider], resolveWebSettingsCatalog([f.settings]));
  const route = { id: "route", agentAdapters: ["codex", "dsh"] as AgentAdapterType[], primaryAgentTarget: "local:dsh",
    codexThreadId: "native-task", codexThreadName: "Renamed", codexCwd: "D:/Work",
    dshSessionId: "saved-session", dshBaseUrl: "http://localhost:3333", astrbotPassword: "local-fixture-secret",
    customFutureField: { preserve: true } };
  const before = structuredClone(route);
  const rows = configuredAgentRows(catalog, route.agentAdapters);
  assert.deepEqual(rows.map(row => [row.type, row.available]), [["codex", true], ["dsh", false]]);
  assert.equal(resolvePrimaryAgentTarget(route)?.id, "local:dsh");
  assert.deepEqual(route, before);
  assert.deepEqual(JSON.parse(JSON.stringify(route)), before);
});
