<script setup lang="ts">
import { translateText } from "./i18n";
import { userFacingError } from "./userFacingError";
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { useTheme } from "vuetify";
import { useRoute, useRouter } from "vue-router";
import { useRoleStore } from "./stores/roleStore";
import { isRolePage, roleConfigPath, roleMessageHistoryPath } from "./roleScopedNavigation";
import { personaMessagesLocation } from "./persona/personaMessageRoutes";
import LocaleSwitcher from "./components/LocaleSwitcher.vue";
import PluginPageHost from "./components/PluginPageHost.vue";
import QuickSetupDialog from "./components/QuickSetupDialog.vue";
import RoleSourcePicker from "./components/RoleSourcePicker.vue";
import RoleManagementActions from "./components/RoleManagementActions.vue";
import { useI18n } from "./i18n";
import { routeScopedPathForCurrentPage, routeKeyFromWebguiHash, showsRouteSwitcher } from "./routeScopedNavigation";
import { pluginCatalogStore } from "./pluginCatalogStore";
import { buildWebNavigation } from "./pluginNavigation";
import { gatewayPersonaDisplayName } from "./personaPresentation";
import { useGatewayStore } from "./stores/gatewayStore";
import { configNameFor } from "./utils/gatewayHelpers";
import { pageSaveAction } from "./pageSaveAction";
import { desktopSettingsClient } from "./desktopSettingsClient";
import { applyCatalogInterfaceTheme, applyVuetifyInterfaceTheme, INTERFACE_THEME_CHANGED } from "./interfaceTheme";
import {
  clearStoredWebThemePreference,
  initialWebThemePreference,
  storedWebThemePreference,
  replaceCustomWebThemeResources,
  resolveWebThemeResource,
  type WebThemeId
} from "./pluginThemes";
import { isWebPageRouteActive, webPageDataRequirements } from "./pluginPages";
import { PLUGIN_RECOVERY_ROUTE_NAME } from "./router";
import { managerEventSource } from "./managerApi";
import { API_REFERENCE_CHANGED } from "./docs/apiReferenceClient";
import { disposeWebPluginModules } from "./pluginModules";
import { refreshWebPluginModulesSafely } from "./pluginModuleBootstrap";
import {
  webCommandForHandler,
  webCommandsInSlot,
  type WebCommandContext,
  type WebCommandContribution,
  type WebCommandState
} from "./pluginCommands";

const store = useGatewayStore();
const route = useRoute();
const router = useRouter();
const roles = useRoleStore();
const roleCreation = ref<InstanceType<typeof RoleManagementActions> | null>(null);
const showRoleSwitcher = computed(() => isRolePage(route.path));
const roleSourceQuery = computed(() => roles.sourceDeviceId ? { source: roles.sourceDeviceId } : {});
const embeddedPlanView = computed(() => Boolean(route.params.planId) && window.self !== window.top);
const { t } = useI18n();
const vuetifyTheme = useTheme();
const interfaceThemePreference = ref<WebThemeId>("system");
const systemThemeQuery = window.matchMedia("(prefers-color-scheme: dark)");
let managerEvents: EventSource | null = null;

async function handlePluginCatalogChanged(): Promise<void> {
  await pluginCatalogStore.refresh();
  await refreshWebPluginModulesSafely();
  if (!webCommandForHandler(pluginCatalogStore.commands.value, "web.quick-setup")) store.quickSetupDialogOpen = false;
  const routeId = typeof route.meta.pluginRouteId === "string" ? route.meta.pluginRouteId : "";
  if (routeId && !isWebPageRouteActive(pluginCatalogStore.pages.value, routeId)) {
    await router.replace({ name: PLUGIN_RECOVERY_ROUTE_NAME, query: { from: route.fullPath } });
  }
}

function refreshInterfaceTheme(): void {
  const selected = resolveWebThemeResource(pluginCatalogStore.themes.value, interfaceThemePreference.value);
  const resolved = applyCatalogInterfaceTheme(pluginCatalogStore.themes.value, interfaceThemePreference.value, systemThemeQuery.matches);
  applyVuetifyInterfaceTheme(vuetifyTheme, resolved, selected.customTheme);
}

function onSystemThemeChanged(): void {
  refreshInterfaceTheme();
}

