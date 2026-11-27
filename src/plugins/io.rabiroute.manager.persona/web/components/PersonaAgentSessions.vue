<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, reactive, ref, watch, type VNodeRef } from 'vue';
import { createAgentSessionClient, agentSessionProject, agentSessionMembersAvailable, agentNodeLabel, agentSessionRunning, type AgentNode, type PersonaSessionAgent, type PersonaAgentTask } from '../persona/agentSessionClient';
import { cachedSessionPage, forgetSessionPages, rememberSessionPage } from '../persona/agentSessionCache';
import type { HistoryConversationDevice, HistoryConversationItem } from '../../../../../ribiwebgui/src/historyConversationPresentation';
import { agentHistoryMessages, latestAgentConversationPage, type AgentHistoryEvent, type AgentSessionMessage, type LoadOlderAgentHistory } from '../../../../../ribiwebgui/src/agentSessionHistory';
import { useI18n } from '../../../../../ribiwebgui/src/i18n/index';
import { pluginCatalogStore } from '../../../../../ribiwebgui/src/pluginCatalogStore';
import { userFacingError } from '../../../../../ribiwebgui/src/userFacingError';
import { chatHistoryScroller, chatHistoryViewport, waitForChatHistoryFrame } from '../../../../../ribiwebgui/src/personaChatHistoryLayout';
import { renderMarkdownPreview } from '../../../../../ribiwebgui/src/markdownPreview';
import { peerManagerPath } from '../../../../../ribiwebgui/src/peerManagerTarget';
import { deviceSystemIcon } from '../../../../../ribiwebgui/src/deviceSystem';
import AgentAvatar from '../../../../../ribiwebgui/src/components/AgentAvatar.vue';
import HistoryConversationLayout from './HistoryConversationLayout.vue';
import PersonaAgentSessionComposer from './PersonaAgentSessionComposer.vue';
import ChatMessageBody from './ChatMessageBody.vue';
import LoadOlderHistory from './LoadOlderHistory.vue';

const props = defineProps<{ roleId: string; active: boolean }>();
// Resolved per call so the ambient fetch (and any later replacement) is always the one used.
const rawFetch: typeof fetch = (input, init) => fetch(input as RequestInfo, init);
const { t, locale } = useI18n();

/** One loaded Agent endpoint: its page of sessions and continuation offset. */
type SessionEntry = { key: string; node: AgentNode; agent: PersonaSessionAgent; tasks: PersonaAgentTask[]; nextOffset: number | null; loading: boolean; error: string };
const SEPARATOR = '\u0000';
const entryKey = (nodeId: string, agentKey: string) => nodeId + SEPARATOR + agentKey;

const nodes = ref<AgentNode[]>([{ id: 'local', kind: 'local', name: '本机', online: true }]);
const nodeLoading = ref(false), nodeError = ref('');
const entries = reactive(new Map<string, SessionEntry>());
const deviceLoading = reactive(new Set<string>());
const deviceErrors = reactive(new Map<string, string>());
const loadedDevices = reactive(new Set<string>());
/** Every node keeps its own client so a read can never borrow another computer's owner. */
const clients = new Map<string, ReturnType<typeof createAgentSessionClient>>();
const deviceRequests = new Map<string, AbortController>();
function clientFor(node: AgentNode) {
  let client = clients.get(node.id);
  if (!client) {
    client = createAgentSessionClient(rawFetch, '', {
      node: () => node,
      candidates: () => [...new Set(pluginCatalogStore.agentAdapters.value.map(item => item.type))]
    });
    clients.set(node.id, client);
  }
  return client;
}

const devices = computed<HistoryConversationDevice[]>(() => nodes.value.map(node => ({
  key: node.id,
  title: node.kind === 'instance' && !node.deviceId ? node.name : agentNodeLabel(node),
  // The same operating-system icon the Device control page uses for this computer.
  icon: deviceSystemIcon({ platform: node.platform, deviceKind: node.deviceKind, name: node.name, id: node.instanceId || node.deviceId || node.id }),
  online: node.kind === 'local' || node.online,
  status: node.status,
  path: node.kind === 'peer' ? node.deviceId : node.kind === 'instance' ? node.instanceId : undefined,
  // This Manager opens by default; every other node loads when the user opens it.
  defaultOpen: node.kind === 'local'
})));

