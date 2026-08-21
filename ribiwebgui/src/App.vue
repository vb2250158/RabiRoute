<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { useTheme } from "vuetify";
import { useRoute, useRouter } from "vue-router";
import LocaleSwitcher from "./components/LocaleSwitcher.vue";
import QuickSetupDialog from "./components/QuickSetupDialog.vue";
import { useI18n } from "./i18n";
import {
  routeScopedAdaptersPath,
  routeScopedKnowledgePath,
  routeScopedOverviewPath,
  routeScopedPathForCurrentPage,
  routeScopedPersonaPath,
  routeScopedRuntimePath,
  routeScopedSpeechPath
} from "./routeScopedNavigation";
import { gatewayPersonaDisplayName } from "./personaPresentation";
import { useGatewayStore } from "./stores/gatewayStore";
import { configNameFor } from "./utils/gatewayHelpers";
import { pageSaveAction } from "./pageSaveAction";
import { desktopSettingsClient } from "./desktopSettingsClient";
import { applyInterfaceTheme, INTERFACE_THEME_CHANGED } from "./interfaceTheme";
import type { DesktopTheme } from "@shared/desktopSettingsContract";

const store = useGatewayStore();
const route = useRoute();
const router = useRouter();
const { t } = useI18n();
const vuetifyTheme = useTheme();
const interfaceThemePreference = ref<DesktopTheme>("system");
const systemThemeQuery = window.matchMedia("(prefers-color-scheme: dark)");

function refreshInterfaceTheme(): void {
  const resolved = applyInterfaceTheme(interfaceThemePreference.value, systemThemeQuery.matches);
  vuetifyTheme.global.name.value = resolved === "dark" ? "RabiDark" : "RabiLight";
}

function onSystemThemeChanged(): void {
  if (interfaceThemePreference.value === "system") refreshInterfaceTheme();
}

function onInterfaceThemeChanged(event: Event): void {
  const preference = (event as CustomEvent<DesktopTheme>).detail;
  if (preference !== "system" && preference !== "light" && preference !== "dark") return;
  interfaceThemePreference.value = preference;
  refreshInterfaceTheme();
}

async function loadInterfaceTheme(): Promise<void> {
  try {
    interfaceThemePreference.value = (await desktopSettingsClient.read()).theme;
  } catch {
    interfaceThemePreference.value = "system";
  }
  refreshInterfaceTheme();
}
const DRAWER_PREFERENCES_KEY = "rabiroute:webgui:drawer-preferences";

type DrawerPreferences = {
  default: boolean;
  docs: boolean;
};

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

function pageNeedsGatewayDiagnostics(path: string): boolean {
  return path === "/overview"
    || path === "/routes"
    || path === "/runtime"
    || /^\/routes\/[^/]+\/(?:overview|adapters|runtime)$/.test(path);
}

function ensurePageDiagnostics(path: string, force = false): Promise<void> {
  return pageNeedsGatewayDiagnostics(path) ? store.ensureDiagnostics(force) : Promise.resolve();
}

const drawerPreferences = readDrawerPreferences();
const drawer = ref(route.path === "/docs" ? drawerPreferences.docs : drawerPreferences.default);
const snackbar = ref("");

const selectedRouteKey = computed(() => store.selectedGateway ? configNameFor(store.selectedGateway) : "");
const navItems = computed(() => [
  { title: "控制台", icon: "mdi-view-dashboard-outline", to: routeScopedOverviewPath(selectedRouteKey.value) },
  { title: "消息适配器", icon: "mdi-puzzle-outline", to: routeScopedAdaptersPath(selectedRouteKey.value) },
  { title: "人格配置", icon: "mdi-account-heart-outline", to: routeScopedPersonaPath(selectedRouteKey.value) },
  { title: "计划与记忆", icon: "mdi-notebook-check-outline", to: routeScopedKnowledgePath(selectedRouteKey.value) }
].map(item => ({ ...item, title: t(item.title) })));
const utilityNavItems = computed(() => [
  { title: "语音服务", icon: "mdi-waveform", to: routeScopedSpeechPath(selectedRouteKey.value) },
  { title: "性能监控", icon: "mdi-chart-timeline-variant", to: "/performance" },
  { title: "日志诊断", icon: "mdi-console-line", to: routeScopedRuntimePath(selectedRouteKey.value) },
  { title: "设置", icon: "mdi-cog-outline", to: "/settings" }
].map(item => ({ ...item, title: t(item.title) })));

