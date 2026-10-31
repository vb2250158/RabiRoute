<script setup lang="ts">
import { userFacingError } from "../userFacingError";
import { nextTick, onBeforeUnmount, ref, watch } from "vue";
import type { PersonaChatHistoryPage, PersonaChatReply } from "@shared/personaChatHistory";
import { mergeChatHistoryBatch, readChatHistoryAddition, retainChatHistoryWindow } from "../personaChatHistoryUpdates";
import { waitForChatHistoryFrame } from "../personaChatHistoryLayout";
import { renderMarkdownPreview } from "../markdownPreview";
import { useI18n } from "../i18n";
import { usePersonaService } from "../persona/personaServiceClient";
const fetch = usePersonaService().fetch;

const props = defineProps<{ roleId: string; version: number }>();
const { t } = useI18n();
const entries = ref<PersonaChatReply[]>([]);
const nextCursor = ref<number | null>(null);
const newerCursor = ref<number | null>(null);
const invalidRecords = ref(0);
const bodyCache = ref(new Map<string, string>());
const bodyLoading = ref<string>();
let bodyRequest: AbortController | undefined;
const loading = ref(false);
const error = ref("");
const listElement = ref<HTMLElement>();
const virtualList = ref<{ scrollToIndex: (index: number) => void }>();
const expandedBodies = ref(new Set<string>());
const gapCursor = ref<number | null>(null);
let gapBoundaryId: string | undefined;
let gapAfterId: string | undefined;
let request: AbortController | undefined;
let pendingUpdate = false;

