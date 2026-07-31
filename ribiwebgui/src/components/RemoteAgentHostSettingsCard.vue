<script setup lang="ts">
import { onMounted, ref } from "vue";
import { copyTextToClipboard } from "../clipboard";

type HostSettings = {
  enabled: boolean;
  deviceId: string;
  deviceName: string;
  password: string;
};

type HostStatus = {
  connected?: boolean;
  manager?: Record<string, unknown>;
  discoveryPort?: number;
  lastTaskAt?: string;
  lastError?: string;
};

const settings = ref<HostSettings | null>(null);
const status = ref<HostStatus>({});
const loading = ref(false);
const saving = ref(false);
const message = ref("");
const error = ref("");
const passwordVisible = ref(false);

async function load(): Promise<void> {
  loading.value = true;
  error.value = "";
  try {
    const response = await fetch("/api/remote-agent-host/settings");
    const body = await response.json();
    if (!response.ok || body.code !== 0) throw new Error(body.message || "读取 Remote Agent 设置失败。");
    settings.value = body.settings;
    status.value = body.status || {};
  } catch (loadError) {
    error.value = loadError instanceof Error ? loadError.message : String(loadError);
  } finally {
    loading.value = false;
  }
}

async function save(patch: Record<string, unknown> = {}): Promise<void> {
  if (!settings.value) return;
  saving.value = true;
  message.value = "";
  error.value = "";
  try {
    const response = await fetch("/api/remote-agent-host/settings", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        enabled: settings.value.enabled,
        deviceName: settings.value.deviceName,
        password: settings.value.password,
        ...patch
      })
    });
    const body = await response.json();
    if (!response.ok || body.code !== 0) throw new Error(body.message || "保存 Remote Agent 设置失败。");
    settings.value = body.settings;
    status.value = body.status || status.value;
    message.value = patch.regeneratePassword ? "已生成新的设备密码。" : "Remote Agent 设置已保存。";
  } catch (saveError) {
    error.value = saveError instanceof Error ? saveError.message : String(saveError);
  } finally {
    saving.value = false;
  }
}

async function copyPassword(): Promise<void> {
  if (!settings.value?.password) return;
  await copyTextToClipboard(settings.value.password);
  message.value = "设备密码已复制。";
}

onMounted(() => { void load(); });
</script>

<template>
  <v-card class="app-card glass-card section-card">
    <div class="section-title-row">
      <div>
        <div class="section-title">Remote Agent 消息端</div>
        <div class="section-note">主 RabiManager 通过局域网发现这台设备，并使用设备密码连接。Agent 项目与会话在下方统一配置。</div>
      </div>
      <div class="d-flex ga-2 flex-wrap">
        <v-chip :color="status.connected ? 'success' : 'warning'" variant="tonal">
          {{ status.connected ? "主 Manager 已连接" : "等待主 Manager" }}
        </v-chip>
        <v-btn icon="mdi-refresh" size="small" variant="text" :loading="loading" title="刷新" @click="load" />
      </div>
    </div>

    <v-alert v-if="error" type="error" variant="tonal" density="compact" class="mb-3">{{ error }}</v-alert>
    <v-alert v-if="message" type="success" variant="tonal" density="compact" class="mb-3">{{ message }}</v-alert>

    <div v-if="settings" class="catalog-param-grid">
      <v-text-field
        v-model="settings.deviceName"
        label="设备名称"
        hint="主 RabiManager 扫描时显示的名称"
        persistent-hint
      />
      <v-text-field
        :model-value="settings.deviceId"
        label="设备 ID"
        hint="首次启动自动生成并保持稳定"
        persistent-hint
        readonly
      />
      <v-text-field
        v-model="settings.password"
        :type="passwordVisible ? 'text' : 'password'"
        label="设备密码"
        hint="主 RabiManager 首次连接时输入；至少 16 个字节"
        persistent-hint
      >
        <template #append-inner>
          <v-btn
            :icon="passwordVisible ? 'mdi-eye-off-outline' : 'mdi-eye-outline'"
            size="x-small"
            variant="text"
            title="显示或隐藏密码"
            @click="passwordVisible = !passwordVisible"
          />
          <v-btn icon="mdi-content-copy" size="x-small" variant="text" title="复制密码" @click="copyPassword" />
        </template>
      </v-text-field>
      <div class="d-flex align-center ga-2 flex-wrap">
        <v-switch v-model="settings.enabled" label="允许主 Manager 连接" color="success" inset hide-details />
      </div>
    </div>

    <div v-if="settings" class="agent-action-bar mt-3">
      <div class="agent-action-status">
        <span class="section-note">
          {{ status.lastTaskAt ? `最近任务：${status.lastTaskAt}` : "尚未收到远端任务。" }}
        </span>
      </div>
      <div class="d-flex ga-2 flex-wrap">
        <v-btn variant="tonal" prepend-icon="mdi-key-change" :loading="saving" @click="save({ regeneratePassword: true })">
          生成新密码
        </v-btn>
        <v-btn color="primary" prepend-icon="mdi-content-save" :loading="saving" @click="save()">
          保存消息端设置
        </v-btn>
      </div>
    </div>
  </v-card>
</template>
