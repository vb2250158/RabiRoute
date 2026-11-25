<script setup lang="ts">
import { computed, mergeProps, nextTick, onBeforeUnmount, ref, watch } from "vue";
import { userFacingError } from "../userFacingError";
import { previewAccessDenied, readPreview, writePreview } from "../readPreviewCache";
import { useI18n } from "../i18n/index";
import type { speechServerOptions } from "../../../src/plugins/io.rabiroute.manager.speech/web/speech/peerServerPresentation";

type ModelOption = { value: string; title: string; subtitle?: string; disabled?: boolean };
defineOptions({ inheritAttrs: false });
const props = withDefaults(defineProps<{
  label: string;
  modelLabel?: string;
  modelId?: string;
  deviceId: string;
  computers: {
    options: ReturnType<typeof speechServerOptions>;
    loading: boolean;
    error: string;
    menuChanged: (open: boolean) => void;
  };
  loadModels: (deviceId: string, signal: AbortSignal) => Promise<ModelOption[]>;
  choose: (deviceId: string, modelId: string) => Promise<boolean | void> | boolean | void;
  disabled?: boolean;
  compact?: boolean;
}>(), { modelLabel: "", modelId: "" });

const open = defineModel<boolean>("open", { default: false });
const { t } = useI18n();
const computer = ref<{ value: string; title: string }>();
const options = ref<ModelOption[]>([]);
const loading = ref(false);
const usingPreview = ref(false);
const saving = ref(false);
const error = ref("");
const menuHeading = ref<HTMLElement>();
const computerLabel = computed(() => props.computers.options.find(option => option.value === props.deviceId)?.title || props.deviceId || "本机");
let request: AbortController | undefined;

function showComputers() {
  request?.abort();
  request = undefined;
  computer.value = undefined;
  options.value = [];
  error.value = "";
  loading.value = false;
  usingPreview.value = false;
}
watch(open, value => {
  props.computers.menuChanged(value);
  if (!value) showComputers();
});
onBeforeUnmount(() => {
  if (open.value) props.computers.menuChanged(false);
  request?.abort();
});

async function showModels(machine: { value: string; title: string }) {
  request?.abort();
  const controller = new AbortController();
  request = controller;
  computer.value = machine;
  const key = ["model-options", props.label, machine.value];
  const preview = readPreview<ModelOption[]>(key);
  options.value = preview ?? [];
  usingPreview.value = Boolean(preview?.length);
  loading.value = true;
  error.value = "";
  await nextTick();
  if (controller.signal.aborted) return;
  menuHeading.value?.focus();
  try {
    const result = await props.loadModels(machine.value, controller.signal);
    if (controller.signal.aborted) return;
    options.value = result;
    usingPreview.value = false;
    writePreview(key, result.slice(0, 100).map(({ value, title }) => ({ value, title })));
  } catch (cause) {
    if (!controller.signal.aborted) {
      if (previewAccessDenied((cause as { status?: number } | null)?.status)) {
        options.value = [];
        usingPreview.value = false;
        writePreview(key, undefined);
      }
      error.value = userFacingError(cause);
    }
  } finally {
    if (!controller.signal.aborted) loading.value = false;
  }
}

async function chooseModel(option: ModelOption) {
  if (!computer.value || option.disabled || props.disabled || saving.value || loading.value || usingPreview.value) return;
  saving.value = true;
  error.value = "";
  try {
    if (await props.choose(computer.value.value, option.value) === false) {
      error.value = props.computers.error || "无法应用模型选择，请重试。";
      return;
    }
    open.value = false;
  } catch (cause) {
    error.value = userFacingError(cause);
  } finally {
    saving.value = false;
  }
}
</script>

<template>
  <v-menu v-model="open" location="bottom start" :close-on-content-click="false" :persistent="saving"
    :disabled="disabled && !open" :max-width="440">
    <template #activator="{ props: activator }">
      <button v-bind="mergeProps(activator, $attrs)" type="button" class="computer-model-field" :class="{ compact }" :disabled="disabled"
        :aria-label="label">
        <span v-if="!compact" class="computer-model-label">{{ label }}</span>
        <span class="text-truncate">{{ modelLabel || label }}</span>
        <small class="text-truncate">{{ computerLabel }}</small>
        <v-icon icon="mdi-chevron-down" size="16" />
      </button>
    </template>
    <v-card class="computer-model-options" :aria-label="label">
      <v-list density="compact" bg-color="transparent">
        <template v-if="computer">
          <v-list-item prepend-icon="mdi-arrow-left" :title="computer.title" subtitle="返回机器列表" :disabled="saving"
            @click="showComputers" />
          <v-divider />
          <div ref="menuHeading" tabindex="-1" class="px-3 pt-2 section-note">选择模型</div>
          <div v-if="usingPreview" class="px-3 section-note">{{ t("上次读取") }}</div>
          <v-progress-linear v-else-if="loading" indeterminate />
          <v-list-item v-for="option in options" :key="option.value" :title="option.title" :subtitle="option.subtitle"
            :active="deviceId === computer.value && modelId === option.value" :disabled="saving || loading || usingPreview || disabled || option.disabled"
            @click="chooseModel(option)" />
          <v-list-item v-if="!loading && !error && !options.length" title="这台机器暂无可选模型" />
          <v-alert v-if="error" class="ma-2" type="warning" density="compact" variant="tonal">{{ error }}</v-alert>
          <v-list-item v-if="error" title="重新读取模型" @click="showModels(computer)" />
        </template>
        <template v-else>
          <v-list-subheader>选择机器</v-list-subheader>
          <v-progress-linear v-if="computers.loading" indeterminate />
          <v-list-item v-for="option in computers.options" :key="option.value" :title="option.title" :subtitle="option.detail"
            :active="option.value === deviceId" :disabled="option.props.disabled" append-icon="mdi-chevron-right"
            @click="showModels(option)" />
          <v-alert v-if="computers.error" class="ma-2" type="warning" density="compact" variant="tonal">{{ computers.error }}</v-alert>
        </template>
        <slot name="footer" />
      </v-list>
    </v-card>
  </v-menu>
</template>

<style scoped>
.computer-model-field { display: flex; align-items: center; gap: 8px; position: relative; min-width: 0; width: 100%; min-height: 48px; padding: 0 14px; border: 1px solid var(--rr-border); border-radius: 6px; color: var(--rr-text); text-align: left; }
.computer-model-field.compact { width: auto; min-height: 34px; max-width: 100%; padding: 0 8px; border-color: transparent; border-radius: 20px; }
.computer-model-field:hover, .computer-model-field[aria-expanded="true"] { background: var(--rr-subtle); }
.computer-model-field:focus-visible { outline: 2px solid var(--rr-accent); outline-offset: 2px; }
.computer-model-field > .text-truncate { min-width: 0; }
.computer-model-field:disabled { opacity: .45; cursor: default; }
.computer-model-field small { color: var(--rr-muted); max-width: 13ch; }
.computer-model-field .v-icon { flex: none; margin-inline-start: auto; }
.computer-model-label { position: absolute; top: -9px; padding: 0 4px; background: var(--rr-surface); color: var(--rr-muted); font-size: 11px; }
.computer-model-options { width: min(360px, calc(100vw - 24px)); max-height: min(470px, calc(100dvh - 32px)); overflow-y: auto; overscroll-behavior: contain; }
</style>
