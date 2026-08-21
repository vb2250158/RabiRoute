import assert from "node:assert/strict";
import test from "node:test";
import { builtinManagerPluginDefinitions } from "./builtinManagerPlugins.js";

test("built-in Manager plugins publish the current WebGUI and Desktop contribution surface", () => {
  const definitions = builtinManagerPluginDefinitions();
  assert.deepEqual(definitions.map(item => item.instanceId), [
    "manager:core",
    "manager:persona",
    "manager:speech",
    "manager:performance",
    "manager:desktop",
    "manager:gateway-runtime",
    "manager:rabilink-relay",
    "manager:memory-consolidation",
    "manager:message-processing-automation",
    "manager:plan-feedback-delivery",
    "manager:napcat-supervisor"
  ]);
  const contributions = definitions.flatMap(item => item.contributions ?? []);
  const keys = contributions.map(item => `${item.kind}:${item.id}`);
  assert.equal(new Set(keys).size, keys.length);
  assert.deepEqual(
    contributions.filter(item => item.kind === "navigation").map(item => item.id),
    ["overview", "message-adapters", "runtime", "settings", "docs", "persona", "knowledge", "persona-sync", "speech", "performance"]
  );
  assert.equal(contributions.some(item => item.hosts.includes("desktop")), true);
  const desktopCommands = new Set(
    contributions
      .filter(item => item.kind === "command" && item.hosts.includes("desktop"))
      .map(item => item.id)
  );
  assert.deepEqual(
    contributions
      .filter(item => item.kind === "tray-menu" || item.kind === "hotkey")
      .map(item => item.commandId),
    ["capture-screenshot", "pin-clipboard-image", "open-webgui", "open-settings"]
  );
  assert.equal(
    contributions
      .filter(item => item.kind === "tray-menu" || item.kind === "hotkey")
      .every(item => desktopCommands.has(item.commandId)),
    true
  );
  assert.equal(contributions.every(item => Boolean(item.surface) && Boolean(item.slot)), true);
  assert.equal(contributions.every(item => Boolean(item.label.fallback)), true);
});

test("builtin Manager plugins pair every navigation with a page in the same instance", () => {
  for (const plugin of builtinManagerPluginDefinitions()) {
    const pages = new Map(
      (plugin.contributions ?? [])
        .filter(contribution => contribution.kind === "page")
        .map(contribution => [contribution.routeId, contribution])
    );
    for (const navigation of (plugin.contributions ?? []).filter(contribution => contribution.kind === "navigation")) {
      const page = pages.get(navigation.routeId);
      assert.ok(page, `${plugin.instanceId}:${navigation.id} is missing page ${navigation.routeId}`);
      assert.equal(page.hosts.includes("web"), true);
    }
  }
});

test("builtin Manager plugins publish only controlled interface themes", () => {
  const themes = builtinManagerPluginDefinitions()
    .flatMap(plugin => plugin.contributions ?? [])
    .filter(contribution => contribution.kind === "theme");

  assert.deepEqual(themes.map(theme => theme.themeId), ["system", "light", "dark"]);
  assert.deepEqual(
    themes.map(theme => [theme.webResourceId, theme.desktopResourceId]),
    [
      ["builtin.web-theme.system.v1", "builtin.desktop-theme.system.v1"],
      ["builtin.web-theme.light.v1", "builtin.desktop-theme.light.v1"],
      ["builtin.web-theme.dark.v1", "builtin.desktop-theme.dark.v1"]
    ]
  );
});

test("builtin Desktop hotkeys reference commands from the same plugin instance", () => {
  const desktop = builtinManagerPluginDefinitions().find(plugin => plugin.instanceId === "manager:desktop");
  assert.ok(desktop);
  const commands = new Map(
    (desktop.contributions ?? [])
      .filter(contribution => contribution.kind === "command")
      .map(contribution => [contribution.id, contribution.handlerId])
  );
  const hotkeys = (desktop.contributions ?? []).filter(contribution => contribution.kind === "hotkey");

  assert.deepEqual(
    hotkeys.map(hotkey => [hotkey.commandId, hotkey.defaultBinding, commands.get(hotkey.commandId)]),
    [
      ["capture-screenshot", "Ctrl+Shift+S", "desktop.capture-screenshot"],
      ["pin-clipboard-image", "F3", "desktop.pin-clipboard-image"]
    ]
  );
});

test("builtin Manager service plugins publish no UI contributions", () => {
  const definitions = builtinManagerPluginDefinitions();
  const serviceInstanceIds = [
    "manager:gateway-runtime",
    "manager:rabilink-relay",
    "manager:memory-consolidation",
    "manager:message-processing-automation",
    "manager:plan-feedback-delivery",
    "manager:napcat-supervisor"
  ];

  assert.deepEqual(
    definitions
      .filter(definition => serviceInstanceIds.includes(definition.instanceId))
      .map(definition => ({
        instanceId: definition.instanceId,
        contributions: definition.contributions ?? []
      })),
    serviceInstanceIds.map(instanceId => ({ instanceId, contributions: [] }))
  );
});
