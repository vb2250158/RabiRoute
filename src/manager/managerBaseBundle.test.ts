import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { ManagerPluginDefinition } from "../runtime/managerPluginRuntime.js";

type ManagerBaseBundleModule = Readonly<{
  managerPluginInstanceIds: readonly string[];
  createPlugin(context: Readonly<{
    instanceId: string;
    bundle: Readonly<{ id: string; version: string; revision: string }>;
    services: Readonly<{ activate(): Promise<void> }>;
  }>): ManagerPluginDefinition;
}>;

async function loadBundle(): Promise<ManagerBaseBundleModule> {
  const entry = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "plugins", "packages", "rabi.manager.base", "0.2.1", "index.mjs");
  return import(pathToFileURL(entry).href) as Promise<ManagerBaseBundleModule>;
}

async function definitions(): Promise<ManagerPluginDefinition[]> {
  const bundle = await loadBundle();
  return bundle.managerPluginInstanceIds.map(instanceId => bundle.createPlugin({
    instanceId,
    bundle: { id: "rabi.manager.base", version: "0.2.1", revision: "test" },
    services: { activate: async () => {} }
  }));
}

test("base Bundle directly owns all built-in Manager definitions", async () => {
  const sourcePath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "plugins", "packages", "rabi.manager.base", "0.2.1", "index.mjs");
  const source = fs.readFileSync(sourcePath, "utf8");
  assert.doesNotMatch(source, /createBuiltinManagerPluginDefinition/);
  const loaded = await definitions();
  assert.deepEqual(loaded.map(item => item.instanceId), [
    "manager:core", "manager:persona", "manager:speech", "manager:performance", "manager:desktop", "manager:gateway-runtime",
    "manager:bilibili-history", "manager:route-control", "manager:message-adapter-control", "manager:agent-adapter-catalog",
    "manager:agent-state-control", "manager:agent-thread-control", "manager:agent-communication", "manager:copilot-control",
    "manager:astrbot-control", "manager:marvis-control", "manager:remote-agent", "manager:diagnostics", "manager:rabilink-relay",
    "manager:memory-consolidation", "manager:fennenote-output", "manager:message-processing-control", "manager:message-processing-automation",
    "manager:plan-feedback-delivery", "manager:napcat-control", "manager:napcat-supervisor"
  ]);
  assert.equal(loaded.every(item => item.manifest.id === "rabi.manager.base" && item.manifest.version === "0.2.1"), true);
  assert.equal(loaded.every(item => typeof item.apply === "function"), true);
});

test("base Bundle keeps navigation and command references within their instance", async () => {
  for (const plugin of await definitions()) {
    const contributions = plugin.contributions ?? [];
    const pages = new Map(contributions.filter(item => item.kind === "page").map(item => [item.routeId, item]));
    const commands = new Set(contributions.filter(item => item.kind === "command").map(item => item.id));
    for (const navigation of contributions.filter(item => item.kind === "navigation")) {
      assert.equal(pages.has(navigation.routeId), true, `${plugin.instanceId}:${navigation.id}`);
    }
    for (const item of contributions.filter(item => item.kind === "tray-menu" || item.kind === "hotkey")) {
      assert.equal(commands.has(item.commandId), true, `${plugin.instanceId}:${item.id}`);
    }
  }
});
