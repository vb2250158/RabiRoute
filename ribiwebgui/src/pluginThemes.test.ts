/// <reference types="node" />
import assert from "node:assert/strict";
import test from "node:test";
import { resolveWebThemeCatalog, resolveWebThemeResource } from "./pluginThemes";

function theme(themeId: string, webResourceId: string, overrides: Record<string, unknown> = {}): unknown {
  return {
    kind: "theme",
    id: `${themeId}-theme`,
    instanceId: "manager:core",
    pluginId: "builtin:manager/core",
    themeId,
    webResourceId,
    desktopResourceId: `builtin.desktop-theme.${themeId}.v1`,
    hosts: ["web", "desktop"],
    ...overrides
  };
}

test("theme catalog maps only fixed theme IDs to built-in Web resources", () => {
  const catalog = resolveWebThemeCatalog([
    theme("system", "builtin.web-theme.system.v1"),
    theme("light", "builtin.web-theme.light.v1"),
    theme("dark", "builtin.web-theme.dark.v1"),
    theme("dark", "C:/plugins/theme.css", { instanceId: "manager:unsafe" }),
    theme("custom", "builtin.web-theme.custom.v1")
  ]);

  assert.deepEqual(catalog.options.map(option => [option.themeId, option.webResourceId]), [
    ["system", "builtin.web-theme.system.v1"],
    ["light", "builtin.web-theme.light.v1"],
    ["dark", "builtin.web-theme.dark.v1"]
  ]);
  assert.equal(resolveWebThemeResource(catalog, "dark").webResourceId, "builtin.web-theme.dark.v1");
});

test("missing or unknown catalog selections use the fixed system recovery resource", () => {
  const empty = resolveWebThemeCatalog(null);
  assert.deepEqual(resolveWebThemeResource(empty, "dark"), {
    theme: "system",
    webResourceId: "builtin.web-theme.system.v1"
  });
});
