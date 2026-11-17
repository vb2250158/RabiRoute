<script setup lang="ts">
import { translateText } from "./i18n/index";
import { userFacingError } from "./userFacingError";
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from "vue";
import DataUpgradeDialog from "./components/DataUpgradeDialog.vue";
import { createDataUpgradeController, type DataUpgradeView } from "./dataUpgradeClient";
import { DATA_UPGRADE_STATUS_EVENT, type DataUpgradeStatus } from "../../src/shared/dataUpgradeContract";
import { useTheme } from "vuetify";
import { useRoute, useRouter } from "vue-router";
import { findFirstAvailableRole, useRoleStore } from "./stores/roleStore";
import { isRolePage, roleConfigPath, roleMessageHistoryPath } from "./roleScopedNavigation";
import { personaMessagesLocation } from "../../src/plugins/io.rabiroute.manager.persona/web/persona/personaMessageRoutes";
import LocaleSwitcher from "./components/LocaleSwitcher.vue";
import PluginPageHost from "./components/PluginPageHost.vue";
import QuickSetupDialog from "./components/QuickSetupDialog.vue";
import RoleSourcePicker from "./components/RoleSourcePicker.vue";
import RoleManagementActions from "./components/RoleManagementActions.vue";
import { useI18n } from "./i18n/index";
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
import { refreshWebPluginModulesSafely, webPluginPageLoading } from "./pluginModuleBootstrap";
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
const isPluginManagementPage = computed(() => route.path === "/plugins");
const bootstrapManagerConnected = ref(false);
const dataUpgradeView = reactive<DataUpgradeView>({ status: null, open: false, pending: false, error: "", uncertain: false });
const dataUpgradeController = createDataUpgradeController(dataUpgradeView);
watch(() => Boolean(store.meta?.applicationGenerationId) || bootstrapManagerConnected.value, ready => {
  if (ready) void dataUpgradeController.ready();
}, { immediate: true });
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
const pageHeader = ref<HTMLElement | null>(null);
const pageHeaderHeight = ref(88);
const pageHeaderObserver = new ResizeObserver(entries => {
  pageHeaderHeight.value = entries[0]?.borderBoxSize[0]?.blockSize ?? pageHeader.value?.offsetHeight ?? 0;
});
watch(pageHeader, element => {
  pageHeaderObserver.disconnect();
  pageHeaderHeight.value = element?.offsetHeight ?? 0;
  if (element) pageHeaderObserver.observe(element);
}, { flush: "post" });
const showRouteSwitcher = computed(() => showsRouteSwitcher(route.path));
const selectedRouteKey = computed(() => store.requestedRouteKey || (store.selectedGateway ? configNameFor(store.selectedGateway) : ""));
watch(() => route.fullPath, path => store.syncRouteSelection(`#${path}`), { immediate: true, flush: "sync" });
const pluginCatalogDiagnosticLabels = computed(() => pluginCatalogStore.diagnostics.value.map((value) => {
  if (!value || typeof value !== "object") return "";
  const item = value as Record<string, unknown>;
  return [item.code, item.instanceId, item.pluginId, item.id, typeof item.index === "number" ? `#${item.index}` : undefined]
    .filter((entry): entry is string => typeof entry === "string").join(" · ");
}).filter(Boolean));
const navigationGroups = computed(() => buildWebNavigation(pluginCatalogStore.contributions.value, selectedRouteKey.value, roles.selectedRoleId));
const navItems = computed(() => navigationGroups.value.routePrimary.map(item => ({ ...item, title: t(item.title), to: item.to.startsWith("/roles/") ? { path: item.to, query: roleSourceQuery.value } : item.to })));
const utilityNavItems = computed(() => navigationGroups.value.utility.map(item => ({ ...item, title: t(item.title) })));
const footerNavItems = computed(() => navigationGroups.value.footer.map(item => ({ ...item, title: t(item.title) })));
const sidebarPrimaryCommands = computed(() => webCommandsInSlot(pluginCatalogStore.commands.value, "sidebar-footer-primary"));
const sidebarCommands = computed(() => webCommandsInSlot(pluginCatalogStore.commands.value, "sidebar-footer"));
const managerConnected = computed(() => isPluginManagementPage.value ? bootstrapManagerConnected.value : !store.managerError);
const activePageSaveAction = computed(() => pageSaveAction.value);
const hasUnsavedChanges = computed(() => store.dirty || roles.dirty || activePageSaveAction.value?.dirty.value === true);
// Save appears where a page owns savable state; any dirty or unconfirmed draft keeps it visible.
const pageCanSave = computed(() => activePageSaveAction.value != null
  || hasUnsavedChanges.value
  || store.saveState === "confirming");
