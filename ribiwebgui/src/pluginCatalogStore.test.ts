/// <reference types="node" />
import assert from "node:assert/strict";
import test from "node:test";
import { pluginCatalogStore } from "./pluginCatalogStore";

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
        pluginId: "builtin:manager/core",
        status: "active",
        manifest: {
          id: "builtin:manager/core",
          hosts: ["manager", "web", "desktop"],
          capabilities: ["manager.plugin-catalog", "manager.contributions"]
        }
      }],
      contributions: [{
        kind: "page",
        surface: "web.pages",
        id: "settings-page",
        instanceId: "manager:core",
        pluginId: "builtin:manager/core",
        routeId: "global.settings",
        rendererId: "builtin.web-page.settings.v1",
        hosts: ["web"]
      }, {
        kind: "theme",
        surface: "shared.themes",
        id: "dark-theme",
        instanceId: "manager:core",
        pluginId: "builtin:manager/core",
        themeId: "dark",
        webResourceId: "builtin.web-theme.dark.v1",
        desktopResourceId: "builtin.desktop-theme.dark.v1",
        hosts: ["web", "desktop"]
      }]
    }
  }), { status: 200, headers: { "content-type": "application/json" } });
}

test("catalog store removes plugin contributions after every catalog failure", async () => {
  const originalFetch = globalThis.fetch;
  let mode: "fail" | "success" = "fail";
  globalThis.fetch = (async () => {
    if (mode === "success") return catalogResponse();
    return new Response("unavailable", { status: 503 });
  }) as typeof fetch;

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
    assert.equal(pluginCatalogStore.status.value, "unavailable");
    assert.equal(pluginCatalogStore.pages.value.mode, "recovery");
    assert.deepEqual(pluginCatalogStore.commands.value, []);
    assert.deepEqual(pluginCatalogStore.themes.value.options, []);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
