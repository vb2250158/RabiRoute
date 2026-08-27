import { routeScopedKnowledgePath } from "./routeScopedNavigation";
import { registerTrustedWebPage } from "./pluginPages";

/**
 * Routes that must render before the optional Web Bundle catalog has finished
 * downloading and activating. The catalog later verifies the same renderer
 * identity before exposing its navigation contribution.
 */
registerTrustedWebPage({
  instanceId: "manager:persona",
  pluginId: "rabi.manager.base",
  routeId: "route.knowledge",
  rendererId: "builtin.web-page.knowledge.v1",
  loader: () => import("./pages/RoleKnowledgePage.vue"),
  paths: [
    { path: "/routes/:id/knowledge", title: "计划与记忆" },
    { path: "/knowledge", title: "计划与记忆" }
  ],
  navigation: {
    resolvePath: routeScopedKnowledgePath,
    allowedSlots: ["route-primary"],
    allowedIcons: ["mdi-notebook-check-outline"]
  }
});

export function isBuiltinStartupWebPageRoute(routeId: string): boolean {
  return routeId === "route.knowledge";
}
