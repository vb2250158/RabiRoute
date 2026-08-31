import { definePlugin } from "@rabiroute/plugin-sdk";

export const activate = definePlugin({
  activate(context) {
    const runtime = context.services.require("host.manager.xiaomi-home@1");
    context.services.provide("manager.xiaomi-home@1", Object.freeze({ instanceId: context.identity.instanceId }));
    context.effects.add(() => {
      let activationStage = "request tracker";
      try {
        const tracker = new runtime.ManagerPluginRequestTracker();
        activationStage = "Home Assistant client";
        const client = new runtime.XiaomiHomeManagerApiClient(context.config);
        activationStage = "artifact store";
        const artifacts = new runtime.XiaomiHomeArtifactStore(context.config.runtimeDir);
        activationStage = "artifact access";
        const artifactAccess = new runtime.XiaomiHomeArtifactAccess(context.config, artifacts);
        activationStage = "clip capture worker";
        const clipCapture = new runtime.XiaomiHomeClipCaptureWorker(context.config, artifacts);
        activationStage = "event monitor";
        const monitor = new runtime.XiaomiHomeEventMonitor(context.config, {
          deliverEvent: runtime.deliverXiaomiHomeEvent,
          captureMotionClip: clipCapture.isEnabled() ? candidate => clipCapture.capture(candidate) : undefined
        });
        activationStage = "route handler";
        const handler = runtime.createXiaomiHomeManagerRouteHandler({
          client,
          readJsonBody: runtime.readJsonBody,
          jsonResponse: runtime.jsonResponse,
          deliverEvent: runtime.deliverXiaomiHomeEvent,
           artifacts,
           artifactAccess,
          runtimeHealth: () => ({
            eventMonitor: monitor.status(),
            cameraCapture: clipCapture.status()
          }),
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
            { routeId: "resources", kind: "exact", path: "/api/agent/xiaomi-home/resources", methods: ["GET"] },
            { routeId: "resource", kind: "prefix", pathPrefix: "/api/agent/xiaomi-home/resources/", methods: ["GET"] },
            { routeId: "action-requests", kind: "exact", path: "/api/agent/xiaomi-home/action-requests", methods: ["POST"] },
            { routeId: "events", kind: "exact", path: "/api/agent/xiaomi-home/events", methods: ["POST"] },
            { routeId: "artifacts", kind: "exact", path: "/api/agent/xiaomi-home/artifacts", methods: ["GET", "POST"] },
            { routeId: "artifact", kind: "prefix", pathPrefix: "/api/agent/xiaomi-home/artifacts/", methods: ["GET"] }
          ]
        );
        activationStage = "event monitor start";
        monitor.start();
        return async () => {
          monitor.stop();
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
