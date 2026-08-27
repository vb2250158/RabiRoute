import type { AsyncComponentLoader } from "vue";
import { isBuiltinStartupWebPageRoute } from "./builtinStartupPages";
import { createRouter, createWebHashHistory, type RouteRecordRaw } from "vue-router";
import RouteLoadErrorPage from "./components/RouteLoadErrorPage.vue";
import RouteLoadingPage from "./components/RouteLoadingPage.vue";
import PluginCatalogRecoveryPage from "./pages/PluginCatalogRecoveryPage.vue";
import { createImmediateRouteComponent } from "./immediateRouteComponent";
import { createLazyRouteRecovery } from "./lazyRouteRecovery";
import { pluginCatalogStore } from "./pluginCatalogStore";
import {
  isWebPageRouteActive,
  isTrustedWebPageReplacementInProgress,
  onTrustedWebPageRegistrationChange,
  onTrustedWebPageReplacement,
  registeredWebPages,
  type TrustedWebPageRegistration,
  type WebPageRouteId
} from "./pluginPages";

export const lazyRouteRecovery = createLazyRouteRecovery();
export const PLUGIN_RECOVERY_ROUTE_NAME = "plugin-recovery";

async function reloadActiveTrustedWebPageAfterReplacement(): Promise<void> {
  const current = router.currentRoute.value;
  const routeId = typeof current.meta.pluginRouteId === "string" ? current.meta.pluginRouteId : "";
  if (!routeId || isBuiltinStartupWebPageRoute(routeId) || !isWebPageRouteActive(pluginCatalogStore.pages.value, routeId)) return;
  const resolved = router.resolve(current.fullPath);
  if (typeof resolved.meta.pluginRouteId !== "string" || resolved.meta.pluginRouteId !== routeId) return;
  await router.replace({ name: PLUGIN_RECOVERY_ROUTE_NAME, query: { from: current.fullPath } });
  await router.replace(current.fullPath);
}

function immediatePage(loader: AsyncComponentLoader) {
  return createImmediateRouteComponent(loader, RouteLoadingPage, {
    errorComponent: RouteLoadErrorPage,
    onLoadError: error => { lazyRouteRecovery.recover(error, router.currentRoute.value.fullPath); },
    onLoadSuccess: () => lazyRouteRecovery.markReady()
  });
}

function registeredPageRoutes(registration: TrustedWebPageRegistration): RouteRecordRaw[] {
  const component = immediatePage(registration.loader);
  return registration.paths.map((entry, index) => ({
    path: entry.path,
    name: `trusted-web-page:${registration.routeId}:${index}`,
    component,
    meta: { title: entry.title, pluginRouteId: registration.routeId }
  }));
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
    { path: "/models", redirect: "/speech" },
    {
      path: "/:pathMatch(.*)*",
      redirect: to => ({ name: PLUGIN_RECOVERY_ROUTE_NAME, query: { from: to.fullPath } })
    }
  ]
});

const trustedRouteDisposers = new Map<WebPageRouteId, readonly (() => void)[]>();

function mountTrustedWebPageRoutes(registration: TrustedWebPageRegistration): void {
  if (trustedRouteDisposers.has(registration.routeId)) {
    throw new Error(`Trusted Web page routes are already mounted: ${registration.routeId}`);
  }
  const disposers: Array<() => void> = [];
  try {
    for (const route of registeredPageRoutes(registration)) disposers.push(router.addRoute(route));
    trustedRouteDisposers.set(registration.routeId, Object.freeze(disposers));
  } catch (error) {
    for (const dispose of disposers.reverse()) dispose();
    throw error;
  }
}

function unmountTrustedWebPageRoutes(routeId: WebPageRouteId): void {
  const disposers = trustedRouteDisposers.get(routeId);
  if (!disposers) return;
  trustedRouteDisposers.delete(routeId);
  for (const dispose of disposers) dispose();
}

for (const registration of registeredWebPages()) mountTrustedWebPageRoutes(registration);

onTrustedWebPageRegistrationChange(change => {
  if (change.type === "registered") {
    mountTrustedWebPageRoutes(change.registration);
    const current = router.currentRoute.value;
    const requestedPath = typeof current.query.from === "string" ? current.query.from : "";
    if (current.name === PLUGIN_RECOVERY_ROUTE_NAME && requestedPath.startsWith("/") && !requestedPath.startsWith("/plugin-recovery")) {
      const requestedRoute = router.resolve(requestedPath);
      if (requestedRoute.meta.pluginRouteId === change.registration.routeId) void router.replace(requestedRoute.fullPath);
    }
    return;
  }
  const activeRouteId = router.currentRoute.value.meta.pluginRouteId;
  unmountTrustedWebPageRoutes(change.registration.routeId);
  if (activeRouteId === change.registration.routeId && !isTrustedWebPageReplacementInProgress()) {
    void router.replace({
      name: PLUGIN_RECOVERY_ROUTE_NAME,
      query: { from: router.currentRoute.value.fullPath }
    });
  }
});

onTrustedWebPageReplacement(() => { void reloadActiveTrustedWebPageAfterReplacement(); });

router.beforeEach((to) => {
  const routeId = typeof to.meta.pluginRouteId === "string" ? to.meta.pluginRouteId : "";
  if (!routeId || isBuiltinStartupWebPageRoute(routeId) || isWebPageRouteActive(pluginCatalogStore.pages.value, routeId)) return true;
  return {
    name: PLUGIN_RECOVERY_ROUTE_NAME,
    query: to.name === PLUGIN_RECOVERY_ROUTE_NAME ? {} : { from: to.fullPath }
  };
});