const pageCommands = computed(() => webCommandsInSlot(pluginCatalogStore.commands.value, "topbar-primary").filter(command =>
  (command.handlerId !== "web.add-route" || route.path.startsWith("/routes"))
  && (!isPluginManagementPage.value || command.handlerId !== "web.save-page")
  && (command.handlerId !== "web.save-page" || pageCanSave.value)));
const pageTitle = computed(() => t(route.name === PLUGIN_RECOVERY_ROUTE_NAME && webPluginPageLoading(pluginCatalogStore.status.value)
  ? "页面已切换，正在加载内容" : String(route.meta.title || "RibiWebGUI")));
const pageContext = computed(() => {
  if (showRoleSwitcher.value) return roles.catalog.find(role => role.roleId === roles.selectedRoleId)?.title || roles.selectedRoleId;
  const gateway = showRouteSwitcher.value ? store.selectedGateway : undefined;
  return gateway ? String(gateway.routeName || gateway.name || gateway.id) : "";
});
// Utility pages at or after this order are host maintenance pages and share the "系统" group.
// Served by the Manager at runtime; a bound URL keeps the bundler from importing it.
const brandIconUrl = "/assets/rabiroute-icon.png";
const SYSTEM_NAVIGATION_ORDER = 70;
const firstSystemNavKey = computed(() => utilityNavItems.value.find(item => item.order >= SYSTEM_NAVIGATION_ORDER)?.key ?? "");
const justSaved = ref(false);
let justSavedTimer: ReturnType<typeof setTimeout> | undefined;
function flashSaved(): void {
  justSaved.value = true;
  if (justSavedTimer) clearTimeout(justSavedTimer);
  justSavedTimer = setTimeout(() => { justSaved.value = false; }, 2400);
}
const saveStatus = computed(() => {
  if (store.saveState === "confirming") return { state: "confirming", label: "保存结果待确认" };
  if (pageSaveState().loading) return { state: "saving", label: "正在保存" };
  if (hasUnsavedChanges.value) return { state: "dirty", label: "有未保存的修改" };
  return justSaved.value ? { state: "saved", label: "已保存" } : null;
});
const routeOptions = computed(() => store.gateways.map(gateway => {
  const runtime = store.runtimeFor(gateway.id);
  const title = String(gateway.routeName || gateway.name || gateway.id);
  return { title, value: gateway.id };
}));

function pageSaveState(): WebCommandState {
  return {
    enabled: activePageSaveAction.value
      ? activePageSaveAction.value.ready.value
      : (!roles.dirty || roles.ready) && (roles.dirty || store.dirty),
    loading: store.saving || roles.saving || activePageSaveAction.value?.saving.value === true,
    dirty: hasUnsavedChanges.value
  };
}

async function savePage(): Promise<void> {
  if (activePageSaveAction.value) {
    if (!activePageSaveAction.value.ready.value) return;
    await activePageSaveAction.value.save();
    return;
  }
  // Drafts can outlive their original page; save through their actual owners.
  if (store.dirty) await store.saveChangedRoutes();
  if (roles.dirty) await roles.save();
}

