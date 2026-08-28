<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import type { DesktopTheme } from "@shared/desktopSettingsContract";
import { useTheme } from "vuetify";
import { useRoute, useRouter } from "vue-router";
import LocaleSwitcher from "./components/LocaleSwitcher.vue";
import QuickSetupDialog from "./components/QuickSetupDialog.vue";
import { useI18n } from "./i18n";
import { routeScopedPathForCurrentPage } from "./routeScopedNavigation";
import { pluginCatalogStore } from "./pluginCatalogStore";
import { buildWebNavigation } from "./pluginNavigation";
import { gatewayPersonaDisplayName } from "./personaPresentation";
import { useGatewayStore } from "./stores/gatewayStore";
import { configNameFor } from "./utils/gatewayHelpers";
import { pageSaveAction } from "./pageSaveAction";
import { desktopSettingsClient } from "./desktopSettingsClient";
import { applyCatalogInterfaceTheme, INTERFACE_THEME_CHANGED } from "./interfaceTheme";
import { initialWebThemePreference, readStoredWebThemePreference, resolveWebThemeResource, type WebThemeId } from "./pluginThemes";
import { isWebPageRouteActive, webPageDataRequirements } from "./pluginPages";
import { PLUGIN_RECOVERY_ROUTE_NAME } from "./router";
import { managerEventSource } from "./managerApi";
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
  const resolved = applyCatalogInterfaceTheme(pluginCatalogStore.themes.value, interfaceThemePreference.value, systemThemeQuery.matches);
  vuetifyTheme.global.name.value = resolved === "dark" ? "RabiDark" : "RabiLight";
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
  let desktopTheme: DesktopTheme = "system";
  try {
    desktopTheme = (await desktopSettingsClient.read()).theme;
  } catch {
    desktopTheme = "system";
  }
  interfaceThemePreference.value = initialWebThemePreference(readStoredWebThemePreference(), desktopTheme);
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
const selectedRouteKey = computed(() => store.selectedGateway ? configNameFor(store.selectedGateway) : "");
const navigationGroups = computed(() => buildWebNavigation(pluginCatalogStore.contributions.value, selectedRouteKey.value));
const navItems = computed(() => navigationGroups.value.routePrimary.map(item => ({ ...item, title: t(item.title) })));
const utilityNavItems = computed(() => navigationGroups.value.utility.map(item => ({ ...item, title: t(item.title) })));
const footerNavItems = computed(() => navigationGroups.value.footer.map(item => ({ ...item, title: t(item.title) })));
const sidebarPrimaryCommands = computed(() => webCommandsInSlot(pluginCatalogStore.commands.value, "sidebar-footer-primary"));
const sidebarCommands = computed(() => webCommandsInSlot(pluginCatalogStore.commands.value, "sidebar-footer"));
const topbarCommands = computed(() => webCommandsInSlot(pluginCatalogStore.commands.value, "topbar-primary"));
const managerConnected = computed(() => !store.managerError);
const activePageSaveAction = computed(() => pageSaveAction.value);
const hasUnsavedChanges = computed(() => store.dirty || activePageSaveAction.value?.dirty.value === true);
const pageTitle = computed(() => t(String(route.meta.title || "RibiWebGUI")));
const routeOptions = computed(() => store.gateways.map(gateway => {
  const runtime = store.runtimeFor(gateway.id);
  const title = gatewayPersonaDisplayName(gateway, runtime.roleInfo);
  return { title, value: gateway.id };
}));
const selectedGatewayName = computed(() => store.selectedGateway ? store.configNameFor(store.selectedGateway) : "未选择路由");

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
  await store.save();
}

function commandContext(): WebCommandContext {
  return {
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
  await command.execute(commandContext());
}

async function loadGatewayEditorInBackground(): Promise<void> {
  await store.load();
  if (store.gateways.length === 0) {
    const quickSetup = webCommandForHandler(pluginCatalogStore.commands.value, "web.quick-setup");
    if (quickSetup) await executeCommand(quickSetup);
  } else if (selectedRouteKey.value) {
    const scopedPath = routeScopedPathForCurrentPage(selectedRouteKey.value, route.path);
    if (scopedPath && scopedPath !== route.path) await router.replace(scopedPath);
  }
  void ensurePageDiagnostics();
}

onMounted(() => {
  void loadInterfaceTheme();
  void store.loadRouteSummaries().then(() => loadGatewayEditorInBackground());
  window.addEventListener("beforeunload", beforeUnload);
  window.addEventListener(INTERFACE_THEME_CHANGED, onInterfaceThemeChanged);
  systemThemeQuery.addEventListener("change", onSystemThemeChanged);
  managerEvents = managerEventSource("/api/events");
  managerEvents.addEventListener("plugin_catalog_changed", () => { void handlePluginCatalogChanged(); });
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
  window.removeEventListener("beforeunload", beforeUnload);
  window.removeEventListener(INTERFACE_THEME_CHANGED, onInterfaceThemeChanged);
  systemThemeQuery.removeEventListener("change", onSystemThemeChanged);
  managerEvents?.close();
  managerEvents = null;
  void disposeWebPluginModules();
});

async function refresh(): Promise<void> {
  await Promise.all([store.load(), pluginCatalogStore.refresh()]);
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
  store.selectGateway(id);
  const gateway = store.gateways.find(candidate => candidate.id === id);
  const name = gateway ? configNameFor(gateway) : id;
  const scopedPath = routeScopedPathForCurrentPage(name, route.path);
  if (scopedPath && scopedPath !== route.path) void router.replace(scopedPath);
}
</script>

<template>
  <v-app>
    <v-navigation-drawer v-model="drawer" width="276" class="left-sidebar">
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
        <v-card class="route-picker mb-3" variant="flat">
          <v-card-text class="pa-3">
            <v-select
              :model-value="store.selectedGatewayId"
              :items="routeOptions"
              aria-label="选择航线"
              hide-details
              @update:model-value="value => selectGateway(String(value || ''))"
            >
              <template #item="{ props: itemProps, item }">
                <v-list-item v-bind="itemProps" />
              </template>
              <template #selection="{ item }">
                <span class="text-truncate">{{ item.raw.title }}</span>
              </template>
            </v-select>
          </v-card-text>
        </v-card>

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

    <v-app-bar flat class="top-app-bar px-2">
      <v-app-bar-nav-icon @click="drawer = !drawer" />
      <v-toolbar-title class="topbar-title">
        <div class="font-weight-bold">{{ pageTitle }}</div>
        <div class="topbar-subtitle">{{ selectedGatewayName }}</div>
      </v-toolbar-title>
      <v-spacer />
      <div class="topbar-actions">
        <span v-if="hasUnsavedChanges" class="dirty-hint">有未保存的修改</span>
        <LocaleSwitcher />
        <v-chip class="manager-chip" :color="managerConnected ? 'success' : 'error'" variant="tonal" size="small">
          <v-icon start size="14">mdi-circle</v-icon>
          <span class="manager-chip-text">Manager {{ managerConnected ? "已连接" : "未连接" }}</span>
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

    <v-main>
      <v-alert v-if="store.error" type="error" variant="tonal" class="ma-4">{{ store.error }}</v-alert>
      <router-view />
    </v-main>

    <QuickSetupDialog v-model="store.quickSetupDialogOpen" />
    <v-snackbar :model-value="!!snackbar" timeout="1800" @update:model-value="value => { if (!value) snackbar = '' }">
      {{ snackbar }}
    </v-snackbar>
  </v-app>
</template>
