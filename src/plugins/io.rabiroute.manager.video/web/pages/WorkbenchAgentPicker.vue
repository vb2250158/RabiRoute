<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue";
import {
  workbenchAgentCatalog, workbenchAgentGroups, workbenchAgentLoading,
  loadWorkbenchAgentCatalog, loadWorkbenchAgentSessions, selectedEntryKey, workbenchCliProviders,
  type WorkbenchAgentEntry, type WorkbenchAgentSelection, type WorkbenchAgentSession,
} from "./workbenchAgentCatalog";

const props = defineProps<{ modelValue?: WorkbenchAgentSelection; config?: Record<string, any> }>();
const emit = defineEmits<{ "update:modelValue": [value: WorkbenchAgentSelection | undefined]; settings: [] }>();

const groups = computed(() => workbenchAgentGroups(workbenchAgentCatalog.value.entries));
const entries = computed(() => workbenchAgentCatalog.value.entries);
const entryKey = computed(() => selectedEntryKey(entries.value, props.modelValue));
const selected = computed(() => entries.value.find(entry => entry.key === entryKey.value));
const bound = computed(() => Boolean(props.config?.agentBindingKey || props.config?.target?.threadId));
const missingSelection = computed(() => props.modelValue && !selected.value);

const sessions = ref<WorkbenchAgentSession[]>([]);
const sessionsLoading = ref(false);
const sessionsError = ref("");
const sessionId = computed(() => (props.modelValue?.kind === "session" ? props.modelValue.threadId : ""));
const boundSession = computed(() => (props.modelValue?.kind === "session" ? props.modelValue : undefined));
let sessionFlight = 0;

const cliModels = computed(() => (props.modelValue?.kind === "cli" ? workbenchCliProviders.value.find(provider => provider.id === props.modelValue?.provider)?.models ?? [] : []));
const currentModel = computed(() => (props.modelValue?.kind === "cli" ? props.modelValue.model ?? "" : ""));
const currentModelListed = computed(() => !currentModel.value || cliModels.value.some(model => model.id === currentModel.value));

onMounted(() => { void loadWorkbenchAgentCatalog(); });
watch(entryKey, () => { void readSessions(); }, { immediate: false });

async function readSessions() {
  const entry = selected.value;
  const token = ++sessionFlight;
  sessions.value = [];
  sessionsError.value = "";
  if (!entry || entry.kind !== "session") return;
  sessionsLoading.value = true;
  try {
    const rows = await loadWorkbenchAgentSessions(entry);
    if (token === sessionFlight) sessions.value = rows;
  } catch (cause) {
    if (token === sessionFlight) sessionsError.value = cause instanceof Error ? cause.message : String(cause);
  } finally {
    if (token === sessionFlight) sessionsLoading.value = false;
  }
}

function chooseEntry(key: string) {
  const entry: WorkbenchAgentEntry | undefined = entries.value.find(row => row.key === key);
  if (!entry) { emit("update:modelValue", undefined); return; }
  if (entry.kind === "cli") {
    emit("update:modelValue", { kind: "cli", provider: entry.provider });
    return;
  }
  // A session node is only runnable with an exact thread; the saved default session leads the list.
  const preferred = entry.sessionId && entry.sessionId !== ""
    ? { id: entry.sessionId, name: `${entry.agentName || entry.label} 的默认会话`, ...(entry.workspace ? { workspace: entry.workspace } : {}) }
    : undefined;
  emit("update:modelValue", preferred ? { kind: "session", provider: entry.provider, threadId: preferred.id, ...(entry.binding ? { instanceBinding: entry.binding } : {}), ...(preferred.workspace ? { cwd: preferred.workspace } : {}), ...(entry.deviceName ? { deviceName: entry.deviceName } : {}), ...(entry.agentName ? { agentName: entry.agentName } : {}) } : undefined);
}

function chooseModel(model: string) {
  if (props.modelValue?.kind !== "cli") return;
  emit("update:modelValue", { kind: "cli", provider: props.modelValue.provider, ...(model ? { model } : {}) });
}

