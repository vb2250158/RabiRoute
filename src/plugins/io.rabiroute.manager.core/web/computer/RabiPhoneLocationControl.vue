<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from "vue";
import { useI18n } from "../../../../../ribiwebgui/src/i18n/index";
import { requestPhoneLocationOperation } from "../../../../../ribiwebgui/src/rabiLinkHomeClient";
import type { PhoneDevice } from "./phoneDevice";

const props = defineProps<{ phone: PhoneDevice }>();
const { t } = useI18n();
const enabled = ref<boolean>();
const permission = ref("");
const busy = ref(false);
const error = ref(false);
const position = ref<Record<string, unknown>>();
let request: AbortController | undefined;
const states: Record<string, string> = {
  "feature-disabled": "定位访问已关闭",
  "permission-required": "请在手机上授予定位权限",
  "foreground-required": "请在手机上打开 RabiLink 后重试",
  "location-disabled": "请打开手机的系统定位",
  "permission-changed": "手机定位权限已变化，请刷新状态",
  timeout: "等待定位超时",
};

async function run(input: Record<string, unknown>) {
  if (busy.value) return;
  const controller = new AbortController();
  request = controller;
  busy.value = true;
  error.value = false;
  if (input.action === "location.read" || input.enabled === false) position.value = undefined;
  try {
    const result = await requestPhoneLocationOperation(props.phone, input, controller.signal);
    if (controller.signal.aborted) return;
    if (input.action === "location.read") position.value = result;
    else {
      if (typeof result.enabled !== "boolean" || typeof result.permission !== "string") throw new Error("Invalid location settings");
      enabled.value = result.enabled;
      permission.value = result.permission;
    }
  } catch {
    if (!controller.signal.aborted) error.value = true;
  } finally {
    if (request === controller) busy.value = false;
  }
}

onMounted(() => void run({ action: "location.settings.read" }));
onBeforeUnmount(() => request?.abort());
</script>

<template>
  <section class="location-row">
    <div class="location-summary">
      <strong><v-icon icon="mdi-map-marker-outline" size="18" class="me-2" />{{ t('定位访问') }}</strong>
      <span v-if="permission === 'none'">{{ t('请在手机上授予定位权限') }}</span>
    </div>
    <v-btn variant="tonal" size="small" :disabled="busy || !enabled || permission === 'none'"
      @click="run({ action: 'location.read', includePlace: true })">{{ t('读取当前位置') }}</v-btn>
    <v-switch v-if="enabled !== undefined" :model-value="enabled" :disabled="busy" :loading="busy"
      :aria-label="t('定位访问')" hide-details color="success"
      @update:model-value="value => run({ action: 'location.settings.update', enabled: value === true })" />
    <v-btn v-if="error || permission === 'none'" size="small" variant="text" :disabled="busy"
      @click="run({ action: 'location.settings.read' })">{{ t('刷新状态') }}</v-btn>
    <p v-if="error" class="location-result" role="status">{{ t('无法确认手机定位状态，请刷新。') }}</p>
    <p v-else-if="position" class="location-result" role="status">
      <template v-if="position.state === 'ok'">
        <span v-if="position.precision === 'approximate'">{{ t('近似位置') }} · </span>
        <span v-if="position.place">{{ position.place }} · </span>{{ position.latitude }}, {{ position.longitude }} ({{ position.coordinateSystem }})
        · {{ Math.round(Number(position.accuracyMeters)) }} {{ t('米') }}
        <span v-if="position.observedAt"> · {{ new Date(String(position.observedAt)).toLocaleString() }}</span>
      </template>
      <template v-else>{{ t(states[String(position.state)] || '当前位置暂不可用') }}</template>
    </p>
  </section>
</template>

<style scoped>
.location-row { display: flex; flex-wrap: wrap; align-items: center; gap: 12px; min-height: 62px; }
.location-summary { flex: 1 1 210px; display: grid; gap: 4px; }
.location-summary span, .location-result { color: var(--rr-muted); font-size: .85rem; }
.location-result { flex-basis: 100%; margin: 0; overflow-wrap: anywhere; }
</style>