function onInterfaceThemeChanged(event: Event): void {
  const preference = (event as CustomEvent<WebThemeId>).detail;
  if (typeof preference !== "string" || !preference.trim()) return;
  interfaceThemePreference.value = resolveWebThemeResource(pluginCatalogStore.themes.value, preference).themeId;
  refreshInterfaceTheme();
}

async function loadInterfaceTheme(): Promise<void> {
  let preference: WebThemeId = "system";
  try {
    let settings = await desktopSettingsClient.read();
    replaceCustomWebThemeResources(settings.customThemes);
    const initial = initialWebThemePreference(settings.webTheme, storedWebThemePreference());
    if (initial.migrateToManager) {
      settings = await desktopSettingsClient.update({ webTheme: initial.themeId });
      replaceCustomWebThemeResources(settings.customThemes);
      preference = initialWebThemePreference(settings.webTheme, "").themeId;
    } else {
      preference = initial.themeId;
    }
    clearStoredWebThemePreference();
  } catch {
    preference = "system";
  }
  interfaceThemePreference.value = preference;
  refreshInterfaceTheme();
}

const DRAWER_PREFERENCES_KEY = "rabiroute:webgui:drawer-preferences";
type DrawerPreferences = { default: boolean; docs: boolean };

function readDrawerPreferences(): DrawerPreferences {
  const fallback = { default: window.innerWidth >= 960, docs: false };
  try {
    const stored = JSON.parse(window.localStorage.getItem(DRAWER_PREFERENCES_KEY) || "null") as Partial<DrawerPreferences> | null;
    return {
      default: typeof stored?.default === "boolean" ? stored.default : fallback.default,
      docs: typeof stored?.docs === "boolean" ? stored.docs : fallback.docs
    };
  } catch {
    return fallback;
  }
}

function writeDrawerPreferences(preferences: DrawerPreferences): void {
  try {
    window.localStorage.setItem(DRAWER_PREFERENCES_KEY, JSON.stringify(preferences));
  } catch {
    // 浏览器禁用本地存储时仍保留当前会话内的抽屉状态。
  }
}

function ensurePageDiagnostics(force = false): Promise<void> {
  const routeId = typeof route.meta.pluginRouteId === "string" ? route.meta.pluginRouteId : "";
  return routeId && webPageDataRequirements(routeId).includes("gateway.diagnostics")
    ? store.ensureDiagnostics(force)
    : Promise.resolve();
}

const drawerPreferences = readDrawerPreferences();
const drawer = ref(route.path === "/docs" ? drawerPreferences.docs : drawerPreferences.default);
const snackbar = ref("");
const showRouteSwitcher = computed(() => showsRouteSwitcher(route.path));
const selectedRouteKey = computed(() => store.requestedRouteKey || (store.selectedGateway ? configNameFor(store.selectedGateway) : ""));
watch(() => route.fullPath, path => store.syncRouteSelection(`#${path}`), { immediate: true, flush: "sync" });
const navigationGroups = computed(() => buildWebNavigation(pluginCatalogStore.contributions.value, selectedRouteKey.value, roles.selectedRoleId));
const navItems = computed(() => navigationGroups.value.routePrimary.map(item => ({ ...item, title: t(item.title), to: item.to.startsWith("/roles/") ? { path: item.to, query: roleSourceQuery.value } : item.to })));
const utilityNavItems = computed(() => navigationGroups.value.utility.map(item => ({ ...item, title: t(item.title) })));
const footerNavItems = computed(() => navigationGroups.value.footer.map(item => ({ ...item, title: t(item.title) })));
const sidebarPrimaryCommands = computed(() => webCommandsInSlot(pluginCatalogStore.commands.value, "sidebar-footer-primary"));
const sidebarCommands = computed(() => webCommandsInSlot(pluginCatalogStore.commands.value, "sidebar-footer"));
const topbarCommands = computed(() => webCommandsInSlot(pluginCatalogStore.commands.value, "topbar-primary").filter(command => command.handlerId !== "web.add-route" || route.path.startsWith("/routes")));
const managerConnected = computed(() => !store.managerError);
const activePageSaveAction = computed(() => pageSaveAction.value);
const hasUnsavedChanges = computed(() => store.dirty || roles.dirty || activePageSaveAction.value?.dirty.value === true);
const pageTitle = computed(() => t(String(route.meta.title || "RibiWebGUI")));
const routeOptions = computed(() => store.gateways.map(gateway => {
  const runtime = store.runtimeFor(gateway.id);
  const title = String(gateway.routeName || gateway.name || gateway.id);
  return { title, value: gateway.id };
}));

