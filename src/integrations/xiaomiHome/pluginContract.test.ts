import assert from "node:assert/strict";
import test from "node:test";
import { createPluginTestHarness } from "@rabiroute/plugin-sdk";
import {
  ManagerPluginRouteRegistry,
  type ManagerPluginRouteHandler
} from "../../manager/managerPluginRouteRegistry.js";

// The built-in plugin package is plain ESM by design; this test exercises its
// real activation contract instead of copying its route declarations.
// @ts-expect-error The package entry intentionally has no source-tree .d.ts file.
import { activate } from "../../../plugins/builtin/io.rabiroute.manager.xiaomi-home/1.0.0/manager.mjs";

test("Xiaomi Home plugin registers exact and prefix routes with the Manager contract", async () => {
  const registry = new ManagerPluginRouteRegistry();
  const handler: ManagerPluginRouteHandler = () => false;
  let routeContext: Record<string, any> | undefined;
  class Tracker {
    wrap(value: ManagerPluginRouteHandler): ManagerPluginRouteHandler { return value; }
    trackOperation<T>(operation: Promise<T>): Promise<T> { return operation; }
    async stop(): Promise<void> {}
  }
  class RuntimeController {
    constructor(..._args: unknown[]) {}
    start(): void {}
    stop(): void {}
    settings(): Record<string, unknown> { return { source: "profile" }; }
  }
  const runtime = {
    ManagerPluginRequestTracker: Tracker,
    XiaomiHomeArtifactStore: class { runtimeDir = "unused-in-contract-test"; },
    XiaomiHomeSettingsStore: class {},
    XiaomiHomeRuntimeController: RuntimeController,
    lifecycleFence: { applicationGenerationId: "generation-current", managerInstanceId: "manager-current" },
    createXiaomiHomeManagerRouteHandler: (context: Record<string, any>) => {
      routeContext = context;
      return handler;
    },
    deliverXiaomiHomeEvent: async () => undefined,
    webguiLanRequestAllowed: () => true,
    readJsonBody: async () => ({}),
    jsonResponse: () => undefined,
    managerPluginRoutes: registry,
    registerManagerPluginHandlerRoutes(
      target: ManagerPluginRouteRegistry,
      instanceId: string,
      routeIdPrefix: string,
      handlers: readonly ManagerPluginRouteHandler[],
      routes: ReadonlyArray<{
        routeId: string;
        kind: "exact" | "prefix";
        path?: string;
        pathPrefix?: string;
        methods?: readonly string[];
        handlerIndex?: number;
      }>
    ) {
      return target.register(instanceId, routes.map(route => ({
        routeId: `${routeIdPrefix}.${route.routeId}`,
        match: route.kind === "exact"
          ? { kind: "exact" as const, path: route.path!, methods: route.methods }
          : { kind: "prefix" as const, pathPrefix: route.pathPrefix!, methods: route.methods },
        handler: handlers[route.handlerIndex ?? 0]!
      })));
    }
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

  await harness.activate({ activate });
  const snapshot = registry.snapshot();

  assert.equal(snapshot.length, 1);
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
  }]);
  assert.equal(snapshot[0]?.routeCount, 8);
  assert.deepEqual(
    snapshot[0]?.routes
      .filter(route => route.match.kind === "prefix")
      .map(route => route.match.pathPrefix),
    ["/api/agent/xiaomi-home/resources/", "/api/agent/xiaomi-home/artifacts/"]
  );

  await harness.dispose();
});
