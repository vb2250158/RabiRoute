<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from "vue";
import { createDshConnectionClient, dshConnectionLabel, isLocalDshSetupPage, type DshConnection } from "../dshConnectionClient";
const props = defineProps<{ baseUrl?: string }>();
const emit = defineEmits<{ "update:baseUrl": [value: string] }>();
const client = createDshConnectionClient();
const localSetup = isLocalDshSetupPage(window.location);
const launchUrl = ref("");
const endpoints = ref<DshConnection[]>([]);
const connection = ref<DshConnection>();
const busy = ref(false);
const error = ref("");
const notice = ref("");
const confirmDisconnect = ref("");
let alive = true;
onBeforeUnmount(() => { alive = false; launchUrl.value = ""; });
async function refresh() {
  if (busy.value) return;
  busy.value = true;
  error.value = "";
  try {
    const rows = await client.list();
    const status = props.baseUrl ? await client.status(props.baseUrl) : undefined;
    if (alive) { endpoints.value = rows; connection.value = status; }
  } catch (cause) { if (alive) error.value = cause instanceof Error ? cause.message : "无法读取连接状态，请稍后刷新。"; }
  finally { if (alive) busy.value = false; }
}
function selectOrigin(value: string | null) {
  if (!value || busy.value) return;
  emit("update:baseUrl", value);
  connection.value = endpoints.value.find(row => row.baseUrl === value);
  notice.value = "已选择地址。请点击刷新连接状态，或使用页面原有的扫描按钮获取会话。";
}
async function connect(existing = false) {
  if (busy.value || !localSetup) return;
  busy.value = true; error.value = ""; notice.value = "";
  try {
    const result = await client.connect(existing ? { baseUrl: props.baseUrl } : { launchUrl: launchUrl.value.trim() });
    if (!alive) return;
    connection.value = result;
    endpoints.value = [...endpoints.value.filter(row => row.baseUrl !== result.baseUrl), result];
    emit("update:baseUrl", result.baseUrl);
    notice.value = result.state === "connected"
      ? "连接验证通过，授权已保存。请点击页面原有的扫描按钮获取会话；已有会话绑定未更改。"
      : "连接尚未就绪。请确认 DSH 已启动，并使用当前登录链接重新连接。";
  } catch (cause) { if (alive) error.value = cause instanceof Error ? cause.message : "连接失败，请刷新状态。"; }
  finally { launchUrl.value = ""; if (alive) busy.value = false; }
}
async function disconnect() {
  const target = confirmDisconnect.value;
  if (busy.value || !localSetup || !target || target !== props.baseUrl) { confirmDisconnect.value = ""; return; }
  busy.value = true; error.value = ""; notice.value = "";
  try {
    await client.disconnect(target);
    if (!alive) return;
    if (props.baseUrl === target) connection.value = { baseUrl: target, state: "disconnected" };
    endpoints.value = endpoints.value.filter(row => row.baseUrl !== target);
    notice.value = "已移除 RabiRoute 保存的授权。DSH 会话和现有会话绑定未删除。";
    confirmDisconnect.value = "";
  } catch (cause) { if (alive) error.value = cause instanceof Error ? cause.message : "操作失败，请刷新状态。"; }
  finally { launchUrl.value = ""; if (alive) busy.value = false; }
}
onMounted(refresh);
</script>

<template>
  <v-card variant="outlined" class="mb-3" aria-label="DSH 连接">
    <v-card-title>连接 DSH</v-card-title>
    <v-card-text>
      <v-chip size="small" class="mb-2">{{ dshConnectionLabel(connection?.baseUrl === baseUrl ? connection?.state : undefined) }}</v-chip>
      <p class="mb-3">授权加密保存在运行 RabiRoute 的这台电脑上，不随人格同步。正常重启可沿用；过期、地址改变或 DSH 撤销认证后需重新连接。保存授权不表示当前在线。授权立即保存，不随路线表单的取消而撤销。</p>
      <v-alert v-if="localSetup" type="warning" variant="tonal" class="mb-3">连接将允许 RabiRoute 访问此 DSH 的完整 Web 会话功能，包括读取会话和提交任务，并非仅发送消息。只连接你信任的本机 DSH。</v-alert>
      <v-alert v-if="!localSetup" type="info" variant="tonal" class="mb-3">
        请到运行 RabiRoute 的电脑上打开本机控制台完成授权。远端页面中的本机地址不代表你正在使用的电脑；连接其他电脑请使用远端 Agent 接入。
      </v-alert>
      <v-select v-if="endpoints.length" :model-value="baseUrl" :items="endpoints" item-title="baseUrl" item-value="baseUrl" label="已保存的 DSH 地址" :disabled="busy" @update:model-value="selectOrigin" />
      <template v-if="localSetup">
        <p class="mb-2">启动 DSH，复制它提供的登录链接，粘贴到下方后点击连接。链接包含访问凭据，请勿分享；提交后此输入会清空。</p>
        <v-text-field v-model="launchUrl" type="password" label="DSH 登录链接" autocomplete="off" :spellcheck="false" :disabled="busy" @keydown.enter.prevent="launchUrl.trim() && connect()" />
        <v-btn color="primary" :disabled="busy || !launchUrl.trim()" :loading="busy" @click="connect()">连接 DSH</v-btn>
        <v-btn v-if="baseUrl" variant="text" :disabled="busy" @click="connect(true)">验证并保存现有连接</v-btn>
      </template>
      <v-btn variant="text" prepend-icon="mdi-refresh" :disabled="busy" @click="refresh">刷新连接状态</v-btn>
      <p v-if="connection?.expiresAt && connection.baseUrl === baseUrl" class="mt-2">授权有效期至 {{ new Date(connection.expiresAt).toLocaleString() }}。过期后请重新连接。</p>
      <v-alert v-if="error" type="error" variant="tonal" class="mt-3" role="alert">{{ error }}</v-alert>
      <v-alert v-if="notice" type="info" variant="tonal" class="mt-3" role="status">{{ notice }}</v-alert>
      <v-btn v-if="localSetup && baseUrl" variant="text" class="mt-2" :disabled="busy" @click="confirmDisconnect = baseUrl || ''">移除保存的授权</v-btn>
      <v-alert v-if="confirmDisconnect && confirmDisconnect === baseUrl" type="warning" variant="tonal" class="mt-2">
        仅移除 {{ confirmDisconnect }} 在 RabiRoute 保存的授权，不会删除 DSH 会话或退出其他已登录的客户端。后续投递需要重新授权。
        <div class="mt-2"><v-btn :disabled="busy" @click="disconnect">确认移除</v-btn><v-btn variant="text" :disabled="busy" @click="confirmDisconnect = ''">取消</v-btn></div>
      </v-alert>
    </v-card-text>
  </v-card>
</template>
