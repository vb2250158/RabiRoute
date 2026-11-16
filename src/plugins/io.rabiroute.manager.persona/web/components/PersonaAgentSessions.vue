<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch, type VNodeRef } from 'vue';
import { usePersonaService } from '../persona/personaServiceClient';
import { createAgentSessionClient, type PersonaSessionAgent, type PersonaAgentTask } from '../persona/agentSessionClient';
import { agentHistoryEvents, agentHistoryMessages, agentHistoryNextCursor, type AgentHistoryEvent, type AgentSessionMessage } from '../persona/agentSessionHistory';
import { useI18n } from '../../../../../ribiwebgui/src/i18n/index';
import { pluginCatalogStore } from '../../../../../ribiwebgui/src/pluginCatalogStore';
import { userFacingError } from '../../../../../ribiwebgui/src/userFacingError';
import { renderMarkdownPreview } from '../../../../../ribiwebgui/src/markdownPreview';
import AgentAvatar from '../../../../../ribiwebgui/src/components/AgentAvatar.vue';
import HistoryConversationLayout from './HistoryConversationLayout.vue';
import ChatMessageBody from './ChatMessageBody.vue';

const props = defineProps<{ roleId: string; active: boolean }>();
const service = usePersonaService(), client = createAgentSessionClient(service.fetch, service.deviceId);
const { t, locale } = useI18n();
const agents = ref<PersonaSessionAgent[]>([]), agentKey = ref('');
const agent = computed(() => agents.value.find(item => item.key === agentKey.value));
const tasks = ref<PersonaAgentTask[]>([]), selectedId = ref(''), query = ref('');
const selected = computed(() => tasks.value.find(task => task.id === selectedId.value));
const offset = ref<number | null>(null), cursor = ref<string | null>(null);
const events = ref<AgentHistoryEvent[]>([]), expanded = ref(new Set<string>());
const messages = computed(() => agentHistoryMessages(agent.value?.provider || '', events.value));
const loadingAgents = ref(false), loadingTasks = ref(false), loadingHistory = ref(false);
const agentError = ref(''), taskError = ref(''), historyError = ref(''), partialHistory = ref(false);
let directoryRequest: AbortController | undefined, taskRequest: AbortController | undefined, historyRequest: AbortController | undefined;
let loadedRole = '';
const label = (provider: string) => pluginCatalogStore.agentAdapters.value.find(item => item.type === provider)?.title || provider;
const owner = (item: PersonaSessionAgent) => item.binding
  ? [item.binding.ownerDeviceId, item.binding.instanceId, item.binding.agentId].filter(Boolean).join(' / ')
  : item.dshBaseUrl || t('本机');
const items = computed(() => tasks.value.map(task => ({ key: task.id, title: task.title || task.id,
  preview: task.cwd || task.id, time: task.updatedAt || '', agentProvider: agent.value?.provider })));

