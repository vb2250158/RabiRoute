import { type WebContributionApi, registerContributionPages } from "../../../../ribiwebgui/src/pluginWebContributionApi";

export function activatePerformance(api: WebContributionApi): readonly (() => void)[] {
  return [
    ...registerContributionPages(api, [{
      routeId: "global.performance", rendererId: "builtin.web-page.performance.v1",
      loader: () => import("./pages/PerformancePage.vue"), paths: [{ path: "/performance", title: "性能监控" }]
    }]),
    api.registerStatusRenderer({ rendererId: "builtin.performance-diagnostics.v1", placementId: "diagnostics.performance", allowedSlots: ["diagnostics.performance"], queryId: "manager.performance-status", loader: () => import("./pages/PerformancePage.vue") }),
    api.registerStatusRenderer({ rendererId: "builtin.performance-status.v1", placementId: "runtime-status", allowedSlots: ["runtime-status"], queryId: "manager.performance-status", loader: () => import("./components/renderers/PerformanceStatusRenderer.vue") })
  ];
}
