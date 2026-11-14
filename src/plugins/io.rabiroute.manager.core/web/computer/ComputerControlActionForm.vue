<script setup lang="ts">
import { useI18n } from "../../../../../ribiwebgui/src/i18n/index";
import { computed, reactive, ref, watch } from "vue";
import { computerRequestSchema, computerActionDefinition } from "@shared/agentInteractiveProtocol";
import { schemaDefault, type ComputerFieldSchema } from "./computerControlPresentation";
import ComputerControlSchemaFields from "./ComputerControlSchemaFields.vue";
type ActionBranch = ComputerFieldSchema & { properties: Record<string, ComputerFieldSchema> & { action: {const:string} } };
const branches = (computerRequestSchema as { anyOf: ActionBranch[] }).anyOf;
const { t } = useI18n();
const props = defineProps<{ group: string; capabilities?:string[]; busy?: boolean; disabled?: boolean }>();
const emit = defineEmits<{ submit: [Record<string, unknown>] }>();
const invalid = reactive(new Set<string>());
const action = ref(""); const value = ref<Record<string, unknown>>({});
const labels: Record<string, string> = { "file.stat":"查询文件", "file.read":"读取文件", "upload.begin":"开始上传", "upload.write":"上传分块", "upload.commit":"提交上传", "upload.status":"查询原传输", "upload.abort":"取消传输", "windows.list":"查询窗口", "screen.capture":"刷新画面", "input.execute":"执行输入", "input.status":"查询原输入", "input.cancel":"取消本次输入", "annotation.show":"显示静态标注", "annotation.update":"更新图层", "annotation.status":"查询标注", "annotation.clear":"清除标注", "annotation.track.start":"开始跟踪", "annotation.track.status":"查询跟踪", "annotation.track.stop":"停止跟踪" };
const choices = computed(() => branches.filter(branch => {
  const name = branch.properties.action.const;
  return props.group === "observation" ? ["windows.list", "screen.capture"].includes(name) : props.group === "files" ? name.startsWith("file.") || name.startsWith("upload.") : name.startsWith(`${props.group}.`);
}).map(branch => ({ title: t(labels[branch.properties.action.const] || branch.properties.action.const), value: branch.properties.action.const })));
const supported = computed(() => { const definition=computerActionDefinition(action.value);return !!definition && props.capabilities?.includes(definition.capability) === true; });
const schema = computed(() => {
  const branch = branches.find(branch => branch.properties.action.const === action.value);
  return { ...branch, properties: Object.fromEntries(Object.entries(branch?.properties || {}).filter(([key]) => !(["action", ...(["input.execute", "annotation.show", "annotation.update", "annotation.track.start"].includes(action.value) ? ["requestId"] : []), ...(["input.execute"].includes(action.value) ? ["controlSessionId"] : [])].includes(key)))) } as ComputerFieldSchema;
});
watch([choices, action], () => { if (!choices.value.some(item => item.value === action.value)) action.value = choices.value[0]?.value || ""; invalid.clear(); value.value = (schemaDefault(schema.value) || {}) as Record<string, unknown>; }, { immediate: true });
</script>
<template><div class="computer-action-form"><v-select v-model="action" :items="choices" :label="t('本次操作')" density="compact" :disabled="busy || disabled" hide-details /><ComputerControlSchemaFields :key="action" v-model="value" :schema="schema" :disabled="busy || disabled" @validity="(path, valid) => valid ? invalid.delete(path) : invalid.add(path)" /><v-btn :disabled="!action || disabled || !!invalid.size || !supported" :loading="busy" color="primary" variant="tonal" @click="emit('submit', { ...value, action })">{{ choices.find(item => item.value === action)?.title || t('执行操作') }}</v-btn></div></template>
<style scoped>.computer-action-form{display:grid;gap:12px;min-width:0;padding:12px 0;}</style>
