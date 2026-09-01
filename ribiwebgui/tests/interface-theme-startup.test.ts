import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import {
  clearStoredWebThemePreference,
  initialWebThemePreference,
  storedWebThemePreference,
  replaceCustomWebThemeResources,
  resolveWebThemeCatalog,
  resolveWebThemeResource
} from "../src/pluginThemes";
import { cloneBuiltinInterfaceTheme } from "../../src/shared/interfaceThemeContract";

const appSource = fs.readFileSync(new URL("../src/App.vue", import.meta.url), "utf8");
const managerSource = fs.readFileSync(new URL("../../src/manager/controlPlaneRoutes.ts", import.meta.url), "utf8");

test("startup uses Manager webTheme and registers custom themes before resolution", () => {
  assert.match(appSource, /settings\.webTheme/);
  assert.match(appSource, /replaceCustomWebThemeResources\(settings\.customThemes\)/);
  assert.match(appSource, /storedWebThemePreference\(\)/);
  assert.match(appSource, /clearStoredWebThemePreference\(\)/);
  assert.match(appSource, /desktop_settings_changed/);
  assert.match(appSource, /desktopSettingsClient\.update\(\{\s*webTheme:/);
  assert.doesNotMatch(appSource, /desktopSettingsClient\.update\(\{\s*theme:/);
  assert.match(managerSource, /publishManagerEvent\("desktop_settings_changed"/);
});

test("legacy browser theme is cleared only after Manager selection or migration succeeds", () => {
  const removed: string[] = [];
  const storage = {
    getItem() { return "light"; },
    removeItem(key: string) { removed.push(key); }
  };
  const legacy = storedWebThemePreference(storage);
  const selected = initialWebThemePreference("dark", legacy);
  assert.deepEqual(selected, { themeId: "dark", migrateToManager: false });
  assert.deepEqual(removed, []);
  clearStoredWebThemePreference(storage);
  assert.deepEqual(removed, ["rabiroute:webgui:theme-preference"]);
});

test("custom themes are resolvable without mounting the Settings route", () => {
  const base = cloneBuiltinInterfaceTheme("dark");
  const custom = { id: "custom:any-route-startup", name: "任意路由", ...base };
  replaceCustomWebThemeResources([custom]);
  try {
    const selected = resolveWebThemeResource(resolveWebThemeCatalog(null), custom.id);
    assert.equal(selected.themeId, custom.id);
    assert.equal(selected.customTheme?.name, custom.name);
  } finally {
    replaceCustomWebThemeResources([]);
  }
});
