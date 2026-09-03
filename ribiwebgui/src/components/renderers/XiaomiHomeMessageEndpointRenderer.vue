<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import type { XiaomiHomeAuthorizationSnapshot } from "@shared/xiaomiHomeAuthContract";
import type { XiaomiHomeSettingsSnapshot } from "@shared/xiaomiHomeSettingsContract";
import { xiaomiHomeAuthClient } from "../../xiaomiHomeAuthClient";
import { xiaomiHomeSettingsClient } from "../../xiaomiHomeSettingsClient";

const authorization = ref<XiaomiHomeAuthorizationSnapshot | null>(null);
const settings = ref<XiaomiHomeSettingsSnapshot | null>(null);
const baseUrl = ref("");
const accessToken = ref("");
const loading = ref(true);
const busy = ref(false);
const error = ref("");
const confirmationOpen = ref(false);

const stateLabel = computed(() => ({
  ready: "已连接",
  authorization_required: "等待登录",
  authorization_failed: "凭证失效",
  unreachable: "服务不可达",
  timeout: "连接超时"
}[authorization.value?.state || "authorization_required"]));

const stateColor = computed(() => authorization.value?.state === "ready"
  ? "success"
  : authorization.value?.state === "authorization_required"
    ? "info"
    : "warning");

const sourceLabel = computed(() => authorization.value?.credentialSource === "protected"
  ? "本机受保护凭证"
  : "尚未保存凭证");

async function load(): Promise<void> {
  loading.value = true;
  try {
    const [nextSettings, nextAuthorization] = await Promise.all([
      xiaomiHomeSettingsClient.read(),
      xiaomiHomeAuthClient.read()
    ]);
    settings.value = nextSettings;
    baseUrl.value = nextSettings.settings.baseUrl;
    authorization.value = nextAuthorization;
    error.value = "";
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : String(cause);
  } finally {
    loading.value = false;
  }
}

async function connect(): Promise<void> {
  if (busy.value) return;
  const candidate = accessToken.value.trim();
  if (!candidate) {
    error.value = "请粘贴 Home Assistant 长期访问令牌。";
    return;
  }
  if (!settings.value) {
    error.value = "米家设置尚未加载。";
    return;
  }
  const normalizedBaseUrl = baseUrl.value.trim().replace(/\/+$/, "");
  if (!normalizedBaseUrl) {
    error.value = "请填写 Home Assistant 地址。";
    return;
  }
  if (!authorization.value) {
    error.value = "米家授权状态尚未加载。";
    return;
  }
  const authorizationRevision = authorization.value.revision;
  busy.value = true;
  try {
    authorization.value = await xiaomiHomeAuthClient.connect({
      accessToken: candidate,
      baseUrl: normalizedBaseUrl,
      settingsRevision: settings.value.revision,
      authorizationRevision
    });
    settings.value = await xiaomiHomeSettingsClient.read();
    baseUrl.value = settings.value.settings.baseUrl;
    error.value = "";
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : String(cause);
  } finally {
    accessToken.value = "";
    busy.value = false;
  }
}

async function refresh(): Promise<void> {
  if (busy.value) return;
  busy.value = true;
  try {
    if (!authorization.value) throw new Error("米家授权状态尚未加载。");
    authorization.value = await xiaomiHomeAuthClient.refresh(authorization.value.revision);
    error.value = "";
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : String(cause);
  } finally {
    busy.value = false;
  }
}

async function disconnect(): Promise<void> {
  if (busy.value) return;
  confirmationOpen.value = false;
  busy.value = true;
  try {
    if (!authorization.value) throw new Error("米家授权状态尚未加载。");
    authorization.value = await xiaomiHomeAuthClient.disconnect(authorization.value.revision);
    error.value = "";
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : String(cause);
  } finally {
    busy.value = false;
  }
}

onMounted(() => void load());
</script>

<template>
  <div class="xiaomi-home-endpoint-auth">
    <div class="section-title-row">
      <div>
        <div class="section-title small-title">连接 Home Assistant</div>
        <div class="section-note">在这里完成米家消息端所需的地址与凭证；凭证由本机后端加密保存，页面不会再次读取或回显。</div>
      </div>
      <v-chip v-if="authorization" size="small" variant="tonal" :color="stateColor">{{ stateLabel }}</v-chip>
    </div>
    <v-progress-linear v-if="loading" indeterminate color="secondary" class="my-3" />
    <v-alert v-if="error" type="error" variant="tonal" density="compact" class="my-3">{{ error }}</v-alert>

    <template v-if="!loading && settings && authorization">
      <v-text-field
        v-model="baseUrl"
        label="Home Assistant 地址"
        placeholder="http://127.0.0.1:8123"
        hint="默认只接受本机或私网地址；保存与登录均受当前 Manager 代际围栏保护。"
        persistent-hint
        class="mt-3"
      />
      <v-text-field
        v-model="accessToken"
        type="password"
        autocomplete="new-password"
        label="长期访问令牌"
        placeholder="只在本次连接请求中发送"
        :disabled="busy"
        class="mt-3"
        @keyup.enter="connect"
      />
      <div class="endpoint-actions">
        <v-btn color="primary" :loading="busy" prepend-icon="mdi-shield-key-outline" @click="connect">
          {{ authorization.configured ? "验证并替换凭证" : "验证并连接" }}
        </v-btn>
        <v-btn variant="tonal" :disabled="busy || !authorization.configured" prepend-icon="mdi-refresh" @click="refresh">检查连接</v-btn>
        <v-btn
          v-if="authorization.removable"
          color="error"
          variant="text"
          :disabled="busy"
          prepend-icon="mdi-logout"
          @click="confirmationOpen = true"
        >移除本机凭证</v-btn>
      </div>
      <div class="credential-summary mt-3">
        <span>{{ sourceLabel }}</span>
        <span v-if="authorization.providerName">{{ authorization.providerName }}</span>
        <span v-if="authorization.providerVersion">Home Assistant {{ authorization.providerVersion }}</span>
      </div>
    </template>

    <v-dialog v-model="confirmationOpen" max-width="480">
      <v-card>
        <v-card-title>移除米家凭证？</v-card-title>
        <v-card-text>事件监听和设备读取会立即停止；Home Assistant 地址与其他米家设置仍会保留。</v-card-text>
        <v-card-actions>
          <v-spacer />
          <v-btn variant="text" @click="confirmationOpen = false">取消</v-btn>
          <v-btn color="error" variant="flat" @click="disconnect">确认移除</v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>
  </div>
</template>

<style scoped>
.xiaomi-home-endpoint-auth {
  display: grid;
  gap: 4px;
}
.endpoint-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  margin-top: 12px;
}
.credential-summary {
  display: flex;
  flex-wrap: wrap;
  gap: 8px 14px;
  color: rgb(var(--v-theme-on-surface-variant));
  font-size: 0.82rem;
}
</style>