function commandContext(): WebCommandContext {
  return {
    createRole: () => { if (canLeaveDirtyState()) roleCreation.value?.openCreate(); },
    openQuickSetup: () => store.openQuickSetup(),
    addRoute: () => store.addGatewayAndOpenQuickSetup(),
    openManagerConfig: () => store.openConfigFile("manager"),
    savePage: async () => {
      if (!pageSaveState().enabled || pageSaveState().loading) throw new Error(t("请先完成当前配置再保存。"));
      const origin = route.fullPath;
      await savePage();
      if (origin === route.fullPath && store.saveState !== "confirming") flashSaved();
    },
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

async function refreshManagementMetadata(): Promise<void> {
  try { await store.loadMeta(true); bootstrapManagerConnected.value = true; }
  catch { bootstrapManagerConnected.value = false; }
}

watch(() => route.path, (path, previous) => {
  if (path === "/plugins") void refreshManagementMetadata();
  else if (previous === "/plugins") void store.loadRouteSummaries().then(() => loadGatewayEditorInBackground());
});


let roleNavigationVersion = 0;
let roleSelectionWrite: Promise<void> = Promise.resolve();
let lastSavedRoleSelection = "";
function persistRoleSelection(roleId: string, sourceDeviceId: string): void {
  const selection = { roleId, sourceDeviceId };
  const key = JSON.stringify(selection);
  roleSelectionWrite = roleSelectionWrite.catch(() => {}).then(async () => {
    if (key === lastSavedRoleSelection) return;
    try {
      const saved = await desktopSettingsClient.update({ lastRoleSelection: selection });
      if (JSON.stringify(saved.lastRoleSelection) !== key) throw new Error("角色选择未保存。");
    } catch (error) {
      // An interrupted settings write may have committed; inspect the owning store once.
      const current = await desktopSettingsClient.read().catch(() => null);
      if (JSON.stringify(current?.lastRoleSelection) !== key) throw error;
    }
    lastSavedRoleSelection = key;
  });
  void roleSelectionWrite.catch(error => { roles.error = `角色选择保存失败：${userFacingError(error)}`; });
}
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
    let savedSelection = null;
    if (!("source" in route.query)) {
      try { savedSelection = (await desktopSettingsClient.read()).lastRoleSelection; }
      catch (error) { if (version === roleNavigationVersion) roles.error = `角色选择读取失败：${userFacingError(error)}`; return; }
      if (version !== roleNavigationVersion) return;
    }
    if (savedSelection?.roleId) {
      const savedSource = savedSelection.sourceDeviceId;
      lastSavedRoleSelection = JSON.stringify(savedSelection);
      await router.replace({ path: route.path.endsWith("/message-history") ? roleMessageHistoryPath(savedSelection.roleId) : route.path.endsWith("/knowledge") ? `/roles/${encodeURIComponent(savedSelection.roleId)}/knowledge` : roleConfigPath(savedSelection.roleId), query: savedSource ? { source: savedSource } : {} });
      return;
    }
    roles.sourceDeviceId = source;
    const first = await findFirstAvailableRole(source);
    if (version !== roleNavigationVersion) return;
    if (first) await router.replace({ path: route.path.endsWith("/message-history") ? roleMessageHistoryPath(first.roleId) : route.path.endsWith("/knowledge") ? `/roles/${encodeURIComponent(first.roleId)}/knowledge` : roleConfigPath(first.roleId), query: source ? { source } : {} });
    else await roles.select("", source);
    return;
  }
  await roles.select(id, source);
  if (version !== roleNavigationVersion) return;
  if (roles.detail?.roleId === id && !roles.detail.archivedAt) persistRoleSelection(id, source);
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
  if (isPluginManagementPage.value) void refreshManagementMetadata();
  else void store.loadRouteSummaries().then(() => loadGatewayEditorInBackground());
  // The sidebar role switcher is visible on every page; role pages load their own catalog and selection.
  if (!showRoleSwitcher.value) void restoreSidebarRole();
  window.addEventListener("beforeunload", beforeUnload);
  window.addEventListener(INTERFACE_THEME_CHANGED, onInterfaceThemeChanged);
  systemThemeQuery.addEventListener("change", onSystemThemeChanged);
  managerEvents = managerEventSource("/api/events");
  managerEvents.addEventListener(DATA_UPGRADE_STATUS_EVENT, event => {
    try { dataUpgradeController.event(JSON.parse((event as MessageEvent<string>).data) as DataUpgradeStatus); }
    catch { /* Ignore an incomplete event; the next server status remains authoritative. */ }
  });
  managerEvents.addEventListener("api.catalog.changed", () => { window.dispatchEvent(new Event(API_REFERENCE_CHANGED)); });
  managerEvents.addEventListener("open", () => {
    window.dispatchEvent(new Event(API_REFERENCE_CHANGED));
    void dataUpgradeController.reconnected();
  });
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
    justSaved.value = false;
    if (justSavedTimer) clearTimeout(justSavedTimer);
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
  pageHeaderObserver.disconnect();
  dataUpgradeController.dispose();
  releaseRoleGuard();
  if (justSavedTimer) clearTimeout(justSavedTimer);
  window.removeEventListener("beforeunload", beforeUnload);
  window.removeEventListener(INTERFACE_THEME_CHANGED, onInterfaceThemeChanged);
  systemThemeQuery.removeEventListener("change", onSystemThemeChanged);
  managerEvents?.close();
  managerEvents = null;
  void disposeWebPluginModules();
});

