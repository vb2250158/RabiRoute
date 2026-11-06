import { type WebContributionApi, registerContributionPages } from "../../../../ribiwebgui/src/pluginWebContributionApi";
import { roleConfigPath, roleKnowledgePath, roleMessageHistoryPath } from "../../../../ribiwebgui/src/roleScopedNavigation";

export function activatePersona(api: WebContributionApi): readonly (() => void)[] {
  return registerContributionPages(api, [
    {
      routeId: "route.persona", rendererId: "builtin.web-page.persona.v1",
      loader: () => import("./pages/PersonaTemplatePage.vue"),
      paths: [{ path: "/roles", title: "角色配置" }, { path: "/roles/:roleId/config", title: "角色配置" }, { path: "/routes/:id/persona", title: "角色配置" }, { path: "/persona/:id?", title: "角色配置" }],
      navigation: { scope: "role", resolvePath: roleConfigPath, allowedSlots: ["route-primary"], allowedIcons: ["mdi-account-heart-outline"] }
    },
    {
      routeId: "role.message-history", rendererId: "builtin.web-page.message-history.v1",
      loader: () => import("./pages/RoleMessageHistoryPage.vue"),
      paths: [{ path: "/roles/message-history", title: "消息记录" }, { path: "/roles/:roleId/message-history", title: "消息记录" }],
      navigation: { scope: "role", resolvePath: roleMessageHistoryPath, allowedSlots: ["route-primary"], allowedIcons: ["mdi-message-text-outline"] }
    },
    { routeId: "route.persona-document", rendererId: "builtin.web-page.persona-document.v1", loader: () => import("./pages/PersonaDocumentPage.vue"), paths: [{ path: "/roles/:roleId/document", title: "角色正文" }, { path: "/routes/:id/persona/document", title: "角色正文" }] },
    {
      routeId: "route.knowledge", rendererId: "builtin.web-page.knowledge.v1",
      loader: () => import("./pages/RoleKnowledgePage.vue"),
      // The second address renders one plan in the same page: another client (the DSH
      // plan panel) needs a stable way to open exactly the plan it is bound to, and the
      // plan owns its own presentation, so the focus address belongs to this page.
      paths: [
        { path: "/roles/knowledge", title: "计划与记忆" },
        { path: "/roles/:roleId/knowledge", title: "计划与记忆" },
        { path: "/roles/:roleId/plan/:planId", title: "计划" },
        { path: "/routes/:id/knowledge", title: "计划与记忆" },
        { path: "/knowledge", title: "计划与记忆" },
        { path: "/routes/:id/plan/:planId", title: "计划" }
      ],
      navigation: { scope: "role", resolvePath: roleKnowledgePath, allowedSlots: ["route-primary"], allowedIcons: ["mdi-notebook-check-outline"] }
    }
  ]);
}
