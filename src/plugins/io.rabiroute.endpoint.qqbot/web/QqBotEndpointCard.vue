<script setup lang="ts">
import { computed, onScopeDispose, ref, watch } from "vue";
import { browserUuid } from "../../../../ribiwebgui/src/browserUuid";
import { useGatewayStore } from "../../../../ribiwebgui/src/stores/gatewayStore";
import type { MessageEndpointCardContext } from "../../../../ribiwebgui/src/messageEndpoints/messageEndpointCardContext";
import type { AccountSnapshot } from "../src/accounts";

const props = defineProps<{ context?: MessageEndpointCardContext }>();
const store = useGatewayStore();
const gateway = computed(() => store.selectedGateway);
const accounts = ref<AccountSnapshot[]>([]);
const selected = computed(() => accounts.value.find(account => account.id === gateway.value?.qqbotAccountId));
const form = ref<"add" | "edit">();
const appId = ref("");
const secret = ref("");
const sandbox = ref(true);
const busy = ref(false);
const error = ref("");
const root = "/api/message/qqbot/accounts";

async function responseData<T>(response: Response): Promise<T> {
  const result = await response.json() as { code?: number; data?: T; message?: string };
  if (!response.ok || result.code !== 0 || result.data === undefined) throw new Error(result.message || `请求失败（HTTP ${response.status}）。`);
  return result.data;
}

async function readAccounts() {
  try { accounts.value = await responseData<AccountSnapshot[]>(await fetch(root)); }
  catch (cause) { error.value = cause instanceof Error ? cause.message : "无法读取 QQ 机器人账号。"; }
}

type QrStatus = {
  state: "waiting" | "ready" | "failed" | "cancelled";
  qrCodeDataUrl?: string;
  accounts?: AccountSnapshot[];
  message?: string;
};

const qrMode = ref(false);
const qrImage = ref("");
let cancelQr: (() => void) | undefined;

function stopScan(): void {
  cancelQr?.();
  cancelQr = undefined;
  qrMode.value = false;
  qrImage.value = "";
}

async function startScan(): Promise<void> {
  stopScan();
  closeForm();
  const routeId = gateway.value?.id;
  if (!routeId) return;
  qrMode.value = true;
  error.value = "";
  const path = "/api/message/qqbot/qr/" + encodeURIComponent(browserUuid());
  let active = true;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let headers: Record<string, string> | undefined;
  const remove = () => {
    if (headers) void fetch(path, { method: "DELETE", headers }).catch(() => undefined);
  };
  cancelQr = () => {
    active = false;
    clearTimeout(timer);
    remove();
  };
  function render(result: QrStatus): void {
    if (!active || gateway.value?.id !== routeId) return;
    if (result.state === "failed" || result.state === "cancelled") {
      qrImage.value = "";
      error.value = result.message || "扫码未完成，请重试。";
      return;
    }
    if (result.state === "ready") {
      const account = result.accounts?.[0];
      if (!account) {
        qrImage.value = "";
        error.value = "没有收到机器人，请在手机 QQ 中选择后重试。";
        return;
      }
      bind(account.id);
      stopScan();
      void readAccounts();
      return;
    }
    qrImage.value = result.qrCodeDataUrl || "";
    timer = setTimeout(() => void poll(), 1500);
  }
  function report(cause: unknown): void {
    if (!active) return;
    qrImage.value = "";
    error.value = cause instanceof Error ? cause.message : "无法开始 QQ 扫码。";
  }
  async function poll(): Promise<void> {
    if (!active) return;
    try {
      render(await responseData<QrStatus>(await fetch(path, { headers })));
    } catch (cause) {
      report(cause);
    }
  }
  try {
    const response = await fetch("/meta");
    const identity = await response.json() as { applicationGenerationId?: string; managerInstanceId?: string };
    if (!response.ok || !identity.applicationGenerationId || !identity.managerInstanceId) throw new Error("暂时无法确认当前服务。");
    if (!active) return;
    headers = {
      "x-rabiroute-expected-application-generation-id": identity.applicationGenerationId,
      "x-rabiroute-expected-manager-instance-id": identity.managerInstanceId };
    const result = await responseData<QrStatus>(await fetch(path, { method: "POST", headers }));
    if (active) render(result);
    else remove();
  } catch (cause) {
    report(cause);
  }
}

watch(() => props.context?.routeId, () => { stopScan(); closeForm(); error.value = ""; });
watch(() => props.context?.active !== false, active => {
  if (active) void readAccounts();
  else stopScan();
}, { immediate: true });
watch([() => props.context?.routeId, () => props.context?.active !== false, () => props.context?.loginRequested],
  ([, active, requested]) => {
    if (active && requested && !gateway.value?.qqbotAccountId) void startScan();
  }, { immediate: true });
onScopeDispose(stopScan);

function bind(id: string | null) {
  if (gateway.value) { gateway.value.qqbotAccountId = id ?? ""; store.touch(); }
}
function openForm(mode: "add" | "edit") {
  stopScan();
  form.value = mode;
  appId.value = mode === "edit" ? selected.value?.appId ?? "" : "";
  sandbox.value = mode === "edit" ? selected.value?.sandbox ?? true : true;
  error.value = "";
}
function closeForm() { form.value = undefined; secret.value = ""; }

