import { definePlugin } from "@rabiroute/plugin-sdk";

export const activate = definePlugin({
  activate(context) {
    const runtime = context.services.require("host.manager.yeyu-gamer@1");
    context.services.provide("manager.yeyu-gamer@1", Object.freeze({
      instanceId: context.identity.instanceId
    }));

    context.effects.add(() => {
      const tracker = new runtime.ManagerPluginRequestTracker();
      const handler = runtime.createYeYuGamerManagerRouteHandler({
        getConfig: () => context.config,
        readJsonBody: runtime.readJsonBody,
        jsonResponse: runtime.jsonResponse,
        trackOperation: operation => tracker.trackOperation(operation)
      });
      const unregister = runtime.registerManagerPluginHandlerRoutes(
        runtime.managerPluginRoutes,
        context.identity.instanceId,
        "manager.yeyu-gamer.api",
        [tracker.wrap(handler)],
        [
          { routeId: "health", kind: "exact", path: "/api/agent/yeyu-gamer/health", methods: ["GET"] },
          { routeId: "meta", kind: "exact", path: "/api/agent/yeyu-gamer/meta", methods: ["GET"] },
          { routeId: "snapshot", kind: "exact", path: "/api/agent/yeyu-gamer/snapshot", methods: ["GET"] },
          { routeId: "capabilities", kind: "exact", path: "/api/agent/yeyu-gamer/capabilities", methods: ["GET"] },
          { routeId: "work-items", kind: "exact", path: "/api/agent/yeyu-gamer/work-items", methods: ["POST"] }
        ]
      );
      return async () => {
        unregister();
        await tracker.stop();
      };
    }, "YeYu Gamer Manager routes");
  }
}).activate;
