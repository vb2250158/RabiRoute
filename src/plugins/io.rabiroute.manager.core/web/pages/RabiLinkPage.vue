<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import { managerEventSource } from "../../../../../ribiwebgui/src/managerApi";
import { useGatewayStore } from "../../../../../ribiwebgui/src/stores/gatewayStore";
import { useI18n } from "../../../../../ribiwebgui/src/i18n/index";
import { rabiLinkManagementUrl, rabiLinkTab } from "../../../../../ribiwebgui/src/rabiLinkPresentation";
import { createRabiLinkRefreshFence } from "../../../../../ribiwebgui/src/rabiLinkRefreshFence";
import {
  readRabiLinkHome,
  saveRabiLinkDeviceLabels,
  rabiLinkCapabilities,
  rabiLinkDeviceDisplayName,
  rabiLinkDeviceIcon,
  rabiLinkDeviceKind,
  rabiLinkDeviceVersionLabel,
  type RabiLinkHomeData,
  type RabiLinkHomeDevice
} from "../../../../../ribiwebgui/src/rabiLinkHomeClient";
import { createRabiLinkHomeLoader, type RabiLinkHomeState } from "../../../../../ribiwebgui/src/rabiLinkHomeState";
import ComputerControlPage from "../computer/ComputerControlPage.vue";
import { phoneDeepLink } from "../computer/phoneDevice";
import LanAgentsPage from "../../../../../ribiwebgui/src/pages/LanAgentsPage.vue";
import RabiLinkSettings from "../components/RabiLinkSettings.vue";

