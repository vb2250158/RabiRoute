<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch, type VNodeRef } from 'vue';
import { createAgentSessionClient, agentSessionProject, agentSessionMembersAvailable, agentNodeLabel, type AgentNode, type PersonaSessionAgent, type PersonaAgentTask } from '../persona/agentSessionClient';
import { agentHistoryMessages, latestAgentConversationPage, type AgentHistoryEvent, type AgentSessionMessage, type LoadOlderAgentHistory } from '../../../../../ribiwebgui/src/agentSessionHistory';
import { useI18n } from '../../../../../ribiwebgui/src/i18n/index';
import { pluginCatalogStore } from '../../../../../ribiwebgui/src/pluginCatalogStore';
import { userFacingError } from '../../../../../ribiwebgui/src/userFacingError';
import { chatHistoryScroller, chatHistoryViewport, waitForChatHistoryFrame } from '../../../../../ribiwebgui/src/personaChatHistoryLayout';
import { renderMarkdownPreview } from '../../../../../ribiwebgui/src/markdownPreview';
import { peerManagerPath } from '../../../../../ribiwebgui/src/peerManagerTarget';
import AgentAvatar from '../../../../../ribiwebgui/src/components/AgentAvatar.vue';
import HistoryConversationLayout from './HistoryConversationLayout.vue';
import PersonaAgentSessionComposer from './PersonaAgentSessionComposer.vue';
import ChatMessageBody from './ChatMessageBody.vue';
import LoadOlderHistory from './LoadOlderHistory.vue';

const props = defineProps<{ roleId: string; active: boolean }>();
const rawFetch: typeof fetch = (input, init) => fetch(input as RequestInfo, init);
const nodes = ref<AgentNode[]>([{ id: 'local', kind: 'local', name: '本机', online: true }]);
const nodeKey = ref('local');
const nodeLoading = ref(false), nodeError = ref('');
const selectedNode = computed(() => nodes.value.find(node => node.id === nodeKey.value) ?? nodes.value[0]);
const client = createAgentSessionClient(rawFetch, '', {
  node: () => selectedNode.value,
  candidates: () => [...new Set(pluginCatalogStore.agentAdapters.value.map(item => item.type))]
});
const { t, locale } = useI18n();
const remote = computed(() => selectedNode.value?.kind !== 'local');
const nodeTitle = computed(() => selectedNode.value ? agentNodeLabel(selectedNode.value) : t('本机'));
const localNodes = computed(() => nodes.value.filter(node => node.kind === 'local'));
const peerNodes = computed(() => nodes.value.filter(node => node.kind === 'peer'));
const instanceNodes = computed(() => nodes.value.filter(node => node.kind === 'instance'));
const composerRequest = computed<typeof fetch>(() => {
  const current = selectedNode.value;
  if ((current?.kind === 'peer' || current?.kind === 'instance') && current.deviceId) {
    const deviceId = current.deviceId;
    return (input, init) => typeof input === 'string' ? rawFetch(peerManagerPath(deviceId, input), init) : rawFetch(input, init);
  }
  return rawFetch;
});
const agents = ref<PersonaSessionAgent[]>([]), agentKey = ref('');
const agent = computed(() => agents.value.find(item => item.key === agentKey.value));
const tasks = ref<PersonaAgentTask[]>([]), selectedId = ref(''), query = ref('');
const selected = computed(() => tasks.value.find(task => task.id === selectedId.value));
const members = ref<PersonaAgentTask[]>([]), selectedMember = ref<PersonaAgentTask>();
const membersAvailable = computed(() => agentSessionMembersAvailable(agent.value));
const currentSession = computed(() => selectedMember.value || selected.value);
const currentSessionId = computed(() => currentSession.value?.id || '');
const composerTarget = computed(() => props.active && agent.value && currentSession.value && !currentSession.value.archived
  ? { key: JSON.stringify([nodeKey.value, agent.value.key, currentSessionId.value]), agent: agent.value, threadId: currentSessionId.value }
  : undefined);
