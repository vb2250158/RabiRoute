<script setup lang="ts">
import { useI18n } from "../../../../../ribiwebgui/src/i18n/index";
import { computed, reactive } from "vue";
import { schemaDefault, type ComputerFieldSchema } from "./computerControlPresentation";
const { t } = useI18n();
const props = defineProps<{ schema: ComputerFieldSchema; modelValue: Record<string, unknown>; disabled?: boolean; path?: string[]; disabledPaths?: string[] }>();
const emit = defineEmits<{ "update:modelValue": [Record<string, unknown>]; change: [string[], unknown]; validity: [string, boolean] }>();
function inactive(key:string) { const path = [...(props.path || []),key].join("."); return props.disabled || props.disabledPaths?.some(value => path === value || path.startsWith(`${value}.`)); }
const fields = computed(() => Object.entries(props.schema.properties || {}));
const jsonInputs = reactive<Record<string, string>>({}); const jsonErrors = reactive<Record<string, string>>({});
function updateJson(key: string, value: string) { jsonInputs[key] = value; const fieldPath = [...(props.path || []), key].join(".");
  try { const parsed = JSON.parse(value); jsonErrors[key] = ""; emit("validity", fieldPath, true); update(key, parsed); }
  catch { jsonErrors[key] = "请输入符合此字段结构的 JSON。"; emit("validity", fieldPath, false); }
}
function update(key: string, value: unknown) { emit("update:modelValue", { ...props.modelValue, [key]: value }); emit("change", [...(props.path || []), key], value); }
</script>
<template>
  <div class="computer-fields">
    <template v-for="[key, field] in fields" :key="key">
      <details v-if="field.properties" class="computer-field-group">
        <summary>{{ t(field.title || key) }}</summary><p v-if="field.description" class="field-note">{{ t(field.description) }}</p>
        <ComputerControlSchemaFields :schema="field" :model-value="(modelValue[key] || {}) as Record<string, unknown>" :disabled="inactive(key)" :path="[...(path || []), key]" :disabled-paths="disabledPaths" @update:model-value="emit('update:modelValue', {...modelValue,[key]:$event})" @change="(path, value) => emit('change', path, value)" @validity="(path, valid) => emit('validity',path,valid)" />
        <v-btn size="small" variant="text" :disabled="inactive(key)" @click="update(key, schemaDefault(field))">{{ t('恢复本组默认') }}</v-btn>
      </details>
      <div v-else class="computer-field">
        <v-textarea v-if="field.type === 'array' || field.anyOf || field.oneOf" :model-value="jsonInputs[key] ?? JSON.stringify(modelValue[key] ?? schemaDefault(field) ?? [], null, 2)" :error-messages="jsonErrors[key]" :label="t(field.title || key)" :disabled="inactive(key)" :hint="field.description ? t(field.description) : undefined" persistent-hint rows="3" auto-grow density="compact" @update:model-value="updateJson(key, $event)" />
        <v-switch v-else-if="field.type === 'boolean'" :model-value="modelValue[key]" :label="t(field.title || key)" :disabled="inactive(key)" :hint="field.description ? t(field.description) : undefined" persistent-hint density="compact" hide-details="auto" @update:model-value="update(key, $event)" />
        <v-select v-else-if="field.enum" :model-value="modelValue[key]" :items="field.enum" :label="t(field.title || key)" :disabled="inactive(key)" :hint="field.description ? t(field.description) : undefined" persistent-hint density="compact" @update:model-value="update(key, $event)" />
        <v-text-field v-else :model-value="modelValue[key]" :label="t(field.title || key)" :type="field.type === 'number' || field.type === 'integer' ? 'number' : 'text'" :min="field.minimum" :max="field.maximum" :suffix="field.unit" :disabled="inactive(key)" :hint="field.description ? t(field.description) : undefined" persistent-hint density="compact" @update:model-value="update(key, field.type === 'number' || field.type === 'integer' ? Number($event) : $event)" />
        <div class="field-default"><span>{{ t('默认：') }}{{ Object.hasOwn(field,'default') ? JSON.stringify(field.default) : t('由执行端提供') }}<template v-if="field.minimum !== undefined || field.maximum !== undefined">{{ t(' · 范围 ') }}{{ field.minimum ?? '—' }}–{{ field.maximum ?? '—' }}</template></span><v-btn v-if="field.default !== undefined" size="x-small" variant="text" :disabled="inactive(key)" @click="update(key, schemaDefault(field))">{{ t('恢复默认') }}</v-btn></div>
      </div>
    </template>
  </div>
</template>
<style scoped>
.computer-fields { display:grid;gap:12px;min-width:0; }.computer-field { min-width:0; }.computer-field-group { padding:10px 0;border-top:1px solid var(--rr-border); }.computer-field-group>summary{cursor:pointer;font-weight:600;padding:6px 0;}.field-note,.field-default{color:var(--rr-muted);font-size:.8rem;}.field-default{display:flex;align-items:center;gap:8px;flex-wrap:wrap;}summary:focus-visible{outline:2px solid var(--rr-accent-strong);outline-offset:3px;}
</style>
