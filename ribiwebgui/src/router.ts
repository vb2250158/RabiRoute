import type { AsyncComponentLoader } from "vue";
import { createRouter, createWebHashHistory } from "vue-router";
import RouteLoadingPage from "./components/RouteLoadingPage.vue";
import { createImmediateRouteComponent } from "./immediateRouteComponent";
import { createLazyRouteRecovery } from "./lazyRouteRecovery";

export const lazyRouteRecovery = createLazyRouteRecovery();

function immediatePage(loader: AsyncComponentLoader) {
  return createImmediateRouteComponent(loader, RouteLoadingPage, {
    onLoadError: error => lazyRouteRecovery.recover(error, router.currentRoute.value.fullPath),
    onLoadSuccess: () => lazyRouteRecovery.markReady()
  });
}

const OverviewPage = immediatePage(() => import("./pages/OverviewPage.vue"));
const RouteConfigPage = immediatePage(() => import("./pages/RouteConfigPage.vue"));
const PersonaTemplatePage = immediatePage(() => import("./pages/PersonaTemplatePage.vue"));
const PersonaDocumentPage = immediatePage(() => import("./pages/PersonaDocumentPage.vue"));
const PersonaSyncPage = immediatePage(() => import("./pages/PersonaSyncPage.vue"));
const ProjectDocsPage = immediatePage(() => import("./pages/ProjectDocsPage.vue"));
const RoleKnowledgePage = immediatePage(() => import("./pages/RoleKnowledgePage.vue"));
const RuntimeLogPage = immediatePage(() => import("./pages/RuntimeLogPage.vue"));
const PerformancePage = immediatePage(() => import("./pages/PerformancePage.vue"));
const SpeechServicePage = immediatePage(() => import("./pages/SpeechServicePage.vue"));

export const router = createRouter({
  history: createWebHashHistory(),
  routes: [
    { path: "/", redirect: "/overview" },
    { path: "/overview", component: OverviewPage, meta: { title: "控制台" } },
    { path: "/speech", component: SpeechServicePage, meta: { title: "语音服务" } },
    { path: "/models", redirect: "/speech" },
    { path: "/routes/:id/overview", component: OverviewPage, meta: { title: "控制台" } },
    { path: "/routes/:id/adapters", component: RouteConfigPage, meta: { title: "消息适配器" } },
    { path: "/routes/:id/persona/document", component: PersonaDocumentPage, meta: { title: "人格正文" } },
    { path: "/routes/:id/persona/sync", component: PersonaSyncPage, meta: { title: "多电脑人格同步" } },
    { path: "/routes/:id/persona", component: PersonaTemplatePage, meta: { title: "人格配置" } },
    { path: "/routes/:id/knowledge", component: RoleKnowledgePage, meta: { title: "计划与记忆" } },
    { path: "/routes/:id/speech", component: SpeechServicePage, meta: { title: "语音服务" } },
    { path: "/routes/:id/runtime", component: RuntimeLogPage, meta: { title: "日志诊断" } },
    { path: "/routes/:id?", component: RouteConfigPage, meta: { title: "消息适配器" } },
    { path: "/persona/:id?", component: PersonaTemplatePage, meta: { title: "人格配置" } },
    { path: "/knowledge", component: RoleKnowledgePage, meta: { title: "计划与记忆" } },
    { path: "/docs", component: ProjectDocsPage, meta: { title: "使用手册" } },
    { path: "/performance", component: PerformancePage, meta: { title: "性能监控" } },
    { path: "/runtime", component: RuntimeLogPage, meta: { title: "日志诊断" } }
  ]
});
