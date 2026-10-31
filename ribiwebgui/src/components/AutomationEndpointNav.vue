<script setup lang="ts">
import { computed, watch } from "vue";
import { automationEndpoints } from "../persona/automationEndpoints";

const props = defineProps<{ modelValue: string; counts?: Record<string, number> }>();
const emit = defineEmits<{ "update:modelValue": [value: string] }>();
const visibleEndpoints = computed(() => props.counts
  ? automationEndpoints.filter(option => (props.counts?.[option.value] ?? 0) > 0)
  : automationEndpoints);

watch([visibleEndpoints, () => props.modelValue], ([options, selected]) => {
  if (!options.some(option => option.value === selected)) {
    const next = options[0]?.value ?? "";
    if (selected !== next) emit("update:modelValue", next);
  }
}, { immediate: true });
</script>

<template>
  <nav v-if="visibleEndpoints.length" class="automation-endpoint-nav" aria-label="消息类型">
    <button v-for="option in visibleEndpoints" :key="option.value" type="button"
      class="automation-endpoint-tab" :class="{ 'is-selected': modelValue === option.value }"
      :aria-pressed="modelValue === option.value" @click="$emit('update:modelValue', option.value)">
      <v-icon :icon="option.icon" size="20" />
      <span>{{ option.title }}</span>
      <span v-if="counts" class="automation-endpoint-count">{{ counts[option.value] || 0 }}</span>
    </button>
  </nav>
</template>

<style scoped>
.automation-endpoint-nav { display: grid; gap: 8px; align-content: start; }
.automation-endpoint-tab { display: flex; align-items: center; gap: 10px; padding: 14px; border: 1px solid var(--rr-border-faint); border-radius: 12px; text-align: left; color: rgb(var(--v-theme-on-surface)); background: rgb(var(--v-theme-surface)); cursor: pointer; min-width: 0; }
.automation-endpoint-tab > span:not(.automation-endpoint-count) { flex: 1; overflow-wrap: anywhere; }
.automation-endpoint-tab:hover { background: rgba(var(--v-theme-secondary), .05); }
.automation-endpoint-tab.is-selected { border-color: rgb(var(--v-theme-secondary)); background: rgba(var(--v-theme-secondary), .08); color: rgb(var(--v-theme-secondary)); }
.automation-endpoint-tab:focus-visible { outline: 2px solid rgb(var(--v-theme-secondary)); outline-offset: 2px; }
.automation-endpoint-count { font-size: .8rem; border-radius: 20px; padding: 2px 8px; background: rgba(var(--v-theme-on-surface), .06); }
@media (max-width: 959px) {
  .automation-endpoint-nav { display: flex; overflow-x: auto; padding: 3px; }
  .automation-endpoint-tab { flex: 0 0 auto; max-width: 240px; }
}
</style>
