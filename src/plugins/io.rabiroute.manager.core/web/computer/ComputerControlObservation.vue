<script setup lang="ts">
import { useI18n } from "../../../../../ribiwebgui/src/i18n/index";
import { computed, reactive, ref, watch } from "vue";
import { computerRequestSchema } from "@shared/agentInteractiveProtocol";
import type { ComputerFieldSchema } from "./computerControlPresentation";
import ComputerControlSchemaFields from "./ComputerControlSchemaFields.vue";

const { t } = useI18n();
const props = defineProps<{
  windows: Record<string, unknown>[];
  displays?: Record<string, unknown>[];
  foregroundDisplayId?: string;
  layoutRevision?: string;
  capabilities?: string[];
  disabled?: boolean;
  busy?: boolean;
}>();
const emit = defineEmits<{
  submit: [Record<string, unknown>];
  "source-change": [];
}>();
const requestSchema = computerRequestSchema as {
  anyOf: Array<{ properties: Record<string, ComputerFieldSchema> & { action: { const: string } } }>;
};
const captureBranch = requestSchema.anyOf.find(branch => branch.properties.action.const === "screen.capture");
const scopes = captureBranch?.properties.scope?.enum ?? [];
const supportsDisplays = scopes.includes("display") && scopes.includes("region");
const source = ref(supportsDisplays ? "display" : "desktop");
const selectedWindow = ref("");
const selectedDisplay = ref("");
const parameters = ref<Record<string, unknown>>({});
const region = reactive({ x: 0, y: 0, width: 0, height: 0 });
const currentDisplay = computed(() => props.displays?.find(item => item.displayId === selectedDisplay.value));
const displayBounds = computed(() => currentDisplay.value?.nativeBounds as Record<string, number> | undefined);
const schema = computed(() => ({
  type: "object",
  properties: { maxWidth: captureBranch?.properties.maxWidth ?? {} }
} as ComputerFieldSchema));
const sourceItems = computed(() => supportsDisplays ? [
  { title: t("单块显示器"), value: "display" },
  { title: t("显示器内区域"), value: "region" },
  { title: t("指定窗口"), value: "window" },
  { title: t("全部屏幕概览"), value: "virtual" },
  { title: t("桌面（兼容模式）"), value: "desktop" }
] : [
  { title: t("桌面"), value: "desktop" },
  { title: t("指定窗口"), value: "window" }
]);
const regionValid = computed(() => {
  const bounds = displayBounds.value;
  return !!bounds && [region.x, region.y, region.width, region.height].every(Number.isFinite)
    && region.x >= 0 && region.y >= 0 && region.width > 0 && region.height > 0
    && region.x + region.width <= bounds.width && region.y + region.height <= bounds.height;
});
const canCapture = computed(() => {
  if (props.disabled || props.capabilities && !props.capabilities.includes("screenshots")) return false;
  if (source.value === "window") return props.windows.some(item => item.windowId === selectedWindow.value);
  if (source.value === "region") return regionValid.value;
  if (source.value === "display") return !!currentDisplay.value;
  return true;
});

watch(() => props.displays, () => {
  if (props.displays?.some(item => item.displayId === selectedDisplay.value)) return;
  const display = props.displays?.find(item => item.displayId === props.foregroundDisplayId)
    ?? props.displays?.find(item => item.primary === true)
    ?? props.displays?.[0];
  selectedDisplay.value = typeof display?.displayId === "string" ? display.displayId : "";
}, { immediate: true });
watch([selectedDisplay, () => props.layoutRevision], () => {
  const bounds = displayBounds.value;
  Object.assign(region, { x: 0, y: 0, width: bounds?.width ?? 0, height: bounds?.height ?? 0 });
}, { immediate: true });
watch([source, selectedWindow, selectedDisplay, () => props.layoutRevision,
  () => region.x, () => region.y, () => region.width, () => region.height], () => emit("source-change"));

function capture() {
  if (!canCapture.value) return;
  const request: Record<string, unknown> = { action: "screen.capture", ...parameters.value };
  if (supportsDisplays && source.value !== "desktop") request.scope = source.value;
  if (source.value === "window") {
    const window = props.windows.find(item => item.windowId === selectedWindow.value)!;
    Object.assign(request, { windowId: window.windowId, pid: window.pid });
  }
  if (source.value === "display" || source.value === "region") {
    request.displayId = selectedDisplay.value;
    if (source.value === "region") {
      delete request.maxWidth;
      request.region = { ...region };
    }
  }
  emit("submit", request);
}
</script>

<template>
  <div class="computer-observation">
    <v-select v-model="source" :label="t('观察来源')" :items="sourceItems" :disabled="disabled" density="compact" />
    <template v-if="source === 'display' || source === 'region'">
      <v-btn :disabled="disabled" :loading="busy" variant="text" @click="emit('submit', { action: 'displays.list' })">{{ t('读取显示器') }}</v-btn>
      <v-select v-model="selectedDisplay" :label="t('目标显示器')" :disabled="disabled" density="compact"
        :items="(displays || []).map(display => ({ title: String(display.name || display.displayId), value: String(display.displayId) }))" />
      <p v-if="displayBounds" class="source-description">{{ displayBounds.width }} × {{ displayBounds.height }} {{ t('原生像素') }}</p>
      <div v-if="source === 'region'" class="region-fields">
        <v-text-field v-model.number="region.x" type="number" :label="t('区域 X')" :disabled="disabled" min="0" density="compact" />
        <v-text-field v-model.number="region.y" type="number" :label="t('区域 Y')" :disabled="disabled" min="0" density="compact" />
        <v-text-field v-model.number="region.width" type="number" :label="t('区域宽度')" :disabled="disabled" min="1" density="compact" />
        <v-text-field v-model.number="region.height" type="number" :label="t('区域高度')" :disabled="disabled" min="1" density="compact" />
        <p>{{ t('区域从所选显示器左上角计算，使用原始像素。') }}</p>
      </div>
    </template>
    <template v-if="source === 'window'">
      <v-btn :disabled="disabled || capabilities && !capabilities.includes('windows')" :loading="busy" variant="text" @click="emit('submit', { action: 'windows.list' })">{{ t('按需查询窗口') }}</v-btn>
      <v-select v-model="selectedWindow" :items="windows.map(window => ({ title: String(window.title || t('未命名窗口')), value: String(window.windowId) }))" :label="t('目标窗口')" :disabled="disabled" density="compact" />
    </template>
    <ComputerControlSchemaFields v-if="source !== 'region'" v-model="parameters" :schema="schema" :disabled="disabled" />
    <p v-if="source === 'virtual'" class="source-description">{{ t('全部屏幕会合并缩放；精确定位时可选择单屏或区域。') }}</p>
    <v-btn :disabled="!canCapture" :loading="busy" variant="tonal" @click="capture">{{ t('刷新画面') }}</v-btn>
  </div>
</template>

<style scoped>
.computer-observation { display: grid; gap: 10px; padding: 12px 0; min-width: 0; }
.source-description, .region-fields p { color: rgb(var(--v-theme-on-surface-variant)); margin: 0; font-size: 12px; }
.region-fields { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px; }
.region-fields p { grid-column: 1 / -1; }
@media (max-width: 450px) { .region-fields { grid-template-columns: minmax(0, 1fr); } }
</style>
