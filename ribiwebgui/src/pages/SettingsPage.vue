<script setup lang="ts">
import ResourceCacheSettings from "../components/ResourceCacheSettings.vue";
import { userFacingError } from "../userFacingError";
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { useGatewayStore } from "../stores/gatewayStore";
import { routeScopedKnowledgeUrl, routeScopedOverviewUrl } from "../routeScopedNavigation";
import { configNameFor } from "../utils/gatewayHelpers";
import { redirectCurrentWebguiToLan } from "../webguiLanRedirect";
import { copyTextToClipboard } from "../clipboard";
import { registerPageSaveAction } from "../pageSaveAction";
import { pluginCatalogStore } from "../pluginCatalogStore";
import TrustedWebRendererHost from "../components/TrustedWebRendererHost.vue";
import { webRenderersAt } from "../pluginRenderers";

const store = useGatewayStore();
const settingsRenderers = computed(() => webRenderersAt(pluginCatalogStore.settingsRenderers.value, "global.settings.sections"));

const routeDir = ref("");
const rolesDir = ref("");
const dirSaving = ref(false);
const dirError = ref("");
const settingsDirty = ref(false);
const settingsSaving = ref(false);
const settingsHydrating = ref(true);
const settingsReady = computed(() => !settingsHydrating.value);
type WebguiLanUrl = { name?: string; address: string; cidr?: string; url: string };
type WebguiLanAccess = {
  enabled: boolean;
  tokenConfigured: boolean;
  token: string;
  canManage: boolean;
  managerHost: string;
  managerPort: number;
  listeningOnLan: boolean;
  restartRequired: boolean;
  hostManagedByEnvironment: boolean;
  urls: WebguiLanUrl[];
};
const webguiLanAccess = ref<WebguiLanAccess>({
  enabled: false,
  tokenConfigured: false,
  token: "",
  canManage: true,
  managerHost: "127.0.0.1",
  managerPort: 0,
  listeningOnLan: false,
  restartRequired: false,
  hostManagedByEnvironment: false,
  urls: []
});
const webguiLanSaving = ref(false);
const webguiLanError = ref("");
const webguiLanNotice = ref("");

async function loadDirConfig() {
  try {
    const res = await fetch("/manager-config");
    const data = await res.json();
    routeDir.value = data.routeDir ?? "";
    rolesDir.value = data.rolesDir ?? "";
  } catch { /* ignore */ }
  await loadWebguiLanAccess();
  await nextTick();
  settingsHydrating.value = false;
}

async function loadWebguiLanAccess(): Promise<void> {
  try {
    const response = await fetch("/api/webgui-access");
    const body = await response.json();
    if (!response.ok || body.code !== 0 || !body.data) throw new Error(body.message || "读取局域网 WebGUI 配置失败");
    webguiLanAccess.value = body.data as WebguiLanAccess;
    webguiLanError.value = "";
  } catch (error) {
    webguiLanError.value = userFacingError(error);
  }
}

async function updateWebguiLanAccess(
  patch: { enabled?: boolean; regenerateToken?: boolean },
  redirectCurrent = true
): Promise<void> {
  if (webguiLanSaving.value || !webguiLanAccess.value.canManage) throw new Error("局域网 WebGUI 配置当前无法保存。");
  webguiLanSaving.value = true;
  webguiLanError.value = "";
  webguiLanNotice.value = "";
  try {
    const response = await fetch("/api/webgui-access", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(patch)
    });
    const body = await response.json();
    if (!response.ok || body.code !== 0 || !body.data) throw new Error(body.message || "保存局域网 WebGUI 配置失败");
    webguiLanAccess.value = body.data as WebguiLanAccess;
    if (redirectCurrent && redirectCurrentWebguiToLan(webguiLanAccess.value)) return;
    webguiLanNotice.value = webguiLanAccess.value.restartRequired
      ? "配置已保存；重启 Manager 后监听范围才会改变。"
      : "局域网 WebGUI 配置已更新。";
  } catch (error) {
    webguiLanError.value = userFacingError(error);
    throw error;
  } finally {
    webguiLanSaving.value = false;
  }
}

function toggleWebguiLanAccess(enabled: boolean | null): void {
  if (typeof enabled !== "boolean") return;
  webguiLanAccess.value = { ...webguiLanAccess.value, enabled };
}

async function regenerateWebguiLanToken(): Promise<void> {
  if (webguiLanAccess.value.tokenConfigured && !window.confirm("轮换访问密钥会立即使旧链接失效。确定继续吗？")) return;
  try {
    await updateWebguiLanAccess({ regenerateToken: true });
  } catch {
    // The card shows the actionable error.
  }
}

