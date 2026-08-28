import { definePlugin } from "@rabiroute/plugin-sdk";

export const activate = definePlugin({
  activate(context) {
    context.permissions.require("manager.http");
    const http = context.services.require("host.manager.http@1");
    context.services.provide("example.manager.echo@1", Object.freeze({ instanceId: context.identity.instanceId }));
    for (const contribution of [
      {
        kind: "page",
        id: "echo-page",
        value: {
          surface: "web.pages",
          label: { fallback: "Plugin Echo" },
          routeId: "example.manager.echo.page",
          rendererId: "example.manager.echo.page.v1",
          slot: "utility",
          hosts: ["web"],
          order: 900
        }
      },
      {
        kind: "navigation",
        id: "echo",
        value: {
          surface: "web.navigation",
          label: { fallback: "Plugin Echo" },
          routeId: "example.manager.echo.page",
          icon: "mdi-puzzle-outline",
          slot: "utility",
          hosts: ["web"],
          order: 900
        }
      }
    ]) context.contributions.register(contribution);

    context.effects.add(() => {
      const tracker = new http.ManagerPluginRequestTracker();
      const unregister = http.registerRoutes(context.identity.instanceId, "example.manager.echo.http", [
        tracker.wrap((_request, _url, response) => {
          http.jsonResponse(response, 200, {
            code: 0,
            data: {
              instanceId: context.identity.instanceId,
              pluginId: context.identity.pluginId,
              version: context.identity.version,
              revision: context.identity.revision,
              config: context.config
            }
          });
          return true;
        })
      ], [{ routeId: "echo", kind: "exact", path: "/api/plugins/example-echo", methods: ["GET"] }]);
      http.publishManagerEvent("example_echo_ready", { revision: context.identity.revision });
      return async () => {
        unregister();
        await tracker.stop();
      };
    }, "Manager Echo HTTP route");
  }
}).activate;