const route = useRoute();
const router = useRouter();
const store = useGatewayStore();
const { t } = useI18n();
const tab = computed(() => rabiLinkTab(route.query.tab));
const deviceDirectoryActive = computed(() => tab.value === "home" || tab.value === "computer");
const ready = ref(false);
const computerActive = computed(() => tab.value === "computer");
const computerVisited = ref(computerActive.value);
watch(computerActive, value => { if (value) computerVisited.value = true; });
const saving = ref(false);
const refreshing = ref(false);
const error = ref("");
const refreshFence = createRabiLinkRefreshFence();
const runtime = computed(() => store.meta.rabiLinkRelayRuntime);
const connected = computed(() => runtime.value?.state === "online");
const managementUrl = computed(() => rabiLinkManagementUrl(store.meta.rabiLinkRelay?.url));
const home = ref<RabiLinkHomeState<RabiLinkHomeData>>({ phase: "idle" });
const homeLoader = createRabiLinkHomeLoader(readRabiLinkHome, value => { home.value = value; }, () => "暂时无法读取已连接设备，请检查服务器连接后重试。");
const devices = computed(() => home.value.phase === "ready" ? home.value.data.devices.map(device => {
  const kind = rabiLinkDeviceKind(device);
  return {
    ...device,
    kind,
    icon: rabiLinkDeviceIcon(device),
    displayName: device.labels?.alias || rabiLinkDeviceDisplayName(device),
    versionLabel: rabiLinkDeviceVersionLabel(device, t),
    services: rabiLinkCapabilities(device.capabilities, kind)
  };
}) : []);
const labelDevice = ref<RabiLinkHomeDevice>();
const phones = computed(() => devices.value.filter(device => device.kind === "phone"));
const selectedPhoneId = computed(() => phoneDeepLink(route.query));
const alias = ref("");
const tags = ref("");
const labelError = ref("");
const savingLabels = ref(false);
function editLabels(device: RabiLinkHomeDevice) {
  labelDevice.value = device;
  alias.value = device.labels?.alias ?? "";
  tags.value = device.labels?.tags.join("、") ?? "";
  labelError.value = "";
}
async function saveLabels() {
  const device = labelDevice.value;
  if (!device || savingLabels.value) return;
  const values = tags.value.split(/[,，、\n]+/u).map(tag => tag.trim()).filter(Boolean);
  if (values.length > 20 || values.some(tag => tag.length > 32)) {
    labelError.value = "最多填写 20 个标签，每个标签最多 32 个字符。";
    return;
  }
  savingLabels.value = true;
  labelError.value = "";
  try {
    await saveRabiLinkDeviceLabels(device, { alias: alias.value, tags: values });
    labelDevice.value = undefined;
    refreshHome();
  } catch (reason) {
    labelError.value = reason instanceof Error ? reason.message : "无法保存别名和标签。";
  } finally {
    savingLabels.value = false;
  }
}
const checkedAt = computed(() => home.value.phase === "ready" ? new Date(home.value.data.checkedAt).toLocaleString("zh-CN") : "");
let managerEvents: EventSource | undefined;
let metaRequest: AbortController | undefined;
let disposed = false;
function refreshHome() {
  if (!disposed && ready.value && connected.value && !saving.value && deviceDirectoryActive.value) void homeLoader.refresh();
  else homeLoader.invalidate();
}
function onSaving(value: boolean) {
  saving.value = value;
  refreshFence.setSaving(value);
  metaRequest?.abort();
  refreshing.value = false;
  homeLoader.invalidate();
  if (!value) void refresh();
}
// No background polling. Navigation, saved configuration and status events invalidate the view.
watch([deviceDirectoryActive, connected, () => store.meta.rabiLinkRelay?.url, () => store.meta.rabiLinkRelay?.deviceId,
  () => store.meta.applicationGenerationId, () => store.meta.managerInstanceId], () => {
  homeLoader.invalidate();
  refreshHome();
}, { flush: "sync" });
async function refresh() {
  const revision = refreshFence.begin();
  if (revision === undefined || disposed) return;
  metaRequest?.abort();
  const controller = new AbortController();
  metaRequest = controller;
  refreshing.value = true;
  error.value = "";
  try {
    const response = await fetch("/meta", { cache: "no-store", signal: controller.signal });
    if (!response.ok) throw new Error("读取状态失败");
    const meta = await response.json();
    if (disposed || !refreshFence.accepts(revision)) return;
    const { token: _token, ...relay } = meta.rabiLinkRelay || {};
    store.meta = { ...store.meta, ...meta, rabiLinkRelay: relay };
    ready.value = true;
    refreshHome();
  } catch {
    if (!disposed && refreshFence.accepts(revision)) {
      error.value = "无法读取连接状态，请刷新重试。";
      ready.value = false;
      homeLoader.invalidate();
    }
  } finally {
    if (!disposed && refreshFence.accepts(revision)) refreshing.value = false;
  }
}
onMounted(() => {
  managerEvents = managerEventSource("/api/events");
  managerEvents.addEventListener("rabilink_account_changed", () => {
    homeLoader.invalidate();
    void refresh();
  });
  managerEvents.addEventListener("rabilink_devices_changed", refreshHome);
  managerEvents.addEventListener("rabilink_status", raw => {
    if (disposed || saving.value) return;
    try {
      const status = JSON.parse((raw as MessageEvent).data);
      if (!status || !["disabled", "incomplete", "connecting", "online", "error"].includes(status.state)) return;
      if (status.state === runtime.value?.state) {
        store.meta.rabiLinkRelayRuntime = status;
        return;
      }
      // A status event is newer than any in-flight meta snapshot.
      refreshFence.setSaving(false);
      metaRequest?.abort();
      const refreshMeta = refreshing.value || !ready.value;
      refreshing.value = false;
      store.meta.rabiLinkRelayRuntime = status;
      if (refreshMeta) void refresh();
    } catch { /* An invalid event is not a new authoritative snapshot. */ }
  });
  void refresh();
});
onBeforeUnmount(() => { disposed = true; metaRequest?.abort(); managerEvents?.close(); homeLoader.dispose(); });
</script>

