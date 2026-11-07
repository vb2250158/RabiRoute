import assert from "node:assert/strict";
import test from "node:test";
import {
  parseWebPluginCatalogResponse,
  pluginCatalogClient
} from "../src/pluginCatalogClient";

function catalogEnvelope() {
  return {
    code: 0,
    data: {
      schemaVersion: 2,
      generation: "manager-generation-a",
      host: "web",
      revision: { plugins: 3, contributions: 7 },
      plugins: [{
        instanceId: "manager:core",
        pluginId: "io.rabiroute.manager.core",
        status: "active",
        manifest: {
          id: "io.rabiroute.manager.core",
          hosts: ["manager", "web", "desktop"],
          capabilities: ["manager.core@1", "manager.contributions@2"]
        }
      }],
      contributions: [{
        kind: "navigation",
        surface: "web.navigation",
        id: "overview"
      }]
    }
  };
}

test("plugin catalog client performs the fixed Web catalog GET request", async () => {
  const originalFetch = globalThis.fetch;
  const requests: Array<{ input: string; init?: RequestInit }> = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    requests.push({ input: String(input), init });
    return new Response(JSON.stringify(catalogEnvelope()), {
      status: 200,
      headers: { "content-type": "application/json" }
    });
  }) as typeof fetch;

  try {
    const catalog = await pluginCatalogClient.readWeb();
    assert.equal(catalog.schemaVersion, 2);
    assert.equal(catalog.generation, "manager-generation-a");
    assert.equal(catalog.host, "web");
    assert.deepEqual(catalog.revision, { plugins: 3, contributions: 7 });
    assert.equal(catalog.contributions.length, 1);
    assert.deepEqual(catalog.plugins, [{
      instanceId: "manager:core",
      pluginId: "io.rabiroute.manager.core",
      status: "active",
      manifest: {
        id: "io.rabiroute.manager.core",
        hosts: ["manager", "web", "desktop"],
        capabilities: ["manager.core@1", "manager.contributions@2"]
      }
    }]);
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(requests.length, 1);
  assert.equal(requests[0]?.input, "/api/plugins/catalog?host=web");
  assert.equal(requests[0]?.init?.method, "GET");
  assert.deepEqual(requests[0]?.init?.headers, { accept: "application/json" });
});

test("plugin catalog client accepts an older Schema v2 catalog without generation", () => {
  const envelope = catalogEnvelope();
  delete (envelope.data as { generation?: string }).generation;

  const catalog = parseWebPluginCatalogResponse(envelope);

  assert.equal(catalog.generation, "");
});

test("plugin catalog client rejects unsupported or incomplete payloads", () => {
  assert.throws(
    () => parseWebPluginCatalogResponse({
      ...catalogEnvelope(),
      data: { ...catalogEnvelope().data, host: "desktop" }
    }),
    /schema or host is unsupported/
  );
  assert.throws(
    () => parseWebPluginCatalogResponse({
      ...catalogEnvelope(),
      data: { ...catalogEnvelope().data, contributions: null }
    }),
    /payload is incomplete/
  );
  assert.throws(
    () => parseWebPluginCatalogResponse({ code: -1, message: "catalog unavailable" }),
    /catalog unavailable/
  );
 });

test("one invalid plugin record does not remove healthy catalog entries", () => {
  const badPlugins: unknown[] = [null,
    { instanceId: "manager:bad", pluginId: "io.example.bad", status: "unknown", manifest: { id: "io.example.bad", hosts: ["web"], capabilities: [] } },
    { instanceId: "manager:bad", pluginId: "io.example.bad", status: "active", manifest: { id: "io.example.bad", hosts: ["browser"], capabilities: [] } },
    { instanceId: "manager:bad", pluginId: "io.example.bad", status: "active", manifest: { id: "io.example.bad", hosts: ["web"], capabilities: [" duplicated "] } },
    { instanceId: "manager:bad", pluginId: "io.example.bad", status: "active", manifest: { id: "io.example.bad", hosts: ["web"], capabilities: ["manager.core"] } }
  ];
  for (const bad of badPlugins) {
    const envelope = catalogEnvelope();
    const result = parseWebPluginCatalogResponse({ ...envelope, data: { ...envelope.data, plugins: [bad, ...envelope.data.plugins] } });
    assert.equal(result.partial, true);
    assert.deepEqual(result.plugins.map(value => value.instanceId), ["manager:core"]);
    assert.deepEqual(result.diagnostics, [{ code: "PLUGIN_CATALOG_ITEM_INVALID", index: 0,
      message: "This plugin catalog entry could not be displayed; other entries remain available." }]);
    assert.deepEqual(result.contributions, envelope.data.contributions);
  }
});

test("partial contribution diagnostics remain visible with healthy plugins", () => {
  const envelope = catalogEnvelope();
  const diagnostics = [{ code: "PLUGIN_CONTRIBUTION_PRESENTATION_FAILED", instanceId: "manager:bad", id: "broken" }];
  const result = parseWebPluginCatalogResponse({ ...envelope, data: { ...envelope.data, partial: true, diagnostics } });
  assert.equal(result.partial, true); assert.deepEqual(result.diagnostics, diagnostics); assert.equal(result.plugins.length, 1);
});


test("the Kernel's initializing status is a valid plugin catalog row", () => {
  const envelope = catalogEnvelope();
  const pending = { ...envelope.data.plugins[0]!, status: "initializing" };
  const result = parseWebPluginCatalogResponse({ ...envelope, data: { ...envelope.data, plugins: [pending] } });
  assert.equal(result.plugins[0]?.status, "initializing");
  assert.equal(result.partial, undefined);
});