function refreshAfterSend(key: string) {
  if (composerTarget.value?.key === key) void loadHistory();
}
const memberOffset = ref<number|null>(null), loadingMembers = ref(false), memberError = ref(''), membersOpen = ref(false);
const sessionTitle = (task:PersonaAgentTask) => task.agentNickname || task.title || task.id;
const offset = ref<number | null>(null), olderHistory = ref<LoadOlderAgentHistory | null>(null);
const events = ref<AgentHistoryEvent[]>([]), expanded = ref(new Set<string>());
const listElement = ref<HTMLElement>(), virtualList = ref<{scrollToIndex(index:number):void}>();
const messages = computed(() => agentHistoryMessages(agent.value?.provider || '', events.value));
const loadingAgents = ref(false), loadingTasks = ref(false), loadingHistory = ref(false);
const agentError = ref(''), taskError = ref(''), historyError = ref(''), partialHistory = ref(false);
let directoryRequest: AbortController | undefined, nodeRequest: AbortController | undefined, taskRequest: AbortController | undefined, historyRequest: AbortController | undefined, memberRequest: AbortController | undefined;
let loadedRole = '';
const label = (provider: string) => pluginCatalogStore.agentAdapters.value.find(item => item.type === provider)?.title || provider;
const agentLabel = (item: PersonaSessionAgent) => item.label || label(item.provider);
const owner = (item: PersonaSessionAgent) => item.nodeName || (item.binding
  ? [item.binding.ownerDeviceId, item.binding.instanceId, item.binding.agentId].filter(Boolean).join(' / ')
  : item.dshBaseUrl || t('本机'));
const grouped = ref(false);
const groupingStorageKey = 'rabiroute.history.agent-sessions.grouping';
try { grouped.value = localStorage.getItem(groupingStorageKey) === 'project'; } catch { /* Use the flat list when storage is unavailable. */ }
watch(grouped, value => { try { localStorage.setItem(groupingStorageKey, value ? 'project' : 'flat'); } catch { /* Keep this view preference for the current page. */ } });
const items = computed(() => tasks.value.map(task => {
  const project = agentSessionProject(task.cwd);
  return { key: task.id, title: task.title || task.id, preview: '',
    time: task.lastMessageTime || task.updatedAt || '', agentProvider: agent.value?.provider,
    group: { ...project, title: project.title || t('未指定项目') } };
}));

