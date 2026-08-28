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
  assert.throws(
    () => parseWebPluginCatalogResponse({
      ...catalogEnvelope(),
      data: {
        ...catalogEnvelope().data,
        plugins: [{
          instanceId: "manager:core",
          pluginId: "io.rabiroute.manager.core",
          status: "unknown",
          manifest: { id: "io.rabiroute.manager.core", hosts: ["web"], capabilities: [] }
        }]
      }
    }),
    /status is invalid/
  );
  assert.throws(
    () => parseWebPluginCatalogResponse({
      ...catalogEnvelope(),
      data: {
        ...catalogEnvelope().data,
        plugins: [{
          instanceId: "manager:core",
          pluginId: "io.rabiroute.manager.core",
          status: "active",
          manifest: { id: "io.rabiroute.manager.core", hosts: ["browser"], capabilities: [] }
        }]
      }
    }),
    /manifest\.hosts is invalid/
  );
  assert.throws(
    () => parseWebPluginCatalogResponse({
      ...catalogEnvelope(),
      data: {
        ...catalogEnvelope().data,
        plugins: [{
          instanceId: "manager:core",
          pluginId: "io.rabiroute.manager.core",
          status: "active",
          manifest: { id: "io.rabiroute.manager.core", hosts: ["web"], capabilities: [" duplicated "] }
        }]
      }
    }),
    /manifest\.capabilities\[0\] is invalid/
  );
  assert.throws(
    () => parseWebPluginCatalogResponse({
      ...catalogEnvelope(),
      data: {
        ...catalogEnvelope().data,
        plugins: [{
          instanceId: "manager:core",
          pluginId: "io.rabiroute.manager.core",
          status: "active",
          manifest: { id: "io.rabiroute.manager.core", hosts: ["web"], capabilities: ["manager.core"] }
        }]
      }
    }),
    /manifest\.capabilities\[0\] is invalid/
  );
});
