<script setup lang="ts">
import { computed, onBeforeUnmount, reactive, watch } from "vue";
import type { AllDayEvent } from "@shared/allDayRecording";
import type { PersonaChatHistoryPage } from "@shared/personaChatHistory";
import { chatHistoryCategory } from "@shared/personaHistoryChannels";
import type { MessageContextRecord } from "../../../../../src/messageContextStore";
import { useI18n } from "../../../../../ribiwebgui/src/i18n/index";
import { adapterLabel } from "../../../../../ribiwebgui/src/utils/gatewayHelpers";
import { usePersonaService } from "../persona/personaServiceClient";

type Source = "endpoint" | "chat" | "capture";
type Entry = { id: string; time: number; label: string; text?: string; image?: string; fullText?: string };
type Cursor = string | number;
type Page = { entries: Entry[]; cursor: Cursor | null; pending?: boolean };
const props = defineProps<{ roleId: string; version: number; messageVersion: number; captureVersion: number }>();
const { t } = useI18n();
const service = usePersonaService();
const base = `/api/roles/${encodeURIComponent(props.roleId)}`;
const sources: Source[] = ["endpoint", "chat", "capture"];
const lanes = reactive(Object.fromEntries(sources.map(source => [source, { entries: [] as Entry[], cursor: null as Cursor | null, loading: false, waiting: false, failed: false }])) as Record<Source, {
  entries: Entry[]; cursor: Cursor | null; loading: boolean; waiting: boolean; failed: boolean;
}>);
const requests = new Map<Source, AbortController>();
const refreshPending = new Set<Source>();
const byId = (entries: Entry[]) => [...new Map(entries.map(entry => [entry.id, entry])).values()];
const timeFormat = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "medium" });
const labels = { agent: "Agent 间投递", panel: "角色面板", replies: "任务回复", aiui: "AIUI" };
const rows = computed(() => sources.flatMap(source => lanes[source].entries)
  .sort((left, right) => right.time - left.time || left.id.localeCompare(right.id)));
const loading = computed(() => sources.some(source => lanes[source].loading));
const canLoadOlder = computed(() => sources.some(source => lanes[source].cursor !== null));
const hasProblems = computed(() => sources.some(source => lanes[source].failed));

async function read<T>(path: string, query: URLSearchParams, signal: AbortSignal): Promise<T> {
  const response = await service.fetch(`${base}/${path}?${query}`, { signal });
  const result = await response.json();
  if (!response.ok || result.code !== 0) throw new Error("History read failed");
  return result.data;
}

async function readSource(source: Source, cursor: Cursor | null, signal: AbortSignal): Promise<Page> {
  const query = new URLSearchParams();
  if (cursor !== null) query.set("cursor", String(cursor));
  if (source === "endpoint") {
    query.set("includeArchives", "1");
    query.set("limit", "50");
    const page = await read<{ entries: MessageContextRecord[]; nextCursor: string | null; coverage?: { indexCoverage?: string } }>("message-endpoint-timeline", query, signal);
    return { entries: page.entries.map(row => ({
      id: `endpoint:${row.adapter}:${row.conversationKey}:${row.id ?? row.messageId ?? row.sequence}`, time: row.time * 1000,
      label: [t(adapterLabel(row.adapter)), row.sender].filter(Boolean).join(" · "), text: row.text,
    })), cursor: page.nextCursor, pending: page.coverage?.indexCoverage === "partial" };
  }
  if (source === "chat") {
    query.set("summary", "true");
    query.set("metadata", "recorded");
    const page = await read<PersonaChatHistoryPage>("chat-history", query, signal);
    return { entries: page.entries.map(row => ({
      id: `chat:${row.id}`, time: Date.parse(row.receivedAt),
      label: [t(labels[chatHistoryCategory(row)]), row.sourceLabel ?? row.sessionTitle].filter(Boolean).join(" · "),
      text: row.text, fullText: row.textTruncated ? row.id : undefined,
    })), cursor: page.nextCursor };
  }
  const anchor: { time: number; id: string } = typeof cursor === "string" ? JSON.parse(cursor) : { time: Date.now() + 1, id: "" };
  const page = await read<{ events: AllDayEvent[]; cursor: { time: number; id: string }; hasMore: boolean; loading: boolean; readError?: string }>(
    "all-day-recording/page", new URLSearchParams({ direction: "older", type: "image", time: String(anchor.time), id: anchor.id }), signal);
  if (page.readError) throw new Error(page.readError);
  return { entries: page.events.filter(event => event.kind === "image" && event.media).map(event => ({
    id: `capture:${event.id}`, time: event.startedAt, label: t("画面采集"), text: event.text,
    image: service.resource(`${base}/all-day-recording/${event.media}`),
  })), cursor: page.hasMore && page.events.length ? JSON.stringify(page.cursor) : null, pending: page.loading };
}

