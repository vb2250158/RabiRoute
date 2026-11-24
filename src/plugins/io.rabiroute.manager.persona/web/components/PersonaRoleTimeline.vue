<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, reactive, ref, watch } from "vue";
import type { AllDayEvent } from "@shared/allDayRecording";
import type { PersonaChatHistoryPage } from "@shared/personaChatHistory";
import { chatHistoryCategory, type ChatHistoryCategory } from "@shared/personaHistoryChannels";
import type { MessageContextRecord } from "../../../../../src/messageContextStore";
import { useI18n } from "../../../../../ribiwebgui/src/i18n/index";
import type { HistoryChannel } from "../../../../../ribiwebgui/src/personaHistoryChannels";
import { adapterLabel } from "../../../../../ribiwebgui/src/utils/gatewayHelpers";
import { usePersonaService } from "../persona/personaServiceClient";

type Source = "endpoint" | "chat" | "capture";
type Entry = { id: string; time: number; channel: string; label: string; text?: string; image?: string; fullText?: string };
type Cursor = string | number;
type Page = { entries: Entry[]; cursor: Cursor | null; pending?: boolean };
const props = defineProps<{
  roleId: string;
  version: number;
  messageVersion: number;
  captureVersion: number;
  sourceFilter?: "capture" | { adapter?: string; category?: ChatHistoryCategory };
  channels?: HistoryChannel[];
}>();
const { t } = useI18n();
const service = usePersonaService();
const base = `/api/roles/${encodeURIComponent(props.roleId)}`;
// Each filter mounts a timeline with its own source cursors.
const sources: Source[] = props.sourceFilter === "capture" ? ["capture"]
  : props.sourceFilter?.adapter ? ["endpoint"]
  : props.sourceFilter?.category ? ["chat"]
  : ["endpoint", "chat", "capture"];
const lanes = reactive(Object.fromEntries(sources.map(source => [source, { entries: [] as Entry[], cursor: null as Cursor | null, loading: false, waiting: false, failed: false }])) as Record<Source, {
  entries: Entry[]; cursor: Cursor | null; loading: boolean; waiting: boolean; failed: boolean;
}>);
const requests = new Map<Source, AbortController>();
const refreshPending = new Set<Source>();
const byId = (entries: Entry[]) => [...new Map(entries.map(entry => [entry.id, entry])).values()];
const timeFormat = new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" });
const tickFormat = new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
const localDate = (time: number) => {
  const date = new Date(time);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
};
const labels = { agent: "Agent 间投递", panel: "角色面板", replies: "任务回复", aiui: "AIUI" };
const channelCatalog = computed(() => new Map(props.channels?.filter(channel => channel.adapter || channel.category)
  .map(channel => [channel.id, channel])));
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
    if (typeof props.sourceFilter === "object" && props.sourceFilter.adapter) query.set("adapter", props.sourceFilter.adapter);
    query.set("includeArchives", "1");
    query.set("limit", "50");
    const page = await read<{ entries: MessageContextRecord[]; nextCursor: string | null; coverage?: { indexCoverage?: string } }>("message-endpoint-timeline", query, signal);
    return { entries: page.entries.map(row => {
      const channel = `endpoint:${row.adapter}`;
      return {
        id: `${channel}:${row.conversationKey}:${row.id ?? row.messageId ?? row.sequence}`, time: row.time * 1000,
        channel, label: [t(channelCatalog.value.get(channel)?.label ?? adapterLabel(row.adapter)), row.sender].filter(Boolean).join(" · "), text: row.text,
      };
    }), cursor: page.nextCursor, pending: page.coverage?.indexCoverage === "partial" };
  }
  if (source === "chat") {
    if (typeof props.sourceFilter === "object" && props.sourceFilter.category) query.set("category", props.sourceFilter.category);
    query.set("summary", "true");
    query.set("metadata", "recorded");
    const page = await read<PersonaChatHistoryPage>("chat-history", query, signal);
    return { entries: page.entries.map(row => {
      const category = chatHistoryCategory(row);
      return {
        id: `chat:${row.id}`, time: Date.parse(row.receivedAt), channel: `chat:${category}`,
        label: [t(labels[category]), row.sourceLabel ?? row.sessionTitle].filter(Boolean).join(" · "),
        text: row.text, fullText: row.textTruncated ? row.id : undefined,
      };
    }), cursor: page.nextCursor };
  }
  const anchor: { time: number; id: string } = typeof cursor === "string" ? JSON.parse(cursor) : { time: Date.now() + 1, id: "" };
  const page = await read<{ events: AllDayEvent[]; cursor: { time: number; id: string }; hasMore: boolean; loading: boolean; readError?: string }>(
    "all-day-recording/page", new URLSearchParams({ direction: "older", type: "image", time: String(anchor.time), id: anchor.id }), signal);
  if (page.readError) throw new Error(page.readError);
  return { entries: page.events.filter(event => event.kind === "image" && event.media).map(event => ({
    id: `capture:${event.id}`, time: event.startedAt, channel: "capture", label: t("画面采集"), text: event.text,
    image: service.resource(`${base}/all-day-recording/${event.media}`),
  })), cursor: page.hasMore && page.events.length ? JSON.stringify(page.cursor) : null, pending: page.loading };
}