async function mutate(action: "save" | "logout") {
  if (busy.value) return;
  busy.value = true;
  error.value = "";
  const routeId = gateway.value?.id;
  const account = form.value === "add" ? undefined : selected.value;
  const suffix = account ? `/${account.id}/auth` : "";
  const requestId = browserUuid();
  const credentials = { appId: appId.value.trim(), appSecret: secret.value, sandbox: sandbox.value };
  try {
    const response = await fetch("/meta");
    const meta = await response.json() as { applicationGenerationId?: string; managerInstanceId?: string };
    if (!response.ok || !meta.applicationGenerationId || !meta.managerInstanceId) throw new Error("Manager 身份暂不可用，请刷新页面。");
    const data = await responseData<AccountSnapshot>(await fetch(root + suffix, {
      method: action === "logout" ? "DELETE" : "POST",
      headers: { "content-type": "application/json", "idempotency-key": requestId,
        "x-rabiroute-expected-application-generation-id": meta.applicationGenerationId,
        "x-rabiroute-expected-manager-instance-id": meta.managerInstanceId },
      body: JSON.stringify({
        ...(account ? { revision: account.revision } : {}),
        ...(action === "save" ? credentials : {})
      })
    }));
    if (routeId === gateway.value?.id) {
      if (action === "save") bind(data.id);
      closeForm();
    }
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : "QQ 机器人操作失败。";
  } finally {
    await readAccounts();
    busy.value = false;
  }
}
</script>

<template>
  <div v-if="gateway" class="qqbot-login">
    <v-tabs v-if="props.context?.loginRequested && (qrMode || form === 'add')"
      :model-value="qrMode ? 'qr' : 'manual'" class="mb-3" density="compact" color="primary" grow :disabled="busy"
      @update:model-value="mode => mode === 'qr' ? startScan() : openForm('add')">
      <v-tab value="qr">扫码登录</v-tab>
      <v-tab value="manual">手动填写</v-tab>
    </v-tabs>
    <div v-if="qrMode" class="qqbot-scan">
      <template v-if="qrImage">
        <p class="text-body-2 mb-0">用手机 QQ 扫码，选择要连接的机器人</p>
        <img :src="qrImage" width="192" height="192" alt="QQ 机器人绑定二维码" />
      </template>
      <template v-else-if="!error">
        <v-progress-circular indeterminate color="primary" size="28" />
        <span class="text-body-2" role="status">正在获取二维码</span>
      </template>
      <v-btn v-else size="small" variant="tonal" @click="startScan">重新获取二维码</v-btn>
      <v-btn v-if="!props.context?.loginRequested" size="small" variant="text" @click="openForm('add')">手动填写</v-btn>
    </div>
    <template v-else-if="!form">
      <div class="d-flex flex-wrap align-center ga-2">
        <v-select v-if="accounts.length" class="qqbot-account" :model-value="gateway.qqbotAccountId || null"
          :items="accounts" :item-title="(account: AccountSnapshot) => account.appId + (account.sandbox ? ' · 沙箱' : '')"
          item-value="id" label="账号" density="compact" hide-details :disabled="busy" @update:model-value="bind" />
        <span v-if="selected?.state === 'connected'" class="text-body-2">已登录</span>
        <v-btn v-if="selected" size="small" variant="text" :disabled="busy" @click="openForm('edit')">
          {{ selected.state === "connected" ? "重新授权" : "继续登录" }}
        </v-btn>
        <v-btn v-if="selected?.state === 'connected'" size="small" variant="text" :loading="busy" @click="mutate('logout')">退出登录</v-btn>
        <v-btn color="primary" variant="tonal" size="small" :disabled="busy" @click="startScan">
          {{ accounts.length ? "登录其他账号" : "登录 QQ 机器人" }}
        </v-btn>
      </div>
    </template>

    <form v-else class="qqbot-form" @submit.prevent="mutate('save')">
      <v-select v-if="form === 'add' && accounts.length" :items="accounts"
        :item-title="(account: AccountSnapshot) => account.appId + (account.sandbox ? ' · 沙箱' : '')"
        item-value="id" label="选择已有账号" density="compact" hide-details :disabled="busy"
        @update:model-value="id => { bind(id); closeForm(); }" />
      <div class="qqbot-fields">
        <v-text-field v-model="appId" label="AppID" :readonly="form === 'edit'" :disabled="busy" density="compact" hide-details />
        <v-text-field v-model="secret" label="AppSecret" type="password" autocomplete="new-password"
          :disabled="busy" density="compact" hide-details />
      </div>
      <div class="d-flex align-center flex-wrap ga-2">
        <v-switch v-model="sandbox" label="沙箱" density="compact" hide-details :disabled="busy" />
        <v-btn color="primary" variant="tonal" size="small" type="submit"
          :loading="busy" :disabled="!appId.trim() || !secret.trim()">登录</v-btn>
        <v-btn v-if="form === 'edit' || !props.context?.loginRequested" size="small" variant="text" :disabled="busy" @click="startScan">返回扫码</v-btn>
        <v-btn size="small" variant="text" href="https://q.qq.com/" target="_blank" rel="noopener noreferrer">获取凭据</v-btn>
      </div>
    </form>

    <p v-if="error" class="text-error text-body-2 mt-2 mb-0" role="alert">{{ error }}</p>
  </div>
</template>

<style scoped>
.qqbot-scan {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 16px;
  padding-block: 24px;
}

.qqbot-scan img {
  display: block;
  max-width: 100%;
  height: auto;
  background: white;
  border-radius: 8px;
}
.qqbot-account {
  flex: 0 1 18rem;
  min-width: min(100%, 12rem);
}

.qqbot-form {
  display: grid;
  gap: 8px;
  max-width: 40rem;
}

.qqbot-fields {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(min(100%, 13rem), 1fr));
  gap: 8px;
}
</style>
