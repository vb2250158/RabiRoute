<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { useGatewayStore } from "../stores/gatewayStore";
import { managerEventSource } from "../managerApi";
import { routeScopedKnowledgeUrl, routeScopedOverviewUrl } from "../routeScopedNavigation";
import { configNameFor } from "../utils/gatewayHelpers";
import { redirectCurrentWebguiToLan } from "../webguiLanRedirect";
import { copyTextToClipboard } from "../clipboard";
import { desktopSettingsClient } from "../desktopSettingsClient";
import { publishInterfaceTheme } from "../interfaceTheme";
import type { DesktopTheme } from "@shared/desktopSettingsContract";
import { resolveSelectionSpeechModel, type SelectionSpeechSettings } from "@shared/selectionSpeechContract";
import type { SpeechModel } from "@shared/speechControlContract";
import { speechControlClient } from "../speech/speechControlClient";
import { registerPageSaveAction } from "../pageSaveAction";
import { pluginCatalogStore } from "../pluginCatalogStore";
import { resolveWebThemeResource } from "../pluginThemes";

const store = useGatewayStore();
const desktopSettingsVisible = computed(() => pluginCatalogStore.visibility.value.desktopSettings);
const desktopThemeOptions = computed(() => pluginCatalogStore.themes.value.options);

const routeDir = ref("");
const rolesDir = ref("");
const dirSaving = ref(false);
const dirError = ref("");
const rabiName = ref("");
const rabiSaving = ref(false);
const rabiError = ref("");
const rabiLinkRelayEnabled = ref(false);
const rabiLinkRelayUrl = ref("");
const rabiLinkRelayAppToken = ref("");
const rabiLinkRelayTokenConfigured = ref(false);
const rabiLinkRelayDeviceId = ref("");
const rabiLinkRelayClaimWaitMs = ref(60000);
const rabiLinkRelayReplyIdleTimeoutMs = ref(60000);
const rabiLinkSpeechProxyEnabled = ref(false);
const rabiLinkSpeechServiceUrl = ref("http://127.0.0.1:8781");
const selectionSpeechEnabled = ref(false);
const selectionReadAloudEnabled = ref(true);
const selectionSpeechAdvanced = ref(false);
const selectionSpeechModel = ref("");
const selectionSpeechModels = ref<SpeechModel[]>([]);
const selectionSpeechLoaded = ref(false);
const selectionSpeechSaving = ref(false);
const desktopScreenshotEnabled = ref(false);
const desktopScreenshotShortcut = ref("Ctrl+Shift+S");
const desktopScreenshotShortcutCapturing = ref(false);
const desktopScreenshotClipboardShortcut = ref("F3");
const desktopScreenshotClipboardShortcutCapturing = ref(false);
const desktopScreenshotAutoCopy = ref(true);
const desktopAutostart = ref(false);
const desktopTheme = ref<DesktopTheme>("system");

const desktopSettingsLoaded = ref(false);
const desktopSettingsHydrating = ref(false);
const desktopSettingsSaving = ref(false);
const desktopSettingsError = ref("");
const settingsDirty = ref(false);
const settingsSaving = ref(false);
const settingsHydrating = ref(true);
const settingsReady = computed(() => (!desktopSettingsVisible.value || desktopSettingsLoaded.value) && selectionSpeechLoaded.value);
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
  managerPort: 8790,
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
  rabiName.value = store.meta.rabiName || store.meta.computerName || "";
  loadRabiLinkRelayForm();
  await Promise.all([
    loadWebguiLanAccess(),
    desktopSettingsVisible.value ? loadDesktopSettings() : Promise.resolve(),
    loadSelectionSpeechSettings()
  ]);
  await nextTick();
  settingsHydrating.value = false;
}

