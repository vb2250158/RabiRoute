import { definePlugin } from "@rabiroute/plugin-sdk";

export const activate = definePlugin({
  activate(context) {
    const runtime = context.services.require("host.manager.xiaomi-home@1");
    context.services.provide("manager.xiaomi-home@1", Object.freeze({ instanceId: context.identity.instanceId }));
    context.contributions.register({
      kind: "settings-section",
      id: "xiaomi-home-settings",
      value: {
        surface: "shared.settings",
        label: { fallback: "米家 / Xiaomi Home" },
        rendererId: "builtin.xiaomi-home-settings.v1",
        schemaId: "xiaomi-home.settings.v1",
        readCommandId: "manager.xiaomi-home-settings.read",
        writeCommandId: "manager.xiaomi-home-settings.write",
        icon: "mdi-home-automation",
        slot: "xiaomi-home",
        hosts: ["web"],
        order: 50
      }
    });
    context.effects.add(() => {
      let activationStage = "request tracker";
      try {
        const tracker = new runtime.ManagerPluginRequestTracker();
        activationStage = "Home Assistant client";
        const artifacts = new runtime.XiaomiHomeArtifactStore(context.config.runtimeDir);
        activationStage = "settings store";
        const settingsStore = new runtime.XiaomiHomeSettingsStore(artifacts.runtimeDir, context.config);
        activationStage = "runtime controller";
        const xiaomiHomeRuntime = new runtime.XiaomiHomeRuntimeController(settingsStore, artifacts, {
          deliverEvent: runtime.deliverXiaomiHomeEvent
        });
        activationStage = "route handler";
        const handler = runtime.createXiaomiHomeManagerRouteHandler({
          runtime: xiaomiHomeRuntime,
          lifecycleFence: runtime.lifecycleFence,
          readJsonBody: runtime.readJsonBody,
          jsonResponse: runtime.jsonResponse,
          deliverEvent: runtime.deliverXiaomiHomeEvent,
          trackOperation: operation => tracker.trackOperation(operation)
        });
        activationStage = "route registration";
        const unregister = runtime.registerManagerPluginHandlerRoutes(
          runtime.managerPluginRoutes,
          context.identity.instanceId,
          "manager.xiaomi-home.api",
          [tracker.wrap(handler)],
          [
            { routeId: "health", kind: "exact", path: "/api/agent/xiaomi-home/health", methods: ["GET"] },
            { routeId: "settings", kind: "exact", path: "/api/agent/xiaomi-home/settings", methods: ["GET", "PUT"] },
            { routeId: "resources", kind: "exact", path: "/api/agent/xiaomi-home/resources", methods: ["GET"] },
            { routeId: "resource", kind: "prefix", pathPrefix: "/api/agent/xiaomi-home/resources/", methods: ["GET"] },
            { routeId: "action-requests", kind: "exact", path: "/api/agent/xiaomi-home/action-requests", methods: ["POST"] },
            { routeId: "events", kind: "exact", path: "/api/agent/xiaomi-home/events", methods: ["POST"] },
            { routeId: "artifacts", kind: "exact", path: "/api/agent/xiaomi-home/artifacts", methods: ["GET", "POST"] },
            { routeId: "artifact", kind: "prefix", pathPrefix: "/api/agent/xiaomi-home/artifacts/", methods: ["GET"] }
          ]
        );
        activationStage = "runtime start";
        xiaomiHomeRuntime.start();
        return async () => {
          xiaomiHomeRuntime.stop();
          unregister();
          await tracker.stop();
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`Xiaomi Home activation failed during ${activationStage}: ${message}`, { cause: error });
      }
    }, "Xiaomi Home Manager routes");
  }
}).activate;