function chooseSession(id: string) {
  const entry = selected.value;
  if (!entry || entry.kind !== "session" || !id) { emit("update:modelValue", undefined); return; }
  const row = sessions.value.find(session => session.id === id);
  emit("update:modelValue", {
    kind: "session", provider: entry.provider, threadId: id,
    ...(entry.binding ? { instanceBinding: entry.binding } : {}),
    ...(row?.workspace ? { cwd: row.workspace } : {}),
    ...(entry.deviceName ? { deviceName: entry.deviceName } : {}),
    ...(entry.agentName ? { agentName: entry.agentName } : {}),
  });
}
</script>

<template>
  <div class="agent-picker">
    <label>Agent
      <select :value="entryKey" :disabled="workbenchAgentLoading" @change="chooseEntry(($event.target as HTMLSelectElement).value)">
        <option value="">{{ bound ? '沿用已绑定会话' : '选择 Agent' }}</option>
        <optgroup v-for="group in groups" :key="group.group" :label="group.label">
          <option v-for="entry in group.entries" :key="entry.key" :value="entry.key" :disabled="entry.disabled">
            {{ entry.label }}<template v-if="entry.detail"> · {{ entry.detail }}</template>
          </option>
        </optgroup>
        <option v-if="missingSelection" :value="entryKey" disabled>{{ modelValue?.kind === 'cli' ? modelValue.provider : `${modelValue?.agentName || modelValue?.provider} · ${modelValue?.threadId}` }}（未在目录中）</option>
      </select>
    </label>
    <label v-if="!modelValue || modelValue.kind === 'cli'">模型
      <select :value="currentModel" :disabled="!modelValue" @change="chooseModel(($event.target as HTMLSelectElement).value)">
        <option value="">{{ modelValue ? '默认模型' : '先选择 Agent' }}</option>
        <option v-if="!currentModelListed" :value="currentModel" disabled>{{ currentModel }}（当前不可用）</option>
        <option v-for="model in cliModels" :key="model.id" :value="model.id">{{ model.label }}</option>
      </select>
    </label>
    <label v-else class="session-field">会话
      <select :value="sessionId" :disabled="sessionsLoading || !sessions.length" @change="chooseSession(($event.target as HTMLSelectElement).value)">
        <option value="">{{ sessionsLoading ? '正在读取会话…' : sessions.length ? '选择要续接的会话' : '没有可读取的会话' }}</option>
        <option v-for="row in sessions" :key="row.id" :value="row.id">{{ row.name }}<template v-if="row.workspace"> · {{ row.workspace }}</template></option>
      </select>
    </label>
    <p v-if="sessionsError" class="hint error">{{ sessionsError }}</p>
    <p v-else-if="workbenchAgentCatalog.error" class="hint">{{ workbenchAgentCatalog.error }}</p>
    <p v-else-if="selected?.kind === 'session' && boundSession" class="hint ok">{{ boundSession.deviceName || '本机' }} · {{ selected.label }} · 已绑定会话</p>
    <button v-if="!workbenchAgentLoading && !groups.length" class="manage" type="button" @click="emit('settings')">打开 Agent 设置</button>
  </div>
</template>

<style scoped>
.agent-picker { display:grid; grid-template-columns:minmax(0,1fr) minmax(0,1fr); gap:8px; }
label { min-width:0; color:var(--wb-muted,#aebdca); font-size:12px; }
.session-field { grid-column:2; }
select { display:block; width:100%; margin-top:4px; padding:7px; background:var(--wb-input,#192630); border:1px solid var(--wb-border,#405363); border-radius:6px; color:var(--wb-text,#edf3f7); }
select:disabled { opacity:.56; }
.hint { grid-column:1/-1; margin:0; color:var(--wb-muted,#aebdca); font-size:11px; line-height:1.6; }
.hint.error { color:#e9958a; }
.hint.ok { color:var(--wb-accent,#80cecc); }
.manage { grid-column:1/-1; justify-self:start; color:var(--wb-accent,#80cecc); font-size:12px; }
</style>