<template>
  <div class="page-shell rabilink-page">
    <div class="rabilink-tab-bar mb-4">
      <v-tabs :model-value="tab" color="primary" show-arrows class="rabilink-tabs" aria-label="RabiLink"
        @update:model-value="value => router.replace({ query: { ...route.query, tab: String(value) } })">
        <v-tab value="home">主页</v-tab>
        <v-tab value="agents">节点管理</v-tab>
        <v-tab value="computer">{{ t('设备控制') }}</v-tab>
        <v-tab value="config">配置</v-tab>
      </v-tabs>
      <div class="rabilink-toolbar-actions">
        <v-btn size="small" prepend-icon="mdi-refresh" variant="text" :aria-label="t('刷新')" :title="t('刷新')"
          :disabled="saving" :loading="refreshing || home.phase === 'loading'" @click="refresh">
          <span class="rabilink-action-label">{{ t('刷新') }}</span>
        </v-btn>
        <v-btn v-if="managementUrl" size="small" :href="managementUrl" target="_blank" rel="noopener noreferrer"
          variant="outlined" prepend-icon="mdi-open-in-new" :aria-label="t('服务器管理')" :title="t('服务器管理')">
          <span class="rabilink-action-label">{{ t('服务器管理') }}</span>
        </v-btn>
      </div>
    </div>
    <v-alert v-if="error" type="error" variant="tonal" class="mb-4">{{ error }}</v-alert>
    <section v-if="tab === 'home'" class="rabilink-home" :aria-label="t('已连接设备')" :aria-busy="home.phase === 'loading'">
      <template v-if="!ready">
        <p v-if="!error" role="status" class="section-note">正在读取连接状态…</p>
      </template>
      <div v-else-if="!connected" class="rabilink-empty">
        <v-icon icon="mdi-lan-disconnect" size="32" />
        <h2 class="section-title">尚未连接服务器</h2>
        <p class="section-note">配置服务器后刷新；连接失败时检查服务器地址。</p>
      </div>
      <template v-else>
        <div class="rabilink-list-heading">
          <h2 class="section-title">{{ t('已连接设备') }}</h2>
          <span v-if="home.phase === 'ready'" class="section-note">{{ devices.length }} 台设备 · 更新于 {{ checkedAt }}</span>
        </div>
        <details class="rabilink-help section-note">
          <summary>查看范围与服务器管理</summary>
          <p>这里只显示当前应用已授权的设备（包括电脑、手机与眼镜等端侧设备）。服务标签表示设备声明支持的能力，不代表服务正在运行。服务器管理在新窗口打开，需要使用服务器账号独立登录；应用令牌不能代替网页登录。</p>
        </details>
        <v-progress-linear v-if="home.phase === 'loading'" indeterminate :aria-label="t('正在读取已连接设备')" class="mt-3" />
        <p v-if="home.phase === 'loading'" role="status" class="section-note py-4">{{ t('正在读取已连接设备') }}…</p>
        <v-alert v-else-if="home.phase === 'error'" type="error" variant="tonal" class="mt-3">
          {{ home.error }}
          <v-btn variant="text" size="small" @click="refreshHome">重试</v-btn>
        </v-alert>
        <p v-else-if="saving" role="status" class="section-note py-4">正在保存连接设置…</p>
        <div v-else-if="home.phase === 'ready' && !devices.length" class="rabilink-empty">
          <v-icon icon="mdi-devices" size="32" />
          <h3 class="section-title">{{ t('当前应用尚无已连接设备') }}</h3>
        </div>
        <ul v-else-if="home.phase === 'ready'" class="rabilink-devices">
          <li v-for="device in devices" :key="device.id" class="rabilink-device" :class="{ 'rabilink-device--linked': device.kind !== 'glasses' }">
            <div class="rabilink-device-header">
              <v-icon :icon="device.icon" size="22" class="rabilink-device-icon" />
              <div class="rabilink-device-name" :title="device.displayName">
                <RouterLink
                  v-if="device.kind !== 'glasses'"
                  class="rabilink-device-link"
                  :to="{ path: '/rabilink', query: { tab: 'computer', ...(device.kind === 'phone' ? { phoneId: device.id } : { deviceId: device.isLocal ? '' : device.id }) } }"
                >{{ device.displayName }}</RouterLink>
                <strong v-else>{{ device.displayName }}</strong>
              </div>
              <v-chip size="x-small" :color="device.online ? 'success' : 'default'" variant="tonal">{{ t(device.online ? '在线' : '离线') }}</v-chip>
              <div class="rabilink-device-actions">
                <v-btn v-if="device.labelRevision" icon="mdi-tag-edit-outline" size="x-small" variant="text" class="rabilink-device-edit"
                  :title="t('编辑别名和标签')" :aria-label="t('编辑别名和标签') + ' · ' + device.displayName" @click="editLabels(device)" />
                <v-icon v-if="device.kind !== 'glasses'" icon="mdi-chevron-right" size="18" class="rabilink-device-arrow" />
              </div>
            </div>
            <div class="rabilink-device-content">
              <div class="rabilink-device-meta">
                <span class="section-note" data-no-i18n>{{ device.versionLabel || (device.kind === 'phone' ? 'Android' : '') }}</span>
                <v-chip v-if="device.isLocal" size="x-small" variant="outlined">{{ t('本机') }}</v-chip>
              </div>
              <div class="d-flex flex-wrap ga-2">
                <v-chip v-for="label in device.services.known" :key="label" size="small" variant="outlined">{{ t(label) }}</v-chip>
                <span v-if="!device.services.known.length" class="section-note">{{ device.services.advanced.length ? '其他服务能力' : '未声明服务能力' }}</span>
              </div>
              <div v-if="device.labels?.tags.length" class="d-flex flex-wrap ga-1" :aria-label="t('标签')">
                <v-chip v-for="tag in device.labels.tags" :key="tag" size="x-small" variant="tonal" color="primary" data-no-i18n>{{ tag }}</v-chip>
              </div>
              <details class="section-note rabilink-device-more">
                <summary>高级信息</summary>
                <dl class="rabilink-device-details">
                  <template v-if="device.labels?.alias"><dt>原设备名</dt><dd>{{ rabiLinkDeviceDisplayName(device) }}</dd></template>
                  <dt>设备标识</dt><dd>{{ device.id }}</dd>
                  <dt>唯一标识</dt><dd>{{ device.guid || '未提供' }}</dd>
                  <template v-if="device.services.advanced.length"><dt>其他能力标识</dt><dd>{{ device.services.advanced.join('、') }}</dd></template>
                </dl>
              </details>
            </div>
          </li>
        </ul>
      </template>
    </section>
    <v-dialog :model-value="Boolean(labelDevice)" :persistent="savingLabels" max-width="440"
      @update:model-value="value => { if (!value) labelDevice = undefined }">
      <v-card v-if="labelDevice">
        <v-form @submit.prevent="saveLabels">
          <v-card-title>{{ t('编辑别名和标签') }}</v-card-title>
          <v-card-subtitle data-no-i18n>{{ rabiLinkDeviceDisplayName(labelDevice) }}</v-card-subtitle>
          <v-card-text>
            <v-text-field v-model="alias" :label="t('别名')" :maxlength="80" :disabled="savingLabels" />
            <v-text-field v-model="tags" :label="t('标签')" :hint="t('用逗号或顿号分隔标签')" persistent-hint :disabled="savingLabels" />
            <v-alert v-if="labelError" type="error" variant="tonal" class="mt-3">{{ labelError }}</v-alert>
          </v-card-text>
          <v-card-actions>
            <v-spacer />
            <v-btn :disabled="savingLabels" @click="labelDevice = undefined">{{ t('取消') }}</v-btn>
            <v-btn type="submit" color="primary" :loading="savingLabels">{{ t('保存') }}</v-btn>
          </v-card-actions>
        </v-form>
      </v-card>
    </v-dialog>
    <LanAgentsPage v-if="tab === 'agents'" />
    <ComputerControlPage v-if="computerVisited" v-show="computerActive" :active="computerActive"
      :phones="phones" :phones-loading="home.phase === 'loading' || !ready"
      :phones-error="home.phase === 'error' ? home.error : ''" :phone-id="selectedPhoneId" @refresh="refreshHome" />
    <RabiLinkSettings v-show="tab === 'config'" :ready="ready" :active="tab === 'config'" @saving="onSaving" />
  </div>