async function load(source: Source, older = false): Promise<void> {
  const lane = lanes[source];
  if (requests.has(source)) {
    if (!older) refreshPending.add(source);
    return;
  }
  const cursor = older ? lane.cursor : null;
  if (older && cursor === null) return;
  const request = new AbortController();
  requests.set(source, request);
  lane.loading = true;
  try {
    const page = await readSource(source, cursor, request.signal);
    if (request.signal.aborted) return;
    const existing = new Set(lane.entries.map(entry => entry.id));
    lane.entries = byId([...lane.entries, ...page.entries.filter(entry => Number.isFinite(entry.time))]);
    const hasGap = page.entries.length > 0 && !page.entries.some(entry => existing.has(entry.id));
    if ((!page.pending || page.entries.length) && (older || !existing.size || hasGap)) lane.cursor = page.cursor;
    lane.waiting = Boolean(page.pending);
    lane.failed = false;
  } catch {
    if (!request.signal.aborted) lane.failed = true;
  } finally {
    if (requests.get(source) === request) {
      requests.delete(source);
      lane.loading = false;
      if (refreshPending.delete(source)) void load(source);
    }
  }
}

function loadOlder(): void {
  for (const source of sources) void load(source, true);
}

async function expand(row: Entry): Promise<void> {
  if (!row.fullText) return;
  const id = row.fullText;
  const query = new URLSearchParams({ id, limit: "1", metadata: "recorded" });
  const controller = new AbortController();
  detail?.abort();
  detail = controller;
  try {
    const page = await read<PersonaChatHistoryPage>("chat-history", query, controller.signal);
    if (controller.signal.aborted || page.entries[0]?.id !== id) return;
    lanes.chat.entries = lanes.chat.entries.map(entry => entry.id === row.id
      ? { ...entry, text: page.entries[0]!.text, fullText: undefined } : entry);
  } catch {
    if (!controller.signal.aborted) lanes.chat.failed = true;
  }
}

let detail: AbortController | undefined;
watch(() => props.version, () => { void load("chat"); }, { immediate: true });
watch(() => props.messageVersion, () => { void load("endpoint"); }, { immediate: true });
watch(() => props.captureVersion, () => { void load("capture"); }, { immediate: true });
onBeforeUnmount(() => {
  detail?.abort();
  for (const request of requests.values()) request.abort();
  requests.clear();
  refreshPending.clear();
});
</script>

<template>
  <section class="role-timeline" aria-live="polite">
    <h2>{{ t("全天记录") }}</h2>
    <v-progress-linear v-if="loading || sources.some(source => lanes[source].waiting)" indeterminate color="secondary" />
    <v-alert v-if="hasProblems" type="warning" variant="tonal">{{ t("部分记录暂不可用。") }}</v-alert>
    <p v-if="!rows.length && !loading && !hasProblems && !sources.some(source => lanes[source].waiting)">{{ t("暂无消息记录") }}</p>
    <ol>
      <li v-for="row in rows" :key="row.id">
        <div class="role-timeline-meta">
          <span>{{ row.label }}</span>
          <time :datetime="new Date(row.time).toISOString()">{{ timeFormat.format(row.time) }}</time>
        </div>
        <p v-if="row.text">{{ row.text }}</p>
        <a v-if="row.image" :href="row.image" target="_blank" rel="noopener">
          <img :src="row.image" :alt="t('画面采集')" loading="lazy" />
        </a>
        <v-btn v-if="row.fullText" size="small" variant="text" @click="expand(row)">{{ t("展开全文") }}</v-btn>
      </li>
    </ol>
    <v-btn v-if="canLoadOlder" variant="text" :loading="loading" @click="loadOlder">{{ t("加载更早的消息") }}</v-btn>
  </section>
</template>

<style scoped>
.role-timeline { display: grid; align-content: start; gap: 10px; max-width: 1060px; padding: 0 12px 16px; }
.role-timeline h2 { font-size: 1.25rem; }
.role-timeline ol { display: grid; grid-auto-rows: max-content; gap: 6px; padding: 0; list-style: none; }
.role-timeline li { padding: 12px 14px; border: 1px solid rgba(var(--v-theme-on-surface), .14); border-radius: 8px; }
.role-timeline-meta { display: flex; flex-wrap: wrap; justify-content: space-between; column-gap: 12px; font-size: .85rem; }
.role-timeline-meta time { color: rgba(var(--v-theme-on-surface), .7); }
.role-timeline li p { margin: 6px 0 0; white-space: pre-wrap; overflow-wrap: anywhere; }
.role-timeline li img { display: block; margin-top: 8px; max-width: 100%; max-height: 220px; object-fit: contain; }
.role-timeline > .v-btn { justify-self: center; }
</style>
