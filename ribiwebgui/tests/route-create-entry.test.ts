import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { createPinia, setActivePinia } from "pinia";
import { activate as activateRouteControl } from "../src/bundles/builtin/route-control";
import { registerTrustedWebCommand, resolveWebCommandCatalog, webCommandsInSlot } from "../src/pluginCommands";
import { availableWebContributions } from "../src/pluginContributions";
import type { WebPluginCatalog } from "../src/pluginCatalogClient";

test("the real route-control package exposes its create command with no routes and releases it with its Web entry", async () => {
  const owner = { instanceId: "manager:route-control", pluginId: "io.rabiroute.manager.route-control" };
  const root = new URL("../../plugins/builtin/io.rabiroute.manager.route-control/1.0.0/", import.meta.url);
  const manifest = JSON.parse(fs.readFileSync(new URL("rabi.plugin.json", root), "utf8"));
  const manager = fs.readFileSync(new URL("manager.mjs", root), "utf8");
  const declared = manager.match(/for \(const contribution of (\[[\s\S]*?\])\)\s*context\.contributions\.register/);
  assert.ok(declared, "Manager must declare the route-control contributions");
  const contributions = JSON.parse(declared[1]).map((item: any) => ({ kind: item.kind, id: item.id, ...item.value, ...owner }));
  const catalog: WebPluginCatalog = {
    schemaVersion: 2, generation: "generation", host: "web", revision: { plugins: 1, contributions: 1 },
    plugins: [{ ...owner, status: "active", manifest: { id: manifest.id, hosts: Object.keys(manifest.entries), capabilities: [] } }],
    contributions
  };
  assert.deepEqual(manifest.entries.web, { execution: "in_process", module: "./web/client.mjs" });
  const dispose = activateRouteControl({ instanceIds: [owner.instanceId], forInstance: () => ({
    registerCommand: input => registerTrustedWebCommand({ ...input, ...owner })
  }) });
  try {
    const commands = resolveWebCommandCatalog(availableWebContributions(catalog));
    const create = webCommandsInSlot(commands, "topbar-primary").find(command => command.handlerId === "web.add-route");
    assert.ok(create, "Create must remain in the topbar when the route list is empty");
    assert.equal(create.label, "新增路由");
    Object.assign(globalThis, { window: { location: { pathname: "/", hash: "" } } });
    const { useGatewayStore } = await import("../src/stores/gatewayStore");
    setActivePinia(createPinia());
    const store = useGatewayStore();
    assert.equal(store.gateways.length, 0);
    await create.execute({
      addRoute: () => store.addGatewayAndOpenQuickSetup(), openQuickSetup() {}, openManagerConfig() {},
      savePage: async () => {}, pageSaveState: () => ({}), notify() {}
    });
    assert.equal(store.gateways.length, 1);
    assert.equal(store.selectedGatewayId, store.gateways[0].id);
    assert.equal(store.quickSetupDialogOpen, true);
  } finally { dispose(); }
  assert.deepEqual(resolveWebCommandCatalog(availableWebContributions(catalog)), []);
});

test("route-control is built and synchronized as an independent Web entry", () => {
  const vite = fs.readFileSync(new URL("../vite.config.ts", import.meta.url), "utf8");
  const sync = fs.readFileSync(new URL("../../scripts/sync-plugin-web-bundles.mjs", import.meta.url), "utf8");
  const app = fs.readFileSync(new URL("../src/App.vue", import.meta.url), "utf8");
  assert.match(vite, /managerRouteControlPlugin:[^\n]*builtin\/route-control\.ts/);
  assert.match(sync, /\["src\/bundles\/builtin\/route-control\.ts", "io.rabiroute.manager.route-control"\]/);
  assert.match(app, /topbarCommands = computed\(\(\) => webCommandsInSlot\(pluginCatalogStore.commands.value, "topbar-primary"\)\)/);
  assert.match(app, /v-for="command in topbarCommands"/);
});