async function load(older = false, resumeGap = false, newer = false): Promise<void> {
  if (request) { if (!older) pendingUpdate = true; return; }
  const controller = new AbortController();
  request = controller;
  loading.value = true;
  error.value = "";
  const roleId = props.roleId;
  const continuation = resumeGap && gapCursor.value !== null;
  const boundaryId = gapBoundaryId ?? entries.value[0]?.id;
  const afterId = continuation ? gapAfterId : undefined;
  const refreshed = new Map<string, PersonaChatReply>();
  const readPage = async (cursor?: number): Promise<PersonaChatHistoryPage> => {
    const query = new URLSearchParams({ limit: "50", summary: "true", ...(newer ? { direction: "newer" } : {}) });
    if (cursor !== undefined) query.set("cursor", String(cursor));
    const response = await fetch(`/api/roles/${encodeURIComponent(roleId)}/chat-history?${query}`, { signal: controller.signal });
    const result = await response.json() as { code: number; data: PersonaChatHistoryPage; message?: string };
    if (!response.ok || result.code !== 0) throw new Error(result.message || t("消息记录读取失败"));
    for (const entry of result.data.entries) refreshed.set(entry.id, entry);
    return result.data;
  };
  try {
    const hadEntries = entries.value.length > 0;
    const page = newer ? await readPage(newerCursor.value ?? undefined) : older
      ? await readPage(nextCursor.value ?? undefined)
      : await readChatHistoryAddition(gapCursor.value !== null && boundaryId ? new Set([boundaryId]) : new Set(entries.value.map(entry => entry.id)), readPage, { cursor: continuation ? gapCursor.value! : undefined });
    if (controller.signal.aborted) return;
    const known = new Set(entries.value.map(entry => entry.id));
    for (const entry of entries.value) {
      const update = refreshed.get(entry.id);
      if (update) {
        delete entry.taskUrl;
        delete entry.targetTaskUrl;
        Object.assign(entry, update);
      }
    }
    const added = page.entries.filter(entry => !known.has(entry.id));
    // Retain existing keyed nodes and the visible reading anchor during a prepend.
    const viewport = listElement.value?.getBoundingClientRect();
    const anchor = [...(listElement.value?.querySelectorAll<HTMLElement>(".chat-reply") ?? [])]
      .find(element => element.getBoundingClientRect().bottom > Math.max(0, viewport?.top ?? 0) && element.getBoundingClientRect().top < Math.min(window.innerHeight, viewport?.bottom ?? window.innerHeight));
    const anchorTop = anchor?.getBoundingClientRect().top ?? 0;
    const anchorId = anchor?.dataset.entryId;
    let scroller = anchor?.parentElement;
    while (scroller && !(/auto|scroll/.test(getComputedStyle(scroller).overflowY) && scroller.scrollHeight > scroller.clientHeight)) scroller = scroller.parentElement;
    const readingScroller = scroller ?? document.scrollingElement;
    const preservePosition = (readingScroller?.scrollTop ?? 0) > 0;
    if (older) entries.value.push(...added);
    else entries.value = mergeChatHistoryBatch(entries.value, page.entries, afterId);
    const retained = retainChatHistoryWindow(entries.value, anchorId, older);
    entries.value = retained.entries;
    const retainedIds = new Set(entries.value.map(entry => entry.id));
    for (const id of expandedBodies.value) if (!retainedIds.has(id)) { expandedBodies.value.delete(id); bodyCache.value.delete(id); }
    if (older || !hadEntries) nextCursor.value = page.nextCursor;
    if (retained.trimmedOlder) nextCursor.value = entries.value.at(-1)?.historyCursor ?? nextCursor.value;
    if (newer || !hadEntries) newerCursor.value = page.newerCursor ?? null;
    if (retained.trimmedNewer) newerCursor.value = entries.value[0]?.historyEndCursor ?? newerCursor.value;
    invalidRecords.value = page.invalidRecords ?? invalidRecords.value;
    if (!older && !newer && "continuationCursor" in page) {
      gapCursor.value = page.continuationCursor as number | null;
      gapBoundaryId = gapCursor.value === null ? undefined : boundaryId;
      gapAfterId = gapCursor.value === null ? undefined : (page.entries.at(-1)?.id ?? afterId);
    }
    await nextTick();
    if (!controller.signal.aborted && anchorId && added.length && preservePosition) {
      // Vuetify measures dynamic rows with ResizeObserver and updates spacer offsets
      // after Vue's nextTick. Keep the actual rendered anchor, then settle its offset
      // across those measurements; scrollToIndex is only needed if it left the window.
      let userInterrupted = false;
      const interrupt = () => { userInterrupted = true; };
      const interruptionEvents = ["wheel", "touchstart", "pointerdown", "keydown"] as const;
      for (const event of interruptionEvents) readingScroller?.addEventListener(event, interrupt, { passive: true });
      try {
        let stableFrames = 0;
        let requestedIndex = false;
        for (let frame = 0; frame < 16 && !controller.signal.aborted && !userInterrupted; frame++) {
          if (!await waitForChatHistoryFrame(controller.signal) || userInterrupted) break;
          const restored = [...(listElement.value?.querySelectorAll<HTMLElement>(".chat-reply") ?? [])]
            .find(element => element.dataset.entryId === anchorId);
          if (!restored) {
            if (!requestedIndex) {
              virtualList.value?.scrollToIndex(entries.value.findIndex(entry => entry.id === anchorId));
              requestedIndex = true;
            }
            stableFrames = 0;
            continue;
          }
          const delta = restored.getBoundingClientRect().top - anchorTop;
          if (Math.abs(delta) > 0.5 && readingScroller) {
            readingScroller.scrollTop += delta;
            stableFrames = 0;
          } else if (++stableFrames >= 4) break;
        }
      } finally {
        for (const event of interruptionEvents) readingScroller?.removeEventListener(event, interrupt);
      }
    }
  } catch (cause) {
    if (!controller.signal.aborted) error.value = userFacingError(cause);
  } finally {
    if (request === controller) {
      request = undefined;
      loading.value = false;
      if (pendingUpdate) { pendingUpdate = false; void load(); }
    }
  }
}