async function loadNodes() {
  nodeRequest?.abort(); const request = new AbortController(); nodeRequest = request;
  nodeLoading.value = true; nodeError.value = '';
  try {
    const result = await client.nodes(request.signal);
    if (request.signal.aborted) return;
    nodes.value = result;
    if (!result.some(node => node.id === nodeKey.value)) nodeKey.value = 'local';
  } catch (error) { if (!request.signal.aborted) nodeError.value = userFacingError(error); }
  finally { if (nodeRequest === request) nodeLoading.value = false; }
}
function selectNode(id: string) {
  if (id === nodeKey.value) return;
  nodeKey.value = id;
}
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
async function loadMembers(more=false) {
  if (!agent.value || !selectedId.value || !membersAvailable.value) return;
  memberRequest?.abort(); const request = new AbortController(); memberRequest = request;
  loadingMembers.value = true; memberError.value = '';
  try {
    const page = await client.members(agent.value,selectedId.value,more ? memberOffset.value ?? 0 : 0,request.signal);
    if (request.signal.aborted) return;
    members.value = [...new Map([...(more ? members.value : []),...page.items].map(item=>[item.id,item])).values()];
    memberOffset.value = page.nextOffset;
    if (selectedMember.value) selectedMember.value = members.value.find(item=>item.id===selectedMember.value!.id) || selectedMember.value;
  } catch (error) { if (!request.signal.aborted) memberError.value = userFacingError(error); }
  finally { if (memberRequest === request) loadingMembers.value = false; }
}
function chooseRoot(id:string) { selectedMember.value = undefined; selectedId.value = id; membersOpen.value = false; }
function chooseMember(task:PersonaAgentTask) { selectedMember.value = task; membersOpen.value = false; }
function back() { if (selectedMember.value) selectedMember.value = undefined; else selectedId.value = ''; }
async function loadHistory(more = false) {
  const owner = agent.value, sessionId = currentSessionId.value, loadOlder = olderHistory.value;
  if (!owner || !sessionId || (more && (loadingHistory.value || !loadOlder))) return;
  historyRequest?.abort(); const request = new AbortController(); historyRequest = request;
  loadingHistory.value = true; historyError.value = '';
  try {
    const page = more && loadOlder ? await loadOlder(request.signal)
      : await latestAgentConversationPage(owner.provider, (cursor, signal) => client.history(owner, sessionId, cursor, signal), request.signal);
    if (request.signal.aborted) return;
    const scroller = chatHistoryScroller(listElement.value), viewport = chatHistoryViewport(scroller);
    const anchor = [...(listElement.value?.querySelectorAll<HTMLElement>('.session-message') ?? [])]
      .find(element => element.getBoundingClientRect().bottom > viewport.top && element.getBoundingClientRect().top < viewport.bottom);
    const anchorId = anchor?.dataset.entryId, anchorTop = anchor?.getBoundingClientRect().top ?? 0;
    const followBottom = !more;
    events.value = [...new Map([...page.events, ...(more ? events.value : [])].map(event => [event.id, event])).values()];
    olderHistory.value = page.older;
    partialHistory.value = page.partial || more && partialHistory.value;
    await nextTick();
    const interrupt = () => request.abort(), interruptionEvents = ['wheel', 'touchstart', 'pointerdown', 'keydown'] as const;
    for (const event of interruptionEvents) scroller.addEventListener(event, interrupt, {passive:true});
    try {
      if (followBottom && messages.value.length) virtualList.value?.scrollToIndex(messages.value.length - 1);
      let requestedAnchor = false;
      for (let frame = 0; frame < 12; frame++) {
        if (!await waitForChatHistoryFrame(request.signal)) break;
        if (followBottom) scroller.scrollTop = scroller.scrollHeight;
        else if (anchorId) {
          const restored = [...(listElement.value?.querySelectorAll<HTMLElement>('.session-message') ?? [])]
            .find(element => element.dataset.entryId === anchorId);
          if (restored) scroller.scrollTop += restored.getBoundingClientRect().top - anchorTop;
          else if (!requestedAnchor) {
            virtualList.value?.scrollToIndex(messages.value.findIndex(message => message.id === anchorId));
            requestedAnchor = true;
          }
        }
      }
    } finally {
      for (const event of interruptionEvents) scroller.removeEventListener(event, interrupt);
    }

  } catch (error) { if (!request.signal.aborted) historyError.value = userFacingError(error); }
  finally { if (historyRequest === request) loadingHistory.value = false; }
}
function toggle(id: string) {
  const next = new Set(expanded.value);
  if (next.has(id)) next.delete(id); else next.add(id);
  expanded.value = next;
}
watch(() => [props.roleId, props.active], () => {
  if (!props.active) { directoryRequest?.abort(); taskRequest?.abort(); historyRequest?.abort(); memberRequest?.abort(); }
  if (loadedRole !== props.roleId) {
    directoryRequest?.abort(); taskRequest?.abort(); historyRequest?.abort();
    agents.value = []; agentKey.value = ''; tasks.value = []; selectedId.value = ''; events.value = [];
    if (props.active) { void loadNodes(); void loadAgents(); }
  } else if (props.active && agent.value) {
    if (!tasks.value.length) void loadTasks();
    if (currentSessionId.value && !events.value.length) void loadHistory();
    if (selectedId.value && membersAvailable.value && !members.value.length) void loadMembers();
  }
}, { immediate: true });
watch(nodeKey, () => {
  taskRequest?.abort(); historyRequest?.abort(); memberRequest?.abort();
  agents.value = []; agentKey.value = ''; tasks.value = []; selectedId.value = ''; events.value = []; offset.value = null;
  if (props.active) void loadAgents();
});
watch(agentKey, () => {
  taskRequest?.abort(); historyRequest?.abort();
  tasks.value = []; selectedId.value = ''; query.value = ''; offset.value = null;
  if (agent.value) void loadTasks();
});
watch(selectedId, () => {
  memberRequest?.abort(); selectedMember.value = undefined; members.value = []; memberOffset.value = null; memberError.value = ''; membersOpen.value = false;
  if (selectedId.value) void loadMembers();
});
watch(currentSessionId, () => {
  historyRequest?.abort(); events.value = []; olderHistory.value = null; historyError.value = ''; partialHistory.value = false; expanded.value = new Set();
  if (currentSessionId.value) void loadHistory();
});
onBeforeUnmount(() => { directoryRequest?.abort(); nodeRequest?.abort(); taskRequest?.abort(); historyRequest?.abort(); memberRequest?.abort(); });
</script>

