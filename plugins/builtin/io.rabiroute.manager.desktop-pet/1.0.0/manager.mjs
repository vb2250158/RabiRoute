import { definePlugin } from "@rabiroute/plugin-sdk";

export const activate = definePlugin({
  activate(context) {
    const runtime = context.services.require("host.manager.desktop-pet@1");
    context.services.provide("manager.desktop-pet@1", Object.freeze({
      instanceId: context.identity.instanceId
    }));

    context.effects.add(() => {
      const tracker = new runtime.ManagerPluginRequestTracker();
      const unregister = runtime.registerManagerPluginHandlerRoutes(
        runtime.managerPluginRoutes,
        context.identity.instanceId,
        "manager.desktop-pet.api",
        [tracker.wrap((request, requestUrl, response) => runtime.handleDesktopPetApi(
          request,
          requestUrl,
          response,
          runtime.resolveRoleDir,
          runtime.desktopSettings,
          undefined,
          runtime.publishManagerEvent
        ))],
        [{
          routeId: "desktop-pet",
          kind: "prefix",
          pathPrefix: "/api/desktop-pet/",
          methods: ["GET", "PATCH", "PUT", "POST"]
        }]
      );
      return async () => {
        unregister();
        await tracker.stop();
      };
    }, "Desktop pet Manager routes");
  }
}).activate;