async function expandBody(entry: PersonaChatReply) {
  bodyRequest?.abort();
  const controller = new AbortController(); bodyRequest = controller; bodyLoading.value = entry.id;
  const roleId = props.roleId;
  try {
    let text = entry.text;
    if (entry.textTruncated) {
      const query = new URLSearchParams({ limit: '1', direction: 'newer', cursor: String(entry.historyCursor), id: entry.id });
      const response = await fetch(`/api/roles/${encodeURIComponent(roleId)}/chat-history?${query}`, { signal: controller.signal });
      const result = await response.json() as { code: number; data: PersonaChatHistoryPage; message?: string };
      if (!response.ok || result.code !== 0 || result.data.entries[0]?.id !== entry.id) throw new Error(result.message || t('消息记录读取失败'));
      text = result.data.entries[0].text;
    }
    if (controller.signal.aborted || roleId !== props.roleId || !entries.value.some(item => item.id === entry.id)) return;
    if (bodyCache.value.size >= 3) { const oldest = bodyCache.value.keys().next().value!; bodyCache.value.delete(oldest); expandedBodies.value.delete(oldest); }
    bodyCache.value.set(entry.id, text); expandedBodies.value.add(entry.id);
  } catch (cause) { if (!controller.signal.aborted) error.value = userFacingError(cause); }
  finally { if (bodyRequest === controller) { bodyLoading.value = undefined; bodyRequest = undefined; } }
}
function collapseBody(id: string) { expandedBodies.value.delete(id); bodyCache.value.delete(id); }

watch(() => props.roleId, () => {
  request?.abort();
  request = undefined;
  pendingUpdate = false;
  entries.value = [];
  gapCursor.value = null;
  gapBoundaryId = undefined;
  gapAfterId = undefined;
  expandedBodies.value.clear();
  bodyRequest?.abort(); bodyRequest = undefined; bodyLoading.value = undefined; bodyCache.value.clear();
  newerCursor.value = null; invalidRecords.value = 0;
  nextCursor.value = null;
  void load();
}, { immediate: true });
watch(() => props.version, () => { void load(); });
onBeforeUnmount(() => { bodyRequest?.abort(); pendingUpdate = false; request?.abort(); request = undefined; });
</script>

