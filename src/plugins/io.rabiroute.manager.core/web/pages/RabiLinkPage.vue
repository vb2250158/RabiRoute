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
  rabiLinkCapabilities,
  rabiLinkDeviceDisplayName,
  rabiLinkDeviceIcon,
  rabiLinkDeviceKind,
  rabiLinkDeviceVersionLabel,
  type RabiLinkHomeData
} from "../../../../../ribiwebgui/src/rabiLinkHomeClient";
import { createRabiLinkHomeLoader, type RabiLinkHomeState } from "../../../../../ribiwebgui/src/rabiLinkHomeState";
import ComputerControlPage from "../computer/ComputerControlPage.vue";
import LanAgentsPage from "../../../../../ribiwebgui/src/pages/LanAgentsPage.vue";
import RabiLinkSettings from "../components/RabiLinkSettings.vue";

const route = useRoute();
const router = useRouter();
const store = useGatewayStore();
const { t } = useI18n();
const tab = computed(() => rabiLinkTab(route.query.tab));
const ready = ref(false);
const computerVisited = ref(tab.value === "computer");
watch(tab, value => { if (value === "computer") computerVisited.value = true; });
const saving = ref(false);
const account = ref<{ username: string } | null>(null);
const accountAvailable = ref(false);
const accountUsername = ref("");
const accountPassword = ref("");
const accountBusy = ref(false);
const accountError = ref("");
const refreshing = ref(false);
const error = ref("");
const refreshFence = createRabiLinkRefreshFence();
const runtime = computed(() => store.meta.rabiLinkRelayRuntime);
const connected = computed(() => runtime.value?.state === "online");
const managementUrl = computed(() => rabiLinkManagementUrl(store.meta.rabiLinkRelay?.url));
const statusLabel = computed(() => !ready.value ? "读取状态中" : ({ disabled: "已关闭", incomplete: "配置不完整", connecting: "连接中", online: "已连接", error: "连接失败" }[runtime.value?.state || "disabled"]));
const home = ref<RabiLinkHomeState<RabiLinkHomeData>>({ phase: "idle" });
const homeLoader = createRabiLinkHomeLoader(readRabiLinkHome, value => { home.value = value; }, () => "暂时无法读取已授权设备，请检查服务器连接后重试。");
const devices = computed(() => home.value.phase === "ready" ? home.value.data.devices.map(device => {
  const kind = rabiLinkDeviceKind(device);
  return {
    ...device,
    kind,
    icon: rabiLinkDeviceIcon(device),
    displayName: rabiLinkDeviceDisplayName(device),
    versionLabel: rabiLinkDeviceVersionLabel(device, t),
    services: rabiLinkCapabilities(device.capabilities, kind)
  };
}) : []);
const checkedAt = computed(() => home.value.phase === "ready" ? new Date(home.value.data.checkedAt).toLocaleString("zh-CN") : "");
const serverConfigured = computed(() => Boolean(store.meta.rabiLinkRelay?.enabled && store.meta.rabiLinkRelay.url?.trim()));
let managerEvents: EventSource | undefined;
let metaRequest: AbortController | undefined;
let disposed = false;
async function changeAccount(action: "login" | "register" | "logout") {
  if (accountBusy.value) return;
  accountBusy.value = true;
  accountError.value = "";
  try {
    const response = await fetch("/api/rabilink/host-account", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ action, ...(action === "logout" ? {} : { username: accountUsername.value.trim(), password: accountPassword.value }) })
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.message || "账号操作失败。");
    account.value = data.account;
    await refresh();
  } catch (failure) { accountError.value = failure instanceof Error ? failure.message : "账号操作失败。"; }
  finally { accountPassword.value = ""; accountBusy.value = false; }
}
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
    const [response, accountResponse] = await Promise.all([
      fetch("/meta", { cache: "no-store", signal: controller.signal }),
      fetch("/api/rabilink/host-account", { cache: "no-store", signal: controller.signal }).catch(() => undefined)
    ]);
    if (!response.ok) throw new Error("读取状态失败");
    const meta = await response.json();
    const accountData = accountResponse?.ok ? await accountResponse.json() : null;
    if (disposed || !refreshFence.accepts(revision)) return;
    const { token: _token, ...relay } = meta.rabiLinkRelay || {};
    store.meta = { ...store.meta, ...meta, rabiLinkRelay: relay };
    accountAvailable.value = Boolean(accountData);
    account.value = accountData?.account ?? null;
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
  managerEvents.addEventListener("rabilink_account_changed", () => { if (!accountBusy.value) void refresh(); });
  managerEvents.addEventListener("rabilink_devices_changed", refreshHome);
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
      <v-chip size="small" :color="connected && ready ? 'success' : 'default'" variant="tonal">{{ connected && account ? '账号已连接' : statusLabel }}</v-chip>
      <div class="rabilink-toolbar-actions">
        <v-btn size="small" prepend-icon="mdi-refresh" variant="text" :disabled="saving" :loading="refreshing || home.phase === 'loading'" @click="refresh">刷新</v-btn>
        <v-btn v-if="managementUrl" size="small" :href="managementUrl" target="_blank" rel="noopener noreferrer" variant="outlined" prepend-icon="mdi-open-in-new">服务器管理</v-btn>
      </div>
    </header>
    <v-tabs :model-value="tab" color="primary" class="mb-4" @update:model-value="value => router.replace({ query: { ...route.query, tab: String(value) } })">
      <v-tab value="home">主页</v-tab>
      <v-tab value="agents">节点管理</v-tab>
      <v-tab value="computer">电脑控制</v-tab>
      <v-tab value="config">配置</v-tab>
    </v-tabs>
    <v-alert v-if="error" type="error" variant="tonal" class="mb-4">{{ error }}</v-alert>
    <v-card v-if="ready && (tab === 'home' || tab === 'config')" variant="outlined" class="mb-4">
      <v-card-text>
        <div v-if="account" class="d-flex flex-wrap align-center ga-3">
          <strong>{{ account.username }}</strong>
          <span class="section-note">另一台电脑登录同一服务器上的这个账号，即可出现在我的设备里。</span>
          <v-btn class="ml-auto" size="small" variant="text" :loading="accountBusy" @click="changeAccount('logout')">退出登录</v-btn>
        </div>
        <form v-else class="rabilink-account" @submit.prevent="changeAccount('login')">
          <h2 class="section-title">登录 Rabi 账号</h2>
          <p v-if="!accountAvailable" class="section-note">请在本机打开 RabiRoute 登录。</p>
          <template v-else-if="serverConfigured">
            <p class="section-note">两台电脑登录同一服务器上的同一账号后会自动连接。</p>
            <div class="rabilink-login-fields">
              <v-text-field v-model="accountUsername" label="账号" autocomplete="username" density="compact" hide-details />
              <v-text-field v-model="accountPassword" label="密码" type="password" autocomplete="current-password" density="compact" hide-details />
              <v-btn type="submit" color="primary" :loading="accountBusy" :disabled="saving || !accountUsername.trim() || !accountPassword">登录</v-btn>
              <v-btn variant="outlined" :disabled="saving || accountBusy || !accountUsername.trim() || !accountPassword" @click="changeAccount('register')">注册</v-btn>
            </div>
          </template>
          <div v-else class="d-flex flex-wrap align-center ga-3">
            <p class="section-note">先在配置中填写服务器地址，开启连接并保存。</p>
            <v-btn v-if="tab !== 'config'" color="primary" variant="tonal" :to="{ path: '/rabilink', query: { ...route.query, tab: 'config' } }">前往配置</v-btn>
          </div>
        </form>
        <v-alert v-if="accountError" type="error" variant="tonal" class="mt-3">{{ accountError }}</v-alert>
      </v-card-text>
    </v-card>
    <section v-if="tab === 'home'" aria-label="已授权设备" :aria-busy="home.phase === 'loading'">
      <template v-if="!ready">
        <p v-if="!error" role="status" class="section-note">正在读取连接状态…</p>
      </template>
      <div v-else-if="!connected" class="rabilink-empty">
        <v-icon icon="mdi-lan-disconnect" size="32" />
        <h2 class="section-title">尚未连接服务器</h2>
        <p class="section-note">{{ account ? '正在连接账号设备。连接失败时可检查服务器地址后刷新。' : '保存服务器地址并登录后，设备会显示在这里。' }}</p>
      </div>
      <template v-else>
        <div class="rabilink-list-heading">
          <h2 class="section-title">{{ account ? '我的设备' : '已授权设备' }}</h2>
          <span v-if="home.phase === 'ready'" class="section-note">{{ devices.length }} 台设备 · 更新于 {{ checkedAt }}</span>
        </div>
        <details v-if="!account" class="rabilink-help section-note">
          <summary>查看范围与服务器管理</summary>
          <p>这里只显示当前应用已授权的设备（包括电脑、手机与眼镜等端侧设备）。服务标签表示设备声明支持的能力，不代表服务正在运行。服务器管理在新窗口打开，需要使用服务器账号独立登录；应用令牌不能代替网页登录。</p>
        </details>
        <v-progress-linear v-if="home.phase === 'loading'" indeterminate aria-label="正在读取已授权设备" class="mt-3" />
        <p v-if="home.phase === 'loading'" role="status" class="section-note py-4">正在读取已授权设备…</p>
        <v-alert v-else-if="home.phase === 'error'" type="error" variant="tonal" class="mt-3">
          {{ home.error }}
          <v-btn variant="text" size="small" @click="refreshHome">重试</v-btn>
        </v-alert>
        <p v-else-if="saving" role="status" class="section-note py-4">正在保存连接设置…</p>
        <div v-else-if="home.phase === 'ready' && !devices.length" class="rabilink-empty">
          <v-icon icon="mdi-devices" size="32" />
          <h3 class="section-title">{{ account ? '等待设备上线' : '当前应用尚无已授权设备' }}</h3>
        </div>
        <ul v-else-if="home.phase === 'ready'" class="rabilink-devices">
          <li v-for="device in devices" :key="device.id" class="rabilink-device">
            <v-icon :icon="device.icon" class="rabilink-device-icon" />
            <div class="rabilink-device-content">
              <div class="d-flex flex-wrap align-center ga-2">
                <strong>{{ device.displayName }}</strong>
                <v-chip v-if="device.isLocal" size="x-small" variant="outlined">{{ t('本机') }}</v-chip>
                <span v-if="device.versionLabel" class="section-note" data-no-i18n>{{ device.versionLabel }}</span>
                <v-chip size="x-small" :color="device.online ? 'success' : 'default'" variant="tonal">{{ device.online ? '在线' : '离线' }}</v-chip>
              </div>
              <div class="d-flex flex-wrap ga-2 mt-2">
                <v-chip v-for="label in device.services.known" :key="label" size="small" variant="outlined">{{ label }}</v-chip>
                <span v-if="!device.services.known.length" class="section-note">{{ device.services.advanced.length ? '其他服务能力' : '未声明服务能力' }}</span>
              </div>
              <v-btn v-if="device.kind === 'desktop'" class="mt-2" size="small" variant="tonal" prepend-icon="mdi-remote-desktop" :to="{ path: '/rabilink', query: { tab: 'computer', deviceId: device.isLocal ? undefined : device.id } }">查看电脑控制</v-btn>
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
    <ComputerControlPage v-if="computerVisited" v-show="tab === 'computer'" :active="tab === 'computer'" />
    <RabiLinkSettings v-show="tab === 'config'" :ready="ready" :active="tab === 'config'" @saving="onSaving" />
  </div>
</template>

<style scoped>
.rabilink-page { min-width: 0; }
.rabilink-toolbar { display: flex; flex-wrap: wrap; align-items: center; gap: 12px; margin-bottom: 12px; }
.rabilink-toolbar .page-title { font-size: 1.5rem; }
.rabilink-toolbar-actions { display: flex; flex-wrap: wrap; gap: 4px; margin-left: auto; }
.rabilink-account { display: grid; gap: 10px; }
.rabilink-login-fields { display: flex; flex-wrap: wrap; align-items: center; gap: 10px; max-width: 720px; }
.rabilink-login-fields :deep(.v-input) { flex: 1 1 170px; }
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