const primaryWebguiLanUrl = computed(() => webguiLanAccess.value.urls[0]?.url || "");
const selectedRouteOverviewLanUrl = computed(() => {
  const gateway = store.selectedGateway;
  return gateway
    ? routeScopedOverviewUrl(primaryWebguiLanUrl.value, configNameFor(gateway))
    : primaryWebguiLanUrl.value;
});
const selectedRouteKnowledgeLanUrl = computed(() => {
  const gateway = store.selectedGateway;
  return gateway
    ? routeScopedKnowledgeUrl(primaryWebguiLanUrl.value, configNameFor(gateway))
    : "";
});
const webguiLanStatusText = computed(() => {
  const access = webguiLanAccess.value;
  if (access.hostManagedByEnvironment) return `监听地址由 GATEWAY_MANAGER_HOST=${access.managerHost} 管理。`;
  if (access.restartRequired) return access.enabled
    ? "已允许局域网访问；重启 Manager 后开始监听局域网。"
    : "已关闭局域网访问；重启 Manager 后恢复为仅本机监听。";
  if (access.listeningOnLan) return "Manager 正在监听局域网；非本机请求必须携带访问密钥。";
  return "Manager 当前只监听本机回环地址，局域网设备无法连接。";
});

async function copyWebguiLanText(value: string, successMessage: string): Promise<void> {
  if (!value) {
    webguiLanError.value = "当前没有可复制的局域网地址。";
    return;
  }
  try {
    await copyTextToClipboard(value);
    webguiLanNotice.value = successMessage;
    webguiLanError.value = "";
  } catch (error) {
    webguiLanError.value = `复制失败：${userFacingError(error)}`;
  }
}

async function saveDirConfig(): Promise<void> {
  dirSaving.value = true;
  dirError.value = "";
  try {
    const res = await fetch("/manager-config", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ routeDir: routeDir.value || undefined, rolesDir: rolesDir.value || undefined })
    });
    const data = await res.json();
    if (data.code !== 0) throw new Error(data.message || "保存失败");
    routeDir.value = data.routeDir ?? "";
    rolesDir.value = data.rolesDir ?? "";
  } catch (e) {
    dirError.value = userFacingError(e);
    throw e;
  } finally {
    dirSaving.value = false;
  }
}

const trackedSettingValues = [
  routeDir,
  rolesDir,
  () => webguiLanAccess.value.enabled
];

watch(trackedSettingValues, () => {
  if (!settingsHydrating.value) settingsDirty.value = true;
});


async function saveSettings(): Promise<void> {
  if (!settingsReady.value || settingsSaving.value) return;
  settingsSaving.value = true;
  settingsHydrating.value = true;
  try {
    const results = await Promise.allSettled([
      saveDirConfig(),
      webguiLanAccess.value.canManage && !webguiLanAccess.value.hostManagedByEnvironment
        ? updateWebguiLanAccess({ enabled: webguiLanAccess.value.enabled }, false)
        : Promise.resolve()
    ]);
    const failures = results
      .filter((result): result is PromiseRejectedResult => result.status === "rejected")
      .map(result => result.reason instanceof Error ? result.reason.message : String(result.reason));
    if (failures.length) throw new Error(failures.join("；"));
    await nextTick();
    settingsDirty.value = false;
    redirectCurrentWebguiToLan(webguiLanAccess.value);
  } finally {
    settingsSaving.value = false;
    settingsHydrating.value = false;
  }
}

let unregisterPageSaveAction: (() => void) | undefined;

onMounted(async () => {
  unregisterPageSaveAction = registerPageSaveAction({
    dirty: settingsDirty,
    ready: settingsReady,
    saving: settingsSaving,
    save: saveSettings
  });
  await loadDirConfig();
});
onBeforeUnmount(() => {
  unregisterPageSaveAction?.();
});
</script>

