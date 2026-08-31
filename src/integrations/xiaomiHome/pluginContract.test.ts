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
  class ClipCapture {
    isEnabled(): boolean { return false; }
    status(): Record<string, unknown> { return { enabled: false, ready: false }; }
    async capture(): Promise<never> { throw new Error("capture is disabled in this contract test"); }
  }
  class EventMonitor {
    start(): void {}
    stop(): void {}
    status(): Record<string, unknown> { return { connectionState: "stopped" }; }
  }
  const runtime = {
    ManagerPluginRequestTracker: Tracker,
    XiaomiHomeManagerApiClient: class {},
    XiaomiHomeArtifactStore: class {},
    XiaomiHomeArtifactAccess: class {},
    XiaomiHomeClipCaptureWorker: ClipCapture,
    XiaomiHomeEventMonitor: EventMonitor,
    createXiaomiHomeManagerRouteHandler: (context: Record<string, any>) => {
      routeContext = context;
      return handler;
    },
    deliverXiaomiHomeEvent: async () => undefined,
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
  assert.deepEqual(routeContext?.runtimeHealth(), {
    eventMonitor: { connectionState: "stopped" },
    cameraCapture: { enabled: false, ready: false }
  });
  assert.equal(snapshot[0]?.routeCount, 7);
  assert.deepEqual(
    snapshot[0]?.routes
      .filter(route => route.match.kind === "prefix")
      .map(route => route.match.pathPrefix),
    ["/api/agent/xiaomi-home/resources/", "/api/agent/xiaomi-home/artifacts/"]
  );

  await harness.dispose();
});
