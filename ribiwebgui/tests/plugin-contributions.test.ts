import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import type { WebPluginCatalog, WebPluginCatalogPlugin } from "../src/pluginCatalogClient";
import { availableWebContributions } from "../src/pluginContributions";
import { resolveWebCommandCatalog } from "../src/pluginCommands";

const pluginId = "rabi.manager.base";
const activePlugin: WebPluginCatalogPlugin = {
  instanceId: "manager:route-control",
  pluginId,
  status: "active",
  manifest: {
    id: pluginId,
    hosts: ["manager", "web", "desktop"],
    capabilities: ["plugin.unrelated-capability"]
  }
};

function catalog(
  contributions: readonly unknown[],
  plugins: readonly WebPluginCatalogPlugin[] = [activePlugin]
): WebPluginCatalog {
  return {
    schemaVersion: 2,
    generation: "manager-generation-a",
    host: "web",
    revision: { plugins: 1, contributions: 1 },
    plugins,
    contributions
  };
}

function quickSetup(overrides: Record<string, unknown> = {}): unknown {
  return {
    kind: "command",
    surface: "web.commands",
    id: "quick-setup",
    instanceId: "manager:route-control",
    pluginId,
    hosts: ["web"],
    handlerId: "web.quick-setup",
    slot: "sidebar-footer-primary",
    icon: "mdi-lightning-bolt-outline",
    label: { fallback: "快速配置" },
    order: 10,
    ...overrides
  };
}

test("Web contributions require an active matching owner whose manifest supports Web", () => {
  assert.equal(availableWebContributions(catalog([quickSetup()])).length, 1);
  assert.equal(availableWebContributions(catalog([quickSetup()], [{ ...activePlugin, status: "failed" }])).length, 0);
  assert.equal(availableWebContributions(catalog([quickSetup({ pluginId: "example.other" })])).length, 0);
  assert.equal(availableWebContributions(catalog([quickSetup()], [{ ...activePlugin, manifest: { ...activePlugin.manifest, hosts: ["manager"] } }])).length, 0);
  assert.equal(availableWebContributions(catalog([quickSetup()], [
    activePlugin,
    { ...activePlugin, pluginId: "package:other", manifest: { ...activePlugin.manifest, id: "package:other" } }
  ])).length, 0);
});

test("required capabilities use the Web host registry", () => {
  assert.equal(availableWebContributions(catalog([
    quickSetup({ requiredCapabilities: ["web.command"] })
  ])).length, 1);
  assert.equal(availableWebContributions(catalog([
    quickSetup({ requiredCapabilities: ["plugin.unrelated-capability"] })
  ])).length, 0);
  assert.equal(availableWebContributions(catalog([
    quickSetup({ requiredCapabilities: ["web.command", "web.command"] })
  ])).length, 0);
});

test("command entry disappears when its owner is revoked", () => {
  const active = resolveWebCommandCatalog(availableWebContributions(catalog([quickSetup()])));
  const revoked = resolveWebCommandCatalog(availableWebContributions(catalog(
    [quickSetup()],
    [{ ...activePlugin, status: "inactive" }]
  )));
  assert.deepEqual(active.map(command => command.handlerId), ["web.quick-setup"]);
  assert.deepEqual(revoked, []);
});

test("App keeps only refresh, connection state, and recovery as fixed host controls", () => {
  const source = fs.readFileSync(new URL("../src/App.vue", import.meta.url), "utf8");
  const overview = fs.readFileSync(new URL("../src/pages/OverviewPage.vue", import.meta.url), "utf8");
  assert.match(source, /webCommandsInSlot/);
  assert.match(source, /webCommandForHandler/);
  assert.doesNotMatch(source, /@click="store\.openQuickSetup"/);
  assert.doesNotMatch(source, /@click="store\.addGatewayAndOpenQuickSetup"/);
  assert.doesNotMatch(overview, /addGatewayAndOpenQuickSetup/);
  assert.doesNotMatch(source, /@click="store\.openConfigFile\('manager'\)"/);
  assert.match(source, /aria-label="刷新状态"/);
  assert.match(source, /Manager \{\{ managerConnected/);
  assert.match(source, /PLUGIN_RECOVERY_ROUTE_NAME/);
  assert.match(source, /webPageDataRequirements/);
  assert.doesNotMatch(source, /pageNeedsGatewayDiagnostics|\^\/routes/);
});