const managerConnected = computed(() => !store.managerError);
const activePageSaveAction = computed(() => pageSaveAction.value);
const saveBusy = computed(() => store.saving || activePageSaveAction.value?.saving.value === true);
const saveDisabled = computed(() => activePageSaveAction.value != null && !activePageSaveAction.value.ready.value);
const hasUnsavedChanges = computed(() => store.dirty || activePageSaveAction.value?.dirty.value === true);
const pageTitle = computed(() => t(String(route.meta.title || "RibiWebGUI")));
const routeOptions = computed(() => store.gateways.map(gateway => {
  const runtime = store.runtimeFor(gateway.id);
  const title = gatewayPersonaDisplayName(gateway, runtime.roleInfo);
  return { title, value: gateway.id };
}));
const selectedGatewayName = computed(() => store.selectedGateway
  ? store.configNameFor(store.selectedGateway)
  : "未选择路由");

onMounted(async () => {
  await loadInterfaceTheme();
  await store.load();
  if (store.gateways.length === 0) store.openQuickSetup();
  else if (selectedRouteKey.value) {
    const scopedPath = routeScopedPathForCurrentPage(selectedRouteKey.value, route.path);
    if (scopedPath && scopedPath !== route.path) await router.replace(scopedPath);
  }
  void ensurePageDiagnostics(route.path);
  window.addEventListener("beforeunload", beforeUnload);
  window.addEventListener(INTERFACE_THEME_CHANGED, onInterfaceThemeChanged);
  systemThemeQuery.addEventListener("change", onSystemThemeChanged);
});

watch(
  () => route.path,
  (path) => {
    void ensurePageDiagnostics(path);
    if (path === "/docs") {
      drawer.value = false;
      return;
    }
    drawer.value = drawerPreferences.default;
  }
);

watch(drawer, (value) => {
  if (route.path === "/docs") drawerPreferences.docs = value;
  else drawerPreferences.default = value;
  writeDrawerPreferences(drawerPreferences);
});

onBeforeUnmount(() => {
  window.removeEventListener("beforeunload", beforeUnload);
  window.removeEventListener(INTERFACE_THEME_CHANGED, onInterfaceThemeChanged);
  systemThemeQuery.removeEventListener("change", onSystemThemeChanged);
});

async function save() {
  if (activePageSaveAction.value) {
    if (!activePageSaveAction.value.ready.value) return;
    await activePageSaveAction.value.save();
    snackbar.value = "配置已保存";
    return;
  }
  await store.save();
  snackbar.value = "配置已保存";
}

async function refresh() {
  await store.load();
  await ensurePageDiagnostics(route.path, true);
  snackbar.value = "状态已刷新";
}

function beforeUnload(event: BeforeUnloadEvent) {
  if (!hasUnsavedChanges.value) return;
  event.preventDefault();
  event.returnValue = "";
}

function canLeaveDirtyState(): boolean {
  return !hasUnsavedChanges.value || window.confirm(t("当前配置有未保存修改。确定要切换吗？"));
}

function selectGateway(id: string) {
  if (!canLeaveDirtyState()) return;
  store.selectGateway(id);
  // Route 相关页面始终把左侧当前 Route 同步进 URL。
  const gw = store.gateways.find(g => g.id === id);
  const name = gw ? configNameFor(gw) : id;
  const scopedPath = routeScopedPathForCurrentPage(name, route.path);
  if (scopedPath && scopedPath !== route.path) router.replace(scopedPath);
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
            :key="item.to"
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
            :key="item.to"
            :to="item.to"
            :prepend-icon="item.icon"
            :title="item.title"
            rounded="lg"
          />
        </v-list>
      </div>

      <template #append>
        <div class="sidebar-footer">
          <v-btn block class="sidebar-footer-btn" variant="tonal" color="primary" prepend-icon="mdi-lightning-bolt-outline" @click="store.openQuickSetup">
            快速配置
          </v-btn>
          <v-btn block class="sidebar-footer-btn" variant="text" prepend-icon="mdi-github" :href="store.meta.githubUrl" target="_blank">
            GitHub
          </v-btn>
          <v-btn block class="sidebar-footer-btn" variant="text" prepend-icon="mdi-book-open-page-variant-outline" to="/docs">
            使用手册
          </v-btn>
          <v-btn block class="sidebar-footer-btn" variant="text" prepend-icon="mdi-folder-cog-outline" @click="store.openConfigFile('manager')">
            打开配置目录
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
        <v-btn class="desktop-action" prepend-icon="mdi-plus" variant="tonal" @click="store.addGatewayAndOpenQuickSetup">新增航线</v-btn>
        <v-btn class="mobile-action" icon="mdi-plus" variant="tonal" aria-label="新增航线" @click="store.addGatewayAndOpenQuickSetup" />
        <v-btn class="desktop-action" color="primary" prepend-icon="mdi-content-save" :loading="saveBusy" :disabled="saveDisabled" @click="save">
          保存配置
        </v-btn>
        <v-btn class="mobile-action" color="primary" icon="mdi-content-save" :loading="saveBusy" :disabled="saveDisabled" aria-label="保存配置" @click="save" />
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
