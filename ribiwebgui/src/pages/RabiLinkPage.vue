<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import { managerEventSource } from "../managerApi";
import { useGatewayStore } from "../stores/gatewayStore";
import { rabiLinkManagementUrl, rabiLinkTab } from "../rabiLinkPresentation";
import { createRabiLinkRefreshFence } from "../rabiLinkRefreshFence";
import { readRabiLinkHome, rabiLinkCapabilities, type RabiLinkHomeData } from "../rabiLinkHomeClient";
import { createRabiLinkHomeLoader, type RabiLinkHomeState } from "../rabiLinkHomeState";
import LanAgentsPage from "./LanAgentsPage.vue";
import RabiLinkSettings from "../components/RabiLinkSettings.vue";

const route = useRoute();
const router = useRouter();
const store = useGatewayStore();
const tab = computed(() => rabiLinkTab(route.query.tab));
const ready = ref(false);
const saving = ref(false);
const refreshing = ref(false);
const error = ref("");
const refreshFence = createRabiLinkRefreshFence();
const runtime = computed(() => store.meta.rabiLinkRelayRuntime);
const connected = computed(() => runtime.value?.state === "online");
const managementUrl = computed(() => rabiLinkManagementUrl(store.meta.rabiLinkRelay?.url));
const statusLabel = computed(() => !ready.value ? "读取状态中" : ({ disabled: "已关闭", incomplete: "配置不完整", connecting: "连接中", online: "已连接", error: "连接失败" }[runtime.value?.state || "disabled"]));
const home = ref<RabiLinkHomeState<RabiLinkHomeData>>({ phase: "idle" });
const homeLoader = createRabiLinkHomeLoader(readRabiLinkHome, value => { home.value = value; }, () => "暂时无法读取已授权电脑，请检查服务器连接后重试。");
const devices = computed(() => home.value.phase === "ready" ? home.value.data.devices.map(device => ({ ...device, services: rabiLinkCapabilities(device.capabilities) })) : []);
const checkedAt = computed(() => home.value.phase === "ready" ? new Date(home.value.data.checkedAt).toLocaleString("zh-CN") : "");
let managerEvents: EventSource | undefined;
let metaRequest: AbortController | undefined;
let disposed = false;
function refreshHome() {
  if (!disposed && ready.value && connected.value && !saving.value && tab.value === "home") void homeLoader.refresh();
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
watch([tab, connected, () => store.meta.rabiLinkRelay?.url, () => store.meta.rabiLinkRelay?.deviceId], () => {
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
  homeLoader.invalidate();
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
  managerEvents.addEventListener("rabilink_status", raw => {
    if (disposed || saving.value) return;
    try {
      const status = JSON.parse((raw as MessageEvent).data);
      if (!status || !["disabled", "incomplete", "connecting", "online", "error"].includes(status.state)) return;
      // A status event is newer than any in-flight meta snapshot.
      refreshFence.setSaving(false);
      metaRequest?.abort();
      refreshing.value = false;
      store.meta.rabiLinkRelayRuntime = status;
      homeLoader.invalidate();
      if (!ready.value) void refresh();
      else refreshHome();
    } catch { /* An invalid event is not a new authoritative snapshot. */ }
  });
  void refresh();
});
onBeforeUnmount(() => { disposed = true; metaRequest?.abort(); managerEvents?.close(); homeLoader.dispose(); });
</script>

<template>
  <div class="page-shell rabilink-page">
    <header class="rabilink-toolbar">
      <h1 class="page-title">RabiLink</h1>
      <v-chip size="small" :color="connected && ready ? 'success' : 'default'" variant="tonal">{{ statusLabel }}</v-chip>
      <div class="rabilink-toolbar-actions">
        <v-btn size="small" prepend-icon="mdi-refresh" variant="text" :disabled="saving" :loading="refreshing || home.phase === 'loading'" @click="refresh">刷新</v-btn>
        <v-btn v-if="managementUrl" size="small" :href="managementUrl" target="_blank" rel="noopener noreferrer" variant="text" prepend-icon="mdi-open-in-new" title="在新窗口打开，需使用服务器账号独立登录">服务器管理</v-btn>
      </div>
    </header>
    <v-tabs :model-value="tab" color="primary" class="mb-4" @update:model-value="value => router.replace({ query: { ...route.query, tab: String(value) } })">
      <v-tab value="home">主页</v-tab>
      <v-tab value="agents">远端智能体</v-tab>
      <v-tab value="config">配置</v-tab>
    </v-tabs>
    <v-alert v-if="error" type="error" variant="tonal" class="mb-4">{{ error }}</v-alert>
    <section v-if="tab === 'home'" aria-label="已授权电脑" :aria-busy="home.phase === 'loading'">
      <template v-if="!ready">
        <p v-if="!error" role="status" class="section-note">正在读取连接状态…</p>
      </template>
      <div v-else-if="!connected" class="rabilink-empty">
        <v-icon icon="mdi-lan-disconnect" size="32" />
        <h2 class="section-title">尚未连接服务器</h2>
        <p class="section-note">请在配置中检查服务器地址与应用令牌，再保存连接设置。</p>
        <v-btn color="primary" variant="tonal" :to="{ path: '/rabilink', query: { ...route.query, tab: 'config' } }">前往配置</v-btn>
      </div>
      <template v-else>
        <div class="rabilink-list-heading">
          <h2 class="section-title">已授权电脑</h2>
          <span v-if="home.phase === 'ready'" class="section-note">{{ devices.length }} 台 · 更新于 {{ checkedAt }}</span>
        </div>
        <details class="rabilink-help section-note">
          <summary>查看范围与服务器管理</summary>
          <p>这里只显示当前应用已授权的电脑。服务标签表示电脑声明支持的能力，不代表服务正在运行。服务器管理在新窗口打开，需要使用服务器账号独立登录；应用令牌不能代替网页登录。</p>
        </details>
        <v-progress-linear v-if="home.phase === 'loading'" indeterminate aria-label="正在读取已授权电脑" class="mt-3" />
        <p v-if="home.phase === 'loading'" role="status" class="section-note py-4">正在读取已授权电脑…</p>
        <v-alert v-else-if="home.phase === 'error'" type="error" variant="tonal" class="mt-3">
          {{ home.error }}
          <v-btn variant="text" size="small" @click="refreshHome">重试</v-btn>
        </v-alert>
        <p v-else-if="saving" role="status" class="section-note py-4">正在保存连接设置…</p>
        <div v-else-if="home.phase === 'ready' && !devices.length" class="rabilink-empty">
          <v-icon icon="mdi-monitor" size="32" />
          <h3 class="section-title">当前应用尚无已授权电脑</h3>
          <p class="section-note">连接电脑后刷新查看，或前往服务器管理检查应用授权。</p>
        </div>
        <ul v-else-if="home.phase === 'ready'" class="rabilink-devices">
          <li v-for="device in devices" :key="device.guid || device.id" class="rabilink-device">
            <v-icon icon="mdi-monitor" class="rabilink-device-icon" />
            <div class="rabilink-device-content">
              <div class="d-flex flex-wrap align-center ga-2">
                <strong>{{ device.name || '未命名电脑' }}</strong>
                <v-chip size="x-small" :color="device.online ? 'success' : 'default'" variant="tonal">{{ device.online ? '在线' : '离线' }}</v-chip>
              </div>
              <div class="d-flex flex-wrap ga-2 mt-2">
                <v-chip v-for="label in device.services.known" :key="label" size="small" variant="outlined">{{ label }}</v-chip>
                <span v-if="!device.services.known.length" class="section-note">{{ device.services.advanced.length ? '其他服务能力' : '未声明服务能力' }}</span>
              </div>
              <details class="section-note mt-2">
                <summary>高级信息</summary>
                <dl class="rabilink-device-details">
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
    <LanAgentsPage v-if="tab === 'agents'" />
    <!-- One mounted editor preserves its draft and save registration across tabs. -->
    <RabiLinkSettings v-show="tab === 'config'" :ready="ready" @saving="onSaving" />
  </div>
</template>

<style scoped>
.rabilink-page { min-width: 0; }
.rabilink-toolbar { display: flex; flex-wrap: wrap; align-items: center; gap: 12px; margin-bottom: 12px; }
.rabilink-toolbar .page-title { font-size: 1.5rem; }
.rabilink-toolbar-actions { display: flex; flex-wrap: wrap; gap: 4px; margin-left: auto; }
.rabilink-list-heading { display: flex; flex-wrap: wrap; align-items: baseline; justify-content: space-between; gap: 8px; }
.rabilink-help { margin-top: 8px; max-width: 75ch; }
.rabilink-help p { margin: 8px 0 0; line-height: 1.7; }
summary { cursor: pointer; width: fit-content; }
summary:focus-visible { outline: 2px solid currentColor; outline-offset: 4px; }
.rabilink-empty { display: grid; justify-items: center; text-align: center; gap: 12px; padding: 36px 16px; }
.rabilink-devices { list-style: none; margin: 16px 0 0; padding: 0; border-top: 1px solid var(--rr-border); }
.rabilink-device { display: flex; gap: 14px; padding: 18px 4px; border-bottom: 1px solid var(--rr-border); }
.rabilink-device-icon { margin-top: 2px; color: var(--rr-text-muted); }
.rabilink-device-content { min-width: 0; flex: 1; overflow-wrap: anywhere; }
.rabilink-device-details { display: grid; grid-template-columns: auto 1fr; gap: 4px 12px; margin-top: 8px; }
.rabilink-device-details dd { margin: 0; overflow-wrap: anywhere; }
@media (max-width: 600px) { .rabilink-toolbar-actions { width: 100%; margin-left: 0; } .rabilink-device-details { grid-template-columns: 1fr; } }
</style>