<template>
  <v-card class="app-card glass-card pa-4">
    <div class="d-flex align-center justify-space-between ga-3 mb-3">
      <div>
        <div class="text-h6">{{ t('消息记录') }}</div>
        <div class="text-body-2 text-medium-emphasis">{{ t('显示当前角色的用户消息、最终回复和 Agent 之间的投递，最新在前。') }}</div>
      </div>
      <v-btn variant="text" prepend-icon="mdi-refresh" :loading="loading" @click="load()">{{ t('刷新') }}</v-btn>
    </div>
    <v-alert v-if="error" type="error" variant="tonal" class="mb-3">{{ error }}</v-alert>
    <v-progress-linear v-if="loading && !entries.length" indeterminate color="secondary" :aria-label="t('正在读取消息记录')" />
    <v-alert v-else-if="!entries.length && !error" type="info" variant="tonal">
      {{ nextCursor !== null ? t('当前没有可显示的消息，请继续加载更早的回复。') : t('暂无消息记录。用户提交并投递的消息、Hook 最终回复和 Agent 投递会显示在这里。') }}
    </v-alert>
    <v-alert v-if="gapCursor !== null" type="info" variant="tonal" class="mb-3">
      {{ t('还有消息待加载，当前记录仍可浏览。') }}
      <v-btn variant="text" :disabled="loading" @click="load(false, true)">{{ t('继续加载') }}</v-btn>
    </v-alert>
    <v-alert v-if="invalidRecords" type="warning" variant="tonal" class="mb-3">{{ t('部分消息记录损坏，其他消息仍可浏览。') }}</v-alert>
    <v-btn v-if="newerCursor !== null" variant="tonal" :disabled="loading" @click="load(false, false, true)">{{ t('加载较新的回复') }}</v-btn>
    <div ref="listElement" class="chat-history-list" aria-live="polite" :aria-busy="loading">
      <v-virtual-scroll v-if="entries.length" ref="virtualList" :items="entries" item-key="id" :height="600" :item-height="180">
      <template #default="{ item: entry }">
      <article :key="entry.id" :data-entry-id="entry.id" class="chat-reply">
        <div class="text-caption text-medium-emphasis mb-2">
          <time :datetime="entry.receivedAt">{{ new Date(entry.receivedAt).toLocaleString() }}</time>
          <div class="chat-task-row mt-1">
            <div class="chat-task-source">
            <template v-if="entry.kind === 'user_delivery'">{{ t('来自用户') }} · {{ entry.sourceLabel }}<span v-if="entry.planTitle"> · {{ entry.planTitle }}</span></template>
            <template v-else>
            {{ t('来源任务') }}：
            <a v-if="entry.taskUrl" :href="entry.taskUrl" class="chat-task-link" :title="entry.sessionId" data-no-i18n>{{ entry.sessionTitle || entry.sessionId }}</a>
            <span v-else :title="entry.sessionId" data-no-i18n>{{ entry.sessionTitle || entry.sessionId }}</span>
            <span v-if="entry.sourceTaskOwner?.kind === 'instance'" class="chat-task-node">{{ t('远端节点') }} · <span data-no-i18n>{{ entry.sourceTaskOwner.nodeName || entry.sourceTaskOwner.nodeId }}</span></span>
            </template>
            </div>
            <div v-if="entry.targetSessionId" class="chat-task-target">
              {{ t('目标任务') }}：
              <a v-if="entry.targetTaskUrl" :href="entry.targetTaskUrl" class="chat-task-link" :title="entry.targetSessionId" data-no-i18n>{{ entry.targetSessionTitle || entry.targetSessionId }}</a>
              <span v-else :title="entry.targetSessionId" data-no-i18n>{{ entry.targetSessionTitle || entry.targetSessionId }}</span>
              <span v-if="!entry.targetSessionTitle" class="chat-task-node">{{ t('任务名称暂不可用') }}</span>
              <span v-if="entry.targetTaskOwner?.kind === 'instance'" class="chat-task-node">{{ t('远端节点') }} · <span data-no-i18n>{{ entry.targetTaskOwner.nodeName || entry.targetTaskOwner.nodeId }}</span></span>
            </div>
          </div>
          <div v-if="entry.kind === 'user_delivery'" class="mt-1">{{ t(entry.deliveryStatus === 'unconfirmed' ? '用户投递（记录时尚未确认送达）' : '用户投递') }}</div>
          <div v-if="entry.kind === 'agent_delivery'" class="mt-1">{{ t(entry.deliveryStatus === 'unconfirmed' ? 'Agent 投递（记录时尚未确认送达）' : 'Agent 投递') }}</div>
          <details class="mt-1">
            <summary>ID</summary>
            <div v-if="entry.kind !== 'user_delivery'" data-no-i18n>Task: {{ entry.sessionId }}</div>
            <div v-if="entry.targetSessionId" data-no-i18n>Target: {{ entry.targetSessionId }}</div>
            <div v-if="entry.targetTaskOwner?.nodeId" data-no-i18n>Target node: {{ entry.targetTaskOwner.nodeId }}</div>
            <div v-if="entry.turnId" data-no-i18n>Turn: {{ entry.turnId }}</div>
            <div v-if="entry.feedbackId" data-no-i18n>Feedback: {{ entry.feedbackId }}</div>
            <div v-if="entry.deliveryId" data-no-i18n>Delivery: {{ entry.deliveryId }}</div>
          </details>
        </div>
        <template v-if="(entry.textTruncated || entry.text.length > 2000) && !expandedBodies.has(entry.id)">
          <div class="chat-reply-text chat-reply-summary" data-no-i18n>{{ entry.text.slice(0, 2000) }}…</div>
          <v-btn variant="text" :loading="bodyLoading === entry.id" @click="expandBody(entry)">{{ t('展开全文') }}</v-btn>
        </template>
        <template v-else>
          <div class="chat-reply-text" data-no-i18n v-html="renderMarkdownPreview(bodyCache.get(entry.id) ?? entry.text)"></div>
          <v-btn v-if="entry.textTruncated || entry.text.length > 2000" variant="text" @click="collapseBody(entry.id)">{{ t('收起') }}</v-btn>
        </template>
      </article>
      </template>
      </v-virtual-scroll>
    </div>
    <v-btn v-if="nextCursor !== null" class="mt-3" variant="tonal" :disabled="loading" @click="load(true)">{{ t('加载更早的回复') }}</v-btn>
  </v-card>