let desktopSettingsLoadPromise: Promise<void> | undefined;
async function loadDesktopSettings(): Promise<void> {
  if (desktopSettingsLoaded.value) return;
  if (desktopSettingsLoadPromise) return desktopSettingsLoadPromise;
  const current = (async () => {
    desktopSettingsHydrating.value = true;
    try {
      const settings = await desktopSettingsClient.read();
      desktopScreenshotEnabled.value = settings.screenshot.enabled;
      desktopScreenshotShortcut.value = settings.screenshot.shortcut;
      desktopScreenshotClipboardShortcut.value = settings.screenshot.clipboardShortcut;
      desktopScreenshotAutoCopy.value = settings.screenshot.autoCopy;
      desktopAutostart.value = settings.autostart;
      desktopTheme.value = resolveWebThemeResource(pluginCatalogStore.themes.value, settings.theme).theme;
      desktopSettingsLoaded.value = true;
      desktopSettingsError.value = "";
      await nextTick();
    } catch (error) {
      desktopSettingsError.value = error instanceof Error ? error.message : String(error);
    } finally {
      desktopSettingsHydrating.value = false;
    }
  })();
  desktopSettingsLoadPromise = current;
  try {
    await current;
  } finally {
    if (desktopSettingsLoadPromise === current) desktopSettingsLoadPromise = undefined;
  }
}

async function saveDesktopSettings(): Promise<void> {
  if (!desktopSettingsLoaded.value || desktopSettingsSaving.value) throw new Error("桌面设置尚未加载完成。");
  desktopSettingsSaving.value = true;
  desktopSettingsError.value = "";
  try {
    const settings = await desktopSettingsClient.update({
      screenshot: {
        enabled: desktopScreenshotEnabled.value,
        shortcut: desktopScreenshotShortcut.value,
        clipboardShortcut: desktopScreenshotClipboardShortcut.value,
        autoCopy: desktopScreenshotAutoCopy.value
      },
      autostart: desktopAutostart.value,
      theme: desktopTheme.value
    });
    desktopScreenshotEnabled.value = settings.screenshot.enabled;
    desktopScreenshotShortcut.value = settings.screenshot.shortcut;
    desktopScreenshotClipboardShortcut.value = settings.screenshot.clipboardShortcut;
    desktopScreenshotAutoCopy.value = settings.screenshot.autoCopy;
    desktopAutostart.value = settings.autostart;
    desktopTheme.value = resolveWebThemeResource(pluginCatalogStore.themes.value, settings.theme).theme;
    publishInterfaceTheme(desktopTheme.value);
  } catch (error) {
    desktopSettingsError.value = error instanceof Error ? error.message : String(error);
    throw error;
  } finally {
    desktopSettingsSaving.value = false;
  }
}

async function loadSelectionSpeechSettings(): Promise<void> {
  try {
    const [settings, modelPayload] = await Promise.all([
      speechControlClient.selectionReaderSettings(),
      speechControlClient.models()
    ]);
    selectionSpeechEnabled.value = settings.enabled;
    selectionReadAloudEnabled.value = settings.readAloudEnabled;
    selectionSpeechAdvanced.value = settings.advanced;
    selectionSpeechModel.value = settings.model;
    selectionSpeechModels.value = modelPayload.models || [];
    if (selectionSpeechAdvanced.value) {
      selectionSpeechModel.value = resolveSelectionSpeechModel(settings, selectionSpeechModels.value);
    }
    selectionSpeechLoaded.value = true;
  } catch (error) {
    desktopSettingsError.value = error instanceof Error ? error.message : String(error);
  }
}

async function saveSelectionSpeechSettings(): Promise<void> {
  if (!selectionSpeechLoaded.value || selectionSpeechSaving.value) throw new Error("滑词菜单设置尚未加载完成。");
  selectionSpeechSaving.value = true;
  try {
    const settings: SelectionSpeechSettings = {
      enabled: selectionSpeechEnabled.value,
      readAloudEnabled: selectionReadAloudEnabled.value,
      advanced: selectionSpeechAdvanced.value,
      model: selectionSpeechModel.value
    };
    const saved = await speechControlClient.updateSelectionReaderSettings(settings);
    selectionSpeechEnabled.value = saved.enabled;
    selectionReadAloudEnabled.value = saved.readAloudEnabled;
    selectionSpeechAdvanced.value = saved.advanced;
    selectionSpeechModel.value = saved.model;
  } catch (error) {
    desktopSettingsError.value = error instanceof Error ? error.message : String(error);
    throw error;
  } finally {
    selectionSpeechSaving.value = false;
  }
}

