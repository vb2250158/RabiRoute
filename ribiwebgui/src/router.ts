import type { AsyncComponentLoader } from "vue";
import { createRouter, createWebHashHistory, type RouteRecordRaw } from "vue-router";
import RouteLoadingPage from "./components/RouteLoadingPage.vue";
import PluginCatalogRecoveryPage from "./pages/PluginCatalogRecoveryPage.vue";
import { createImmediateRouteComponent } from "./immediateRouteComponent";
import { createLazyRouteRecovery } from "./lazyRouteRecovery";
import { pluginCatalogStore } from "./pluginCatalogStore";
import {
  isWebPageRouteActive,
  onTrustedWebPageRegistrationChange,
  registeredWebPages,
  type TrustedWebPageRegistration,
  type WebPageRouteId
} from "./pluginPages";

export const lazyRouteRecovery = createLazyRouteRecovery();
export const PLUGIN_RECOVERY_ROUTE_NAME = "plugin-recovery";

function immediatePage(loader: AsyncComponentLoader) {
  return createImmediateRouteComponent(loader, RouteLoadingPage, {
    onLoadError: error => lazyRouteRecovery.recover(error, router.currentRoute.value.fullPath),
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
    { path: "/:pathMatch(.*)*", redirect: { name: PLUGIN_RECOVERY_ROUTE_NAME } }
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
    return;
  }
  const activeRouteId = router.currentRoute.value.meta.pluginRouteId;
  unmountTrustedWebPageRoutes(change.registration.routeId);
  if (activeRouteId === change.registration.routeId) {
    void router.replace({
      name: PLUGIN_RECOVERY_ROUTE_NAME,
      query: { from: router.currentRoute.value.fullPath }
    });
  }
});

router.beforeEach((to) => {
  const routeId = typeof to.meta.pluginRouteId === "string" ? to.meta.pluginRouteId : "";
  if (!routeId || isWebPageRouteActive(pluginCatalogStore.pages.value, routeId)) return true;
  return {
    name: PLUGIN_RECOVERY_ROUTE_NAME,
    query: to.name === PLUGIN_RECOVERY_ROUTE_NAME ? {} : { from: to.fullPath }
  };
});
