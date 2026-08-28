const MESSAGE = "Manager Echo plugin is active";

export function activate(moduleApi) {
  const disposers = moduleApi.instanceIds.flatMap(instanceId => {
    const api = moduleApi.forInstance(instanceId);
    return [api.registerPage({
      routeId: "example.manager.echo.page",
      rendererId: "example.manager.echo.page.v1",
      loader: async () => api.asComponent({
        name: "ManagerEchoPluginPage",
        setup() {
          return () => api.h("main", { class: "pa-6" }, [
            api.h("h1", "Plugin Echo"),
            api.h("p", `${MESSAGE} (${api.version})`)
          ]);
        }
      }),
      paths: [{ path: "/plugin-example-echo", title: "Plugin Echo" }],
      navigation: {
        resolvePath: () => "/plugin-example-echo",
        allowedSlots: ["utility"],
        allowedIcons: ["mdi-puzzle-outline"]
      }
    })];
  });
  return () => { for (const dispose of [...disposers].reverse()) dispose(); };
}
