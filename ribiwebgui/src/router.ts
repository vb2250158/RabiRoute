import { createRouter, createWebHashHistory } from "vue-router";
import OverviewPage from "./pages/OverviewPage.vue";
import RouteConfigPage from "./pages/RouteConfigPage.vue";
import PersonaTemplatePage from "./pages/PersonaTemplatePage.vue";
import RuntimeLogPage from "./pages/RuntimeLogPage.vue";

export const router = createRouter({
  history: createWebHashHistory(),
  routes: [
    { path: "/", redirect: "/overview" },
    { path: "/overview", component: OverviewPage, meta: { title: "控制台" } },
    { path: "/routes/:id?", component: RouteConfigPage, meta: { title: "消息适配器" } },
    { path: "/persona/:id?", component: PersonaTemplatePage, meta: { title: "Rabi 人格" } },
    { path: "/runtime", component: RuntimeLogPage, meta: { title: "日志诊断" } }
  ]
});
