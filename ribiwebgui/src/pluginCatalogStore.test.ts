/// <reference types="node" />
import assert from "node:assert/strict";
import test from "node:test";
import { activateCore } from "../../src/plugins/io.rabiroute.manager.core/web/contributions";
import { pluginCatalogStore } from "./pluginCatalogStore";
import { activateWebPluginForTest } from "../tests/web-plugin-test-host";

function catalogResponse(): Response {
  return new Response(JSON.stringify({
    code: 0,
    data: {
      schemaVersion: 2,
      generation: "manager-generation-a",
      host: "web",
      revision: { plugins: 1, contributions: 2 },
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
        kind: "page",
        surface: "web.pages",
        id: "settings-page",
        instanceId: "manager:core",
        pluginId: "io.rabiroute.manager.core",
        routeId: "global.settings",
        rendererId: "builtin.web-page.settings.v1",
        hosts: ["web"]
      }, {
        kind: "theme",
        surface: "shared.themes",
        id: "dark-theme",
        instanceId: "manager:core",
        pluginId: "io.rabiroute.manager.core",
        themeId: "dark",
        webResourceId: "builtin.web-theme.dark.v1",
        desktopResourceId: "builtin.desktop-theme.dark.v1",
        hosts: ["web", "desktop"]
      }]
    }
  }), { status: 200, headers: { "content-type": "application/json" } });
}

test("catalog store retains healthy display on temporary failure and clears it on authentication loss", async () => {
  const originalFetch = globalThis.fetch;
  let mode: "fail" | "success" | "forbidden" = "fail";
  globalThis.fetch = (async () => {
    if (mode === "success") return catalogResponse();
    return new Response("unavailable", { status: mode === "forbidden" ? 403 : 503 });
  }) as typeof fetch;

  const disposeCore = activateWebPluginForTest(
    { instanceId: "manager:core", pluginId: "io.rabiroute.manager.core" },
    activateCore
  );

  try {
    await pluginCatalogStore.refresh();
    assert.equal(pluginCatalogStore.status.value, "unavailable");
    assert.equal(pluginCatalogStore.pages.value.mode, "recovery");

    mode = "success";
    await pluginCatalogStore.refresh();
    assert.equal(pluginCatalogStore.status.value, "ready");
    assert.equal(pluginCatalogStore.pages.value.pages[0]?.routeId, "global.settings");
    assert.deepEqual(pluginCatalogStore.themes.value.options.map(option => option.themeId), ["dark"]);

    mode = "fail";
    await pluginCatalogStore.refresh();
    assert.equal(pluginCatalogStore.status.value, "ready");
    assert.equal(pluginCatalogStore.pages.value.pages[0]?.routeId, "global.settings");
    assert.deepEqual(pluginCatalogStore.themes.value.options.map(option => option.themeId), ["dark"]);
    assert.ok(pluginCatalogStore.lastRefreshError.value);
    mode = "success";
    await pluginCatalogStore.refresh();
    assert.equal(pluginCatalogStore.lastRefreshError.value, "");
    mode = "forbidden";
    await pluginCatalogStore.refresh();
    assert.equal(pluginCatalogStore.status.value, "unavailable");
    assert.equal(pluginCatalogStore.pages.value.mode, "recovery");
    assert.deepEqual(pluginCatalogStore.commands.value, []);
    assert.deepEqual(pluginCatalogStore.themes.value.options, []);
  } finally {
    disposeCore();
    globalThis.fetch = originalFetch;
  }
});


test("a late catalog response cannot restore a snapshot after newer authentication loss", async () => {
  const originalFetch = globalThis.fetch;
  let finishOld!: (response: Response) => void;
  let requests = 0;
  globalThis.fetch = (async () => {
    requests++;
    if (requests === 1) return new Promise<Response>(resolve => { finishOld = resolve; });
    return new Response("unauthorized", { status: 401 });
  }) as typeof fetch;
  try {
    const old = pluginCatalogStore.refresh();
    await pluginCatalogStore.refresh();
    assert.equal(pluginCatalogStore.status.value, "unavailable");
    finishOld(catalogResponse());
    await old;
    assert.equal(pluginCatalogStore.status.value, "unavailable");
    assert.equal(pluginCatalogStore.pages.value.mode, "recovery");
  } finally { globalThis.fetch = originalFetch; }
});
