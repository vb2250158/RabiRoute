<script setup lang="ts">
import { userFacingError } from "../../userFacingError";
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import type { XiaomiHomeRuntimeSettings, XiaomiHomeSettingsSnapshot } from "@shared/xiaomiHomeSettingsContract";
import { registerPageSaveAction } from "../../pageSaveAction";
import { xiaomiHomeSettingsClient, type XiaomiHomeResource } from "../../xiaomiHomeSettingsClient";

import type { MessageAdapterScanResult } from "../../types";

const props = defineProps<{
  context?: {
    scan?: MessageAdapterScanResult;
    scanError?: string;
    scanLoading?: boolean;
    refreshScan?: () => Promise<void>;
  };
}>();
const monitorRequirement = computed(() => props.context?.scan?.requirements?.find(item => item.id === "event-monitor"));

type XiaomiHomeSettingsDraft = { -readonly [Key in keyof XiaomiHomeRuntimeSettings]: XiaomiHomeRuntimeSettings[Key] };

const snapshot = ref<XiaomiHomeSettingsSnapshot | null>(null);
const draft = ref<XiaomiHomeSettingsDraft | null>(null);
const cameraMotionEntities = ref("");
const cameraAllowedHosts = ref("");
const loading = ref(true);
const saving = ref(false);
const hydrating = ref(true);
const dirty = ref(false);
const error = ref("");
const resources = ref<readonly XiaomiHomeResource[]>([]);
const resourceError = ref("");
const speechBindings = ref<Array<{ mediaPlayerEntityId: string; notifyEntityId: string; encoding: "text" | "json-array" }>>([]);
const speakers = computed(() => resources.value.filter(item => item.kind === "media_player").map(item => ({ title: item.displayName, value: item.entityId })));
const speechTargets = computed(() => resources.value.filter(item => item.kind === "notify").map(item => ({ title: item.displayName, value: item.entityId })));
async function refreshResources(): Promise<void> {
  try { resources.value = await xiaomiHomeSettingsClient.listResources(); resourceError.value = ""; }
  catch (cause) { resourceError.value = userFacingError(cause); }
}
const ready = computed(() => !loading.value && !!snapshot.value && !!draft.value);
let unregisterSaveAction: (() => void) | undefined;

const RECOMMENDED_MEDIA_HOSTS = [
  "fds.api.xiaomi.com",
  "cn.fds.api.xiaomi.com",
  "api.io.mi.com",
  "cdn.fds.api.xiaomi.com"
] as const;

function lines(value: readonly string[]): string {
  return value.join("\n");
}

function parsedLines(value: string): readonly string[] {
  return [...new Set(value.split(/[,\n]/).map(item => item.trim()).filter(Boolean))];
}

function applyRecommendedHosts(): void {
  const current = parsedLines(cameraAllowedHosts.value);
  const merged = [...new Set([...current, ...RECOMMENDED_MEDIA_HOSTS])];
  cameraAllowedHosts.value = lines(merged);
  dirty.value = true;
}

function hydrate(value: XiaomiHomeSettingsSnapshot): void {
  hydrating.value = true;
  snapshot.value = value;
  draft.value = structuredClone(value.settings);
  speechBindings.value = structuredClone(value.settings.speechBindings ?? []) as typeof speechBindings.value;
  cameraMotionEntities.value = lines(value.settings.cameraMotionEntityIds);
  cameraAllowedHosts.value = lines(value.settings.cameraClipAllowedHosts);
  void nextTick(() => {
    dirty.value = false;
    hydrating.value = false;
  });
}

async function load(): Promise<void> {
  loading.value = true;
  try {
    hydrate(await xiaomiHomeSettingsClient.read());
    void refreshResources();
    error.value = "";
  } catch (cause) {
    error.value = userFacingError(cause);
  } finally {
    loading.value = false;
  }
}

