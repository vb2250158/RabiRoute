<script setup lang="ts">
import { computed } from "vue";

const props = withDefaults(defineProps<{
  label: string;
  modelValue: string | number;
  min: number;
  max: number;
  step: number;
  suffix?: string;
  hint?: string;
  decimals?: number;
  disabled?: boolean;
}>(), {
  suffix: "",
  hint: "",
  decimals: 0,
  disabled: false
});

const emit = defineEmits<{
  "update:modelValue": [value: number];
}>();

const numericValue = computed(() => {
  const value = Number(props.modelValue);
  return Number.isFinite(value) ? Math.min(props.max, Math.max(props.min, value)) : props.min;
});

function update(value: unknown): void {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return;
  const clamped = Math.min(props.max, Math.max(props.min, parsed));
  emit("update:modelValue", Number(clamped.toFixed(Math.max(0, props.decimals))));
}
</script>

<template>
  <div class="speech-parameter-slider">
    <div class="speech-parameter-copy">
      <strong>{{ label }}</strong>
      <span v-if="hint">{{ hint }}</span>
    </div>
    <v-slider
      class="speech-parameter-track"
      color="secondary"
      track-color="grey-lighten-2"
      :model-value="numericValue"
      :min="min"
      :max="max"
      :step="step"
      :disabled="disabled"
      :aria-label="label"
      thumb-label
      hide-details
      @update:model-value="update"
    />
    <v-text-field
      class="speech-parameter-input"
      density="compact"
      variant="outlined"
      type="number"
      :model-value="numericValue"
      :min="min"
      :max="max"
      :step="step"
      :disabled="disabled"
      :suffix="suffix"
      :aria-label="`${label}精确值`"
      hide-details
      @update:model-value="update"
    />
  </div>
</template>

<style scoped>
.speech-parameter-slider {
  display: grid;
  grid-template-columns: minmax(130px, .7fr) minmax(190px, 1.5fr) 118px;
  gap: 14px;
  align-items: center;
  min-height: 58px;
  padding: 8px 12px;
  border: 1px solid rgba(17, 32, 51, .08);
  border-radius: 12px;
  background: rgba(255, 255, 255, .62);
}
.speech-parameter-copy { display: grid; gap: 2px; }
.speech-parameter-copy strong { color: #29445a; font-size: 12px; }
.speech-parameter-copy span { color: #7b8c9b; font-size: 10px; line-height: 1.35; }
.speech-parameter-track { min-width: 0; }
.speech-parameter-input { min-width: 0; }
@media (max-width: 880px) {
  .speech-parameter-slider { grid-template-columns: 1fr 108px; }
  .speech-parameter-copy { grid-column: 1 / -1; }
}
</style>