function pageSaveState(): WebCommandState {
  return {
    enabled: activePageSaveAction.value == null || activePageSaveAction.value.ready.value,
    loading: store.saving || activePageSaveAction.value?.saving.value === true,
    dirty: hasUnsavedChanges.value
  };
}

async function savePage(): Promise<void> {
  if (activePageSaveAction.value) {
    if (!activePageSaveAction.value.ready.value) return;
    await activePageSaveAction.value.save();
    return;
  }
  if (showRoleSwitcher.value) { await roles.save(); return; }
  await store.save();
}

function commandContext(): WebCommandContext {
  return {
    createRole: () => { if (canLeaveDirtyState()) roleCreation.value?.openCreate(); },
    openQuickSetup: () => store.openQuickSetup(),
    addRoute: () => store.addGatewayAndOpenQuickSetup(),
    openManagerConfig: () => store.openConfigFile("manager"),
    savePage,
    pageSaveState,
    notify: message => { snackbar.value = message; }
  };
}

function commandState(command: WebCommandContribution): WebCommandState {
  return command.state?.(commandContext()) ?? {};
}

async function executeCommand(command: WebCommandContribution): Promise<void> {
  if (commandState(command).enabled === false) return;
  try {
    await command.execute(commandContext());
  } catch (error) {
    store.error = userFacingError(error);
  }
}

async function loadGatewayEditorInBackground(): Promise<void> {
  await store.load();
  if (store.gateways.length === 0 && route.path.startsWith("/routes")) {
    const createRole = webCommandForHandler(pluginCatalogStore.commands.value, "web.create-role");
    if (createRole) await executeCommand(createRole);
  } else if (!showRoleSwitcher.value && selectedRouteKey.value && !routeKeyFromWebguiHash(`#${route.fullPath}`)) {
    const scopedPath = routeScopedPathForCurrentPage(selectedRouteKey.value, route.path);
    if (scopedPath && scopedPath !== route.path) await router.replace({ path: scopedPath, query: route.query, hash: route.hash });
  }
  void ensurePageDiagnostics();
}


let roleNavigationVersion = 0;
async function syncRolePage(): Promise<void> {
  const version = ++roleNavigationVersion;
  if (route.path === "/routes" || /^\/routes\/[^/]+(?:\/adapters)?$/.test(route.path)) {
    await store.load();
    if (version !== roleNavigationVersion) return;
    const key = String(route.params.id || "");
    const original = key ? store.gateways.find(item => item.id === key || configNameFor(item) === key) : store.selectedGateway;
    if (original?.agentRoleId) {
      const destination = personaMessagesLocation(original);
      await router.replace({ ...destination, query: { ...route.query, ...destination.query } });
    }
    return;
  }
  const legacy = route.path.match(/^\/routes\/([^/]+)\/(persona(?:\/document)?|knowledge|plan\/(.+))$/)
    || route.path.match(/^\/persona\/([^/]+)$/);
  if (legacy) {
    await store.load();
    if (version !== roleNavigationVersion) return;
    const key = decodeURIComponent(legacy[1]);
    const original = store.gateways.find(item => item.id === key || configNameFor(item) === key);
    if (!original?.agentRoleId) { roles.error = original ? "当前路由未绑定角色，请在路由配置中选择。" : "未找到原链接对应的路由。"; return; }
    const suffix = legacy[2] === "knowledge" ? "knowledge" : legacy[2]?.startsWith("plan/") ? `plan/${legacy[3]}` : legacy[2]?.endsWith("document") ? "document" : "config";
    await router.replace({ path: `/roles/${encodeURIComponent(original.agentRoleId)}/${suffix}`, query: { ...route.query, ...(original.agentRoleDeviceId ? { source: original.agentRoleDeviceId } : {}) } });
    return;
  }
  if (route.path === "/persona" || route.path === "/knowledge") {
    await router.replace(route.path === "/knowledge" ? "/roles/knowledge" : "/roles"); return;
  }
  if (!isRolePage(route.path)) return;
  const source = String(route.query.source || "");
  const id = String(route.params.roleId || "");
  if (!id) {
    roles.sourceDeviceId = source;
    await roles.loadCatalog();
    if (version !== roleNavigationVersion) return;
    const first = roles.catalog.find(role => !role.error);
    if (first) await router.replace({ path: route.path.endsWith("/message-history") ? roleMessageHistoryPath(first.roleId) : route.path.endsWith("/knowledge") ? `/roles/${encodeURIComponent(first.roleId)}/knowledge` : roleConfigPath(first.roleId), query: source ? { source } : {} });
    else await roles.select("", source);
    return;
  }
  await roles.select(id, source);
  if (version !== roleNavigationVersion) return;
  await roles.loadCatalog();
}
watch(() => route.fullPath, () => { void syncRolePage().catch(error => { roles.error = userFacingError(error); }); }, { immediate: true });
function selectRole(id: string, source = roles.sourceDeviceId): void {
  if (!id || (id === roles.selectedRoleId && source === roles.sourceDeviceId) || !canLeaveDirtyState()) return;
  const suffix = route.path.endsWith("/message-history") ? "message-history" : route.path.includes("/knowledge") || route.path.includes("/plan/") ? "knowledge" : "config";
  void router.push({ path: `/roles/${encodeURIComponent(id)}/${suffix}`, query: { ...(source ? { source } : {}), ...(route.query.tab === "messages" ? { tab: "messages" } : {}) } });
}
const releaseRoleGuard = router.beforeEach((to, from) => {
  if (!roles.dirty || !isRolePage(from.path)) return true;
  if (String(to.params.roleId || "") === roles.selectedRoleId && String(to.query.source || "") === roles.sourceDeviceId) return true;
  return window.confirm(translateText("当前角色有未保存修改，确定离开？"));
});