async function loadAgents() {
  directoryRequest?.abort(); const request = new AbortController(); directoryRequest = request;
  loadingAgents.value = true; agentError.value = '';
  try {
    const result = await client.agents(props.roleId, request.signal);
    if (request.signal.aborted) return;
    agents.value = result; loadedRole = props.roleId;
    if (!result.some(item => item.key === agentKey.value)) agentKey.value = result[0]?.key || '';
  } catch (error) { if (!request.signal.aborted) agentError.value = userFacingError(error); }
  finally { if (directoryRequest === request) loadingAgents.value = false; }
}
async function loadTasks(more = false) {
  if (!agent.value) return;
  taskRequest?.abort(); const request = new AbortController(); taskRequest = request;
  loadingTasks.value = true; taskError.value = '';
  try {
    const page = await client.tasks(agent.value, query.value.trim(), more ? offset.value ?? 0 : 0, request.signal);
    if (request.signal.aborted) return;
    tasks.value = [...new Map([...(more ? tasks.value : []), ...page.items].map(task => [task.id, task])).values()];
    offset.value = page.nextOffset;
    if (!tasks.value.some(task => task.id === selectedId.value)) selectedId.value = '';
  } catch (error) { if (!request.signal.aborted) taskError.value = userFacingError(error); }
  finally { if (taskRequest === request) loadingTasks.value = false; }
}
async function loadHistory(more = false) {
  if (!agent.value || !selectedId.value) return;
  historyRequest?.abort(); const request = new AbortController(); historyRequest = request;
  loadingHistory.value = true; historyError.value = '';
  try {
    const previousCursor = more ? cursor.value ?? undefined : undefined;
    const page = await client.history(agent.value, selectedId.value, previousCursor, request.signal);
    if (request.signal.aborted) return;
    const nextCursor = agentHistoryNextCursor(agent.value.provider, page);
    if (nextCursor !== null && nextCursor === previousCursor) throw new Error(t('历史分页位置未前进，请刷新后重试。'));
    const incoming = agentHistoryEvents(agent.value.provider, page);
    events.value = [...new Map([...(more ? events.value : []), ...incoming].map(event => [event.id, event])).values()];
    cursor.value = nextCursor;
    partialHistory.value = Boolean(more && partialHistory.value || page.warnings?.length || page.coverage?.partial);
  } catch (error) { if (!request.signal.aborted) historyError.value = userFacingError(error); }
  finally { if (historyRequest === request) loadingHistory.value = false; }
}
function toggle(id: string) {
  const next = new Set(expanded.value);
  if (next.has(id)) next.delete(id); else next.add(id);
  expanded.value = next;
}
watch(() => [props.roleId, props.active], () => {
  if (loadedRole !== props.roleId) {
    directoryRequest?.abort(); taskRequest?.abort(); historyRequest?.abort();
    agents.value = []; agentKey.value = ''; tasks.value = []; selectedId.value = ''; events.value = [];
    if (props.active) void loadAgents();
  }
}, { immediate: true });
watch(agentKey, () => {
  taskRequest?.abort(); historyRequest?.abort();
  tasks.value = []; selectedId.value = ''; query.value = ''; offset.value = null;
  if (agent.value) void loadTasks();
});
watch(selectedId, () => {
  historyRequest?.abort(); events.value = []; cursor.value = null; historyError.value = ''; partialHistory.value = false; expanded.value = new Set();
  if (selectedId.value) void loadHistory();
});
onBeforeUnmount(() => { directoryRequest?.abort(); taskRequest?.abort(); historyRequest?.abort(); });
</script>