const query = ref('');
/** Project identity is cached per working directory; the same cwd repeats across sessions. */
const projectCache = new Map<string, ReturnType<typeof agentSessionProject>>();
function projectFor(cwd: string) {
  let project = projectCache.get(cwd);
  if (!project) {
    project = agentSessionProject(cwd);
    if (projectCache.size > 512) projectCache.clear();
    projectCache.set(cwd, project);
  }
  return project;
}
const items = computed<HistoryConversationItem[]>(() => {
  const deviceIndex = new Map(devices.value.map(device => [device.key, device]));
  const rows: HistoryConversationItem[] = [];
  for (const entry of entries.values()) {
    const device = deviceIndex.get(entry.node.id) ?? { key: entry.node.id, title: agentNodeLabel(entry.node), online: entry.node.online };
    for (const task of entry.tasks) {
      const project = projectFor(task.cwd || '');
      rows.push({
        key: entryKey(entry.node.id, entry.agent.key) + SEPARATOR + task.id,
        // An untitled session falls back to its id so every row stays selectable and searchable.
        title: task.title || task.id, preview: '', time: task.lastMessageTime || task.updatedAt || '',
        agentProvider: entry.agent.provider, device, running: agentSessionRunning(task),
        group: { ...project, title: project.title || t('未指定项目') }
      });
    }
  }
  return rows;
});
/** A search needle is matched once per row, and only changed rows rebuild. */
const searchNeedle = computed(() => query.value.trim().toLowerCase());
const visibleItems = computed(() => {
  const needle = searchNeedle.value;
  if (!needle) return items.value;
  // A session may arrive without a title; the fallback keeps one untitled row from breaking search.
  return items.value.filter(item => (item.title || '').toLowerCase().includes(needle) || (item.group?.title || '').toLowerCase().includes(needle));
});

const selection = ref<{ entry: string; taskId: string }>();
const selectedEntry = computed(() => selection.value ? entries.get(selection.value.entry) : undefined);
const agent = computed(() => selectedEntry.value?.agent);
const selected = computed(() => selectedEntry.value?.tasks.find(task => task.id === selection.value?.taskId));
const membersAvailable = computed(() => agentSessionMembersAvailable(agent.value));

const memberOffset = ref<number|null>(null), loadingMembers = ref(false), memberError = ref(''), membersOpen = ref(false);
const members = ref<PersonaAgentTask[]>([]), selectedMember = ref<PersonaAgentTask>();
const currentSession = computed(() => selectedMember.value || selected.value);
const currentSessionId = computed(() => currentSession.value?.id || '');
const sessionTitle = (task:PersonaAgentTask) => task.agentNickname || task.title || task.id;

const events = ref<AgentHistoryEvent[]>([]), expanded = ref(new Set<string>());
const listElement = ref<HTMLElement>(), virtualList = ref<{scrollToIndex(index:number):void}>();
const messages = computed(() => agentHistoryMessages(agent.value?.provider || '', events.value));
const offset = ref<number | null>(null), olderHistory = ref<LoadOlderAgentHistory | null>(null);
const loadingHistory = ref(false), loadingTasks = ref(false);
const taskError = ref(''), historyError = ref(''), partialHistory = ref(false);

const composerTarget = computed(() => props.active && agent.value && currentSession.value && !currentSession.value.archived
  ? { key: JSON.stringify([selectedEntry.value?.node.id, agent.value.key, currentSessionId.value]), agent: agent.value, threadId: currentSessionId.value }
  : undefined);
/** Remote sessions are sent through the owning computer, never through this Manager. */
const composerRequest = computed<typeof fetch>(() => {
  const node = selectedEntry.value?.node;
  if ((node?.kind === 'peer' || node?.kind === 'instance') && node.deviceId) {
    const deviceId = node.deviceId;
    return (input, init) => typeof input === 'string' ? rawFetch(peerManagerPath(deviceId, input), init) : rawFetch(input, init);
  }
  return rawFetch;
});
function refreshAfterSend(key: string) { if (composerTarget.value?.key === key) void loadHistory(); }

