import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import { RabiCordisHost } from "../runtime/cordisHost.js";
import { mountManagerPluginRuntime } from "../runtime/managerPluginRuntime.js";
import { ManagerPluginReconciler } from "../runtime/managerPluginReconciler.js";
import { builtinManagerPluginDefinitions } from "./builtinManagerPlugins.js";
import { normalizeManagerPluginConfig } from "./managerPluginConfig.js";
import { handlePluginCatalogApi } from "./pluginCatalogRoutes.js";

async function startCatalogServer() {
  const host = new RabiCordisHost();
  const runtime = await mountManagerPluginRuntime(host);
  const reconciler = new ManagerPluginReconciler(runtime);
  const normalized = normalizeManagerPluginConfig({});
  await reconciler.reconcile(normalized.desired);
  let reconcileCount = 0;
  const server = http.createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (!handlePluginCatalogApi(request, url, response, {
      runtime,
      reconciliation: {
        reconciler,
        diagnostics: () => normalized.diagnostics,
        reconcile: async () => {
          reconcileCount += 1;
          return reconciler.reconcile(normalized.desired);
        }
      }
    })) {
      response.writeHead(404).end();
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Catalog test server did not bind.");
  return {
    runtime,
    reconciler,
    reconcileCount: () => reconcileCount,
    baseUrl: `http://127.0.0.1:${address.port}`,
    async close() {
      await runtime.unmount();
      await host.dispose();
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  };
}

test("Plugin Catalog API publishes one unified plugin and contribution snapshot", async () => {
  const app = await startCatalogServer();
  try {
    const response = await fetch(`${app.baseUrl}/api/plugins/catalog`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "no-store");
    const body = await response.json() as {
      code: number;
      data: {
        schemaVersion: number;
        host: string;
        plugins: Array<{ instanceId: string; status: string }>;
        contributions: Array<{ id: string; kind: string }>;
      };
    };
    assert.equal(body.code, 0);
    assert.equal(body.data.schemaVersion, 2);
    assert.equal(body.data.host, "all");
    assert.equal(body.data.plugins.every(item => item.status === "active"), true);
    assert.equal(body.data.contributions.some(item => item.id === "overview"), true);
    assert.equal(body.data.contributions.some(item => item.id === "desktop-settings"), true);
    assert.equal(body.data.contributions.some(item => item.kind === "page" && item.id === "overview-page"), true);
    assert.equal(body.data.contributions.some(item => item.kind === "theme" && item.id === "system-theme"), true);
    assert.equal(body.data.contributions.some(item => item.kind === "hotkey" && item.id === "capture-screenshot-hotkey"), true);
    const serialized = JSON.stringify(body.data);
    for (const forbidden of ["target", "endpoint", "query", "body", "resourceRoot"]) {
      assert.equal(serialized.includes(`"${forbidden}"`), false);
    }
  } finally {
    await app.close();
  }
});

test("Plugin Catalog API filters contributions for Desktop", async () => {
  const app = await startCatalogServer();
  try {
    const response = await fetch(`${app.baseUrl}/api/plugins/catalog?host=desktop`);
    assert.equal(response.status, 200);
    const body = await response.json() as {
      data: {
        host: string;
        generation: string;
        plugins: Array<{ instanceId: string; host: string }>;
        contributions: Array<{ hosts: string[]; instanceId: string }>;
      };
    };
    assert.equal(body.data.host, "desktop");
    assert.equal(body.data.generation, app.runtime.generation);
    assert.match(body.data.generation, /^[0-9a-f-]{36}$/);
    assert.equal(body.data.plugins.some(item => item.instanceId === "manager:core" && item.host === "manager"), true);
    assert.equal(body.data.contributions.length > 0, true);
    assert.equal(body.data.contributions.every(item => item.hosts.includes("desktop")), true);
    assert.equal(body.data.contributions.every(item => item.instanceId.startsWith("manager:")), true);
  } finally {
    await app.close();
  }
});

test("Plugin Catalog API rejects unsupported hosts and ignores unrelated paths", async () => {
  const app = await startCatalogServer();
  try {
    const invalid = await fetch(`${app.baseUrl}/api/plugins/catalog?host=gateway`);
    assert.equal(invalid.status, 400);
    const missing = await fetch(`${app.baseUrl}/api/plugins/other`);
    assert.equal(missing.status, 404);
  } finally {
    await app.close();
  }
});


test("Plugin reconciliation API publishes state and triggers a controlled reread", async () => {
  const app = await startCatalogServer();
  try {
    const current = await fetch(`${app.baseUrl}/api/plugins/reconciliation`);
    assert.equal(current.status, 200);
    const currentBody = await current.json() as {
      data: { schemaVersion: number; state: string; active: string[]; diagnostics: unknown[] };
    };
    assert.equal(currentBody.data.schemaVersion, 1);
    assert.equal(currentBody.data.state, "idle");
    assert.equal(currentBody.data.active.includes("manager:core"), true);
    assert.deepEqual(currentBody.data.diagnostics, []);

    const reconciled = await fetch(`${app.baseUrl}/api/plugins/reconciliation`, { method: "POST" });
    assert.equal(reconciled.status, 200);
    assert.equal(app.reconcileCount(), 1);
    const reconciledBody = await reconciled.json() as { data: { changed: string[] } };
    assert.deepEqual(reconciledBody.data.changed, []);
  } finally {
    await app.close();
  }
});
