export function createPlugin(context) {
  return {
    instanceId: context.instanceId,
    manifest: {
      id: context.bundle.id,
      name: "Manager Echo Example",
      version: context.bundle.version,
      kind: "package",
      hosts: ["manager", "web"],
      capabilities: ["example.manager.echo"]
    },
    scope: "global",
    provides: ["example.manager.echo"],
    contributions: [
      {
        kind: "page",
        surface: "web.pages",
        id: "echo-page",
        label: { fallback: "Plugin Echo" },
        routeId: "example.manager.echo.page",
        rendererId: "example.manager.echo.page.v1",
        slot: "utility",
        hosts: ["web"],
        order: 900
      },
      {
        kind: "navigation",
        surface: "web.navigation",
        id: "echo",
        label: { fallback: "Plugin Echo" },
        routeId: "example.manager.echo.page",
        icon: "mdi-puzzle-outline",
        slot: "utility",
        hosts: ["web"],
        order: 900
      },
      {
        kind: "status-card",
        surface: "shared.status",
        id: "echo-status",
        label: { fallback: "Plugin Echo" },
        queryId: "example.manager.echo",
        rendererId: "example.manager.echo.status.v1",
        slot: "runtime-status",
        hosts: ["web"],
        order: 900
      }
    ],
    apply(ctx) {
      const unregister = context.services.registerRoutes([{
        routeId: "echo",
        match: { kind: "exact", path: "/api/plugins/example-echo", methods: ["GET"] },
        handler: (_request, _url, response) => {
          context.services.json(response, 200, {
            code: 0,
            data: {
              instanceId: context.instanceId,
              package: context.bundle.id,
              version: context.bundle.version,
              revision: context.bundle.revision,
              config: context.config
            }
          });
          return true;
        }
      }]);
      context.services.publish("echo.ready", { revision: context.bundle.revision });
      ctx.effect(() => unregister, "remove Manager Echo example routes");
    }
  };
}