async function load(source: Source, older = false): Promise<void> {
  if (!sources.includes(source)) return;
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

async function loadOlder(): Promise<void> {
  await Promise.all(sources.map(source => load(source, true)));
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
const minSpan = 3000;
const maxSpan = 86400000;
const span = ref(30 * 60000);
const position = ref<number>();
const selectedId = ref<string>();
const live = ref(false);
const clock = ref(Date.now());
let clockTimer: ReturnType<typeof setInterval> | undefined;
const reviewTime = computed(() => live.value ? clock.value : position.value ?? rows.value[0]?.time ?? clock.value);
const selected = computed(() => selectedId.value ? rows.value.find(row => row.id === selectedId.value) : position.value === undefined ? rows.value[0] : undefined);
const unavailableImage = ref<string>();
const list = ref<HTMLElement>();
const scrollTop = ref(0);
const rowStride = 90;
const listStart = computed(() => Math.max(0, Math.floor(scrollTop.value / rowStride) - 3));
const listRows = computed(() => rows.value.slice(listStart.value, listStart.value + 24));
const channelInfo = computed(() => {
  const info = new Map([...channelCatalog.value.values()].map(channel => [channel.id, {
    title: t(channel.label), icon: channel.icon, color: channel.category ? "#8cbbeb" : "#ba9deb",
  }]));
  info.set("capture", { title: t("画面采集"), icon: "mdi-monitor-screenshot", color: "#65cde4" });
  for (const row of rows.value) {
    if (info.has(row.channel)) continue;
    const [type, id] = row.channel.split(":");
    info.set(row.channel, type === "chat"
      ? { title: t(labels[id as ChatHistoryCategory] ?? id), icon: "mdi-message-outline", color: "#8cbbeb" }
      : { title: t(adapterLabel(id)), icon: "mdi-message-outline", color: "#ba9deb" });
  }
  return info;
});
const trackChannels = computed(() => {
  const filter = props.sourceFilter;
  const id = filter === "capture" ? "capture" : filter?.adapter ? `endpoint:${filter.adapter}` : filter?.category ? `chat:${filter.category}` : undefined;
  return [...channelInfo.value].filter(([channel]) => !id || id === channel);
});
const viewStart = computed(() => reviewTime.value - span.value / 2);
const percent = (time: number) => (time - viewStart.value) / span.value * 100;
const ticks = computed(() => Array.from({ length: 7 }, (_, index) => viewStart.value + span.value * index / 6));
const markers = computed(() => {
  const tracks = new Map<string, Map<number, { row: Entry; offset: number; count: number }>>();
  for (const row of rows.value) {
    const offset = percent(row.time);
    if (offset < 0 || offset > 100) continue;
    let track = tracks.get(row.channel);
    if (!track) { track = new Map(); tracks.set(row.channel, track); }
    const bucket = Math.floor(offset / 2);
    const marker = track.get(bucket);
    if (!marker || row.id === selected.value?.id) track.set(bucket, { row, offset, count: (marker?.count ?? 0) + 1 });
    else marker.count++;
  }
  return tracks;
});

function stopLive(): void {
  clearInterval(clockTimer);
  live.value = false;
}

function select(row: Entry, syncList = true): void {
  stopLive();
  position.value = row.time;
  selectedId.value = row.id;
  if (syncList) {
    void nextTick(() => {
      if (list.value) list.value.scrollTop = Math.max(0, rows.value.findIndex(candidate => candidate.id === row.id) * rowStride);
    });
  }
}

function goLive(): void {
  position.value = undefined;
  selectedId.value = undefined;
  stopLive();
  clock.value = Date.now();
  live.value = true;
  clockTimer = setInterval(() => { clock.value = Date.now(); }, 1000);
  if (list.value) list.value.scrollTop = 0;
}

function browseTime(time: number): void {
  stopLive();
  position.value = Math.min(time, Date.now());
  selectedId.value = undefined;
}

async function jumpDate(date: string): Promise<void> {
  if (!date) return;
  const first = rows.value.find(row => localDate(row.time) === date);
  if (first) { select(first); return; }
  browseTime(new Date(`${date}T12:00:00`).getTime());
  if (!canLoadOlder.value || (rows.value.length && date >= localDate(rows.value.at(-1)!.time))) return;
  const target = position.value;
  await loadOlder();
  if (position.value !== target) return;
  const match = rows.value.find(row => localDate(row.time) === date);
  if (match) select(match);
}

function adjacent(direction: 1 | -1): Entry | undefined {
  if (selected.value) {
    const index = rows.value.findIndex(row => row.id === selected.value?.id);
    return rows.value[index + direction];
  }
  if (direction === 1) return rows.value.find(row => row.time <= reviewTime.value);
  const older = rows.value.findIndex(row => row.time < reviewTime.value);
  return rows.value[older < 0 ? rows.value.length - 1 : older - 1];
}

async function navigate(direction: 1 | -1): Promise<void> {
  let row = adjacent(direction);
  if (!row && direction === 1 && canLoadOlder.value && !loading.value) {
    await loadOlder();
    row = adjacent(direction);
  }
  if (row) select(row);
}

function zoom(factor: number): void {
  span.value = Math.max(minSpan, Math.min(maxSpan, span.value * factor));
}

let drag: { x: number; time: number; width: number } | undefined;
function startPan(event: PointerEvent): void {
  if (event.button !== 0) return;
  const ruler = event.currentTarget as HTMLElement;
  drag = { x: event.clientX, time: reviewTime.value, width: ruler.clientWidth };
  ruler.setPointerCapture(event.pointerId);
}

function pan(event: PointerEvent): void {
  if (drag && drag.width) browseTime(drag.time - (event.clientX - drag.x) * span.value / drag.width);
}

watch(() => props.version, () => { void load("chat"); }, { immediate: true });
watch(() => props.messageVersion, () => { void load("endpoint"); }, { immediate: true });
watch(() => props.captureVersion, () => { void load("capture"); }, { immediate: true });
onBeforeUnmount(() => {
  stopLive();
  detail?.abort();
  for (const request of requests.values()) request.abort();
  requests.clear();
  refreshPending.clear();
});
</script>

<template>
  <section class="all-day role-timeline" data-testid="persona-role-timeline">
    <div class="recording-toolbar">
      <h2>{{ t("全天记录") }}</h2>
      <span class="muted">{{ t("事件") }} {{ rows.length }}</span>
    </div>
    <v-progress-linear v-if="loading || sources.some(source => lanes[source].waiting)" indeterminate color="secondary" />
    <v-alert v-if="hasProblems" type="warning" variant="tonal">{{ t("部分记录暂不可用。") }}</v-alert>
    <div class="recording-workspace">
      <div class="review-column">
        <v-card class="app-card glass-card review-card">
          <div class="recording-preview" aria-live="polite">
            <a v-if="selected?.image && unavailableImage !== selected.image" :href="selected.image" target="_blank" rel="noopener">
              <img :src="selected.image" :alt="t('画面采集')" :key="selected.id" @error="unavailableImage = selected.image" />
            </a>
            <div v-else-if="selected" class="event-preview">
              <v-icon :icon="channelInfo.get(selected.channel)?.icon" :color="channelInfo.get(selected.channel)?.color" size="38" />
              <strong>{{ selected.label }}</strong>
              <p v-if="selected.text">{{ selected.text }}</p>
              <p v-if="selected.image">{{ t("画面暂不可用") }}</p>
              <v-btn v-if="selected.fullText" size="small" variant="text" @click="expand(selected)">{{ t("展开全文") }}</v-btn>
            </div>
            <div v-else class="preview-empty">
              <v-icon icon="mdi-timeline-clock-outline" size="42" />
              <p>{{ t("选择时间轴上的事件回看") }}</p>
            </div>
            <time v-if="selected" class="preview-time" :datetime="new Date(selected.time).toISOString()">
              {{ localDate(selected.time) }} · {{ timeFormat.format(selected.time) }}
            </time>
          </div>
        </v-card>
        <div class="timeline-dock">
          <div class="date-toolbar">
            <input :value="localDate(reviewTime)" :max="localDate(Date.now())" type="date" :aria-label="t('跳转日期')" @change="jumpDate(($event.target as HTMLInputElement).value)" />
            <v-spacer />
            <v-btn variant="text" prepend-icon="mdi-chevron-left" :disabled="!adjacent(1) && !canLoadOlder" @click="navigate(1)">{{ t("上一个事件") }}</v-btn>
            <v-btn variant="text" append-icon="mdi-chevron-right" :disabled="!adjacent(-1)" @click="navigate(-1)">{{ t("下一个事件") }}</v-btn>
            <v-btn variant="text" :aria-pressed="live" @click="goLive">{{ t("回到实时") }}</v-btn>
            <v-btn icon="mdi-minus" variant="text" :disabled="span >= maxSpan" :aria-label="t('缩小时间轴')" @click="zoom(2)" />
            <v-btn icon="mdi-plus" variant="text" :disabled="span <= minSpan" :aria-label="t('放大时间轴')" @click="zoom(.5)" />
          </div>
          <div class="time-ruler" tabindex="0" role="group" :aria-label="t('记录时间轴')"
            @pointerdown="startPan" @pointermove="pan" @pointerup="drag = undefined" @pointercancel="drag = undefined"
            @wheel.prevent="browseTime(reviewTime + Math.sign($event.deltaX || $event.deltaY) * span / 5)"
            @keydown.left.prevent="navigate(1)" @keydown.right.prevent="navigate(-1)">
            <div class="time-ticks"><time v-for="tick in ticks" :key="tick">{{ (span < 300000 ? timeFormat : tickFormat).format(tick) }}</time></div>
            <div v-for="[channel, source] in trackChannels" :key="channel" class="source-lane">
              <span class="lane-name" :title="source.title">{{ source.title }}</span>
              <button v-for="marker in markers.get(channel)?.values()" :key="marker.row.id" type="button" class="timeline-event"
                :class="{ selected: selected?.id === marker.row.id }" :style="{ left: `${marker.offset}%`, '--event-color': source.color }"
                :title="`${timeFormat.format(marker.row.time)} · ${marker.row.label}`" :aria-label="`${source.title} ${timeFormat.format(marker.row.time)}`"
                @pointerdown.stop @click="select(marker.row); if (marker.count > 1) zoom(.25)" />
            </div>
            <div class="timeline-cursor" style="left: 50%" />
          </div>
        </div>
      </div>
      <div class="events-column">
        <div ref="list" class="events-scroller" tabindex="0" role="region" :aria-label="t('事件')" @scroll.passive="scrollTop = ($event.currentTarget as HTMLElement).scrollTop">
          <div v-if="!rows.length && !loading && !sources.some(source => lanes[source].waiting)" class="no-events">{{ t("暂无消息记录") }}</div>
          <div v-else class="virtual-events" :style="{ height: `${rows.length * rowStride}px` }">
            <button v-for="(row, offset) in listRows" :key="row.id" type="button" class="recording-event-row" :class="{ active: selected?.id === row.id }"
              :style="{ top: `${(listStart + offset) * rowStride}px` }" :aria-pressed="selected?.id === row.id" @click="select(row, false)">
              <time :datetime="new Date(row.time).toISOString()">{{ localDate(row.time) }}<br />{{ timeFormat.format(row.time) }}</time>
              <v-icon :icon="channelInfo.get(row.channel)?.icon" :color="channelInfo.get(row.channel)?.color" />
              <div><b>{{ row.label }}</b><p v-if="row.text">{{ row.text }}</p></div>
            </button>
          </div>
          <v-btn v-if="canLoadOlder" variant="text" :loading="loading" @click="loadOlder">{{ t("加载更早的消息") }}</v-btn>
        </div>
      </div>
    </div>
  </section>
</template>

<style scoped src="./personaRecordingReview.css"></style>
<style scoped>
.role-timeline { padding: 0 2px 16px; }
.role-timeline .event-preview { max-height: calc(100% - 56px); margin-top: 36px; white-space: pre-wrap; overflow-wrap: anywhere; }
.role-timeline .recording-preview a, .role-timeline .recording-preview img { position: absolute; inset: 0; }
.role-timeline .preview-time { pointer-events: none; }
.role-timeline .events-scroller::after { content: none; }
.role-timeline .lane-name { max-width: 96px; text-overflow: ellipsis; overflow: hidden; }
.role-timeline .timeline-event { transform: translateX(-50%); }
.role-timeline .recording-event-row b { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
@media(max-width: 650px) { .role-timeline .time-ticks time:nth-child(even) { display: none; } }
</style>
