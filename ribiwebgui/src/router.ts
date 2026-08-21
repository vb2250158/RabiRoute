import type { AsyncComponentLoader, Component } from "vue";
import { createRouter, createWebHashHistory, type RouteRecordRaw } from "vue-router";
import RouteLoadingPage from "./components/RouteLoadingPage.vue";
import PluginCatalogRecoveryPage from "./pages/PluginCatalogRecoveryPage.vue";
import { createImmediateRouteComponent } from "./immediateRouteComponent";
import { createLazyRouteRecovery } from "./lazyRouteRecovery";
import { pluginCatalogStore } from "./pluginCatalogStore";
import {
  isWebPageRouteActive,
  webPageRenderer,
  type ControlledWebPageRouteId
} from "./pluginPages";

export const lazyRouteRecovery = createLazyRouteRecovery();
export const PLUGIN_RECOVERY_ROUTE_NAME = "plugin-recovery";

function immediatePage(loader: AsyncComponentLoader) {
  return createImmediateRouteComponent(loader, RouteLoadingPage, {
    onLoadError: error => lazyRouteRecovery.recover(error, router.currentRoute.value.fullPath),
    onLoadSuccess: () => lazyRouteRecovery.markReady()
  });
}

function registeredPage(routeId: ControlledWebPageRouteId) {
  return immediatePage(webPageRenderer(routeId).loader);
}

const OverviewPage = registeredPage("route.overview");
const RouteConfigPage = registeredPage("route.adapters");
const PersonaTemplatePage = registeredPage("route.persona");
const PersonaDocumentPage = registeredPage("route.persona-document");
const PersonaSyncPage = registeredPage("route.persona-sync");
const ProjectDocsPage = registeredPage("global.docs");
const RoleKnowledgePage = registeredPage("route.knowledge");
const RuntimeLogPage = registeredPage("route.runtime");
const PerformancePage = registeredPage("global.performance");
const SpeechServicePage = registeredPage("route.speech");
const SettingsPage = registeredPage("global.settings");

function pageRoute(
  path: string,
  routeId: ControlledWebPageRouteId,
  component: Component,
  title: string
): RouteRecordRaw {
  return { path, component, meta: { title, pluginRouteId: routeId } };
}

export const router = createRouter({
  history: createWebHashHistory(),
  routes: [
    { path: "/", redirect: "/overview" },
    {
      path: "/plugin-recovery",
      name: PLUGIN_RECOVERY_ROUTE_NAME,
      component: PluginCatalogRecoveryPage,
      meta: { title: "插件恢复" }
    },
    pageRoute("/overview", "route.overview", OverviewPage, "控制台"),
    pageRoute("/speech", "route.speech", SpeechServicePage, "语音服务"),
    { path: "/models", redirect: "/speech" },
    pageRoute("/routes/:id/overview", "route.overview", OverviewPage, "控制台"),
    pageRoute("/routes/:id/adapters", "route.adapters", RouteConfigPage, "消息适配器"),
    pageRoute("/routes/:id/persona/document", "route.persona-document", PersonaDocumentPage, "人格正文"),
    pageRoute("/routes/:id/persona/sync", "route.persona-sync", PersonaSyncPage, "多电脑人格同步"),
    pageRoute("/routes/:id/persona", "route.persona", PersonaTemplatePage, "人格配置"),
    pageRoute("/routes/:id/knowledge", "route.knowledge", RoleKnowledgePage, "计划与记忆"),
    pageRoute("/routes/:id/speech", "route.speech", SpeechServicePage, "语音服务"),
    pageRoute("/routes/:id/runtime", "route.runtime", RuntimeLogPage, "日志诊断"),
    pageRoute("/routes/:id?", "route.adapters", RouteConfigPage, "消息适配器"),
    pageRoute("/persona/:id?", "route.persona", PersonaTemplatePage, "人格配置"),
    pageRoute("/knowledge", "route.knowledge", RoleKnowledgePage, "计划与记忆"),
    pageRoute("/docs", "global.docs", ProjectDocsPage, "使用手册"),
    pageRoute("/performance", "global.performance", PerformancePage, "性能监控"),
    pageRoute("/runtime", "route.runtime", RuntimeLogPage, "日志诊断"),
    pageRoute("/settings", "global.settings", SettingsPage, "设置"),
    { path: "/:pathMatch(.*)*", redirect: { name: PLUGIN_RECOVERY_ROUTE_NAME } }
  ]
});

router.beforeEach((to) => {
  const routeId = to.meta.pluginRouteId as ControlledWebPageRouteId | undefined;
  if (!routeId || isWebPageRouteActive(pluginCatalogStore.pages.value, routeId)) return true;
  return {
    name: PLUGIN_RECOVERY_ROUTE_NAME,
    query: to.name === PLUGIN_RECOVERY_ROUTE_NAME ? {} : { from: to.fullPath }
  };
});