let nodeRequest: AbortController | undefined, historyRequest: AbortController | undefined, memberRequest: AbortController | undefined;
/** One continuation per Agent endpoint; a refresh or a newer page cancels the previous one. */
const moreRequests = new Map<string, AbortController>();
let loadedRole = '';

async function loadNodes() {
  nodeRequest?.abort(); const request = new AbortController(); nodeRequest = request;
  nodeLoading.value = true; nodeError.value = '';
  try {
    const result = await clientFor({ id: 'local', kind: 'local', name: '本机', online: true }).nodes(request.signal);
    if (request.signal.aborted) return;
    nodes.value = result;
    if (props.active) void prefetchDevices(result);
  } catch (error) { if (!request.signal.aborted) nodeError.value = userFacingError(error); }
  finally { if (nodeRequest === request) nodeLoading.value = false; }
}

/** A single computer serializes its own reads, so a dozen endpoints never queue behind each other. */
const AGENT_CONCURRENCY = 2;

/**
 * This Manager reads on first paint. Every other computer waits for the user to open it,
 * because a closed device only needs its name, status and icon — reading a dozen endpoints
 * on nine idle computers would spend the user's bandwidth for rows nobody has opened.
 */
async function prefetchDevices(list: readonly AgentNode[]) {
  const local = list.find(node => node.kind === 'local' && node.online !== false && !loadedDevices.has(node.id));
  if (local) await loadDevice(local);
}

/** Reading a node loads its Agent endpoints once and their first session page. */
const deviceFlights = new Map<string, Promise<void>>();
function loadDevice(node: AgentNode, force = false): Promise<void> {
  // A forced refresh supersedes an in-flight read instead of joining it, so the rows it
  // returns are always the ones produced after the caller cleared the list.
  const running = force ? undefined : deviceFlights.get(node.id);
  if (running) return running;
  if (!force && (loadedDevices.has(node.id) || node.online === false)) return Promise.resolve();
  if (node.online === false) return Promise.resolve();
  const flight = readDevice(node, force).finally(() => { if (deviceFlights.get(node.id) === flight) deviceFlights.delete(node.id); });
  deviceFlights.set(node.id, flight);
  return flight;
}
async function readDevice(node: AgentNode, force: boolean): Promise<void> {
  deviceRequests.get(node.id)?.abort();
  const request = new AbortController();
  deviceRequests.set(node.id, request);
  deviceLoading.add(node.id); deviceErrors.delete(node.id);
  // A cancelled read leaves no entry, so reopening the tab retries it instead of showing an empty list.
  for (const [key, entry] of entries) if (entry.node.id === node.id && entry.error) entries.delete(key);
  try {
    const client = clientFor(node);
    const pages: Promise<void>[] = [];
    // Every endpoint is read in parallel; the first page that returns paints, and an endpoint
    // with no sessions simply contributes nothing.
    for await (const item of client.agentsStream(props.roleId, request.signal)) {
      if (request.signal.aborted || !props.active) return;
      const key = entryKey(node.id, item.key);
      if (!force && entries.has(key)) continue;
      // Warm start: a recent read paints immediately and the live page replaces it when it lands.
      const cached = force ? undefined : cachedSessionPage(key);
      if (cached) entries.set(key, { key, node, agent: item, tasks: cached.tasks, nextOffset: cached.nextOffset, loading: true, error: '' });
      pages.push(client.tasks(item, '', 0, request.signal).then(page => {
        if (request.signal.aborted) return;
        // An empty endpoint is not a tab; it is dropped without leaving a blank row behind.
        if (!page.items.length && !cached) { entries.delete(key); return; }
        entries.set(key, { key, node, agent: item, tasks: page.items, nextOffset: page.nextOffset, loading: false, error: '' });
        rememberSessionPage(key, page.items, page.nextOffset);
      }, error => {
        if (request.signal.aborted) return;
        // A failed refresh keeps whatever the cache already showed instead of blanking the list.
        if (!cached) { entries.delete(key); return; }
        entries.set(key, { key, node, agent: item, tasks: cached.tasks, nextOffset: cached.nextOffset, loading: false, error: userFacingError(error) });
      }));
    }
    await Promise.all(pages);
    if (!request.signal.aborted) loadedDevices.add(node.id);
  } catch (error) {
    if (!request.signal.aborted) deviceErrors.set(node.id, userFacingError(error));
  } finally {
    if (deviceRequests.get(node.id) === request) deviceRequests.delete(node.id);
    deviceLoading.delete(node.id);
  }
}
function expandDevice(id: string) {
  const node = nodes.value.find(item => item.id === id);
  if (node) void loadDevice(node);
}

