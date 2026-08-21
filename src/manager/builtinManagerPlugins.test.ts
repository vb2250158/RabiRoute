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
    "manager:desktop"
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
    ["open-webgui", "open-settings"]
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