function normalizeScreenshotShortcut(): void {
  desktopScreenshotShortcut.value = desktopScreenshotShortcut.value.trim().replace(/\s*\+\s*/g, "+");
}

function normalizeScreenshotClipboardShortcut(): void {
  desktopScreenshotClipboardShortcut.value = desktopScreenshotClipboardShortcut.value.trim().replace(/\s*\+\s*/g, "+");
}

function screenshotShortcutFromKeyEvent(event: KeyboardEvent): string | null {
  const key = event.key === " " ? "SPACE" : event.key.toUpperCase();
  const functionKey = /^(F[1-9]|F1[0-2])$/.test(key);
  const validKey = /^[A-Z0-9]$/.test(key)
    || functionKey
    || /^(SPACE|TAB|ENTER|ESCAPE)$/.test(key);
  if (!validKey) return null;
  const modifiers = [
    event.ctrlKey ? "Ctrl" : "",
    event.altKey ? "Alt" : "",
    event.shiftKey ? "Shift" : "",
    event.metaKey ? "Win" : ""
  ].filter(Boolean);
  if (!modifiers.length && !functionKey) return null;
  return [...modifiers, key === "ESCAPE" ? "Esc" : key[0] + key.slice(1).toLowerCase()].join("+");
}

function beginScreenshotShortcutCapture(): void {
  desktopScreenshotShortcutCapturing.value = true;
}

function captureScreenshotShortcut(event: KeyboardEvent): void {
  const shortcut = screenshotShortcutFromKeyEvent(event);
  if (!shortcut) return;
  event.preventDefault();
  event.stopPropagation();
  desktopScreenshotShortcut.value = shortcut;
  desktopScreenshotShortcutCapturing.value = false;
}

function beginScreenshotClipboardShortcutCapture(): void {
  desktopScreenshotClipboardShortcutCapturing.value = true;
}

function captureScreenshotClipboardShortcut(event: KeyboardEvent): void {
  const shortcut = screenshotShortcutFromKeyEvent(event);
  if (!shortcut) return;
  event.preventDefault();
  event.stopPropagation();
  desktopScreenshotClipboardShortcut.value = shortcut;
  desktopScreenshotClipboardShortcutCapturing.value = false;
}

async function loadWebguiLanAccess(): Promise<void> {
  try {
    const response = await fetch("/api/webgui-access");
    const body = await response.json();
    if (!response.ok || body.code !== 0 || !body.data) throw new Error(body.message || "读取局域网 WebGUI 配置失败");
    webguiLanAccess.value = body.data as WebguiLanAccess;
    webguiLanError.value = "";
  } catch (error) {
    webguiLanError.value = error instanceof Error ? error.message : String(error);
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
    webguiLanError.value = error instanceof Error ? error.message : String(error);
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
    webguiLanError.value = `复制失败：${error instanceof Error ? error.message : String(error)}`;
  }
}

function loadRabiLinkRelayForm(): void {
  const relay = store.meta.rabiLinkRelay || {};
  rabiLinkRelayEnabled.value = relay.enabled === true;
  rabiLinkRelayUrl.value = relay.url || "";
  rabiLinkRelayAppToken.value = relay.token || "";
  rabiLinkRelayTokenConfigured.value = relay.tokenConfigured === true || Boolean(relay.token);
  rabiLinkRelayDeviceId.value = relay.deviceId || store.meta.computerName || "";
  rabiLinkRelayClaimWaitMs.value = Number(relay.claimWaitMs || 60000);
  rabiLinkRelayReplyIdleTimeoutMs.value = Number(relay.replyIdleTimeoutMs || 60000);
  rabiLinkSpeechProxyEnabled.value = relay.speechProxyEnabled === true;
  rabiLinkSpeechServiceUrl.value = relay.speechServiceUrl || "http://127.0.0.1:8781";
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
    dirError.value = e instanceof Error ? e.message : String(e);
    throw e;
  } finally {
    dirSaving.value = false;
  }
}