<template>
  <section class="agent-session-history">
    <div class="agent-session-toolbar">
      <div class="agent-node-bar" role="tablist" :aria-label="t('节点')">
        <button v-for="node in localNodes" :key="node.id" type="button" role="tab" :aria-selected="nodeKey === node.id"
          class="agent-node-chip" :class="{ 'is-active': nodeKey === node.id }" :title="`${t('本机')} · ${node.name}`" @click="selectNode(node.id)">
          <v-icon icon="mdi-monitor" size="15" /><span data-no-i18n>{{ agentNodeLabel(node) }}</span>
        </button>
        <v-divider v-if="peerNodes.length" vertical class="agent-node-divider" />
        <button v-for="node in peerNodes" :key="node.id" type="button" role="tab" :aria-selected="nodeKey === node.id"
          class="agent-node-chip" :class="{ 'is-active': nodeKey === node.id, 'is-offline': !node.online }" :disabled="!node.online"
          :title="`${node.name} · ${node.online ? t('在线') : t('离线')}`" @click="selectNode(node.id)">
          <v-icon icon="mdi-laptop" size="15" /><span data-no-i18n>{{ agentNodeLabel(node) }}</span>
          <span v-if="!node.online" class="agent-node-chip-state">{{ t('离线') }}</span>
        </button>
        <v-divider v-if="instanceNodes.length" vertical class="agent-node-divider" />
        <button v-for="node in instanceNodes" :key="node.id" type="button" role="tab" :aria-selected="nodeKey === node.id"
          class="agent-node-chip" :class="{ 'is-active': nodeKey === node.id, 'is-offline': !node.online || !node.agents?.length }"
          :disabled="!node.online || !node.agents?.length"
          :title="`${node.name} · ${node.online ? `${node.agents?.length || 0} ${t('个 Agent 端')}` : t('离线')}`" @click="selectNode(node.id)">
          <v-icon icon="mdi-robot-outline" size="15" /><span data-no-i18n>{{ agentNodeLabel(node) }}</span>
          <span v-if="node.agents?.length" class="agent-node-chip-count">{{ node.agents.length }}</span>
          <span v-else-if="node.online" class="agent-node-chip-state">{{ t('无可绑定的 Agent 端') }}</span>
          <span v-else class="agent-node-chip-state">{{ t('离线') }}</span>
        </button>
        <v-btn icon="mdi-refresh" size="x-small" variant="text" :loading="nodeLoading" :aria-label="t('刷新节点')" :title="t('刷新节点')" @click="loadNodes()" />
      </div>
      <div class="agent-session-tabs-row">
        <v-tabs v-model="agentKey" color="secondary" show-arrows class="agent-session-tabs" :aria-label="t('Agent 端')">
          <v-tab v-for="item in agents" :key="item.key" :value="item.key" class="agent-session-tab" :title="`${agentLabel(item)} · ${owner(item)}`">
            <AgentAvatar :provider="item.provider" :size="24" />
            <span class="agent-tab-copy" data-no-i18n><span>{{ agentLabel(item) }}</span><small>{{ owner(item) }}</small></span>
          </v-tab>
        </v-tabs>
        <v-chip v-if="remote" size="small" variant="tonal" color="secondary" class="agent-remote-badge" :title="t('远端节点')">{{ t('远端') }}</v-chip>
        <v-btn icon="mdi-refresh" variant="text" :loading="loadingAgents" :aria-label="t('刷新 Agent 端')" :title="t('刷新 Agent 端')" @click="loadAgents" />
      </div>
    </div>
    <v-alert v-if="nodeError" type="warning" variant="tonal" density="compact" class="mb-3">{{ nodeError }}</v-alert>
    <v-alert v-if="agentError" type="error" variant="tonal" class="mb-3">{{ agentError }}</v-alert>
    <v-alert v-if="!agents.length && !loadingAgents && !agentError" type="info" variant="tonal">
      {{ remote ? t('该远端节点暂无可用会话，或节点上未安装受支持的 Agent 端。') : t('本机暂无可读取的 Agent 会话。') }}
    </v-alert>
    <HistoryConversationLayout v-if="agent" :items="items" :grouped="grouped" :compact="true" :project-preview-limit="5" :selected="selectedId" v-model:search="query" :loading="loadingTasks" :detail-open="Boolean(selected)" :has-details="membersAvailable&&Boolean(selected)" details-title="子 Agent" v-model:info-open="membersOpen" @select="chooseRoot" @back="back" @search="loadTasks()">
      <template #list-actions>
        <v-btn :icon="grouped ? 'mdi-format-list-bulleted' : 'mdi-folder-outline'" variant="text" size="small" :aria-label="t(grouped ? '平铺会话' : '按项目分组')" :title="t(grouped ? '平铺会话' : '按项目分组')" :aria-pressed="grouped" @click="grouped = !grouped" />
        <v-btn icon="mdi-magnify" variant="text" size="small" :disabled="loadingTasks" :aria-label="t('搜索会话')" @click="loadTasks()" />
        <v-btn icon="mdi-refresh" variant="text" size="small" :disabled="loadingTasks" :aria-label="t('刷新会话列表')" @click="loadTasks()" />
      </template>
      <template #list-notice><v-alert v-if="taskError" type="error" variant="tonal" density="compact">{{ taskError }}</v-alert></template>
      <template #list-footer><v-btn v-if="offset !== null" block variant="text" :loading="loadingTasks" @click="loadTasks(true)">{{ t('加载更多会话') }}</v-btn></template>
      <template v-if="currentSession">
        <v-btn v-if="selectedMember" variant="text" prepend-icon="mdi-arrow-left" class="session-parent-link" :title="selected ? sessionTitle(selected) : ''" @click="selectedMember=undefined">{{t('返回主会话')}}</v-btn>
        <header class="session-heading">
          <div><h3 data-no-i18n>{{ sessionTitle(currentSession) }}</h3><div class="text-caption text-medium-emphasis" data-no-i18n>{{ currentSession.cwd }}</div></div>
          <v-btn icon="mdi-refresh" variant="text" :loading="loadingHistory" :aria-label="t('刷新会话历史')" @click="loadHistory()" />
        </header>
        <v-alert v-if="remote" type="info" variant="tonal" density="compact" class="session-remote-note">{{ t('该会话位于远端节点') }} {{ nodeTitle }}，{{ t('发送会投递到远端电脑。') }}</v-alert>
        <v-alert v-if="historyError" type="error" variant="tonal" class="mb-3">{{ historyError }}</v-alert>
        <v-alert v-if="partialHistory" type="warning" variant="tonal" class="mb-3">{{ t('部分历史记录暂时无法读取，已加载的消息仍可查看。') }}</v-alert>
        <v-progress-linear v-if="loadingHistory" indeterminate :aria-label="t('正在加载历史记录')" />
        <div v-if="!messages.length && !loadingHistory && !historyError" class="pa-4 text-medium-emphasis">{{ t('当前页暂无用户输入或最终回复。') }}</div>
        <LoadOlderHistory v-if="olderHistory" :active="active" :loading="loadingHistory" @load="loadHistory(true)" />
        <div ref="listElement" class="session-messages" aria-live="polite" :aria-busy="loadingHistory">
          <v-virtual-scroll ref="virtualList" :items="messages" :item-height="160" renderless><template #default="{ item, itemRef }: { item: AgentSessionMessage; itemRef?: VNodeRef }">
            <article v-if="item.instructionHeading" :ref="itemRef" :key="item.id" class="session-message session-instruction" :data-entry-id="item.id">
              <button type="button" class="session-instruction-toggle" :aria-expanded="expanded.has(item.id)" @click="toggle(item.id)">
                <v-icon :icon="expanded.has(item.id) ? 'mdi-chevron-down' : 'mdi-chevron-right'" size="16" />
                <span>{{ t('提示词注入') }}：<span data-no-i18n>{{ item.instructionHeading }} …</span></span>
              </button>
              <pre v-if="expanded.has(item.id)" data-no-i18n>{{ item.text }}</pre>
            </article>
            <article v-else :ref="itemRef" :key="item.id" class="session-message" :class="{ 'session-user': item.role === 'user' }" :data-message-role="item.role" :data-entry-id="item.id">
              <AgentAvatar :provider="agent.provider" :kind="item.role === 'user' ? 'user' : 'agent'" />
              <div class="session-message-content">
                <div class="session-sender">{{ item.role === 'user' ? t('用户') : t('最终回复') }}<time v-if="item.time" :datetime="item.time">{{ new Date(item.time).toLocaleString(locale) }}</time></div>
                <div class="session-bubble"><ChatMessageBody :expanded="expanded.has(item.id)" @toggle="toggle(item.id)"><div class="markdown-preview" data-no-i18n v-html="renderMarkdownPreview(item.text)" /></ChatMessageBody></div>
              </div>
            </article>
          </template></v-virtual-scroll>
        </div>
      </template>
      <div v-else class="pa-6 text-medium-emphasis">{{ t('选择会话查看用户输入和最终回复。') }}</div>
      <template #details>
        <div v-if="selected" class="session-members">
          <header class="session-members-heading"><strong>{{t('子 Agent')}}</strong><v-btn icon="mdi-refresh" variant="text" size="small" :loading="loadingMembers" :aria-label="t('刷新子 Agent')" @click="loadMembers()" /></header>
          <v-alert v-if="memberError" type="warning" variant="tonal" density="compact">{{memberError}}</v-alert>
          <v-list bg-color="transparent" class="session-member-list">
            <v-list-item :active="!selectedMember" @click="chooseRoot(selected.id)">
              <template #prepend><AgentAvatar :provider="agent.provider" :size="32" /></template>
              <v-list-item-title data-no-i18n>{{sessionTitle(selected)}}</v-list-item-title><v-list-item-subtitle>{{t('主会话')}}</v-list-item-subtitle>
            </v-list-item>
            <v-virtual-scroll :items="members" :item-height="64" renderless><template #default="{item,itemRef}:{item:PersonaAgentTask;itemRef?:VNodeRef}">
              <v-list-item data-no-i18n :ref="itemRef" :key="item.id" :active="selectedMember?.id===item.id" :title="sessionTitle(item)" :subtitle="item.preview||item.agentRole||''" @click="chooseMember(item)">
                <template #prepend><AgentAvatar :provider="agent.provider" :size="32" /></template>
              </v-list-item>
            </template></v-virtual-scroll>
          </v-list>
          <p v-if="!members.length&&!loadingMembers&&!memberError" class="pa-3 text-caption text-medium-emphasis">{{t('此会话暂无子 Agent。')}}</p>
          <v-btn v-if="memberOffset!==null" block variant="text" :loading="loadingMembers" @click="loadMembers(true)">{{t('加载更多子 Agent')}}</v-btn>
        </div>
      </template>
      <template #composer><PersonaAgentSessionComposer :target="composerTarget" :request="composerRequest" @sent="refreshAfterSend" /></template>
    </HistoryConversationLayout>
  </section>