async function save(): Promise<void> {
  if (!snapshot.value || !draft.value || saving.value) return;
  saving.value = true;
  try {
    const settings: XiaomiHomeRuntimeSettings = {
      ...draft.value,
      speechBindings: speechBindings.value,
      cameraMotionEntityIds: parsedLines(cameraMotionEntities.value),
      cameraClipAllowedHosts: parsedLines(cameraAllowedHosts.value)
    };
    hydrate(await xiaomiHomeSettingsClient.update(snapshot.value, settings));
    error.value = "";
    await props.context?.refreshScan?.();
  } catch (cause) {
    error.value = userFacingError(cause);
    throw cause;
  } finally {
    saving.value = false;
  }
}

watch([draft, cameraMotionEntities, cameraAllowedHosts, speechBindings], () => {
  if (!hydrating.value && ready.value) dirty.value = true;
}, { deep: true });

onMounted(() => {
  unregisterSaveAction = registerPageSaveAction({ dirty, ready, saving, save });
  void load();
});

onBeforeUnmount(() => unregisterSaveAction?.());
</script>

<template>
  <v-card class="app-card glass-card section-card xiaomi-home-message-endpoint-settings">
    <div class="section-title-row">
      <div>
        <div class="section-title">事件、设备控制与录像基础设置</div>
        <div class="section-note">配置底层连接开关与媒体参数；具体摄像头的业务触发规则请前往「人格配置 → 自动化」添加。</div>
      </div>
      <v-chip v-if="snapshot" size="small" variant="tonal" :color="snapshot.source === 'runtime' ? 'success' : 'info'">
        {{ snapshot.source === "runtime" ? "本机设置" : "Profile 默认值" }}
      </v-chip>
    </div>
    <v-progress-linear v-if="loading" indeterminate color="secondary" class="mb-3" />
    <v-alert v-if="error" type="error" variant="tonal" density="compact" class="mb-3">{{ error }}</v-alert>

    <template v-if="draft">
      <div class="xiaomi-switch-grid mt-2">
        <section aria-label="监听设备事件">
          <v-switch v-model="draft.eventMonitorEnabled" label="监听设备事件" color="success" inset hide-details />
          <div v-if="draft.eventMonitorEnabled !== snapshot?.settings.eventMonitorEnabled" class="section-note">尚未保存</div>
          <div v-else-if="!draft.eventMonitorEnabled" class="section-note">已关闭</div>
          <v-alert v-else-if="context?.scanError" type="error" variant="tonal" density="compact">{{ context.scanError }}</v-alert>
          <div v-else role="status" class="section-note">{{ monitorRequirement?.detail || '尚未检查' }}</div>
          <v-btn size="small" variant="text" :loading="context?.scanLoading" @click="context?.refreshScan?.()">检查事件监听</v-btn>
        </section>
        <section aria-label="设备控制"><div class="text-subtitle-2">设备控制</div><div class="section-note">连接成功后即可使用设备支持的动作。</div></section>
        <section aria-label="摄像头事件录像">
          <v-switch v-model="draft.cameraClipCaptureEnabled" label="保存移动事件录像" color="warning" inset hide-details />
          <div class="section-note">{{ draft.cameraClipCaptureEnabled !== snapshot?.settings.cameraClipCaptureEnabled ? '尚未保存' : draft.cameraClipCaptureEnabled ? '已开启' : '已关闭' }}</div>
        </section>
      </div>

      <section aria-label="音箱播报" class="media-hosts-card mt-3 pa-4">
        <div class="text-subtitle-2 font-weight-bold">音箱播报</div>
        <div class="section-note">将音箱绑定到它的“播放文本”服务，保存后 Agent 可以播报文字。请核对设备归属，选择播报服务。</div>
        <v-alert v-if="resourceError" type="info" density="compact" variant="tonal">{{ resourceError }}；设备选择仅支持在运行 Rabi 的电脑上访问。</v-alert>
        <div v-for="(binding, index) in speechBindings" :key="index" class="xiaomi-form-grid mt-3">
          <v-select v-model="binding.mediaPlayerEntityId" :items="speakers" label="音箱" />
          <v-select v-model="binding.notifyEntityId" :items="speechTargets" label="文字播报服务" />
          <v-select v-model="binding.encoding" :items="[{title: '小米文字播报', value: 'json-array'}, {title: '普通文本通知', value: 'text'}]" label="服务格式" />
          <v-btn variant="text" @click="speechBindings.splice(index, 1)">移除绑定</v-btn>
        </div>
        <v-btn size="small" variant="tonal" class="mt-2" @click="speechBindings.push({mediaPlayerEntityId: '', notifyEntityId: '', encoding: 'json-array'})">添加音箱</v-btn>
        <v-btn size="small" variant="text" class="mt-2" @click="refreshResources">刷新设备</v-btn>
      </section>
      <div class="media-hosts-card mt-3 pa-4">
        <div class="d-flex align-center justify-space-between mb-1">
          <div>
            <div class="text-subtitle-2 font-weight-bold">录像媒体域名白名单</div>
            <div class="text-caption text-medium-emphasis">用于防止 SSRF；仅允许从白名单中的 HTTPS 主机下载切片视频。</div>
          </div>
          <v-btn
            size="small"
            variant="tonal"
            color="info"
            prepend-icon="mdi-playlist-check"
            title="自动填入小米云端对象存储（FDS/CDN）常用域名"
            @click="applyRecommendedHosts"
          >
            填入小米推荐 CDN
          </v-btn>
        </div>
        <v-textarea
          v-model="cameraAllowedHosts"
          placeholder="fds.api.xiaomi.com&#10;cn.fds.api.xiaomi.com&#10;api.io.mi.com&#10;cdn.fds.api.xiaomi.com"
          rows="3"
          density="compact"
          variant="outlined"
          class="mt-2"
          hint="每行一个 HTTPS 主机；只放行真实事件录像切片使用的域名。"
          :error-messages="draft.cameraClipCaptureEnabled && !cameraAllowedHosts.trim() ? '录像抓取已开启，但媒体域名白名单为空，因此仍不会下载录像。' : ''"
          persistent-hint
        />
      </div>

      <v-expansion-panels variant="accordion" class="mt-3">
        <v-expansion-panel>
          <v-expansion-panel-title>高级设置</v-expansion-panel-title>
          <v-expansion-panel-text>
            <div class="xiaomi-form-grid">
              <v-select v-model="draft.eventDeliveryMode" label="事件投递范围" :items="[{ title: '重要事件', value: 'significant' }, { title: '全部状态变化', value: 'all' }]" />
              <v-text-field v-model="draft.agentRoleId" label="事件接收人格" />
              <v-text-field v-model.number="draft.requestTimeoutMs" type="number" min="250" max="30000" label="Home Assistant 请求超时（毫秒）" />
              <v-text-field v-model="draft.ffmpegPath" label="ffmpeg 路径" />
              <v-text-field v-model="draft.ffprobePath" label="ffprobe 路径" />
              <v-text-field v-model.number="draft.cameraClipRequestTimeoutMs" type="number" min="1000" max="30000" label="录像分片请求超时（毫秒）" />
              <v-text-field v-model.number="draft.cameraClipMaxSegments" type="number" min="1" max="500" label="单段录像最大分片数" />
              <v-text-field v-model.number="draft.cameraClipMaxSegmentBytes" type="number" min="1024" max="134217728" label="单分片最大字节数" />
            </div>
            <v-switch v-model="draft.allowPublicBaseUrl" label="允许 Home Assistant 域名或公网地址（仍禁止重定向）" color="warning" inset hide-details />
            <v-switch v-model="draft.allowInsecurePrivateHttp" label="允许非回环私网使用不安全 HTTP（令牌可能被局域网截获）" color="error" inset hide-details />
          </v-expansion-panel-text>
        </v-expansion-panel>
      </v-expansion-panels>
      <div class="section-note mt-3">修改由页面顶部“保存”统一提交；保存成功后 Manager 热加载，无需重启正式 Host。</div>
    </template>
  </v-card>
</template>

<style scoped>
.xiaomi-form-grid,
.xiaomi-switch-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 12px 16px;
}
.xiaomi-switch-grid {
  grid-template-columns: repeat(3, minmax(0, 1fr));
}
.media-hosts-card {
  border: 1px solid rgba(var(--v-border-color), var(--v-border-opacity));
  border-radius: 8px;
  background: rgba(var(--v-theme-surface), 0.4);
}
@media (max-width: 760px) {
  .xiaomi-form-grid,
  .xiaomi-switch-grid { grid-template-columns: 1fr; }
}
</style>
