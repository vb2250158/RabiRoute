import assert from "node:assert/strict";
import test from "node:test";
import { renderPluginCatalog, type PluginCatalogInput } from "./pluginCatalogPresentation.js";

function fixture(): PluginCatalogInput {
  return {
    id: "generation-original", sequence: 2,
    records: [{
      identity: { applicationGenerationId: "application", managerInstanceId: "manager", activationId: "active",
        instanceId: "agent:example", pluginId: "io.example.agent", version: "1.0.0", revision: "immutable", host: "manager" },
      manifest: { schemaVersion: 2, id: "io.example.agent", version: "1.0.0", entries: {},
        provides: ["agent.adapter.example@1"], requires: [], optional: [], permissions: [] },
      status: "active", missingCapabilities: []
    }],
    contributions: { revision: 2, contributions: [
      { instanceId: "agent:example", kind: "agent-adapter", id: "example", value: {
        type: "exampleAgent", capability: "agent.adapter.example@1",
        manifest: { type: "exampleAgent", label: "Example", maturity: "experimental", capabilities: {} }
      } },
      { instanceId: "agent:example", kind: "agent-adapter-settings", id: "example.web", value: { hosts: ["web"] } },
      { instanceId: "agent:example", kind: "settings-section", id: "example.desktop", value: { hosts: ["desktop"] } }
    ] }
  };
}

test("Web catalog retains native Agent identity and capabilities from its active owner", () => {
  const result = renderPluginCatalog(fixture(), "web");
  assert.deepEqual(result.contributions.map(value => value.id), ["example", "example.web"]);
  assert.equal(result.contributions[0]?.pluginId, "io.example.agent");
  assert.equal(result.contributions[0]?.instanceId, "agent:example");
  assert.deepEqual(result.plugins[0]?.manifest.capabilities, ["agent.adapter.example@1"]);
});

test("desktop projection does not receive Web-only renderer contributions", () => {
  const result = renderPluginCatalog(fixture(), "desktop");
  assert.deepEqual(result.contributions.map(value => value.id), ["example", "example.desktop"]);
});


test("one broken contribution leaves healthy neighbors and the plugin lifecycle intact", () => {
  const original = fixture();
  const broken = { hosts: ["web"], get label(): string { throw new Error("private error detail"); } };
  const generation: PluginCatalogInput = { ...original, contributions: { ...original.contributions, contributions: [
    original.contributions.contributions[0]!,
    { instanceId: "agent:example", kind: "page", id: "broken", value: broken },
    ...original.contributions.contributions.slice(1)
  ] } };
  const result = renderPluginCatalog(generation, "web");
  assert.deepEqual(result.contributions.map(value => value.id), ["example", "example.web"]);
  assert.equal(result.partial, true);
  assert.deepEqual(result.diagnostics?.map(item => [item.code, item.instanceId, item.id]),
    [["PLUGIN_CONTRIBUTION_PRESENTATION_FAILED", "agent:example", "broken"]]);
  assert.equal(result.plugins[0]?.status, "active");
  assert.equal(result.generation, generation.id);
  assert.deepEqual(result.revision, { plugins: 2, contributions: 2 });
  assert(!JSON.stringify(result).includes("private error detail"));
});

test("hosts, nested JSON failures and late getters stay local to their contribution", () => {
  const generation = fixture();
  const cycle: { self?: unknown } = {}; cycle.self = cycle;
  const failures: unknown[] = [
    { get hosts(): never { throw new Error("hosts failed"); } },
    { hosts: ["web"], nested: cycle },
    { hosts: ["web"], nested: 1n },
    { hosts: ["web"], toJSON(): never { throw new Error("JSON failed"); } }
  ];
  const brokenGeneration: PluginCatalogInput = { ...generation, contributions: { ...generation.contributions, contributions: [
    ...generation.contributions.contributions,
    ...failures.map((value, index) => ({ instanceId: "agent:example", kind: "page", id: `broken-${index}`, value }))
  ] } };
  const result = renderPluginCatalog(brokenGeneration, "web");
  assert.equal(result.diagnostics?.length, failures.length);
  assert.deepEqual(result.contributions.map(value => value.id), ["example", "example.web"]);
  assert.doesNotThrow(() => JSON.stringify(result));
  const restored = renderPluginCatalog(generation, "web");
  assert.equal(restored.partial, undefined);
  assert.equal(restored.diagnostics, undefined);
});