async function loadMore(entry: SessionEntry) {
  if (entry.loading || entry.nextOffset === null) return;
  entry.loading = true; entry.error = '';
  const key = entry.key, offset = entry.nextOffset;
  const request = new AbortController();
  moreRequests.set(key, request);
  try {
    const page = await clientFor(entry.node).tasks(entry.agent, '', offset, request.signal);
    // A refresh, a role change or a newer page read replaces the entry; late rows must not land there.
    if (request.signal.aborted || entries.get(key) !== entry) return;
    entry.tasks = [...new Map([...entry.tasks, ...page.items].map(task => [task.id, task])).values()];
    entry.nextOffset = page.nextOffset;
  } catch (error) { if (!request.signal.aborted) entry.error = userFacingError(error); }
  finally {
    if (moreRequests.get(key) === request) moreRequests.delete(key);
    entry.loading = false;
  }
}
async function refreshAll() {
  taskError.value = '';
  // Cancel every in-flight node read first: a superseded flight must not write rows after
  // the lists below are cleared.
  for (const request of deviceRequests.values()) request.abort();
  deviceRequests.clear();
  deviceFlights.clear();
  for (const request of moreRequests.values()) request.abort();
  moreRequests.clear();
  entries.clear(); loadedDevices.clear(); deviceErrors.clear();
  for (const node of nodes.value) if (node.kind === 'local') await loadDevice(node, true);
}

async function loadMembers(more = false) {
  const owner = agent.value, sessionId = selection.value?.taskId;
  if (!owner || !sessionId || !membersAvailable.value) return;
  memberRequest?.abort(); const request = new AbortController(); memberRequest = request;
  loadingMembers.value = true; memberError.value = '';
  try {
    const page = await clientFor(selectedEntry.value!.node).members(owner, sessionId, more ? memberOffset.value ?? 0 : 0, request.signal);
    if (request.signal.aborted) return;
    members.value = [...new Map([...(more ? members.value : []), ...page.items].map(item => [item.id, item])).values()];
    memberOffset.value = page.nextOffset;
    if (selectedMember.value) selectedMember.value = members.value.find(item => item.id === selectedMember.value!.id) || selectedMember.value;
  } catch (error) { if (!request.signal.aborted) memberError.value = userFacingError(error); }
  finally { if (memberRequest === request) loadingMembers.value = false; }
}

function chooseRoot(key: string) {
  const at = key.lastIndexOf(SEPARATOR);
  const entry = key.slice(0, at), taskId = key.slice(at + 1);
  if (!entries.has(entry)) return;
  selectedMember.value = undefined;
  membersOpen.value = false;
  selection.value = { entry, taskId };
}
function chooseMember(task: PersonaAgentTask) { selectedMember.value = task; membersOpen.value = false; }
function back() { if (selectedMember.value) selectedMember.value = undefined; else selection.value = undefined; }
function toggle(id: string) {
  const next = new Set(expanded.value);
  if (next.has(id)) next.delete(id); else next.add(id);
  expanded.value = next;
}

