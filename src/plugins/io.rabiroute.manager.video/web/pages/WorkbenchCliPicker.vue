<script setup lang="ts">
import { computed, onMounted } from "vue";
import { cliProviders, cliLoading, loadWorkbenchCli, type WorkbenchCliSelection } from "./workbenchCliCatalog";

const props = defineProps<{ modelValue?: WorkbenchCliSelection; bound?: boolean }>();
const emit = defineEmits<{ "update:modelValue": [value: WorkbenchCliSelection | undefined]; settings: [] }>();
const selected = computed(() => cliProviders.value.find(item => item.id === props.modelValue?.provider));
const selectedModelIsListed = computed(() => selected.value?.models.some(model => model.id === props.modelValue?.model));
onMounted(() => { void loadWorkbenchCli(); });

function chooseCli(provider: string) {
  emit("update:modelValue", provider ? { provider } : undefined);
}
function chooseModel(model: string) {
  if (!props.modelValue) return;
  emit("update:modelValue", { provider: props.modelValue.provider, ...(model && { model }) });
}
</script>

<template>
  <div class="cli-picker">
    <label>Agent
      <select :value="modelValue?.provider || ''" @change="chooseCli(($event.target as HTMLSelectElement).value)">
        <option value="">{{ bound ? '沿用已绑定会话' : '选择 Agent' }}</option>
        <option v-if="modelValue?.provider && !selected" :value="modelValue.provider" disabled>{{ modelValue.provider }}</option>
        <option v-for="cli in cliProviders" :key="cli.id" :value="cli.id" :disabled="!cli.ready">
          {{ cli.label }}{{ !cli.installed ? '（未安装）' : !cli.ready ? '（需检查）' : '' }}
        </option>
      </select>
    </label>
    <label>模型
      <select :value="modelValue?.model || ''" :disabled="!selected?.ready" @change="chooseModel(($event.target as HTMLSelectElement).value)">
        <option value="">{{ selected ? '默认模型' : '先选择 Agent' }}</option>
        <option v-if="modelValue?.model && !selectedModelIsListed" :value="modelValue.model" disabled>{{ modelValue.model }}（当前不可用）</option>
        <option v-for="model in selected?.models || []" :key="model.id" :value="model.id">{{ model.label }}</option>
      </select>
    </label>
    <button v-if="!cliLoading && !cliProviders.some(cli => cli.ready)" class="manage" type="button" @click="emit('settings')">打开 Agent 设置</button>
  </div>
</template>

<style scoped>
.cli-picker { display:grid; grid-template-columns:minmax(0,1fr) minmax(0,1fr); gap:8px; }
label { min-width:0; color:var(--wb-muted,#aebdca); font-size:12px; }
select { display:block; width:100%; margin-top:4px; padding:7px; background:var(--wb-input,#192630); border:1px solid var(--wb-border,#405363); border-radius:6px; color:var(--wb-text,#edf3f7); }
select:disabled { opacity:.56; }
.manage { grid-column:1/-1; justify-self:start; color:var(--wb-accent,#80cecc); font-size:12px; }
</style>