async function saveRabiIdentity(): Promise<void> {
  rabiSaving.value = true;
  rabiError.value = "";
  try {
    const relayPatch: Record<string, unknown> = {
      enabled: rabiLinkRelayEnabled.value,
      url: rabiLinkRelayUrl.value,
      deviceId: rabiLinkRelayDeviceId.value,
      claimWaitMs: Number(rabiLinkRelayClaimWaitMs.value || 60000),
      replyIdleTimeoutMs: Number(rabiLinkRelayReplyIdleTimeoutMs.value || 60000),
      speechProxyEnabled: rabiLinkSpeechProxyEnabled.value,
      speechServiceUrl: rabiLinkSpeechServiceUrl.value
    };
    if (rabiLinkRelayAppToken.value.trim()) relayPatch.token = rabiLinkRelayAppToken.value.trim();
    const res = await fetch("/api/rabi/identity", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        rabiName: rabiName.value,
        rabiLinkRelay: relayPatch
      })
    });
    const data = await res.json();
    if (data.code !== 0) throw new Error(data.message || "保存失败");
    await store.load({ replaceDirtyConfig: true });
    rabiName.value = store.meta.rabiName || "";
    loadRabiLinkRelayForm();
  } catch (e) {
    rabiError.value = e instanceof Error ? e.message : String(e);
    throw e;
  } finally {
    rabiSaving.value = false;
  }
}

function toggleRabiLinkRelay(enabled: boolean | null): void {
  if (typeof enabled !== "boolean") return;
  rabiLinkRelayEnabled.value = enabled;
}

const relayRuntimeState = computed(() => store.meta.rabiLinkRelayRuntime?.state || "disabled");
const relayRuntimeMessage = computed(() => store.meta.rabiLinkRelayRuntime?.message || "RabiLink Relay 全局连接已关闭。");
const relayRuntimeLabel = computed(() => ({
  disabled: "已关闭",
  incomplete: "配置不完整",
  connecting: "连接中",
  online: "已连接",
  error: "连接失败"
}[relayRuntimeState.value] || "未知"));
const relayRuntimeColor = computed(() => ({
  disabled: "grey",
  incomplete: "warning",
  connecting: "info",
  online: "success",
  error: "error"
}[relayRuntimeState.value] || "grey"));

async function refreshRelayRuntime(): Promise<void> {
  try {
    const response = await fetch("/meta");
    if (!response.ok) return;
    const meta = await response.json();
    store.meta.rabiLinkRelayRuntime = meta.rabiLinkRelayRuntime;
  } catch {
    // Keep the most recent status while Manager is restarting.
  }
}

let managerEvents: EventSource | null = null;
const trackedSettingValues = [
  routeDir,
  rolesDir,
  rabiName,
  rabiLinkRelayEnabled,
  rabiLinkRelayUrl,
  rabiLinkRelayAppToken,
  rabiLinkRelayDeviceId,
  rabiLinkRelayClaimWaitMs,
  rabiLinkRelayReplyIdleTimeoutMs,
  rabiLinkSpeechProxyEnabled,
  rabiLinkSpeechServiceUrl,
  selectionSpeechEnabled,
  selectionReadAloudEnabled,
  selectionSpeechAdvanced,
  selectionSpeechModel,
  desktopScreenshotEnabled,
  desktopScreenshotShortcut,
  desktopScreenshotClipboardShortcut,
  desktopScreenshotAutoCopy,
  desktopAutostart,
  desktopTheme,
  () => webguiLanAccess.value.enabled
];