</template>

<style scoped>
.agent-session-history{display:flex;flex-direction:column;min-width:0;min-height:0;height:100%;}
.agent-session-toolbar{display:flex;flex-direction:column;gap:6px;min-width:0;margin:2px 0 14px;}
.agent-node-bar{display:flex;align-items:center;gap:4px;min-width:0;overflow-x:auto;padding:1px 0;scrollbar-width:none;}
.agent-node-bar::-webkit-scrollbar{display:none;}
.agent-node-chip{display:inline-flex;align-items:center;gap:5px;flex:none;height:30px;padding:0 10px;border:1px solid transparent;border-radius:999px;background:rgba(var(--v-theme-on-surface),.04);color:rgba(var(--v-theme-on-surface),.72);font-size:12px;line-height:1;cursor:pointer;transition:background-color .15s ease,color .15s ease,border-color .15s ease;}
.agent-node-chip:hover:not(:disabled){background:rgba(var(--v-theme-on-surface),.08);}
.agent-node-chip.is-active{background:rgba(var(--v-theme-secondary),.12);border-color:rgba(var(--v-theme-secondary),.3);color:rgb(var(--v-theme-secondary));font-weight:600;}
.agent-node-chip:disabled{cursor:not-allowed;opacity:.5;}
.agent-node-chip.is-offline{opacity:.55;}
.agent-node-chip-count{min-width:15px;padding:0 4px;border-radius:8px;background:rgba(var(--v-theme-on-surface),.1);font-size:10px;line-height:15px;text-align:center;font-variant-numeric:tabular-nums;}
.agent-node-chip-state{font-size:10px;opacity:.7;}
.agent-node-divider{align-self:center;height:16px;margin-inline:2px;}
.agent-session-tabs-row{display:flex;align-items:center;gap:8px;min-width:0;border-bottom:1px solid var(--rr-border-faint);}
.agent-session-tabs-row .agent-session-tabs{flex:1;min-width:0;}
.agent-remote-badge{flex:none;}
.agent-session-tab{text-transform:none;max-width:340px;letter-spacing:normal;}
.agent-tab-copy{display:grid;gap:2px;min-width:0;margin-left:10px;text-align:left;}
.agent-tab-copy small{max-width:260px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:11px;opacity:.65;}
.session-members-heading{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:8px 6px;font-size:13px;}
.session-member-list :deep(.v-list-item){min-height:64px;padding-inline:6px;}
.session-member-list :deep(.agent-avatar){margin-right:8px;}
.session-member-list :deep(.v-list-item-title),.session-member-list :deep(.v-list-item-subtitle){font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.session-parent-link{align-self:flex-start;margin-bottom:4px;}
.session-remote-note{margin:-8px 0 16px;}
.session-heading{position:sticky;top:0;z-index:3;background:rgb(var(--v-theme-background));display:flex;align-items:center;justify-content:space-between;gap:16px;padding:8px 16px 18px;border-bottom:1px solid var(--rr-border-faint);margin-bottom:20px;}
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
.session-bubble .markdown-preview {
  max-inline-size: 900px;
  font-size: 14px;
  line-height: 1.75;
}
.markdown-preview :deep(> * + *) { margin-block-start: .7em; }
.markdown-preview :deep(h1), .markdown-preview :deep(h2), .markdown-preview :deep(h3),
.markdown-preview :deep(h4), .markdown-preview :deep(h5), .markdown-preview :deep(h6) {
  font-weight: 650;
  line-height: 1.4;
}
.markdown-preview :deep(h1) { font-size: 1.3em; }
.markdown-preview :deep(h2) { font-size: 1.2em; }
.markdown-preview :deep(h3) { font-size: 1.12em; }
.markdown-preview :deep(h4), .markdown-preview :deep(h5), .markdown-preview :deep(h6) { font-size: 1em; }
.markdown-preview :deep(> * + :is(h1, h2, h3, h4, h5, h6)) { margin-block-start: 1.15em; }
.markdown-preview :deep(ol), .markdown-preview :deep(ul) { padding-inline-start: 1.7em; }
.markdown-preview :deep(li + li), .markdown-preview :deep(li > * + *) { margin-block-start: .32em; }
.markdown-preview :deep(:not(pre) > code) {
  padding: .08em .3em;
  border-radius: 4px;
  background: rgba(var(--v-theme-on-surface), .09);
  font-size: .9em;
}
.markdown-preview :deep(pre) {
  padding: .7em .85em;
  border-radius: 6px;
  background: rgba(var(--v-theme-on-surface), .07);
  font-size: .9em;
  line-height: 1.6;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.session-instruction{display:grid;justify-items:center;gap:8px;margin-bottom:20px;}
.session-instruction-toggle{display:flex;align-items:center;gap:4px;max-width:100%;min-height:32px;padding:0 8px;color:rgba(var(--v-theme-on-surface),.64);font-size:12px;border-radius:5px;}
.session-instruction-toggle:hover,.session-instruction-toggle:focus-visible{background:rgba(var(--v-theme-on-surface),.08);}
.session-instruction-toggle>span{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.session-instruction pre{width:100%;margin:0;padding:12px 16px;background:rgba(var(--v-theme-on-surface),.045);border-radius:8px;font-size:12px;white-space:pre-wrap;overflow-wrap:anywhere;}
@media(max-width:760px){
  .agent-session-toolbar{gap:4px;margin-bottom:12px;}
  .agent-node-bar{gap:3px;}
  .agent-node-chip{height:28px;padding:0 8px;font-size:11px;}
  .agent-remote-badge{display:none;}
  .session-messages{padding:0 4px;}
  .session-message-content{max-width:calc(100% - 52px);}
  .session-sender{flex-wrap:wrap;gap:4px 10px;}
}
</style>