onMounted(() => {
  void loadInterfaceTheme();
  void store.loadRouteSummaries().then(() => loadGatewayEditorInBackground());
  window.addEventListener("beforeunload", beforeUnload);
  window.addEventListener(INTERFACE_THEME_CHANGED, onInterfaceThemeChanged);
  systemThemeQuery.addEventListener("change", onSystemThemeChanged);
  managerEvents = managerEventSource("/api/events");
  managerEvents.addEventListener("api.catalog.changed", () => { window.dispatchEvent(new Event(API_REFERENCE_CHANGED)); });
  managerEvents.addEventListener("open", () => { window.dispatchEvent(new Event(API_REFERENCE_CHANGED)); });
  managerEvents.addEventListener("plugin_catalog_changed", () => { void handlePluginCatalogChanged(); });
  managerEvents.addEventListener("role_catalog_changed", () => { void roles.loadCatalog(); if (!roles.dirty && showRoleSwitcher.value) void roles.load(); });
  managerEvents.addEventListener("desktop_settings_changed", () => { void loadInterfaceTheme(); });
});

watch(
  () => pluginCatalogStore.themes.value.options.map(option => option.webResourceId).join("|"),
  () => refreshInterfaceTheme()
);

watch(
  () => route.meta.pluginRouteId,
  () => { void ensurePageDiagnostics(); }
);

watch(
  () => route.path,
  path => {
    if (path === "/docs") {
      drawer.value = false;
      return;
    }
    drawer.value = drawerPreferences.default;
  }
);

watch(drawer, value => {
  if (route.path === "/docs") drawerPreferences.docs = value;
  else drawerPreferences.default = value;
  writeDrawerPreferences(drawerPreferences);
});

onBeforeUnmount(() => {
  releaseRoleGuard();
  window.removeEventListener("beforeunload", beforeUnload);
  window.removeEventListener(INTERFACE_THEME_CHANGED, onInterfaceThemeChanged);
  systemThemeQuery.removeEventListener("change", onSystemThemeChanged);
  managerEvents?.close();
  managerEvents = null;
  void disposeWebPluginModules();
});

async function refresh(): Promise<void> {
  await Promise.all([store.load(), roles.loadCatalog(), pluginCatalogStore.refresh()]);
  if (showRoleSwitcher.value && (!roles.dirty || window.confirm(translateText("放弃当前角色未保存修改并刷新？")))) await roles.load();
  await refreshWebPluginModulesSafely();
  const routeId = typeof route.meta.pluginRouteId === "string" ? route.meta.pluginRouteId : "";
  if (routeId && !isWebPageRouteActive(pluginCatalogStore.pages.value, routeId)) {
    await router.replace({ name: PLUGIN_RECOVERY_ROUTE_NAME, query: { from: route.fullPath } });
    return;
  }
  await ensurePageDiagnostics(true);
  snackbar.value = "状态已刷新";
}

