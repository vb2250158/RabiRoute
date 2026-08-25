const MESSAGE = "Manager Echo Bundle is active";

export function activate(api) {
  const disposePage = api.registerPage({
    routeId: "example.manager.echo.page",
    rendererId: "example.manager.echo.page.v1",
    loader: async () => api.asComponent({
      name: "ManagerEchoBundlePage",
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
  });
  const disposeStatus = api.registerStatusRenderer({
    rendererId: "example.manager.echo.status.v1",
    placementId: "runtime-status",
    allowedSlots: ["runtime-status"],
    queryId: "example.manager.echo",
    loader: async () => api.asComponent({
      name: "ManagerEchoBundleStatus",
      setup() {
        return () => api.h("div", { class: "text-caption" }, `${MESSAGE} (${api.version})`);
      }
    })
  });
  return () => {
    disposeStatus();
    disposePage();
  };
}
