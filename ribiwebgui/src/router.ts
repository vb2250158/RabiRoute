import { createRouter, createWebHashHistory } from "vue-router";
import OverviewPage from "./pages/OverviewPage.vue";
import RouteConfigPage from "./pages/RouteConfigPage.vue";
import PersonaTemplatePage from "./pages/PersonaTemplatePage.vue";
import RuntimeLogPage from "./pages/RuntimeLogPage.vue";

export const router = createRouter({
  history: createWebHashHistory(),
  routes: [
    { path: "/", redirect: "/overview" },
    { path: "/overview", component: OverviewPage, meta: { title: "总览" } },
    { path: "/routes", component: RouteConfigPage, meta: { title: "路由配置" } },
    { path: "/persona", component: PersonaTemplatePage, meta: { title: "人格与模板" } },
    { path: "/runtime", component: RuntimeLogPage, meta: { title: "运行日志" } }
  ]
});