/** Show the last chosen role on non-role pages without loading its editable configuration. */
async function restoreSidebarRole(): Promise<void> {
  try {
    const saved = roles.selectedRoleId ? null : (await desktopSettingsClient.read()).lastRoleSelection;
    if (saved?.roleId && !roles.selectedRoleId && !showRoleSwitcher.value) {
      roles.sourceDeviceId = saved.sourceDeviceId || "";
      roles.selectedRoleId = saved.roleId;
    }
    await roles.loadCatalog();
  } catch {
    // The switcher keeps its neutral label; role pages report their own read failures.
  }
}

async function refresh(): Promise<void> {
  if (isPluginManagementPage.value) await Promise.all([refreshManagementMetadata(), pluginCatalogStore.refresh()]);
  else await Promise.all([store.load(), roles.loadCatalog(), pluginCatalogStore.refresh()]);
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
    <v-navigation-drawer v-if="!embeddedPlanView" v-model="drawer" width="264" class="app-sidebar">
      <div class="sidebar-brand">
        <img :src="brandIconUrl" alt="" />
        <span class="sidebar-brand-name">RabiRoute</span>
        <div v-if="store.meta.version" class="sidebar-brand-version" data-no-i18n>v{{ store.meta.version }}</div>
      </div>

      <div class="sidebar-context">
        <RoleSourcePicker @select="selectRole" />
        <v-select
          v-if="showRouteSwitcher && !showRoleSwitcher"
          class="context-route-picker mt-2"
          :model-value="store.selectedGatewayId"
          :items="routeOptions"
          aria-label="选择路由"
          density="compact"
          hide-details
          prepend-inner-icon="mdi-source-branch"
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

      <nav class="sidebar-scroll" :aria-label="t('导航')">
        <div v-if="navItems.length" class="sidebar-group">
          <div class="sidebar-group-label">{{ t("当前角色") }}</div>
          <router-link v-for="item in navItems" :key="item.key" :to="item.to" class="sidebar-link" active-class="is-active">
            <v-icon :icon="item.icon" />
            <span class="sidebar-link-label">{{ item.title }}</span>
          </router-link>
        </div>
        <div class="sidebar-group">
          <template v-for="item in utilityNavItems" :key="item.key">
            <div v-if="item.key === utilityNavItems[0]?.key && item.order < SYSTEM_NAVIGATION_ORDER" class="sidebar-group-label">{{ t("本机服务") }}</div>
            <div v-if="item.key === firstSystemNavKey" class="sidebar-group-label" :class="{ 'mt-3': item.key !== utilityNavItems[0]?.key }">{{ t("系统") }}</div>
            <router-link :to="item.to" class="sidebar-link" active-class="is-active">
              <v-icon :icon="item.icon" />
              <span class="sidebar-link-label">{{ item.title }}</span>
            </router-link>
          </template>
          <router-link to="/plugins" class="sidebar-link" active-class="is-active">
            <v-icon icon="mdi-puzzle-outline" />
            <span class="sidebar-link-label">{{ t("插件") }}</span>
          </router-link>
        </div>
      </nav>

      <div class="sidebar-footer">
        <v-btn
          v-for="command in sidebarPrimaryCommands"
          :key="command.key"
          block
          class="sidebar-footer-btn"
          variant="tonal"
          :color="command.appearance === 'primary' ? 'secondary' : undefined"
          :prepend-icon="command.icon"
          :loading="commandState(command).loading"
          :disabled="commandState(command).enabled === false"
          @click="executeCommand(command)"
        >
          {{ t(command.label) }}
        </v-btn>
        <div class="sidebar-status" role="status">
          <span class="connection-dot" :class="{ 'is-online': managerConnected }" aria-hidden="true" />
          <span class="sidebar-status-text">{{ t(managerConnected ? "服务已连接" : "服务未连接") }}</span>
          <div class="sidebar-tools">
            <LocaleSwitcher />
            <v-btn
              v-for="item in footerNavItems"
              :key="item.key"
              :to="item.to"
              :icon="item.icon"
              :aria-label="item.title"
              :title="item.title"
              size="small"
              variant="text"
            />
            <v-btn
              v-for="command in sidebarCommands"
              :key="command.key"
              :icon="command.icon"
              :aria-label="t(command.label)"
              :title="t(command.label)"
              :loading="commandState(command).loading"
              :disabled="commandState(command).enabled === false"
              size="small"
              variant="text"
              @click="executeCommand(command)"
            />
            <v-btn icon="mdi-github" aria-label="GitHub" title="GitHub" :href="store.meta.githubUrl" target="_blank" size="small" variant="text" />
          </div>
        </div>
      </div>
    </v-navigation-drawer>

    <v-main class="shell-main" :style="{ '--rr-content-height': `calc(100dvh - ${embeddedPlanView ? 0 : pageHeaderHeight}px)` }" :class="{ 'navigation-collapsed': !drawer, 'is-embedded': embeddedPlanView }">
    <header v-if="!embeddedPlanView" ref="pageHeader" class="page-bar">
      <v-btn icon="mdi-menu" variant="text" :aria-label="t('导航')" :aria-expanded="drawer" @click="drawer = !drawer" />
      <div class="page-bar-heading">
        <div v-if="pageContext" class="page-bar-context" data-no-i18n>{{ pageContext }}</div>
        <Transition name="page-bar-title" mode="out-in">
          <h1 :key="pageTitle" class="page-bar-title">{{ pageTitle }}</h1>
        </Transition>
      </div>
      <div id="page-topbar-controls" class="topbar-page-controls" />
      <div class="page-bar-actions">
        <Transition name="save-status">
          <span v-if="saveStatus" :key="saveStatus.state" class="save-status" :data-state="saveStatus.state" role="status" :title="t(saveStatus.label)">
            <span class="save-status-dot" aria-hidden="true" />
            <span class="save-status-label">{{ t(saveStatus.label) }}</span>
          </span>
        </Transition>
        <v-btn icon="mdi-refresh" variant="text" :loading="store.loading" aria-label="刷新状态" :title="t('刷新状态')" @click="refresh" />
        <template v-for="command in pageCommands" :key="command.key">
          <v-btn
            class="desktop-action"
            :class="{ 'save-command': command.handlerId === 'web.save-page', 'is-dirty': command.handlerId === 'web.save-page' && hasUnsavedChanges }"
            :color="command.appearance === 'primary' ? 'secondary' : undefined"
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
            :color="command.appearance === 'primary' ? 'secondary' : undefined"
            :icon="command.icon"
            :variant="command.appearance === 'primary' ? 'flat' : 'tonal'"
            :loading="commandState(command).loading"
            :disabled="commandState(command).enabled === false"
            :aria-label="t(command.label)"
            @click="executeCommand(command)"
          />
        </template>
      </div>
    </header>
      <v-alert v-if="pluginCatalogStore.lastRefreshError.value || pluginCatalogStore.partial.value" type="warning" variant="tonal" class="ma-4" role="status">
        <div v-if="pluginCatalogStore.lastRefreshError.value">{{ t(pluginCatalogStore.lastRefreshError.value) }}</div>
        <div v-if="pluginCatalogStore.partial.value">{{ t("部分插件目录项暂不可用，其余功能可继续使用。") }}</div>
        <details v-if="pluginCatalogDiagnosticLabels.length">
          <summary>{{ t("查看详情") }}</summary>
          <div v-for="(label, index) in pluginCatalogDiagnosticLabels" :key="index" data-no-i18n>{{ label }}</div>
        </details>
      </v-alert>
      <v-alert v-if="store.error && !isPluginManagementPage" type="error" variant="tonal" class="ma-4">{{ store.error }}</v-alert>
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
    <v-alert v-if="dataUpgradeView.error && !dataUpgradeView.open" type="warning" variant="tonal" class="ma-4" closable @click:close="dataUpgradeView.error = ''">{{ t(dataUpgradeView.error) }}</v-alert>
    <DataUpgradeDialog :view="dataUpgradeView" @close="dataUpgradeController.close" @confirm="dataUpgradeController.confirm" />
    <RoleManagementActions ref="roleCreation" create-only />
    <v-snackbar class="app-toast" :model-value="!!snackbar" timeout="2200" location="bottom" @update:model-value="value => { if (!value) snackbar = '' }">
      <v-icon icon="mdi-check-circle-outline" size="18" />{{ t(snackbar) }}
    </v-snackbar>
  </v-app>
</template>