</template>

<style scoped>
.chat-history-list :deep(.v-virtual-scroll) { overflow-anchor: none; }
.chat-reply-summary { white-space: pre-wrap; display: -webkit-box; -webkit-line-clamp: 8; -webkit-box-orient: vertical; overflow: hidden; }
.chat-history-list .chat-reply { margin-bottom: 16px; }
.chat-reply { padding: 16px; border: 1px solid rgba(var(--v-theme-on-surface), .12); border-radius: 12px; min-width: 0; }
.chat-reply-text { overflow-wrap: anywhere; line-height: 1.65; }
.chat-reply-text :deep(> :first-child) { margin-top: 0; }
.chat-reply-text :deep(> :last-child) { margin-bottom: 0; }
.chat-reply-text :deep(p) { margin: .75em 0; }
.chat-reply-text :deep(h1), .chat-reply-text :deep(h2), .chat-reply-text :deep(h3),
.chat-reply-text :deep(h4), .chat-reply-text :deep(h5), .chat-reply-text :deep(h6) { margin: 1.2em 0 .5em; line-height: 1.35; }
.chat-reply-text :deep(h1) { font-size: 1.45em; }
.chat-reply-text :deep(h2) { font-size: 1.3em; }
.chat-reply-text :deep(h3) { font-size: 1.15em; }
.chat-reply-text :deep(ul), .chat-reply-text :deep(ol) { padding-left: 1.5em; margin: .6em 0; }
.chat-reply-text :deep(li + li) { margin-top: .3em; }
.chat-reply-text :deep(code) { padding: .12em .35em; border-radius: 4px; background: rgba(var(--v-theme-on-surface), .07); font-size: .9em; }
.chat-reply-text :deep(pre) { overflow-x: auto; padding: 12px 16px; margin: .8em 0; border-radius: 8px; background: rgba(var(--v-theme-on-surface), .05); }
.chat-reply-text :deep(pre code) { padding: 0; background: none; overflow-wrap: normal; }
.chat-reply-text :deep(blockquote) { border-left: 3px solid rgba(var(--v-theme-secondary), .5); padding-left: 1em; margin: .8em 0; color: rgba(var(--v-theme-on-surface), .75); }
.chat-reply-text :deep(table) { display: block; max-width: 100%; overflow-x: auto; border-collapse: collapse; margin: .8em 0; }
.chat-reply-text :deep(th), .chat-reply-text :deep(td) { border: 1px solid rgba(var(--v-theme-on-surface), .15); padding: 8px 12px; text-align: left; }
.chat-reply-text :deep(a) { color: rgb(var(--v-theme-secondary)); text-underline-offset: 3px; }
details { overflow-wrap: anywhere; }
summary { cursor: pointer; }
.chat-task-link { color: rgb(var(--v-theme-secondary)); text-underline-offset: 3px; overflow-wrap: anywhere; }
.chat-task-row { display: flex; justify-content: space-between; align-items: baseline; gap: 24px; }
.chat-task-source, .chat-task-target { min-width: 0; overflow-wrap: anywhere; flex: 0 1 50%; }
.chat-task-node { display: block; font-size: .75rem; opacity: .8; }
.chat-task-target { text-align: right; }
@media (max-width: 600px) { .chat-task-row { flex-direction: column; gap: 8px; } .chat-task-target { text-align: left; } }
</style>
