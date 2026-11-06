import { type WebContributionApi, registerContributionPages } from "../../../../ribiwebgui/src/pluginWebContributionApi";
import { routeScopedOverviewPath } from "../../../../ribiwebgui/src/routeScopedNavigation";

export function activateCore(api: WebContributionApi): readonly (() => void)[] {
  return [
    ...registerContributionPages(api, [
      {
        routeId: "route.overview", rendererId: "builtin.web-page.overview.v1",
        loader: () => import("./pages/OverviewPage.vue"),
        paths: [{ path: "/overview", title: "控制台" }, { path: "/routes/:id/overview", title: "控制台" }],
        requirements: ["gateway.diagnostics"],
        navigation: { resolvePath: routeScopedOverviewPath, allowedSlots: ["utility"], allowedIcons: ["mdi-view-dashboard-outline"] }
      },
      {
        routeId: "global.lan-agents", rendererId: "builtin.web-page.lan-agents.v1",
        loader: () => import("./pages/RabiLinkPage.vue"),
        paths: [{ path: "/rabilink", title: "RabiLink" }],
        navigation: { resolvePath: () => "/rabilink", allowedSlots: ["utility"], allowedIcons: ["mdi-lan-connect"] }
      },
      {
        routeId: "global.settings", rendererId: "builtin.web-page.settings.v1",
        loader: () => import("./pages/SettingsPage.vue"),
        paths: [{ path: "/settings", title: "设置" }, { path: "/settings/archived-roles", title: "已归档角色" }],
        navigation: { resolvePath: () => "/settings", allowedSlots: ["utility"], allowedIcons: ["mdi-cog-outline"] }
      },
      {
        routeId: "global.docs", rendererId: "builtin.web-page.docs.v1",
        loader: () => import("./pages/ProjectDocsPage.vue"),
        paths: [{ path: "/docs", title: "使用手册" }],
        navigation: { resolvePath: () => "/docs", allowedSlots: ["footer"], allowedIcons: ["mdi-book-open-page-variant-outline"] }
      }
    ]),
    api.registerTheme({ themeId: "system", webResourceId: "builtin.web-theme.system.v1", label: "跟随系统", icon: "mdi-theme-light-dark", desktopTheme: "system", apply: systemDark => systemDark ? "dark" : "light" }),
    api.registerTheme({ themeId: "light", webResourceId: "builtin.web-theme.light.v1", label: "浅色", icon: "mdi-weather-sunny", desktopTheme: "light", apply: () => "light" }),
    api.registerTheme({ themeId: "dark", webResourceId: "builtin.web-theme.dark.v1", label: "深色", icon: "mdi-weather-night", desktopTheme: "dark", apply: () => "dark" })
  ];
}
