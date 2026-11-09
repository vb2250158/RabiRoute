import { type WebContributionApi, registerContributionPages } from "../../../../ribiwebgui/src/pluginWebContributionApi";
import { routeScopedRuntimePath } from "../../../../ribiwebgui/src/routeScopedNavigation";

export function activateDiagnostics(api: WebContributionApi): readonly (() => void)[] {
  return registerContributionPages(api, [{
    routeId: "route.runtime", rendererId: "builtin.web-page.runtime.v1",
    loader: () => import("./pages/RuntimeLogPage.vue"),
    paths: [{ path: "/routes/:id/runtime", title: "日志诊断" }, { path: "/runtime", title: "日志诊断" }],
    requirements: ["gateway.diagnostics"],
    navigation: { resolvePath: routeScopedRuntimePath, allowedSlots: ["utility"], allowedIcons: ["mdi-console-line"] }
  }, {
    routeId: "global.deliveries", rendererId: "builtin.web-page.deliveries.v1",
    loader: () => import("./pages/DeliveryRecordsPage.vue"),
    // Retain direct links and diagnostics without a duplicate sidebar entry.
    paths: [{ path: "/deliveries", title: "投递记录" }]
  }]);
}
