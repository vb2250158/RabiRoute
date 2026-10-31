import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import { createPluginTestHarness } from "@rabiroute/plugin-sdk";
import { ManagerPluginRouteRegistry } from "../../manager/managerPluginRouteRegistry.js";
import { createXiaomiHomeManagerOperations } from "./managerOperations.js";
import type { XiaomiHomeManagerRoutesContext } from "./managerRoutes.js";

// The built-in plugin package is plain ESM by design; this test exercises its
// real activation contract instead of copying its route declarations.
// @ts-expect-error The package entry intentionally has no source-tree .d.ts file.
import { activate } from "../../../plugins/builtin/io.rabiroute.manager.xiaomi-home/1.0.0/manager.mjs";

test("shipped Xiaomi profile does not bind a private persona by default", () => {
  const profile = JSON.parse(fs.readFileSync(new URL("../../../plugins/profiles/desktop.json", import.meta.url), "utf8"));
  const plugin = profile.instances.find((item: { package: string }) => item.package === "io.rabiroute.manager.xiaomi-home");
  assert.equal(plugin.config.agentRoleId, undefined);
});

test("Xiaomi Home plugin registers all 53 executable contracts and retires both registrations", async t => {
  const registry = new ManagerPluginRouteRegistry();
  let routeContext: Record<string, any> | undefined;
  class RuntimeController {
    constructor(..._args: unknown[]) {}
    start(): void {}
    async activate(): Promise<void> {}
    assertAvailable(): void {}
    async stop(): Promise<void> {}
    settings(): Record<string, unknown> { return { source: "profile" }; }
  }
  const runtime = {
    XiaomiHomeArtifactStore: class { runtimeDir = "unused-in-contract-test"; },
    XiaomiHomeSettingsStore: class {},
    XiaomiHomeRuntimeController: RuntimeController,
    lifecycleFence: { applicationGenerationId: "generation-current", managerInstanceId: "manager-current" },
    createXiaomiHomeManagerOperations: (context: Record<string, any>) => {
      routeContext = context;
      return createXiaomiHomeManagerOperations(context as XiaomiHomeManagerRoutesContext);
    },
    deliverXiaomiHomeEvent: async () => undefined,
    webguiLanRequestAllowed: () => true,
    managerPluginRoutes: registry
  };
  const harness = createPluginTestHarness({
    config: { runtimeDir: "unused-in-contract-test" },
    identity: {
      instanceId: "manager:xiaomi-home",
      pluginId: "io.rabiroute.manager.xiaomi-home",
      version: "1.0.0",
      revision: "test",
      host: "manager"
    },
    services: [["host.manager.xiaomi-home@1", runtime]]
  });
  t.after(() => harness.dispose());

  await harness.activate({ activate });
  const snapshot = registry.snapshot();

  assert.equal(registry.catalogSnapshot().operations.length, 53);
  assert.ok(routeContext?.runtime instanceof RuntimeController);
  assert.deepEqual(routeContext?.lifecycleFence, runtime.lifecycleFence);
  assert.equal(routeContext?.controlPlaneAccessAllowed, runtime.webguiLanRequestAllowed);
  assert.deepEqual(harness.contributions.list().map(contribution => ({
    kind: contribution.kind,
    id: contribution.id,
    surface: (contribution.value as Record<string, unknown>).surface,
    slot: (contribution.value as Record<string, unknown>).slot,
    rendererId: (contribution.value as Record<string, unknown>).rendererId
  })), [{
    kind: "message-endpoint-settings",
    id: "xiaomi-home-message-endpoint",
    surface: "route.adapters",
    slot: "xiaomiHome",
    rendererId: "builtin.xiaomi-home-message-endpoint.v1"
  }, {
    kind: "message-endpoint-settings",
    id: "xiaomi-home-message-endpoint-auth",
    surface: "route.adapters",
    slot: "xiaomiHome",
    rendererId: "builtin.xiaomi-home-auth.v1"
  }, {
    kind: "message-endpoint-settings", id: "xiaomi-home-devices", surface: "route.adapters",
    slot: "xiaomiHome", rendererId: "builtin.xiaomi-home-devices.v1"
  }]);
  assert.equal(snapshot.reduce((count, item) => count + item.routeCount, 0), 53);
  assert.ok(snapshot.flatMap(item => item.routes).every(route => route.match.kind !== "prefix"));
  const entries = registry.catalogSnapshot().operations;
  for (const suffix of ["entity-actions", "deployment/install", "deployment/events"]) assert.ok(entries.some(entry => entry.contract.pathTemplate === "/api/agent/xiaomi-home/" + suffix));

  await harness.dispose();
  assert.equal(registry.catalogSnapshot().operations.length, 0);
});