<template>
  <div class="page-shell">
    <div class="page-header">
      <div>
        <div class="eyebrow">RABIROUTE</div>
        <h1 class="page-title">设置</h1>
        <div class="page-subtitle">管理界面、目录和局域网访问。RabiLink 连接与实例身份请前往 RabiLink 配置。</div>
      </div>
    </div>

    <div class="two-column">
      <TrustedWebRendererHost :renderers="settingsRenderers" />
      <ResourceCacheSettings />

      <v-card class="app-card glass-card section-card">
        <div class="section-title-row">
          <div>
            <div class="section-title">目录配置</div>
            <div class="section-note">全局目录设置，影响所有路由。修改后重启 Manager 生效。</div>
          </div>
        </div>
        <v-alert v-if="dirError" type="error" variant="tonal" density="compact" class="mb-3">{{ dirError }}</v-alert>
        <div class="form-grid">
          <v-text-field v-model="routeDir" label="路由数据目录" placeholder="data/route" density="compact" hide-details />
          <v-text-field v-model="rolesDir" label="角色目录" placeholder="data/roles" density="compact" hide-details />
        </div>
        <v-divider class="my-4" />
        <div class="section-title-row compact-row mb-2">
          <div>
            <div class="section-title small-title">局域网访问 WebGUI</div>
            <div class="section-note">让同一局域网中的手机或电脑直接访问这台 Rabi PC；访问密钥由 Manager 统一校验。</div>
          </div>
          <v-switch
            :model-value="webguiLanAccess.enabled"
            label="允许局域网访问"
            color="success"
            density="compact"
            inset
            hide-details
            :loading="webguiLanSaving"
            :disabled="webguiLanSaving || !webguiLanAccess.canManage || webguiLanAccess.hostManagedByEnvironment"
            @update:model-value="toggleWebguiLanAccess"
          />
        </div>
        <v-alert v-if="webguiLanError" type="error" variant="tonal" density="compact" class="mb-3">{{ webguiLanError }}</v-alert>
        <v-alert v-if="webguiLanNotice" type="success" variant="tonal" density="compact" class="mb-3">{{ webguiLanNotice }}</v-alert>
        <v-alert
          :type="webguiLanAccess.restartRequired ? 'warning' : webguiLanAccess.listeningOnLan ? 'success' : 'info'"
          variant="tonal"
          density="compact"
          class="mb-3"
        >
          {{ webguiLanStatusText }}
        </v-alert>
        <v-alert v-if="!webguiLanAccess.canManage" type="info" variant="tonal" density="compact" class="mb-3">
          开关和密钥只能在运行 Manager 的 Rabi PC 本机管理。
        </v-alert>
        <div class="form-grid">
          <v-text-field
            :model-value="webguiLanAccess.token"
            label="WebGUI 局域网访问密钥"
            :placeholder="webguiLanAccess.tokenConfigured ? '已配置；仅本机显示明文' : '点击生成访问密钥'"
            type="password"
            density="compact"
            readonly
            hide-details
          />
          <v-text-field
            :model-value="selectedRouteOverviewLanUrl"
            :label="store.selectedGateway ? `当前 Route 控制台链接 · ${configNameFor(store.selectedGateway)}` : '局域网访问链接'"
            placeholder="启用并生成密钥后显示"
            density="compact"
            readonly
            hide-details
          />
          <v-text-field
            :model-value="selectedRouteKnowledgeLanUrl"
            :label="store.selectedGateway ? `当前 Route 知识库链接 · ${configNameFor(store.selectedGateway)}` : '当前 Route 知识库链接'"
            placeholder="请先选择 Route"
            density="compact"
            readonly
            hide-details
          />
        </div>
        <div class="hero-actions mt-3">
          <v-btn
            prepend-icon="mdi-key-plus"
            variant="tonal"
            color="primary"
            :loading="webguiLanSaving"
            :disabled="!webguiLanAccess.canManage"
            @click="regenerateWebguiLanToken"
          >
            {{ webguiLanAccess.tokenConfigured ? "轮换访问密钥" : "生成访问密钥" }}
          </v-btn>
          <v-btn
            prepend-icon="mdi-link-variant"
            variant="tonal"
            :disabled="!selectedRouteOverviewLanUrl || !webguiLanAccess.token"
            @click="copyWebguiLanText(selectedRouteOverviewLanUrl, '已复制局域网访问链接')"
          >
            复制访问链接
          </v-btn>
          <v-btn
            prepend-icon="mdi-content-copy"
            variant="text"
            :disabled="!webguiLanAccess.token"
            @click="copyWebguiLanText(webguiLanAccess.token, '已复制 WebGUI 访问密钥')"
          >
            复制密钥
          </v-btn>
          <v-btn
            prepend-icon="mdi-notebook-check-outline"
            variant="tonal"
            :disabled="!selectedRouteKnowledgeLanUrl || !webguiLanAccess.token"
            @click="copyWebguiLanText(selectedRouteKnowledgeLanUrl, '已复制当前 Route 知识库链接')"
          >
            复制 Route 知识库链接
          </v-btn>
        </div>
        <div class="section-note mt-3">
          其他设备必须使用这台 Rabi PC 的局域网 IP，不能使用 127.0.0.1。若重启后仍无法连接，请确认 RabiRouteHost.exe 正在运行，并按 Host READY 当前发布的动态 Manager 地址检查 Windows 防火墙。
        </div>
      </v-card>
    </div>
  </div>
</template>