watch(trackedSettingValues, () => {
  if (!settingsHydrating.value && !desktopSettingsHydrating.value) settingsDirty.value = true;
});

watch(desktopSettingsVisible, (visible) => {
  if (visible && !desktopSettingsLoaded.value) void loadDesktopSettings();
}, { immediate: true });

async function saveSettings(): Promise<void> {
  if (!settingsReady.value || settingsSaving.value) return;
  settingsSaving.value = true;
  settingsHydrating.value = true;
  try {
    const results = await Promise.allSettled([
      desktopSettingsVisible.value ? saveDesktopSettings() : Promise.resolve(),
      saveSelectionSpeechSettings(),
      saveRabiIdentity(),
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
  await refreshRelayRuntime();
  managerEvents = managerEventSource("/api/events");
  managerEvents.addEventListener("rabilink_status", (raw) => {
    try {
      store.meta.rabiLinkRelayRuntime = JSON.parse((raw as MessageEvent).data || "{}");
    } catch {
      // Keep the latest valid status.
    }
  });
});
onBeforeUnmount(() => {
  managerEvents?.close();
  unregisterPageSaveAction?.();
});
</script>

<template>
  <div class="page-shell">
    <div class="page-header">
      <div>
        <div class="eyebrow">RABIROUTE</div>
        <h1 class="page-title">设置</h1>
        <div class="page-subtitle">管理本机身份、RabiLink 连接、目录和局域网访问。</div>
      </div>
    </div>

    <div class="two-column">
      <v-card v-if="desktopSettingsVisible" class="app-card glass-card section-card">
        <div class="section-title-row">
          <div>
            <div class="section-title">RabiRoute 桌面功能</div>
            <div class="section-note">RabiRoute 在 Windows 中提供截图、滑词和登录启动设置。</div>
          </div>
        </div>
        <v-alert v-if="desktopSettingsError" type="error" variant="tonal" density="compact" class="mb-3">{{ desktopSettingsError }}</v-alert>
        <div class="section-title-row compact-row mb-2">
          <div>
            <div class="section-title small-title">界面主题</div>
            <div class="section-note">同时影响当前 WebGUI、托盘菜单、角色面板、滑词操作条和截图窗口。</div>
          </div>
          <v-btn-toggle v-model="desktopTheme" color="secondary" density="compact" mandatory divided :disabled="!desktopSettingsLoaded">
            <v-btn
              v-for="option in desktopThemeOptions"
              :key="option.webResourceId"
              :value="option.themeId"
              :prepend-icon="option.icon"
            >
              {{ option.label }}
            </v-btn>
          </v-btn-toggle>
        </div>
        <v-divider class="my-4" />
        <div class="section-title-row compact-row mb-2">
          <div>
            <div class="section-title small-title">系统级截图</div>
            <div class="section-note">框选截图后可复制到剪贴板、贴到屏幕或发送给已激活人格；在截图窗口按 F2 发送，按 &lt; / &gt; 切换上一张和下一张。</div>
          </div>
          <v-switch v-model="desktopScreenshotEnabled" label="启用截图" color="success" density="compact" inset hide-details :disabled="!desktopSettingsLoaded" />
        </div>
        <v-text-field
          v-model="desktopScreenshotShortcut"
          label="截图快捷键"
          placeholder="Ctrl+Shift+S"
          :hint="desktopScreenshotShortcutCapturing ? '正在录入，按下要绑定的按键。' : '点击输入框后按下快捷键；可单独使用 F1-F12，或搭配 Ctrl、Alt、Shift、Win。'"
          persistent-hint
          density="compact"
          readonly
          :disabled="!desktopSettingsLoaded || !desktopScreenshotEnabled"
          @click="beginScreenshotShortcutCapture"
          @focus="beginScreenshotShortcutCapture"
          @keydown="captureScreenshotShortcut"
          @blur="desktopScreenshotShortcutCapturing = false; normalizeScreenshotShortcut()"
        />
        <div class="section-title-row compact-row mb-2">
          <div>
            <div class="section-title small-title">自动复制选区</div>
            <div class="section-note">确认选区时自动复制到剪贴板；关闭后可按 Ctrl+C 或点击“复制”。</div>
          </div>
          <v-switch v-model="desktopScreenshotAutoCopy" label="自动复制" color="success" density="compact" inset hide-details :disabled="!desktopSettingsLoaded || !desktopScreenshotEnabled" />
        </div>
        <v-text-field
          v-model="desktopScreenshotClipboardShortcut"
          label="贴图快捷键"
          placeholder="F3"
          :hint="desktopScreenshotClipboardShortcutCapturing ? '正在录入，按下要绑定的按键。' : '截图窗口打开时，直接贴出框选区域；其他时候贴出剪贴板图片。默认 F3；可单独使用 F1-F12，或搭配 Ctrl、Alt、Shift、Win。'"
          persistent-hint
          density="compact"
          readonly
          :disabled="!desktopSettingsLoaded || !desktopScreenshotEnabled"
          @click="beginScreenshotClipboardShortcutCapture"
          @focus="beginScreenshotClipboardShortcutCapture"
          @keydown="captureScreenshotClipboardShortcut"
          @blur="desktopScreenshotClipboardShortcutCapturing = false; normalizeScreenshotClipboardShortcut()"
        />
        <v-divider class="my-4" />
        <div class="section-title-row compact-row">
          <div>
            <div class="section-title small-title">Windows 登录启动</div>
            <div class="section-note">登录 Windows 后自动启动 RabiRoute Desktop；后台运行时保留系统托盘入口。</div>
          </div>
          <v-switch v-model="desktopAutostart" label="登录后启动" color="success" density="compact" inset hide-details :disabled="!desktopSettingsLoaded" />
        </div>
      </v-card>

      <v-card class="app-card glass-card section-card">
        <div class="section-title-row">
          <div>
            <div class="section-title">开启滑词菜单</div>
            <div class="section-note">在 Windows 任意支持文本选区的软件中划选文字，再点击悬浮按钮执行朗读或投递。</div>
          </div>
        </div>
        <div class="section-title-row compact-row mb-2">
          <div>
            <div class="section-title small-title">滑词菜单</div>
            <div class="section-note">划选后显示「朗读」和「投递至」；划选本身不执行动作。</div>
          </div>
          <v-switch v-model="selectionSpeechEnabled" label="开启滑词菜单" color="success" density="compact" inset hide-details :disabled="!selectionSpeechLoaded" />
        </div>
        <template v-if="selectionSpeechEnabled">
        <div class="section-title-row compact-row mb-2">
          <div>
            <div class="section-title small-title">滑词朗读</div>
            <div class="section-note">点击左侧“朗读”才会播放；关闭后悬浮条只保留“投递至”。</div>
          </div>
          <v-switch v-model="selectionReadAloudEnabled" label="滑词朗读" color="success" density="compact" inset hide-details :disabled="!selectionSpeechLoaded" />
        </div>
        <v-switch v-model="selectionSpeechAdvanced" label="高级选项" color="primary" density="compact" hide-details :disabled="!selectionSpeechLoaded || !selectionReadAloudEnabled" />
        <v-select
          v-if="selectionSpeechEnabled && selectionReadAloudEnabled && selectionSpeechAdvanced"
          v-model="selectionSpeechModel"
          class="mt-3"
          label="滑词朗读模型"
          :items="selectionSpeechModels.filter(item => item.capability === 'tts' && item.available)"
          item-title="name"
          item-value="id"
          :disabled="!selectionSpeechLoaded"
        >
          <template #item="{ props, item }"><v-list-item v-bind="props" :subtitle="item.raw.id" /></template>
        </v-select>
        </template>
      </v-card>

      <v-card class="app-card glass-card section-card">
        <div class="section-title-row">
          <div>
            <div class="section-title">Rabi 实例</div>
            <div class="section-note">保存到 data/Config.json，作为这台 Rabi PC 的全局身份。</div>
          </div>
        </div>
        <v-alert v-if="rabiError" type="error" variant="tonal" density="compact" class="mb-3">{{ rabiError }}</v-alert>
        <div class="form-grid">
          <v-text-field v-model="rabiName" label="RabiRoute 实例名" :placeholder="store.meta.computerName || 'RabiRoute'" density="compact" hide-details />
          <v-text-field :model-value="store.meta.rabiGuid || '-'" label="RabiRoute GUID" density="compact" readonly hide-details />
        </div>
        <v-divider class="my-4" />
        <div class="section-title-row compact-row mb-2">
          <div>
            <div class="section-title small-title">RabiLink 系统转接服务</div>
            <div class="section-note">全局内置服务，不是消息端。开启后由 Manager 常驻登记本机，可被 WebGUI、语音服务和眼镜端共同使用。</div>
          </div>
          <div class="relay-global-controls">
            <v-chip :color="relayRuntimeColor" size="small" variant="tonal">{{ relayRuntimeLabel }}</v-chip>
            <v-switch
              :model-value="rabiLinkRelayEnabled"
              label="连接服务器"
              color="success"
              density="compact"
              inset
              hide-details
              :disabled="rabiSaving"
              @update:model-value="toggleRabiLinkRelay"
            />
          </div>
        </div>
        <v-alert
          :type="relayRuntimeState === 'error' ? 'error' : relayRuntimeState === 'incomplete' ? 'warning' : 'info'"
          variant="tonal"
          density="compact"
          class="mb-3"
        >
          {{ relayRuntimeMessage }}
        </v-alert>
        <div class="form-grid">
          <v-text-field v-model="rabiLinkRelayDeviceId" label="本机 Rabi PC 标识" :placeholder="store.meta.computerName || 'rabilink-pc'" density="compact" hide-details />
          <v-text-field v-model="rabiLinkRelayUrl" label="Relay 服务器地址" placeholder="https://rabiroute.example.com" density="compact" hide-details />
          <v-text-field
            v-model="rabiLinkRelayAppToken"
            label="Relay 应用 token"
            :placeholder="rabiLinkRelayTokenConfigured ? '已安全保存；留空保持不变' : 'X-RabiLink-Token'"
            type="password"
            density="compact"
            hide-details
          />
          <v-text-field v-model.number="rabiLinkRelayClaimWaitMs" label="领取任务等待毫秒" type="number" min="0" max="60000" step="1000" density="compact" hide-details />
          <v-text-field v-model.number="rabiLinkRelayReplyIdleTimeoutMs" label="回复空闲超时毫秒" type="number" min="1000" max="120000" step="1000" density="compact" hide-details />
        </div>
        <v-divider class="my-4" />
        <div class="section-title-row compact-row mb-2">
          <div>
            <div class="section-title small-title">转接本机 TTS / ASR API</div>
            <div class="section-note">启用后，外部可用 Relay 应用 token 直接调用本机语音服务；本机仍只监听回环地址。</div>
          </div>
          <v-switch
            v-model="rabiLinkSpeechProxyEnabled"
            label="允许语音中转"
            color="success"
            density="compact"
            inset
            hide-details
          />
        </div>
        <div class="form-grid">
          <v-text-field v-model="rabiLinkSpeechServiceUrl" label="本机语音服务地址" placeholder="http://127.0.0.1:8781" density="compact" hide-details />
        </div>
      </v-card>

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
          其他设备必须使用这台 Rabi PC 的局域网 IP，不能使用 127.0.0.1。若重启后仍无法连接，请检查 Windows 防火墙是否允许 RabiRoute/Node.js 的 8790 端口。
        </div>
      </v-card>
    </div>
  </div>
</template>