async function loadHistory(more = false) {
  const owner = agent.value, sessionId = currentSessionId.value, loadOlder = olderHistory.value, node = selectedEntry.value?.node;
  if (!owner || !sessionId || !node || (more && (loadingHistory.value || !loadOlder))) return;
  historyRequest?.abort(); const request = new AbortController(); historyRequest = request;
  loadingHistory.value = true; historyError.value = '';
  try {
    const client = clientFor(node);
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

watch(() => [props.roleId, props.active], () => {
  if (!props.active) { nodeRequest?.abort(); historyRequest?.abort(); memberRequest?.abort(); for (const request of deviceRequests.values()) request.abort(); deviceRequests.clear(); return; }
  if (loadedRole !== props.roleId) {
    entries.clear(); loadedDevices.clear(); deviceErrors.clear();
    selection.value = undefined; events.value = []; members.value = [];
    loadedRole = props.roleId;
    // loadNodes prefetches every readable device once the directory is known.
    void loadNodes();
  } else if ([...entries.values()].some(entry => entry.error) || !entries.size) {
    // A cancelled or failed read resumes; a completed one is left alone.
    void prefetchDevices(nodes.value);
    if (currentSessionId.value && !events.value.length) void loadHistory();
  } else if (currentSessionId.value && !events.value.length) {
    void loadHistory();
  }
}, { immediate: true });
watch(() => selection.value?.entry, () => {
  memberRequest?.abort(); historyRequest?.abort();
  selectedMember.value = undefined; members.value = []; memberOffset.value = null; memberError.value = '';
  events.value = []; olderHistory.value = null; historyError.value = ''; partialHistory.value = false; expanded.value = new Set();
  if (selection.value) void loadMembers();
});
watch(currentSessionId, () => {
  historyRequest?.abort();
  events.value = []; olderHistory.value = null; historyError.value = ''; partialHistory.value = false; expanded.value = new Set();
  if (currentSessionId.value) void loadHistory();
});
onBeforeUnmount(() => {
  nodeRequest?.abort(); historyRequest?.abort(); memberRequest?.abort();
  for (const request of deviceRequests.values()) request.abort();
  for (const request of moreRequests.values()) request.abort();
  deviceRequests.clear(); moreRequests.clear(); deviceFlights.clear();
});
</script>

<template>
  <section class="agent-session-history">
    <HistoryConversationLayout :items="visibleItems" :devices="devices" :device-loading="deviceLoading" :device-error="deviceErrors"
      :compact="true" :project-preview-limit="5" :selected="selection ? selection.entry + '\u0000' + selection.taskId : ''"
      v-model:search="query" :loading="loadingTasks" :detail-open="Boolean(selected)" :has-details="membersAvailable&&Boolean(selected)"
      details-title="子 Agent" v-model:info-open="membersOpen" @select="chooseRoot" @back="back" @expand-device="expandDevice">
      <template #list-actions>
        <v-btn icon="mdi-refresh" variant="text" size="small" :loading="nodeLoading" :aria-label="t('刷新节点')" :title="t('刷新节点')" @click="nodeLoading || (loadNodes(), refreshAll())" />
      </template>
      <template #list-notice>
        <v-alert v-if="nodeError" type="warning" variant="tonal" density="compact" class="mx-2 mb-1">{{ nodeError }}</v-alert>
        <v-alert v-for="[deviceId, message] in [...deviceErrors]" :key="deviceId" type="error" variant="tonal" density="compact" class="mx-2 mb-1">{{ message }}</v-alert>
        <v-alert v-if="taskError" type="error" variant="tonal" density="compact" class="mx-2 mb-1">{{ taskError }}</v-alert>
      </template>
      <template #list-footer>
        <v-btn v-if="selectedEntry?.nextOffset !== null && selectedEntry" block variant="text" size="small" :loading="selectedEntry?.loading" @click="loadMore(selectedEntry!)">{{ t('加载更多会话') }}</v-btn>
      </template>
      <template v-if="currentSession">
        <v-btn v-if="selectedMember" variant="text" prepend-icon="mdi-arrow-left" class="session-parent-link" :title="selected ? sessionTitle(selected) : ''" @click="selectedMember=undefined">{{t('返回主会话')}}</v-btn>
        <header class="session-heading">
          <div><h3 data-no-i18n>{{ sessionTitle(currentSession) }}</h3><div class="text-caption text-medium-emphasis" data-no-i18n>{{ currentSession.cwd }}</div></div>
          <v-btn icon="mdi-refresh" variant="text" :loading="loadingHistory" :aria-label="t('刷新会话历史')" @click="loadHistory()" />
        </header>
        <v-alert v-if="selectedEntry && selectedEntry.node.kind !== 'local'" type="info" variant="tonal" density="compact" class="session-remote-note">
          {{ t('该会话位于远端节点') }} {{ agentNodeLabel(selectedEntry.node) }}，{{ t('发送会投递到远端电脑。') }}
        </v-alert>
        <v-alert v-if="historyError" type="error" variant="tonal" density="compact" class="mb-4">{{ historyError }}</v-alert>
        <v-alert v-else-if="partialHistory" type="info" variant="tonal" density="compact" class="mb-4">{{ t('已读取最近一部分历史，可继续加载更早消息。') }}</v-alert>
        <div class="session-messages">
          <v-btn v-if="olderHistory" variant="text" size="small" class="mb-4" block :loading="loadingHistory" @click="loadHistory(true)">{{ t('加载更早的消息') }}</v-btn>
          <template v-for="(message, index) in messages" :key="message.id">
            <div v-if="message.instructionHeading" class="session-instruction">
              <button type="button" class="session-instruction-toggle" :aria-expanded="expanded.has(message.id)" @click="toggle(message.id)">
                <v-icon :icon="expanded.has(message.id) ? 'mdi-chevron-up' : 'mdi-chevron-down'" size="14" />
                <span>{{ t('已注入的指令') }} · {{ message.instructionHeading }}</span>
              </button>
              <pre v-if="expanded.has(message.id)" data-no-i18n>{{ message.text }}</pre>
            </div>
            <article v-else class="session-message" :class="{ 'session-user': message.role === 'user' }" :data-message-role="message.role" :data-entry-id="message.id">
              <AgentAvatar :provider="agent?.provider" :kind="message.role === 'user' ? 'user' : 'agent'" />
              <div class="session-message-content">
                <div class="session-sender">{{ message.role === 'user' ? t('用户') : t('最终回复') }}<time v-if="message.time" :datetime="message.time">{{ new Date(message.time).toLocaleString(locale) }}</time></div>
                <div class="session-bubble"><ChatMessageBody :expanded="expanded.has(message.id)" @toggle="toggle(message.id)"><div class="markdown-preview" data-no-i18n v-html="renderMarkdownPreview(message.text)" /></ChatMessageBody></div>
              </div>
            </article>
          </template>
          <p v-if="!loadingHistory && !messages.length && !historyError" class="text-center text-body-2 text-medium-emphasis pa-8">{{ t('这段会话还没有可显示的正文。') }}</p>
        </div>
      </template>
      <template v-else>
        <div class="session-placeholder"><v-icon icon="mdi-forum-outline" size="34" /><p>{{ t('选择会话查看用户输入和最终回复。') }}</p></div>
      </template>
      <template #composer><PersonaAgentSessionComposer :target="composerTarget" :request="composerRequest" @sent="refreshAfterSend" /></template>
      <template v-if="membersAvailable" #details>
        <div class="session-members-heading"><span>{{ t('子 Agent') }}</span><v-btn icon="mdi-refresh" variant="text" size="x-small" :loading="loadingMembers" :aria-label="t('刷新子 Agent')" @click="loadMembers()" /></div>
        <v-alert v-if="memberError" type="error" variant="tonal" density="compact">{{ memberError }}</v-alert>
        <v-list v-else density="compact" class="session-member-list">
          <v-virtual-scroll :items="members" :item-height="64" renderless><template #default="{item,itemRef}:{item:PersonaAgentTask;itemRef?:VNodeRef}">
            <v-list-item data-no-i18n :ref="itemRef" :key="item.id" :active="selectedMember?.id===item.id" :title="sessionTitle(item)" :subtitle="item.preview||item.agentRole||''" @click="chooseMember(item)">
              <template #prepend><AgentAvatar :provider="agent?.provider" :size="32" /></template>
            </v-list-item>
          </template></v-virtual-scroll>
        </v-list>
        <p v-if="!members.length&&!loadingMembers&&!memberError" class="pa-3 text-caption text-medium-emphasis">{{t('此会话暂无子 Agent。')}}</p>
        <v-btn v-if="memberOffset!==null" block variant="text" :loading="loadingMembers" @click="loadMembers(true)">{{t('加载更多子 Agent')}}</v-btn>
      </template>
    </HistoryConversationLayout>
  </section>
</template>

<style scoped>
.agent-session-history{display:flex;flex-direction:column;min-width:0;min-height:0;height:100%;}
.session-members-heading{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:8px 6px;font-size:13px;}
.session-member-list :deep(.v-list-item){min-height:64px;padding-inline:6px;}
.session-member-list :deep(.agent-avatar){margin-right:8px;}
.session-member-list :deep(.v-list-item-title),.session-member-list :deep(.v-list-item-subtitle){font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.session-parent-link{align-self:flex-start;margin-bottom:4px;}
.session-remote-note{margin:-8px 0 16px;}
.session-heading{position:sticky;top:0;z-index:3;background:rgb(var(--v-theme-background));display:flex;align-items:center;justify-content:space-between;gap:16px;padding:8px 16px 18px;border-bottom:1px solid var(--rr-border-faint);margin-bottom:20px;}
.session-heading h3{font-size:17px;font-weight:600;overflow-wrap:anywhere;}
.session-placeholder{display:flex;flex-direction:column;align-items:center;gap:10px;padding:80px 16px;color:rgba(var(--v-theme-on-surface),.45);}
.session-placeholder p{margin:0;font-size:13px;}
.session-messages{padding:0 16px;min-width:0;}
.session-message{display:flex;gap:12px;margin-bottom:24px;min-width:0;}
.session-message-content{min-width:0;max-width:92%;}
.session-sender{display:flex;align-items:center;gap:12px;font-size:12px;color:rgb(var(--v-theme-on-surface));opacity:.7;margin-bottom:7px;}
.session-sender time{font-size:11px;}
.session-bubble{padding:14px 18px;border-radius:4px 14px 14px 14px;background:rgba(var(--v-theme-on-surface),.06);overflow-wrap:anywhere;}
.session-user{flex-direction:row-reverse;}
.session-user .session-sender{justify-content:flex-end;}
.session-user .session-bubble{border-radius:14px 4px 14px 14px;background:rgba(var(--v-theme-secondary),.12);}
.session-bubble .markdown-preview{max-inline-size:900px;font-size:14px;line-height:1.75;}
.markdown-preview :deep(> * + *){margin-block-start:.7em;}
.markdown-preview :deep(h1),.markdown-preview :deep(h2),.markdown-preview :deep(h3),
.markdown-preview :deep(h4),.markdown-preview :deep(h5),.markdown-preview :deep(h6){font-weight:650;line-height:1.4;}
.markdown-preview :deep(h1){font-size:1.3em;}
.markdown-preview :deep(h2){font-size:1.2em;}
.markdown-preview :deep(h3){font-size:1.12em;}
.markdown-preview :deep(h4),.markdown-preview :deep(h5),.markdown-preview :deep(h6){font-size:1em;}
.markdown-preview :deep(> * + :is(h1, h2, h3, h4, h5, h6)){margin-block-start:1.15em;}
.markdown-preview :deep(ol),.markdown-preview :deep(ul){padding-inline-start:1.7em;}
.markdown-preview :deep(li + li),.markdown-preview :deep(li > * + *){margin-block-start:.32em;}
.markdown-preview :deep(:not(pre) > code){padding:.08em .3em;border-radius:4px;background:rgba(var(--v-theme-on-surface),.09);font-size:.9em;}
.markdown-preview :deep(pre){padding:.7em .85em;border-radius:6px;background:rgba(var(--v-theme-on-surface),.07);font-size:.9em;line-height:1.6;white-space:pre-wrap;overflow-wrap:anywhere;}
.session-instruction{display:grid;justify-items:center;gap:8px;margin-bottom:20px;}
.session-instruction-toggle{display:flex;align-items:center;gap:4px;max-width:100%;min-height:32px;padding:0 8px;color:rgba(var(--v-theme-on-surface),.64);font-size:12px;border-radius:5px;}
.session-instruction-toggle:hover,.session-instruction-toggle:focus-visible{background:rgba(var(--v-theme-on-surface),.08);}
.session-instruction-toggle>span{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.session-instruction pre{width:100%;margin:0;padding:12px 16px;background:rgba(var(--v-theme-on-surface),.045);border-radius:8px;font-size:12px;white-space:pre-wrap;overflow-wrap:anywhere;}
@media(max-width:760px){.session-messages{padding:0 4px;}.session-message-content{max-width:calc(100% - 52px);}.session-sender{flex-wrap:wrap;gap:4px 10px;}}
</style>
