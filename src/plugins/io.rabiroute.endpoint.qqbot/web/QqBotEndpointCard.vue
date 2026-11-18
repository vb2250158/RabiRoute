<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { browserUuid } from "../../../../ribiwebgui/src/browserUuid";
import { useGatewayStore } from "../../../../ribiwebgui/src/stores/gatewayStore";
import MessageEndpointDependencyPanel from "../../../../ribiwebgui/src/messageEndpoints/MessageEndpointDependencyPanel.vue";
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
watch(() => props.context?.routeId, () => { closeForm(); void readAccounts(); }, { immediate: true });

function bind(id: string | null) {
  if (gateway.value) { gateway.value.qqbotAccountId = id ?? ""; store.touch(); }
}
function setPort(value: unknown) {
  if (gateway.value) { gateway.value.qqbotCallbackPort = Number(value || 0); store.touch(); }
}
function setTransport(value: "webhook" | "websocket") {
  if (gateway.value) { gateway.value.qqbotTransport = value; store.touch(); }
}
function setIntents(value: unknown) {
  if (gateway.value) { gateway.value.qqbotIntents = Number(value || 0); store.touch(); }
}
function setManagement(value: boolean | null) {
  if (gateway.value) { gateway.value.qqbotManagementEnabled = value !== false; store.touch(); }
}
function openForm(mode: "add" | "edit") {
  form.value = mode;
  appId.value = mode === "edit" ? selected.value?.appId ?? "" : "";
  sandbox.value = mode === "edit" ? selected.value?.sandbox ?? true : true;
  error.value = "";
}
function closeForm() { form.value = undefined; secret.value = ""; }

async function mutate(action: "save" | "refresh" | "logout") {
  if (busy.value) return;
  busy.value = true;
  error.value = "";
  const routeId = props.context?.routeId;
  const account = form.value === "add" ? undefined : selected.value;
  const suffix = account ? `/${account.id}/auth` : "";
  const requestId = browserUuid();
  const submittedSecret = secret.value;
  secret.value = "";
  try {
    const response = await fetch("/meta");
    const meta = await response.json() as { applicationGenerationId?: string; managerInstanceId?: string };
    if (!response.ok || !meta.applicationGenerationId || !meta.managerInstanceId) throw new Error("Manager 身份暂不可用，请刷新页面。");
    const data = await responseData<AccountSnapshot>(await fetch(root + suffix + (action === "refresh" ? "/refresh" : ""), {
      method: action === "logout" ? "DELETE" : "POST",
      headers: { "content-type": "application/json", "idempotency-key": requestId,
        "x-rabiroute-expected-application-generation-id": meta.applicationGenerationId,
        "x-rabiroute-expected-manager-instance-id": meta.managerInstanceId },
      body: JSON.stringify({
        ...(account ? { revision: account.revision } : {}),
        ...(action === "save" ? { appId: appId.value.trim(), appSecret: submittedSecret, sandbox: sandbox.value } : {})
      })
    }));
    if (routeId === props.context?.routeId) {
      if (action === "save") bind(data.id);
      closeForm();
    }
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : "QQ 机器人操作失败。";
  } finally {
    await readAccounts();
    void props.context?.refreshScan?.();
    busy.value = false;
  }
}
</script>

<template>
  <template v-if="gateway">
    <MessageEndpointDependencyPanel :scan="context?.scan" :loading="context?.scanLoading"
      :error="context?.scanError" @refresh="context?.refreshScan?.()" />
    <div class="catalog-param-grid">
      <v-select :model-value="gateway.qqbotAccountId || null" :items="accounts"
        :item-title="(account: AccountSnapshot) => account.appId + (account.sandbox ? ' · 沙箱' : ' · 正式')"
        item-value="id" label="QQ 机器人账号" clearable @update:model-value="bind" />
      <v-select :model-value="gateway.qqbotTransport || 'webhook'" :items="['webhook', 'websocket']"
        label="事件接收方式" @update:model-value="setTransport" />
      <v-text-field v-if="gateway.qqbotTransport !== 'websocket'" :model-value="gateway.qqbotCallbackPort || 0" type="number" :min="0" :max="65535"
        label="本机回调端口" hint="0 由系统分配。固定反向代理请填写固定端口。" persistent-hint
        @update:model-value="setPort" />
      <v-text-field v-else :model-value="gateway.qqbotIntents ?? 33554432" type="number" :min="0" :max="4294967295"
        label="WebSocket 事件权限掩码" hint="使用开放平台已授予的 intents。默认订阅 QQ 群与单聊。"
        persistent-hint @update:model-value="setIntents" />
      <v-switch :model-value="gateway.qqbotManagementEnabled !== false" label="允许 QQ 频道管理操作"
        density="compact" @update:model-value="setManagement" />
      <div class="full-span d-flex flex-wrap ga-2 align-center">
        <v-btn prepend-icon="mdi-plus" :disabled="busy" @click="openForm('add')">添加机器人</v-btn>
        <v-btn v-if="selected" variant="text" :disabled="busy" @click="openForm('edit')">重新授权</v-btn>
        <v-btn v-if="selected?.state === 'connected'" variant="text" :disabled="busy || !!form" @click="mutate('refresh')">检查授权</v-btn>
        <v-btn v-if="selected?.state === 'connected'" variant="text" :disabled="busy || !!form" @click="mutate('logout')">解除授权</v-btn>
        <v-btn variant="text" href="https://q.qq.com/" target="_blank" rel="noopener noreferrer">QQ 开放平台</v-btn>
        <span v-if="selected">{{ selected.state === "connected" ? "凭据验证通过" : "待授权" }}</span>
      </div>
      <template v-if="form">
        <v-text-field v-model="appId" label="AppID" :readonly="form === 'edit'" :disabled="busy" />
        <v-text-field v-model="secret" label="AppSecret" type="password" autocomplete="new-password" :disabled="busy" />
        <v-switch v-model="sandbox" label="使用 QQ 沙箱环境" density="compact" :disabled="busy" />
        <div class="d-flex ga-2">
          <v-btn color="primary" :loading="busy" :disabled="!appId.trim() || !secret.trim()" @click="mutate('save')">验证并保存</v-btn>
          <v-btn variant="text" :disabled="busy" @click="closeForm">取消</v-btn>
        </div>
      </template>
      <v-alert v-if="error" type="error" variant="tonal" density="compact" class="full-span">{{ error }}</v-alert>
      <p v-if="gateway.qqbotTransport !== 'websocket'" class="full-span">保存 Route 后，将公开 HTTPS 地址反向代理到本机 <code>/qqbot</code>，在 QQ 开放平台选择事件订阅。</p>
      <p v-else class="full-span">保存 Route 后，RabiRoute 会使用所选账号连接腾讯网关。连接结果可在 Route 运行日志中查看。</p>
    </div>
  </template>
</template>
