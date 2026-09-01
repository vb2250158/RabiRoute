/// <reference types="node" />
import assert from "node:assert/strict";
import test from "node:test";
import {
  consumeStoredWebThemePreference,
  initialWebThemePreference,
  registerTrustedWebThemeResource,
  registeredWebThemeResources,
  resolveWebThemeCatalog,
  resolveWebThemeResource
} from "./pluginThemes";

function theme(themeId: string, webResourceId: string, overrides: Record<string, unknown> = {}): unknown {
  return {
    kind: "theme", surface: "shared.themes", id: `${themeId}-theme`,
    instanceId: "manager:core", pluginId: "io.rabiroute.manager.core", themeId, webResourceId, hosts: ["web", "desktop"], ...overrides
  };
}

test("theme registry starts without base Bundle resources", () => {
  assert.deepEqual(registeredWebThemeResources(), []);
  assert.equal(resolveWebThemeResource(resolveWebThemeCatalog(null), "system").themeId, "system");
});

test("custom trusted theme resources resolve and disappear after disposal", () => {
  const dispose = registerTrustedWebThemeResource({
    instanceId: "manager:trusted", pluginId: "package:trusted", themeId: "trusted.solarized",
    webResourceId: "trusted.web-theme.solarized.v1", label: "Solarized", icon: "mdi-palette-outline", apply: () => "dark"
  });
  try {
    const catalog = resolveWebThemeCatalog([theme("trusted.solarized", "trusted.web-theme.solarized.v1", { instanceId: "manager:trusted", pluginId: "package:trusted" })]);
    assert.deepEqual(catalog.options.map(option => [option.themeId, option.webResourceId]), [["trusted.solarized", "trusted.web-theme.solarized.v1"]]);
    assert.equal(resolveWebThemeResource(catalog, "trusted.solarized").apply(false), "dark");
    assert.deepEqual(resolveWebThemeCatalog([theme("trusted.solarized", "trusted.web-theme.solarized.v1", { instanceId: "manager:other", pluginId: "package:trusted" })]).options, []);
    assert.deepEqual(resolveWebThemeCatalog([theme("trusted.solarized", "trusted.web-theme.solarized.v1", { instanceId: "manager:trusted", pluginId: "package:other" })]).options, []);
  } finally { dispose(); }
  assert.deepEqual(resolveWebThemeCatalog([theme("trusted.solarized", "trusted.web-theme.solarized.v1", { instanceId: "manager:trusted", pluginId: "package:trusted" })]).options, []);
});

test("unknown catalog selections use the fixed recovery resource and registrations reject duplicates", () => {
  assert.equal(resolveWebThemeResource(resolveWebThemeCatalog(null), "unknown").themeId, "system");
  const dispose = registerTrustedWebThemeResource({
    instanceId: "manager:trusted", pluginId: "package:trusted", themeId: "dark",
    webResourceId: "trusted.web-theme.dark.v1", label: "Dark", icon: "mdi-weather-night", apply: () => "dark"
  });
  try {
    assert.throws(() => registerTrustedWebThemeResource({
      instanceId: "manager:other", pluginId: "package:other", themeId: "dark",
      webResourceId: "trusted.web-theme.duplicate.v1", label: "Duplicate", icon: "mdi-palette-outline", apply: () => "dark"
    }), /already registered/);
  } finally { dispose(); }
});

test("Manager-owned Web theme wins while a missing Manager field migrates one legacy value", () => {
  assert.deepEqual(initialWebThemePreference("dark", "light"), { themeId: "dark", migrateToManager: false });
  assert.deepEqual(initialWebThemePreference("", "trusted.solarized"), { themeId: "trusted.solarized", migrateToManager: true });
  assert.deepEqual(initialWebThemePreference(undefined, ""), { themeId: "system", migrateToManager: false });
});

test("legacy browser theme is consumed once and removed", () => {
  const values = new Map([["rabiroute:webgui:theme-preference", " dark "]]);
  const removed: string[] = [];
  const storage = {
    getItem(key: string) { return values.get(key) ?? null; },
    removeItem(key: string) { removed.push(key); values.delete(key); }
  };
  assert.equal(consumeStoredWebThemePreference(storage), "dark");
  assert.deepEqual(removed, ["rabiroute:webgui:theme-preference"]);
  assert.equal(consumeStoredWebThemePreference(storage), "");
});
