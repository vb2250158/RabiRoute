/// <reference types="node" />
import assert from "node:assert/strict";
import test from "node:test";
import {
  replaceCustomWebThemeResources,
  registerTrustedWebThemeResource,
  registeredWebThemeResources,
  resolveWebThemeCatalog,
  resolveWebThemeResource
} from "./pluginThemes";

function theme(themeId: string, webResourceId: string, overrides: Record<string, unknown> = {}): unknown {
  return {
    kind: "theme",
    surface: "shared.themes",
    id: `${themeId}-theme`,
    instanceId: "manager:core",
    pluginId: "builtin:manager/core",
    themeId,
    webResourceId,
    hosts: ["web", "desktop"],
    ...overrides
  };
}

test("built-in themes use the trusted resource registration API", () => {
  assert.deepEqual(registeredWebThemeResources().map(theme => [theme.instanceId, theme.pluginId, theme.themeId]), [
    ["manager:core", "builtin:manager/core", "system"],
    ["manager:core", "builtin:manager/core", "light"],
    ["manager:core", "builtin:manager/core", "dark"]
  ]);
  const catalog = resolveWebThemeCatalog([
    theme("system", "builtin.web-theme.system.v1"),
    theme("light", "builtin.web-theme.light.v1"),
    theme("dark", "builtin.web-theme.dark.v1")
  ]);
  assert.deepEqual(catalog.options.map(option => [option.themeId, option.webResourceId]), [
    ["system", "builtin.web-theme.system.v1"],
    ["light", "builtin.web-theme.light.v1"],
    ["dark", "builtin.web-theme.dark.v1"]
  ]);
  assert.equal(resolveWebThemeResource(catalog, "dark").apply(false), "dark");
});

test("custom trusted theme resources resolve and disappear after disposal", () => {
  const dispose = registerTrustedWebThemeResource({
    instanceId: "manager:trusted",
    pluginId: "package:trusted",
    themeId: "trusted.solarized",
    webResourceId: "trusted.web-theme.solarized.v1",
    label: "Solarized",
    icon: "mdi-palette-outline",
    apply: () => "dark"
  });
  try {
    const catalog = resolveWebThemeCatalog([
      theme("trusted.solarized", "trusted.web-theme.solarized.v1", {
        instanceId: "manager:trusted",
        pluginId: "package:trusted"
      })
    ]);
    assert.deepEqual(catalog.options.map(option => option.themeId), ["trusted.solarized"]);
    assert.equal(resolveWebThemeResource(catalog, "trusted.solarized").apply(false), "dark");
    assert.deepEqual(resolveWebThemeCatalog([
      theme("trusted.solarized", "C:/plugins/theme.css", {
        instanceId: "manager:trusted",
        pluginId: "package:trusted"
      })
    ]).options, []);
    assert.deepEqual(resolveWebThemeCatalog([
      theme("trusted.solarized", "trusted.web-theme.solarized.v1", {
        instanceId: "manager:other",
        pluginId: "package:trusted"
      })
    ]).options, []);
    assert.deepEqual(resolveWebThemeCatalog([
      theme("trusted.solarized", "trusted.web-theme.solarized.v1", {
        instanceId: "manager:trusted",
        pluginId: "package:other"
      })
    ]).options, []);
    assert.deepEqual(resolveWebThemeCatalog([
      theme("trusted.solarized", "trusted.web-theme.solarized.v1", {
        surface: "web.themes",
        instanceId: "manager:trusted",
        pluginId: "package:trusted"
      })
    ]).options, []);
  } finally {
    dispose();
  }
  assert.deepEqual(resolveWebThemeCatalog([
    theme("trusted.solarized", "trusted.web-theme.solarized.v1", {
      instanceId: "manager:trusted",
      pluginId: "package:trusted"
    })
  ]).options, []);
});

test("unknown catalog selections use the registered system recovery resource", () => {
  assert.deepEqual(resolveWebThemeResource(resolveWebThemeCatalog(null), "unknown").themeId, "system");
  assert.throws(() => registerTrustedWebThemeResource({
    instanceId: "manager:core",
    pluginId: "builtin:manager/core",
    themeId: "dark",
    webResourceId: "trusted.web-theme.duplicate.v1",
    label: "Duplicate",
    icon: "mdi-palette-outline",
    apply: () => "dark"
  }), /already registered/);
});

test("Manager custom themes replace stale registry entries instead of accumulating", () => {
  const customTheme = {
    id: "custom:night-rain-green",
    name: "夜雨绿",
    baseTheme: "dark",
    colors: { accent: "#22c55e" },
    styles: {}
  };
  replaceCustomWebThemeResources([customTheme]);
  assert.deepEqual(resolveWebThemeCatalog(null).options.map(option => option.themeId), [customTheme.id]);
  replaceCustomWebThemeResources([]);
  assert.deepEqual(resolveWebThemeCatalog(null).options, []);
  assert.equal(resolveWebThemeResource(resolveWebThemeCatalog(null), customTheme.id).themeId, "system");
});
