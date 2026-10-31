<script setup lang="ts">
import { computed, ref, useId, watch } from "vue";
import { AGENT_HOOK_CONDITIONS, agentHookConditionErrors, type AgentHookCondition, type AgentHookSession } from "@shared/agentHookAutomation";

const props = defineProps<{
  modelValue: boolean; condition?: AgentHookCondition; usedTypes: string[];
  projects: string[]; sessions: AgentHookSession[]; loading: boolean; sessionLoading: boolean;
  hasMoreSessions: boolean; error: string;
}>();
const emit = defineEmits<{
  "update:modelValue": [value: boolean]; save: [condition: AgentHookCondition];
  scanProjects: []; scanSessions: [more: boolean];
}>();
const titleId = useId();
const draft = ref<AgentHookCondition>({ type: "" });
watch(() => props.modelValue, open => {
  if (open) draft.value = props.condition ? {
    ...props.condition, ...(props.condition.sessions ? { sessions: props.condition.sessions.map(session => ({ ...session })) } : {})
  } : { type: "" };
});
const types = computed(() => AGENT_HOOK_CONDITIONS.map(item => ({ ...item, props: { disabled: props.usedTypes.includes(item.value) } })));
const description = computed(() => AGENT_HOOK_CONDITIONS.find(item => item.value === draft.value.type)?.description);
const errors = computed(() => [...agentHookConditionErrors(draft.value), ...(props.usedTypes.includes(draft.value.type) ? ["同一种条件只能添加一次。"] : [])]);
const sessionOptions = computed(() => [...new Map([...props.sessions, ...(draft.value.sessions ?? [])].map(session => [session.id, session])).values()]
  .map(session => ({ title: session.name || "未命名任务", value: session.id })));
function changeType(type: string) {
  if (type === draft.value.type) return;
  draft.value = type === "project" ? { type, path: "" } : ["include_sessions", "exclude_sessions"].includes(type) ? { type, sessions: [] } : { type };
}
function selectSessions(ids: string[]) {
  draft.value = { ...draft.value, sessions: ids.map(id => ({ id, name: sessionOptions.value.find(item => item.value === id)?.title || "未命名任务" })) };
}
function save() {
  if (errors.value.length) return;
  emit("save", { ...draft.value, ...(draft.value.sessions ? { sessions: draft.value.sessions.map(session => ({ ...session })) } : {}) });
}
</script>

<template>
  <v-dialog :model-value="modelValue" max-width="720" scrollable :aria-labelledby="titleId" @update:model-value="emit('update:modelValue', $event)">
    <v-card>
      <v-card-title :id="titleId">{{ condition ? '编辑条件' : '添加条件' }}</v-card-title>
      <v-card-text class="condition-dialog-content">
        <v-select :model-value="draft.type" :items="types" label="条件类型" hide-details @update:model-value="changeType($event || '')" />
        <div v-if="description" class="condition-explanation" role="note">
          <div class="font-weight-bold mb-2">条件说明</div>
          <p>{{ description }}</p>
        </div>
        <template v-if="draft.type === 'project'">
          <v-combobox :model-value="draft.path" :items="projects" label="项目目录" hide-details @update:model-value="draft.path = String($event || '')" />
          <v-btn variant="text" :loading="loading" @click="emit('scanProjects')">读取项目目录</v-btn>
        </template>
        <template v-else-if="draft.type === 'include_sessions' || draft.type === 'exclude_sessions'">
          <v-autocomplete :model-value="(draft.sessions ?? []).map(session => session.id)" :items="sessionOptions"
            :label="draft.type === 'include_sessions' ? '限定的聊天会话' : '排除的聊天会话'" multiple chips closable-chips hide-details @update:model-value="selectSessions($event)" />
          <div class="d-flex flex-wrap ga-2">
            <v-btn variant="text" :loading="sessionLoading" @click="emit('scanSessions', false)">读取聊天会话</v-btn>
            <v-btn v-if="hasMoreSessions" variant="text" :loading="sessionLoading" @click="emit('scanSessions', true)">加载更多会话</v-btn>
          </div>
        </template>
        <p v-else-if="draft.type" class="text-medium-emphasis">此条件无需额外参数。</p>
        <v-alert v-if="error" type="error" variant="tonal">{{ error }}</v-alert>
        <div v-if="draft.type && errors.length" class="text-warning" role="status"><p v-for="message in errors" :key="message">{{ message }}</p></div>
        <p class="text-body-2 text-medium-emphasis">同一规则的所有条件必须同时满足。确认后仍需点击页面顶部“保存”才会生效；取消不会修改原条件。</p>
      </v-card-text>
      <v-card-actions class="pa-4">
        <v-spacer />
        <v-btn variant="text" @click="emit('update:modelValue', false)">取消</v-btn>
        <v-btn variant="tonal" color="primary" :disabled="errors.length > 0" @click="save">{{ condition ? '保存条件' : '添加条件' }}</v-btn>
      </v-card-actions>
    </v-card>
  </v-dialog>
</template>

<style scoped>
.condition-dialog-content { display: grid; gap: 16px; }
.condition-explanation { padding: 14px 16px; border-radius: 8px; background: rgba(var(--v-theme-primary), .08); line-height: 1.7; }
.condition-explanation p { margin: 0; }
</style>