function beforeUnload(event: BeforeUnloadEvent): void {
  if (!hasUnsavedChanges.value) return;
  event.preventDefault();
  event.returnValue = "";
}

function canLeaveDirtyState(): boolean {
  return !hasUnsavedChanges.value || window.confirm(t("当前配置有未保存修改。确定要切换吗？"));
}

function selectGateway(id: string): void {
  if (!canLeaveDirtyState()) return;
  const gateway = store.gateways.find(candidate => candidate.id === id);
  const name = gateway ? configNameFor(gateway) : id;
  const scopedPath = routeScopedPathForCurrentPage(name, route.path);
  if (scopedPath && scopedPath !== route.path) {
    void router.push({ path: scopedPath, query: route.query, hash: route.hash });
  } else if (!scopedPath) {
    store.selectGateway(id);
  }
}
</script>

<template>
  <v-app>
    <v-navigation-drawer v-if="!embeddedPlanView" v-model="drawer" width="276" class="left-sidebar">
      <div class="sidebar-brand">
        <v-avatar rounded="lg" size="46">
          <v-img src="/assets/rabiroute-icon.png" alt="RabiRoute" />
        </v-avatar>
        <div class="min-w-0">
          <div class="font-weight-black text-primary text-h6 lh-1">RabiRoute</div>
          <div class="section-note">v{{ store.meta.version }}</div>
        </div>
      </div>

      <v-divider />

      <div class="sidebar-body">
        <v-list nav density="comfortable" bg-color="transparent" class="sidebar-list">
          <v-list-item
            v-for="item in navItems"
            :key="item.key"
            :to="item.to"
            :prepend-icon="item.icon"
            :title="item.title"
            rounded="lg"
          />
        </v-list>
        <v-divider class="sidebar-nav-divider" />
        <v-list nav density="comfortable" bg-color="transparent" class="sidebar-list">
          <v-list-item
            v-for="item in utilityNavItems"
            :key="item.key"
            :to="item.to"
            :prepend-icon="item.icon"
            :title="item.title"
            rounded="lg"
          />
        </v-list>
      </div>

      <template #append>
        <div class="sidebar-footer">
          <v-btn
            v-for="command in sidebarPrimaryCommands"
            :key="command.key"
            block
            class="sidebar-footer-btn"
            variant="tonal"
            :color="command.appearance === 'primary' ? 'primary' : undefined"
            :prepend-icon="command.icon"
            :loading="commandState(command).loading"
            :disabled="commandState(command).enabled === false"
            @click="executeCommand(command)"
          >
            {{ t(command.label) }}
          </v-btn>
          <v-btn block class="sidebar-footer-btn" variant="text" prepend-icon="mdi-github" :href="store.meta.githubUrl" target="_blank">
            GitHub
          </v-btn>
          <v-btn
            v-for="item in footerNavItems"
            :key="item.key"
            block
            class="sidebar-footer-btn"
            variant="text"
            :prepend-icon="item.icon"
            :to="item.to"
          >
            {{ item.title }}
          </v-btn>
          <v-btn
            v-for="command in sidebarCommands"
            :key="command.key"
            block
            class="sidebar-footer-btn"
            variant="text"
            :prepend-icon="command.icon"
            :loading="commandState(command).loading"
            :disabled="commandState(command).enabled === false"
            @click="executeCommand(command)"
          >
            {{ t(command.label) }}
          </v-btn>
        </div>
      </template>
    </v-navigation-drawer>

    <v-app-bar v-if="!embeddedPlanView" flat class="top-app-bar px-2">
      <v-app-bar-nav-icon @click="drawer = !drawer" />
      <div class="topbar-context" :class="{ 'has-route-switcher': showRouteSwitcher }">
        <v-toolbar-title class="topbar-title">
          <div class="font-weight-bold">{{ pageTitle }}</div>
        </v-toolbar-title>
        <div id="page-topbar-controls" class="topbar-page-controls" />
        <RoleSourcePicker v-if="showRoleSwitcher" @select="selectRole" />
        <v-select
          v-if="showRouteSwitcher && !showRoleSwitcher"
          class="topbar-route-picker"
          :model-value="store.selectedGatewayId"
          :items="routeOptions"
          aria-label="选择路由"
          density="compact"
          hide-details
          @update:model-value="value => selectGateway(String(value || ''))"
        >
          <template #item="{ props: itemProps }">
            <v-list-item v-bind="itemProps" />
          </template>
          <template #selection="{ item }">
            <span class="text-truncate">{{ item.raw.title }}</span>
          </template>
        </v-select>
      </div>
      <v-spacer />
      <div class="topbar-actions">
        <span v-if="store.saveState === 'confirming'" class="dirty-hint">{{ t("保存结果待确认") }}</span>
        <span v-else-if="hasUnsavedChanges" class="dirty-hint">{{ t("有未保存的修改") }}</span>
        <LocaleSwitcher />
        <v-chip class="manager-chip" :color="managerConnected ? 'success' : 'error'" variant="tonal" size="small">
          <v-icon start size="14">mdi-circle</v-icon>
          <span class="manager-chip-text">{{ t(managerConnected ? "服务已连接" : "服务未连接") }}</span>
        </v-chip>
        <v-btn icon="mdi-refresh" :loading="store.loading" aria-label="刷新状态" @click="refresh" />
        <template v-for="command in topbarCommands" :key="command.key">
          <v-btn
            class="desktop-action"
            :color="command.appearance === 'primary' ? 'primary' : undefined"
            :prepend-icon="command.icon"
            :variant="command.appearance === 'primary' ? 'flat' : 'tonal'"
            :loading="commandState(command).loading"
            :disabled="commandState(command).enabled === false"
            @click="executeCommand(command)"
          >
            {{ t(command.label) }}
          </v-btn>
          <v-btn
            class="mobile-action"
            :color="command.appearance === 'primary' ? 'primary' : undefined"
            :icon="command.icon"
            :variant="command.appearance === 'primary' ? 'flat' : 'tonal'"
            :loading="commandState(command).loading"
            :disabled="commandState(command).enabled === false"
            :aria-label="t(command.label)"
            @click="executeCommand(command)"
          />
        </template>
      </div>
    </v-app-bar>

    <v-main :class="{ 'navigation-collapsed': !drawer }">
      <v-alert v-if="store.error" type="error" variant="tonal" class="ma-4">{{ store.error }}</v-alert>
      <v-btn v-if="store.saveState === 'conflict'" class="ma-4" @click="store.reloadSelectedGateway().catch(error => { store.error = String(error); })">{{ t("重新加载当前路线") }}</v-btn>
      <v-alert v-else-if="store.saveMessage" :type="store.saveState === 'saved' ? 'success' : 'info'" variant="tonal" class="ma-4" role="status">{{ t(store.saveMessage) }}</v-alert>
      <v-alert v-if="store.routeSelectionMissing && !showRoleSwitcher" type="error" variant="tonal" class="ma-4">
        {{ t("未找到当前路由") }}：<span data-no-i18n>{{ store.requestedRouteKey }}</span>
      </v-alert>
      <router-view v-if="!store.routeSelectionMissing || showRoleSwitcher" v-slot="{ Component, route: activeRoute }">
        <KeepAlive>
          <PluginPageHost
            :component="Component"
            :route-id="String(activeRoute.meta.pluginRouteId || '')"
            v-if="activeRoute.meta.keepAlive"
            :key="`${String(activeRoute.meta.pluginRouteId || activeRoute.name || activeRoute.path)}:${String(activeRoute.params.roleId || activeRoute.params.id || '')}:${String(activeRoute.query.source || '')}`"
          />
        </KeepAlive>
        <PluginPageHost :component="Component" :route-id="String(activeRoute.meta.pluginRouteId || '')" v-if="!activeRoute.meta.keepAlive" :key="`${String(activeRoute.meta.pluginRouteId || activeRoute.name || activeRoute.path)}:${String(activeRoute.params.roleId || activeRoute.params.id || '')}:${String(activeRoute.query.source || '')}`" />
      </router-view>
    </v-main>

    <QuickSetupDialog v-model="store.quickSetupDialogOpen" />
    <RoleManagementActions ref="roleCreation" create-only />
    <v-snackbar :model-value="!!snackbar" timeout="1800" @update:model-value="value => { if (!value) snackbar = '' }">
      {{ snackbar }}
    </v-snackbar>
  </v-app>
</template>
