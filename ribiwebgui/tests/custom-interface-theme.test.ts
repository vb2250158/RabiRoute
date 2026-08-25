import assert from "node:assert/strict";
import test from "node:test";
import { cloneBuiltinInterfaceTheme } from "../../src/shared/interfaceThemeContract";
import {
  replaceCustomWebThemeResources,
  resolveWebThemeCatalog,
  resolveWebThemeResource
} from "../src/pluginThemes";

test("Manager-owned custom themes become selectable declarative Web resources", () => {
  const base = cloneBuiltinInterfaceTheme("dark");
  const custom = {
    id: "custom:night-rain-green",
    name: "夜雨绿",
    ...base,
    colors: { ...base.colors, accent: "#22c55e", success: "#16a34a" }
  };
  replaceCustomWebThemeResources([custom]);
  const catalog = resolveWebThemeCatalog(null);
  const selected = resolveWebThemeResource(catalog, custom.id);
  assert.equal(selected.label, custom.name);
  assert.equal(selected.desktopTheme, custom.id);
  assert.equal(selected.customTheme?.colors.success, "#16a34a");
  assert.equal(selected.apply(false), "dark");
  replaceCustomWebThemeResources([]);
});