<template>
  <section class="agent-session-history">
    <div class="agent-session-tabs">
      <v-tabs v-model="agentKey" color="secondary" show-arrows :aria-label="t('Agent 端')">
        <v-tab v-for="item in agents" :key="item.key" :value="item.key" class="agent-session-tab" :title="`${label(item.provider)} · ${owner(item)}`">
          <AgentAvatar :provider="item.provider" :size="24" />
          <span class="agent-tab-copy" data-no-i18n><span>{{ label(item.provider) }}</span><small>{{ owner(item) }}</small></span>
        </v-tab>
      </v-tabs>
      <v-btn icon="mdi-refresh" variant="text" :loading="loadingAgents" :aria-label="t('刷新 Agent 端')" @click="loadAgents" />
    </div>
    <v-alert v-if="agentError" type="error" variant="tonal" class="mb-3">{{ agentError }}</v-alert>
    <v-alert v-if="!agents.length && !loadingAgents && !agentError" type="info" variant="tonal">{{ t('当前角色尚未配置 Agent 端。') }}</v-alert>
    <HistoryConversationLayout v-if="agent" :items="items" :selected="selectedId" v-model:search="query" :loading="loadingTasks" :detail-open="Boolean(selected)" @select="selectedId = $event" @back="selectedId = ''" @search="loadTasks()">
      <template #list-actions>
        <v-btn icon="mdi-magnify" variant="text" size="small" :disabled="loadingTasks" :aria-label="t('搜索会话')" @click="loadTasks()" />
        <v-btn icon="mdi-refresh" variant="text" size="small" :disabled="loadingTasks" :aria-label="t('刷新会话列表')" @click="loadTasks()" />
      </template>
      <template #list-notice><v-alert v-if="taskError" type="error" variant="tonal" density="compact">{{ taskError }}</v-alert></template>
      <template #list-footer><v-btn v-if="offset !== null" block variant="text" :loading="loadingTasks" @click="loadTasks(true)">{{ t('加载更多会话') }}</v-btn></template>
      <template v-if="selected">
        <header class="session-heading">
          <div><h3 data-no-i18n>{{ selected.title || selected.id }}</h3><div class="text-caption text-medium-emphasis" data-no-i18n>{{ selected.cwd }}</div></div>
          <v-btn icon="mdi-refresh" variant="text" :loading="loadingHistory" :aria-label="t('刷新会话历史')" @click="loadHistory()" />
        </header>
        <v-alert v-if="historyError" type="error" variant="tonal" class="mb-3">{{ historyError }}</v-alert>
        <v-alert v-if="partialHistory" type="warning" variant="tonal" class="mb-3">{{ t('部分历史记录暂时无法读取，已加载的消息仍可查看。') }}</v-alert>
        <v-progress-linear v-if="loadingHistory" indeterminate :aria-label="t('正在加载历史记录')" />
        <div v-if="!messages.length && !loadingHistory && !historyError" class="pa-4 text-medium-emphasis">{{ t('当前页暂无用户输入或最终回复。') }}</div>
        <div class="session-messages" aria-live="polite" :aria-busy="loadingHistory">
          <v-virtual-scroll :items="messages" :item-height="160" renderless><template #default="{ item, itemRef }: { item: AgentSessionMessage; itemRef?: VNodeRef }">
            <article :ref="itemRef" :key="item.id" class="session-message" :class="{ 'session-user': item.role === 'user' }" :data-message-role="item.role">
              <AgentAvatar :provider="agent.provider" :kind="item.role === 'user' ? 'user' : 'agent'" />
              <div class="session-message-content">
                <div class="session-sender">{{ item.role === 'user' ? t('用户') : t('最终回复') }}<time v-if="item.time" :datetime="item.time">{{ new Date(item.time).toLocaleString(locale) }}</time></div>
                <div class="session-bubble"><ChatMessageBody :expanded="expanded.has(item.id)" @toggle="toggle(item.id)"><div class="markdown-preview" data-no-i18n v-html="renderMarkdownPreview(item.text)" /></ChatMessageBody></div>
              </div>
            </article>
          </template></v-virtual-scroll>
        </div>
        <v-btn v-if="cursor !== null" class="mt-3" variant="tonal" :loading="loadingHistory" @click="loadHistory(true)">{{ t(agent.provider === 'dsh' ? '加载更早的消息' : '继续加载消息') }}</v-btn>
      </template>
      <div v-else class="pa-6 text-medium-emphasis">{{ t('选择会话查看用户输入和最终回复。') }}</div>
    </HistoryConversationLayout>
  </section>
</template>

<style scoped>
.agent-session-tabs{display:flex;align-items:center;gap:8px;min-width:0;margin:4px 0 20px;border-bottom:1px solid var(--rr-border-faint);}
.agent-session-tabs :deep(.v-tabs){flex:1;min-width:0;}
.agent-session-tab{text-transform:none;max-width:340px;letter-spacing:normal;}
.agent-tab-copy{display:grid;gap:2px;min-width:0;margin-left:10px;text-align:left;}
.agent-tab-copy small{max-width:260px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:11px;opacity:.65;}
.session-heading{display:flex;align-items:center;justify-content:space-between;gap:16px;padding:8px 16px 18px;border-bottom:1px solid var(--rr-border-faint);margin-bottom:20px;}
.session-heading h3{font-size:17px;font-weight:600;overflow-wrap:anywhere;}
.session-messages{padding:0 16px;min-width:0;}
.session-message{display:flex;gap:12px;margin-bottom:24px;min-width:0;}
.session-message-content{min-width:0;max-width:92%;}
.session-sender{display:flex;align-items:center;gap:12px;font-size:12px;color:rgb(var(--v-theme-on-surface));opacity:.7;margin-bottom:7px;}
.session-sender time{font-size:11px;}
.session-bubble{padding:14px 18px;border-radius:4px 14px 14px 14px;background:rgba(var(--v-theme-on-surface),.06);overflow-wrap:anywhere;}
.session-user{flex-direction:row-reverse;}
.session-user .session-sender{justify-content:flex-end;}
.session-user .session-bubble{border-radius:14px 4px 14px 14px;background:rgba(var(--v-theme-secondary),.12);}
@media(max-width:760px){.session-messages{padding:0 4px;}.session-message-content{max-width:calc(100% - 52px);}.session-sender{flex-wrap:wrap;gap:4px 10px;}}
</style>