</template>

<style scoped>
.rabilink-page { min-width: 0; }
.rabilink-tab-bar { display: flex; align-items: center; gap: 8px; min-width: 0; }
.rabilink-tabs { flex: 1; min-width: 0; }
.rabilink-toolbar-actions { display: flex; align-items: center; gap: 8px; flex: none; }
.rabilink-list-heading { display: flex; flex-wrap: wrap; align-items: baseline; justify-content: space-between; gap: 8px; }
.rabilink-help { margin-top: 8px; max-width: 75ch; }
.rabilink-help p { margin: 8px 0 0; line-height: 1.7; }
summary { cursor: pointer; width: fit-content; }
summary:focus-visible { outline: 2px solid currentColor; outline-offset: 4px; }
.rabilink-empty { display: grid; justify-items: center; text-align: center; gap: 12px; padding: 36px 16px; }
.rabilink-home { container-type: inline-size; }
.rabilink-devices {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 12px;
  list-style: none;
  margin: 16px 0 0;
  padding: 0;
}
.rabilink-device {
  position: relative;
  display: grid;
  grid-template-rows: auto 1fr;
  gap: 4px;
  min-width: 0;
  padding: 16px;
  border: 1px solid var(--rr-border);
  border-radius: 12px;
  background: var(--rr-surface);
}
.rabilink-device--linked:hover { border-color: var(--rr-accent-text); }
.rabilink-device-header { display: grid; grid-template-columns: 22px minmax(0, 1fr) auto 54px; gap: 10px; align-items: center; }
.rabilink-device-icon, .rabilink-device-arrow { color: var(--rr-text-muted); }
.rabilink-device-actions { display: flex; align-items: center; justify-content: flex-end; gap: 2px; height: 32px; }
.rabilink-device-name { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.rabilink-device-meta { height: 20px; display: flex; align-items: center; gap: 8px; }
.rabilink-device-edit { z-index: 1; }
.rabilink-device-content { display: flex; flex-direction: column; gap: 8px; min-width: 0; padding-inline-start: 32px; overflow-wrap: anywhere; }
.rabilink-device-more { margin-top: auto; }
.rabilink-device-link { color: inherit; font-weight: 700; text-decoration: none; }
.rabilink-device-link::after { content: ""; position: absolute; inset: 0; border-radius: 12px; }
.rabilink-device-link:focus-visible { outline: none; }
.rabilink-device-link:focus-visible::after { outline: 2px solid var(--rr-accent-text); outline-offset: 2px; }
.rabilink-device summary, .rabilink-device-details { position: relative; z-index: 1; }
.rabilink-device-details { display: grid; grid-template-columns: auto 1fr; gap: 4px 12px; margin-top: 8px; }
.rabilink-device-details dd { margin: 0; overflow-wrap: anywhere; }
@container (max-width: 740px) { .rabilink-devices { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
@container (max-width: 480px) { .rabilink-devices { grid-template-columns: minmax(0, 1fr); } }
@media (max-width: 760px) {
  .rabilink-tab-bar, .rabilink-toolbar-actions { gap: 4px; }
  .rabilink-action-label { display: none; }
  .rabilink-toolbar-actions :deep(.v-btn) { min-width: 36px; width: 36px; padding: 6px; }
  .rabilink-toolbar-actions :deep(.v-btn__prepend) { margin-inline: 0; }
}
@media (max-width: 600px) { .rabilink-device-details { grid-template-columns: 1fr; } }
</style>
