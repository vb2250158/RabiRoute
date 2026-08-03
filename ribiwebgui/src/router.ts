import { createRouter, createWebHashHistory } from "vue-router";

const OverviewPage = () => import("./pages/OverviewPage.vue");
const RouteConfigPage = () => import("./pages/RouteConfigPage.vue");
const PersonaTemplatePage = () => import("./pages/PersonaTemplatePage.vue");
const ProjectDocsPage = () => import("./pages/ProjectDocsPage.vue");
const RoleKnowledgePage = () => import("./pages/RoleKnowledgePage.vue");
const RuntimeLogPage = () => import("./pages/RuntimeLogPage.vue");
const SpeechServicePage = () => import("./pages/SpeechServicePage.vue");

export const router = createRouter({
  history: createWebHashHistory(),
  routes: [
    { path: "/", redirect: "/overview" },
    { path: "/overview", component: OverviewPage, meta: { title: "控制台" } },
    { path: "/speech", component: SpeechServicePage, meta: { title: "语音服务" } },
    { path: "/routes/:id/overview", component: OverviewPage, meta: { title: "控制台" } },
    { path: "/routes/:id/adapters", component: RouteConfigPage, meta: { title: "消息适配器" } },
    { path: "/routes/:id/persona", component: PersonaTemplatePage, meta: { title: "Rabi 人格" } },
    { path: "/routes/:id/knowledge", component: RoleKnowledgePage, meta: { title: "计划与记忆" } },
    { path: "/routes/:id/speech", component: SpeechServicePage, meta: { title: "语音服务" } },
    { path: "/routes/:id/runtime", component: RuntimeLogPage, meta: { title: "日志诊断" } },
    { path: "/routes/:id?", component: RouteConfigPage, meta: { title: "消息适配器" } },
    { path: "/persona/:id?", component: PersonaTemplatePage, meta: { title: "Rabi 人格" } },
    { path: "/knowledge", component: RoleKnowledgePage, meta: { title: "计划与记忆" } },
    { path: "/docs", component: ProjectDocsPage, meta: { title: "使用手册" } },
    { path: "/runtime", component: RuntimeLogPage, meta: { title: "日志诊断" } }
  ]
});
