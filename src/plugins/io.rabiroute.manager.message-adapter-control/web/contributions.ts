import { type WebContributionApi, registerContributionPages } from "../../../../ribiwebgui/src/pluginWebContributionApi";

export function activateMessageAdapterControl(api: WebContributionApi): readonly (() => void)[] {
  return registerContributionPages(api, [{
    routeId: "route.adapters", rendererId: "builtin.web-page.adapters.v1",
    loader: () => import("./pages/RouteConfigPage.vue"),
    // Compatibility entry for existing Route links and routes without a persona.
    paths: [{ path: "/routes/:id/adapters", title: "消息" }, { path: "/routes/:id?", title: "消息" }],
    requirements: ["gateway.diagnostics"],
  }]);
}
