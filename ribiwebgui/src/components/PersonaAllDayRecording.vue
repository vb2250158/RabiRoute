<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, shallowRef, toRaw, watch } from "vue";
import { useI18n } from "../i18n";
import { managerEventSource } from "../managerApi";
import { reviewIndex, reviewWindow, latestReviewEvent } from "../allDayReviewModel";
import { ALL_DAY_SOURCES, DEFAULT_ALL_DAY_SETTINGS, type AllDayEvent, type AllDaySettings, type AllDaySnapshot } from "@shared/allDayRecording";

const props = defineProps<{ roleId: string }>();
const { isEnglish } = useI18n();
const label = (zh: string, en: string) => isEnglish.value ? en : zh;
const sources = computed(() => [
  { id: "microphone", name: label("麦克风", "Microphone"), icon: "mdi-microphone", color: "#62d4a0" },
  { id: "screen", name: label("屏幕", "Screen"), icon: "mdi-monitor", color: "#65cde4" },
  { id: "window", name: label("前台窗口", "Foreground window"), icon: "mdi-application-outline", color: "#dfba70" },
  { id: "camera", name: label("摄像头", "Camera"), icon: "mdi-camera-outline", color: "#ba9deb" },
  { id: "mobile", name: label("手机", "Mobile"), icon: "mdi-cellphone", color: "#e69caa" },
  { id: "session", name: label("采集状态", "Capture status"), icon: "mdi-record-circle-outline", color: "#95a5ad" }
]);
const sourceInfo = (id: string) => sources.value.find(source => source.id === id)!;
const localDate = (date: Date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
const date = computed(() => localDate(new Date(cursor.value)));
const cursor = ref(Date.now());
const span = ref(30 * 60_000);
const viewStart = computed(() => Math.max(0, cursor.value - span.value / 2));
const viewEnd = computed(() => cursor.value + span.value / 2);
const live = ref(true);
let loadedRange = { start: 0, end: 0 };
let requestedRange: { start: number; end: number } | undefined;
let rangeTimer: ReturnType<typeof setTimeout> | undefined;
let inertia = 0;
let velocity = 0;
let lastMove = 0;
let lastX = 0;
const events = shallowRef<AllDayEvent[]>([]);
const fetching = ref(false);
const hasLoaded = ref(false);
let refreshQueued = false;
let disposed = false;
const rowStride = 90;
const listScrollTop = ref(0);
const virtualStart = computed(() => Math.max(0, Math.floor(listScrollTop.value / rowStride) - 6));
const state = ref<(AllDaySnapshot & { devices?: { id: string; lastReceivedAt: number }[] }) | null>(null);
const settings = ref<AllDaySettings>(structuredClone(DEFAULT_ALL_DAY_SETTINGS));
const settingsOpen = ref(false);
const selectedId = ref("");
const filter = ref("all");
const busy = ref(false);
const error = ref("");
const stateError = ref("");
const ruler = ref<HTMLElement>();
const eventList = ref<HTMLElement>();
let listDriving = false;
let expectedScrollTop: number | undefined;
let listFrame = 0;
const loadingMore = ref(false);
let lastEdgeLoad = 0;
let drag: { x: number; time: number; span: number; width: number; moved: boolean } | undefined;
let controller: AbortController | undefined;
let statusController: AbortController | undefined;
let eventSource: EventSource | null = null;
let refreshTimer: ReturnType<typeof setTimeout> | undefined;
const api = computed(() => `/api/roles/${encodeURIComponent(props.roleId)}/all-day-recording`);
const indexedEvents = computed(() => reviewIndex(events.value));
const visible = computed(() => reviewWindow(indexedEvents.value,viewStart.value,viewEnd.value).filter(event => filter.value === "all" || event.source === filter.value));
// Keep the buffered list stable while its scrolling drives the timeline viewport.
const listEvents = computed(() => events.value.filter(event => filter.value === "all" || event.source === filter.value).slice().reverse());
const listIndices = computed(() => new Map(listEvents.value.map((event,index) => [event.id,index])));
const renderedEvents = computed(() => listEvents.value.slice(virtualStart.value, virtualStart.value + 24));
// Co-located events share a marker at wide zoom; zooming reveals individual events.
const markerGroups = computed(() => {
  const lanes = new Map<string, Map<number, { event: AllDayEvent; count: number }>>();
  for (const event of visible.value) {
    let lane = lanes.get(event.source); if (!lane) { lane = new Map(); lanes.set(event.source, lane); }
    const bucket = Math.floor(percent(event.startedAt) * 2);
    const current = lane.get(bucket);
    if (current) { current.count++; if (event.id === selectedId.value) current.event = event; }
    else lane.set(bucket, { event, count: 1 });
  }
  return lanes;
});
function selectMarker(group: { event: AllDayEvent; count: number }) {
  select(group.event);
  if (group.count > 1) span.value = Math.max(30_000, span.value / 4);
}
const selected = computed(() => indexedEvents.value.byId.get(selectedId.value));
const ticks = computed(() => Array.from({ length: 7 }, (_, i) => viewStart.value + (viewEnd.value - viewStart.value) * i / 6));
const formatTime = (time: number) => new Date(time).toLocaleTimeString(isEnglish.value ? "en-GB" : "zh-CN", { hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit" });
const percent = (time: number) => Math.max(0, Math.min(100, (time - viewStart.value) / (viewEnd.value - viewStart.value) * 100));
const mediaUrl = computed(() => selected.value?.kind === 'image' && selected.value.media ? `${api.value}/${selected.value.media}` : "");
const audioUrl = computed(() => selected.value?.kind === 'audio' ? selected.value.media ? `${api.value}/${selected.value.media}` : `${api.value}/audio?${new URLSearchParams({ id: selected.value.id, since: String(selected.value.startedAt), until: String(Math.max(selected.value.startedAt + 1, selected.value.endedAt + 1)) })}` : "");
const displayedImage = ref("");
const imageLoading = ref(false);
const imageError = ref("");
const expandedText = ref(false);
const imageCache = new Map<string,{ url: string; bytes: number }>();
let imageRequest: AbortController | undefined;
let imageTimer: ReturnType<typeof setTimeout> | undefined;
let cacheTimer: ReturnType<typeof setTimeout> | undefined;
let lastNavigation = 0;
let imageSequence = 0;
function clearImages() {
  ++imageSequence; clearTimeout(imageTimer); imageRequest?.abort(); displayedImage.value = "";
  for(const image of imageCache.values()) URL.revokeObjectURL(image.url);
  imageCache.clear(); imageLoading.value = false; imageError.value = "";
}
async function showImage(url: string, sequence: number) {
  const cached = imageCache.get(url);
  if(cached) {
    imageCache.delete(url); imageCache.set(url,cached);
    displayedImage.value = cached.url; imageLoading.value = false; return;
  }
  const pending = new AbortController(); imageRequest = pending;
  let objectUrl = "";
  try {
    const response = await fetch(url,{signal:pending.signal});
    if(!response.ok) throw new Error(`HTTP ${response.status}`);
    const blob = await response.blob();
    if(blob.size > 16 * 1024 * 1024) throw new Error(label("画面过大，无法预览", "Image exceeds preview limit"));
    objectUrl = URL.createObjectURL(blob);
    const decoded = new Image(); decoded.decoding = "async"; decoded.src = objectUrl;
    await decoded.decode();
    if(sequence !== imageSequence || pending.signal.aborted) return;
    imageCache.set(url,{url:objectUrl,bytes:blob.size}); displayedImage.value = objectUrl; objectUrl = "";
    await nextTick();
    let bytes = [...imageCache.values()].reduce((sum,image) => sum + image.bytes,0);
    while(imageCache.size > 4 || (bytes > 16 * 1024 * 1024 && imageCache.size > 1)) {
      const key = imageCache.keys().next().value!; const old = imageCache.get(key)!;
      bytes -= old.bytes; URL.revokeObjectURL(old.url); imageCache.delete(key);
    }
  } catch(failure) {
    if(sequence === imageSequence && !pending.signal.aborted) imageError.value = label("画面读取失败，点击重试", "Could not load image. Retry.");
  } finally {
    if(objectUrl) URL.revokeObjectURL(objectUrl);
    if(sequence === imageSequence) imageLoading.value = false;
  }
}
function requestImage() {
  const sequence = ++imageSequence; clearTimeout(imageTimer); imageRequest?.abort(); imageError.value = "";
  if(!mediaUrl.value) { imageLoading.value = false; return; }
  imageLoading.value = true;
  const url = mediaUrl.value;
  imageTimer = setTimeout(() => void showImage(url,sequence),performance.now() - lastNavigation < 180 ? 150 : 0);
}
watch(mediaUrl, requestImage);
watch(selectedId, () => { expandedText.value = false; });
watch([events,filter], () => {
  if(live.value) selectedId.value = latestReviewEvent(events.value,filter.value)?.id ?? "";
});

async function data<T>(suffix: string, init: RequestInit = {}, signal?: AbortSignal): Promise<T> {
  const response = await fetch(api.value + suffix, { ...init, signal });
  const result = await response.json();
  if (!response.ok || result.code !== 0) throw new Error(result.message || `HTTP ${response.status}`);
  return result.data;
}
async function load(direction: -1 | 0 | 1 = 0, refresh = false) {
  if (refresh && controller) { refreshQueued = true; return; }
  const margin = Math.max(15 * 60_000, span.value / 4);
  const step = Math.max(30 * 60_000, (loadedRange.end - loadedRange.start) / 2);
  const start = direction ? Math.max(0, loadedRange.start + direction * step) : Math.max(0, viewStart.value - margin);
  const end = direction ? loadedRange.end + direction * step : viewEnd.value + margin;
  controller?.abort();
  const pending = new AbortController(); controller = pending;
  requestedRange = { start, end }; fetching.value = true;
  statusController?.abort();
  const statusPending = new AbortController(); statusController = statusPending;
  void data<NonNullable<typeof state.value>>("", {}, statusPending.signal).then(snapshot => {
    if(statusPending.signal.aborted || disposed) return;
    state.value = snapshot; stateError.value = "";
    if(!settingsOpen.value) settings.value = structuredClone(snapshot.settings);
  }).catch(failure => {
    if(!statusPending.signal.aborted && !disposed) stateError.value = failure instanceof Error ? failure.message : String(failure);
  });
  try {
    const timeline = await (async () => {
        const rows: AllDayEvent[] = [];
        // Keep each storage query bounded while the viewport crosses arbitrary dates.
        for (let since = start; since < end; since += 86400_000) {
          const page = await data<{ events: AllDayEvent[] }>(`/events?since=${since}&until=${Math.min(end, since + 86400_000)}`, {}, pending.signal);
          rows.push(...page.events);
        }
        return { events: [...new Map(rows.map(event => [event.id, event])).values()].sort((a, b) => a.startedAt - b.startedAt) };
      })();
    if (pending.signal.aborted) return;
    const anchor = listDriving ? listAnchor() : undefined;
    loadedRange = { start, end }; events.value = timeline.events; error.value = ""; hasLoaded.value = true;
    // Tab-local, bounded warm preview; the owner is always revalidated on entry.
    clearTimeout(cacheTimer);
    const cacheRole = props.roleId;
    cacheTimer = setTimeout(() => {
      try {
        const cached = JSON.stringify({ at: Date.now(), events: timeline.events.slice(-2000) });
        if (cached.length <= 1_000_000) sessionStorage.setItem(`all-day-preview:${cacheRole}`, cached);
      } catch { /* Storage may be disabled or full; live reads remain authoritative. */ }
    },300);
    await nextTick();
    if (pending.signal.aborted) return;
    if (anchor && listDriving) {
      const index = listEvents.value.findIndex(item => item.id === anchor.id);
      if (index >= 0) scrollListTo(index * rowStride - anchor.offset);
    } else if (!listDriving) syncListToCursor();
  } catch (failure) {
    if (!pending.signal.aborted) error.value = failure instanceof Error ? failure.message : String(failure);
  } finally {
    if (controller === pending) {
      requestedRange = undefined; controller = undefined; fetching.value = false;
      if (refreshQueued && !disposed) {
        refreshQueued = false; clearTimeout(refreshTimer);
        refreshTimer = setTimeout(() => void load(0, true), 1000);
      }
    }
  }
}
async function action(name: "start" | "stop" | "settings") {
  if (name === "start" && state.value && !ALL_DAY_SOURCES.some(source => state.value!.settings.sources[source])) { openSettings(); return; }
  busy.value = true; error.value = "";
  try {
    await data(`/${name}`, { method: name === "settings" ? "PUT" : "POST", headers: { "content-type": "application/json" }, ...(name === "settings" ? { body: JSON.stringify(settings.value) } : {}) });
    if (name === "settings") settingsOpen.value = false;
    await load();
  } catch (failure) { error.value = failure instanceof Error ? failure.message : String(failure); }
  finally { busy.value = false; }
}
function stopMotion() { cancelAnimationFrame(inertia); inertia = 0; }
function listAnchor() {
  const top = eventList.value?.scrollTop ?? 0;
  const index = Math.min(listEvents.value.length - 1, Math.floor(top / rowStride));
  const item = listEvents.value[index];
  return item ? { id: item.id, offset: index * rowStride - top } : undefined;
}
function scrollListTo(top: number) {
  const list = eventList.value;
  if (!list) return;
  expectedScrollTop = Math.max(0, Math.min(top, list.scrollHeight - list.clientHeight));
  listScrollTop.value = expectedScrollTop;
  list.scrollTop = expectedScrollTop;
}
function syncListToCursor() {
  if (listDriving || !listEvents.value.length) return;
  let index = listIndices.value.get(selectedId.value) ?? -1;
  if (index < 0) {
    let lo = 0, hi = listEvents.value.length;
    while (lo < hi) { const mid = (lo + hi) >>> 1; if (listEvents.value[mid].startedAt > cursor.value) lo = mid + 1; else hi = mid; }
    index = Math.min(lo, listEvents.value.length - 1);
    if (index > 0 && Math.abs(listEvents.value[index - 1].startedAt - cursor.value) <= Math.abs(listEvents.value[index].startedAt - cursor.value)) index--;
  }
  scrollListTo(index * rowStride);
}
function takeListControl() { stopMotion(); listDriving = true; expectedScrollTop = undefined; }
async function browseList(event: WheelEvent) {
  takeListControl();
  const list = eventList.value;
  if (!list || !listEvents.value.length || loadingMore.value || performance.now() - lastEdgeLoad < 500) return;
  const direction = event.deltaY < 0 && list.scrollTop < 24 ? 1
    : event.deltaY > 0 && list.scrollTop >= (listEvents.value.length - 1) * rowStride - 24 ? -1 : 0;
  if (!direction || (direction < 0 && loadedRange.start <= 0) || (direction > 0 && loadedRange.end >= Date.now())) return;
  loadingMore.value = true; lastEdgeLoad = performance.now();
  try { await load(direction); } finally { loadingMore.value = false; }
}
function scrollEvents() {
  lastNavigation = performance.now();
  const list = eventList.value;
  listScrollTop.value = list?.scrollTop ?? 0;
  if (!list || (expectedScrollTop !== undefined && Math.abs(list.scrollTop - expectedScrollTop) < 1)) return;
  takeListControl();
  cancelAnimationFrame(listFrame);
  listFrame = requestAnimationFrame(() => {
    const anchor = listAnchor();
    const item = anchor ? indexedEvents.value.byId.get(anchor.id) : undefined;
    if (!item) return;
    live.value = false; cursor.value = item.startedAt; selectedId.value = item.id;
  });
}
function takeTimelineControl() { listDriving = false; cancelAnimationFrame(listFrame); }
function position(time: number) {
  lastNavigation = performance.now();
  takeTimelineControl();
  cursor.value = Math.max(0, Math.min(Date.now(), time));
  live.value = cursor.value >= Date.now() - 1000;
  const nearby = reviewWindow(indexedEvents.value,cursor.value - Math.max(15000,settings.value.intervalSeconds * 2500),cursor.value);
  const match = latestReviewEvent(nearby.filter(item => item.kind !== "status"),filter.value);
  selectedId.value = match?.id ?? "";
}
function select(event: AllDayEvent) { lastNavigation = 0; stopMotion(); takeTimelineControl(); live.value = false; cursor.value = event.startedAt; selectedId.value = event.id; void nextTick(syncListToCursor); }
function jumpDate(value: string) {
  const time = new Date(`${value}T12:00:00`).getTime();
  if (!Number.isFinite(time)) return;
  stopMotion(); span.value = 86400_000; position(time);
}
function now() { stopMotion(); live.value = true; position(Date.now()); selectedId.value = latestReviewEvent(events.value,filter.value)?.id ?? ""; void load(); }
function zoom(factor: number) { takeTimelineControl(); span.value = Math.max(30_000, Math.min(7 * 86400_000, span.value * factor)); }
function beginDrag(event: PointerEvent) {
  if (!ruler.value || event.button !== 0 || (event.target as HTMLElement).closest('button, input, audio')) return;
  stopMotion(); takeTimelineControl(); velocity = 0; lastX = event.clientX; lastMove = performance.now();
  drag = { x: event.clientX, time: cursor.value, span: span.value, width: ruler.value.clientWidth, moved: false };
}
function moveDrag(event: PointerEvent) {
  if (!drag) return;
  if (!drag.moved && Math.abs(event.clientX - drag.x) < 5) return;
  drag.moved = true; live.value = false;
  ruler.value?.setPointerCapture(event.pointerId);
  const time = performance.now();
  velocity = (event.clientX - lastX) / Math.max(1, time - lastMove);
  lastX = event.clientX; lastMove = time;
  position(drag.time - (event.clientX - drag.x) / drag.width * drag.span);
}
function leaveDrag() { if (drag && !drag.moved) drag = undefined; }
function endDrag(event: PointerEvent) {
  if (!drag) return;
  if (ruler.value?.hasPointerCapture(event.pointerId)) ruler.value.releasePointerCapture(event.pointerId);
  if (!drag.moved) { drag = undefined; return; }
  const scale = drag.span / drag.width; drag = undefined;
  if (performance.now() - lastMove > 100) velocity = 0;
  let previous = performance.now();
  const coast = (time: number) => {
    const elapsed = Math.min(32, time - previous); previous = time;
    position(cursor.value - velocity * elapsed * scale);
    velocity *= Math.exp(-elapsed / 180);
    if (Math.abs(velocity) > .015 && cursor.value > 0 && !live.value) inertia = requestAnimationFrame(coast);
  };
  inertia = requestAnimationFrame(coast);
}
function wheel(event: WheelEvent) {
  stopMotion();
  if (event.ctrlKey || event.metaKey) zoom(Math.exp(event.deltaY / 300));
  else position(cursor.value + (event.deltaX || event.deltaY) * span.value / Math.max(1, ruler.value?.clientWidth ?? 800));
}
let liveFrame = 0;
let lastClockSecond = 0;
// Visual clock only: event data is refreshed by owner SSE or viewport changes.
function animateClock() {
  const time = Date.now();
  if (live.value && !drag && Math.floor(time / 1000) !== lastClockSecond) {
    lastClockSecond = Math.floor(time / 1000); cursor.value = time;
  }
  liveFrame = requestAnimationFrame(animateClock);
}
liveFrame = requestAnimationFrame(animateClock);
watch([cursor, selectedId, filter], () => { if (!listDriving) void nextTick(syncListToCursor); });
watch([viewStart, viewEnd], () => {
  const range = requestedRange ?? loadedRange;
  if (viewStart.value >= range.start && viewEnd.value <= range.end) return;
  clearTimeout(rangeTimer); rangeTimer = setTimeout(() => void load(), 120);
});
function openSettings() { if (state.value) settings.value = structuredClone(toRaw(state.value.settings)); settingsOpen.value = true; }
watch(() => props.roleId, () => {
  clearImages(); clearTimeout(cacheTimer); live.value = true;
  statusController?.abort(); stateError.value = "";
  controller?.abort(); controller = undefined; refreshQueued = false; listScrollTop.value = 0; eventSource?.close(); clearTimeout(refreshTimer);
  stopMotion(); loadedRange = { start: 0, end: 0 }; state.value = null; events.value = []; selectedId.value = ""; settingsOpen.value = false;
  hasLoaded.value = false;
  try {
    const cached = JSON.parse(sessionStorage.getItem(`all-day-preview:${props.roleId}`) || "null");
    if (cached && Date.now() - cached.at < 300_000 && Array.isArray(cached.events)) {
      events.value = cached.events.filter((item: AllDayEvent) => item && typeof item.id === 'string' && sources.value.some(source => source.id === item.source));
    }
  } catch { /* Ignore an unavailable or invalid preview cache. */ }
  takeTimelineControl(); expectedScrollTop = undefined;
  void load();
  eventSource = managerEventSource("/api/events");
  eventSource.addEventListener("all_day_recording", raw => {
    try { const event = JSON.parse((raw as MessageEvent).data); if (!event.mobile && event.roleId !== props.roleId) return; } catch { return; }
    if (document.hidden) { refreshQueued = true; return; }
    if (controller) { refreshQueued = true; return; }
    clearTimeout(refreshTimer); refreshTimer = setTimeout(() => void load(0, true), 500);
  });
}, { immediate: true });

function resumeVisible() { if (!document.hidden && refreshQueued) { refreshQueued = false; void load(0, true); } }
document.addEventListener("visibilitychange", resumeVisible);
onBeforeUnmount(() => { disposed = true; clearImages(); clearTimeout(cacheTimer); statusController?.abort(); document.removeEventListener("visibilitychange", resumeVisible); stopMotion(); cancelAnimationFrame(listFrame); cancelAnimationFrame(liveFrame); clearTimeout(rangeTimer); controller?.abort(); eventSource?.close(); clearTimeout(refreshTimer); });
</script>

<template>
  <section class="all-day" data-testid="persona-all-day-recording">
    <div class="recording-toolbar">
      <div><h2>{{ label('全天记录', 'All-day recording') }}</h2><span class="muted">{{ label('电脑与手机 · 时间轴和事件', 'Computer and mobile · Timeline and events') }}</span></div>
      <div class="toolbar-buttons">
        <v-chip :color="state?.running ? 'success' : undefined" size="small" variant="tonal">{{ !state ? label('正在加载', 'Loading') : state.running ? label('正在记录', 'Recording') : label('已暂停', 'Paused') }}</v-chip>
        <v-btn :disabled="busy || !state" :loading="busy" :color="state?.running ? 'warning' : 'secondary'" :prepend-icon="state?.running ? 'mdi-pause' : 'mdi-record-circle-outline'" @click="action(state?.running ? 'stop' : 'start')">{{ state?.running ? label('暂停记录', 'Pause') : label('开始记录', 'Start recording') }}</v-btn>
        <v-btn icon="mdi-cog-outline" variant="text" :aria-label="label('记录设置', 'Recording settings')" :disabled="!state" @click="openSettings" />
      </div>
    </div>
    <v-alert v-if="error || stateError || state?.error" type="error" variant="tonal">{{ error || stateError || state?.error }}</v-alert>
    <v-alert v-if="state?.activeRoleId && state.activeRoleId !== roleId" type="info" variant="tonal">{{ label('这台电脑正在为另一个人格记录：', 'This computer is recording for another persona: ') }}{{ state.activeRoleId }}</v-alert>
    <div class="recording-workspace">
    <div class="review-column">
    <v-card class="app-card glass-card review-card">
      <div class="recording-preview">
        <img v-if="mediaUrl && displayedImage" :src="displayedImage" decoding="async" :alt="sourceInfo(selected!.source).name" />
        <div v-else-if="mediaUrl" class="preview-empty"><v-progress-circular v-if="imageLoading" indeterminate size="30" /><p>{{ imageError ? label('画面暂不可用', 'Image unavailable') : label('正在读取画面…', 'Loading image…') }}</p></div>
        <div v-else-if="selected" class="event-preview">
          <v-icon :icon="sourceInfo(selected.source).icon" size="38" :color="sourceInfo(selected.source).color" />
          <p>{{ selected.text ? expandedText ? selected.text : selected.text.slice(0,600) : label('暂无转写', 'No transcript') }}</p>
          <v-btn v-if="(selected.text?.length || 0) > 600" size="small" variant="text" @click="expandedText = !expandedText">{{ expandedText ? label('收起', 'Collapse') : label('展开全文', 'Read more') }}</v-btn>
          <audio v-if="audioUrl" :key="audioUrl" controls preload="none" :src="audioUrl" />
        </div>
        <div v-else class="preview-empty"><v-icon icon="mdi-timeline-clock-outline" size="42" /><p>{{ label('选择时间轴上的事件回看', 'Select a timeline event to review') }}</p><span>{{ label('空白时段没有已保存记录', 'Blank periods have no saved records') }}</span></div>
        <time class="preview-time">{{ date }} · {{ live ? label("实时", "Live") + " · " : "" }}{{ formatTime(cursor) }}</time>
        <span v-if="imageLoading && displayedImage" class="preview-progress" role="status">{{ label('更新画面…', 'Updating image…') }}</span>
        <v-btn v-if="imageError" class="preview-progress" size="small" @click="requestImage">{{ imageError }}</v-btn>
      </div>
    </v-card>
    <div class="timeline-dock">
      <div class="date-toolbar">
        <input :value="date" :max="localDate(new Date())" type="date" :aria-label="label('跳转日期', 'Jump to date')" @change="jumpDate(($event.target as HTMLInputElement).value)" />
        <v-spacer /><v-btn variant="text" @click="now">{{ label('回到实时', 'Live') }}</v-btn>
        <v-btn icon="mdi-minus" variant="text" :aria-label="label('缩小时间轴', 'Zoom out')" @click="zoom(2)" />
        <v-btn icon="mdi-plus" variant="text" :aria-label="label('放大时间轴', 'Zoom in')" @click="zoom(.5)" />
      </div>
      <div ref="ruler" class="time-ruler" tabindex="0" role="group" :aria-label="label('记录时间尺，左右滚动回看，跨日连续浏览', 'Recording timeline, scroll across dates')" @pointerdown="beginDrag" @pointermove="moveDrag" @pointerup="endDrag" @pointercancel="drag = undefined" @pointerleave="leaveDrag" @wheel.prevent="wheel" @keydown.left.self.prevent="position(cursor - span / 4)" @keydown.right.self.prevent="position(cursor + span / 4)">
        <div class="time-ticks"><time v-for="tick in ticks" :key="tick">{{ span >= 86400_000 ? localDate(new Date(tick)).slice(5) + " " : "" }}{{ formatTime(tick).slice(0, span < 300000 ? 8 : 5) }}</time></div>
        <div v-for="source in sources" :key="source.id" class="source-lane">
          <span class="lane-name">{{ source.name }}</span>
          <button v-for="group in markerGroups.get(source.id)?.values()" :key="group.event.id" class="timeline-event" :class="{ selected: selectedId === group.event.id, failed: group.event.state === 'error' }" :style="{ left: `${percent(group.event.startedAt)}%`, width: `${Math.max(.3, percent(group.event.endedAt) - percent(group.event.startedAt))}%`, '--event-color': source.color }" :title="`${formatTime(group.event.startedAt)} · ${source.name}`" :aria-label="`${source.name} ${formatTime(group.event.startedAt)}${group.count > 1 ? ` · ${group.count}` : ''}`" @pointerdown.stop="stopMotion" @click.stop="selectMarker(group)" />
        </div>
        <div class="timeline-cursor" style="left: 50%" />
      </div>

    </div>
    </div>
    <div class="events-column">
    <div class="event-heading"><h3>{{ label('事件', 'Events') }} <span class="muted">{{ listEvents.length }}</span></h3><span v-if="loadingMore || fetching" role="status" class="muted">{{ label('正在加载…', 'Loading…') }}</span><v-select v-model="filter" :items="[{ id: 'all', name: label('全部来源', 'All sources') }, ...sources]" item-title="name" item-value="id" density="compact" hide-details variant="outlined" :aria-label="label('筛选来源', 'Filter sources')" /><v-btn icon="mdi-refresh" variant="text" :aria-label="label('刷新记录', 'Refresh records')" @click="load(0, true)" /></div>
    <div ref="eventList" class="events-scroller" tabindex="0" role="region" :aria-label="label('事件列表，滚动同步时间轴', 'Events, scrolling synchronizes the timeline')" @scroll.passive="scrollEvents" @wheel.passive="browseList" @touchstart.passive="takeListControl" @pointerdown="takeListControl" @keydown="takeListControl">
    <div v-if="!listEvents.length" class="no-events">{{ !hasLoaded ? error ? label('记录读取失败，请重试', 'Could not load records. Please retry.') : label('正在读取最近记录…', 'Loading recent records…') : label('这个时间范围内没有已保存事件', 'No saved events in this time range') }}</div>
    <div v-if="listEvents.length" class="virtual-events" :style="{ height: `${listEvents.length * rowStride}px` }">
    <button v-for="(event, offset) in renderedEvents" :style="{ top: `${(virtualStart + offset) * rowStride}px` }" :key="event.id" :data-event-id="event.id" class="recording-event-row" :class="{ active: selectedId === event.id }" :aria-pressed="selectedId === event.id" @click="select(event)">
      <time>{{ localDate(new Date(event.startedAt)) }}<br />{{ formatTime(event.startedAt) }}</time><v-icon :icon="sourceInfo(event.source).icon" :color="sourceInfo(event.source).color" /><div><b>{{ sourceInfo(event.source).name }}</b><p>{{ event.text?.slice(0,200) || label('已保存画面', 'Saved frame') }}</p></div><v-chip v-if="event.state === 'error'" size="small" color="error">{{ label('采集失败', 'Capture failed') }}</v-chip>
    </button>
    </div>
    </div>
    </div>
    </div>
    <v-dialog v-model="settingsOpen" max-width="560">
      <v-card class="section-card"><v-card-title>{{ label('记录设置', 'Recording settings') }}</v-card-title><v-card-text>
        <p>{{ label('屏幕和摄像头按间隔保存画面；麦克风复用语音服务的监听，暂停记录不会停止原有监听。', 'Screen and camera save periodic frames. Microphone uses the Speech service recording and transcription settings.') }}</p>
        <v-switch v-for="source in ALL_DAY_SOURCES" :key="source" v-model="settings.sources[source]" :label="sourceInfo(source).name" color="secondary" :disabled="state?.running" hide-details />
        <v-text-field v-model.number="settings.intervalSeconds" type="number" :min="10" :max="3600" :label="label('画面采样间隔（秒）', 'Frame interval (seconds)')" :disabled="state?.running" class="mt-4" />
        <v-text-field v-if="settings.sources.camera" v-model.number="settings.cameraIndex" type="number" :min="0" :max="16" :label="label('摄像头编号（默认 0）', 'Camera index (default 0)')" :disabled="state?.running" />
        <v-select v-model="settings.mobileDeviceIds" :items="state?.devices || []" :item-title="device => `${label('手机', 'Mobile')} ${device.id.slice(0, 8)}`" item-value="id" multiple chips :label="label('汇总这些手机的事件', 'Include events from these phones')" :disabled="state?.running" />
        <p v-if="!state?.devices?.length" class="muted">{{ label('尚未收到手机事件。更新手机端并完成一次转写后，再选择设备。', 'No mobile events received. Update the phone app and complete a transcription, then select the device.') }}</p>
        <p class="muted">{{ label('保存设置不会启动采集。暂停或重启后，需要手动开始。原始记录不会自动删除。', 'Saving does not start capture. Resume manually after pausing or restarting. Original records are not automatically deleted.') }}</p>
      </v-card-text><v-card-actions><v-spacer /><v-btn @click="settingsOpen = false">{{ label('取消', 'Cancel') }}</v-btn><v-btn color="secondary" :loading="busy" :disabled="state?.running" @click="action('settings')">{{ label('保存设置', 'Save settings') }}</v-btn></v-card-actions></v-card>
    </v-dialog>
  </section>
</template>

<style scoped>
.recording-workspace,.review-column,.events-column { display: grid; gap: 18px; min-width: 0; align-content: start; }
@media(min-width: 1000px) {
  .recording-workspace { grid-template-columns: minmax(0,3fr) minmax(320px,2fr); align-items: start; }
  .review-column,.events-column { position: sticky; top: calc(var(--v-layout-top,64px) + 12px); }
  .review-column .recording-preview { height: clamp(180px, calc(100dvh - var(--v-layout-top,64px) - 300px), 330px); }
  .events-column .event-heading { flex-wrap: wrap; }
  .events-column { --event-list-height: clamp(240px, calc(100dvh - var(--v-layout-top,64px) - 110px), 1100px); }
}
@media(max-width: 999px) { .review-card { position: sticky; top: calc(var(--v-layout-top,64px) + 8px); z-index: 5; } }
.all-day { display: grid; gap: 18px; --event-list-height: clamp(180px, calc(100dvh - var(--v-layout-top, 64px) - 400px), 520px); }
.recording-toolbar,.toolbar-buttons,.date-toolbar,.event-heading { display: flex; align-items: center; gap: 12px; }
.recording-toolbar { justify-content: space-between; flex-wrap: wrap; }
h2 { font-size: 22px; } .muted { color: rgb(var(--v-theme-on-surface)); opacity: .6; font-size: 13px; }
.review-card { overflow: hidden; background: rgb(var(--v-theme-surface)) !important; color: rgb(var(--v-theme-on-surface)); }
.timeline-dock { background: rgb(var(--v-theme-surface)); border: 1px solid #829aaa33; border-radius: 12px; box-shadow: 0 6px 18px #0003; }
.recording-preview { height: 330px; position: relative; background: #0b131b; display: grid; place-items: center; color: #d7e4ec; }
.recording-preview img { position: absolute; inset: 0; display: block; width: 100%; height: 100%; min-width: 0; min-height: 0; object-fit: contain; object-position: center; }
.preview-empty { text-align: center; color: #8b9daa; } .preview-empty p { margin-top: 16px; } .preview-empty span { font-size: 12px; }
.event-preview { text-align: center; padding: 28px; max-height: 290px; overflow: auto; max-width: 800px; display: grid; gap: 16px; justify-items: center; }
.preview-time { position: absolute; left: 20px; top: 16px; font-variant-numeric: tabular-nums; padding: 4px 9px; background: #111c26cc; border-radius: 6px; }
.preview-progress { position: absolute; bottom: 14px; right: 14px; padding: 5px 10px; border-radius: 6px; background: #111c26dd; font-size: 12px; }
.date-toolbar { padding: 8px 14px; } .date-toolbar input { color: inherit; color-scheme: dark; padding: 8px; border-radius: 6px; }
.time-ruler { position: relative; margin: 0 28px 0 110px; padding: 30px 0 12px; touch-action: pan-y; cursor: grab; user-select: none; }
.time-ticks { position: absolute; top: 0; left: 0; right: 0; display: flex; justify-content: space-between; font-size: 11px; opacity: .65; pointer-events: none; }
.source-lane { height: 22px; position: relative; border-bottom: 1px solid #8197a215; }
.lane-name { position: absolute; right: calc(100% + 14px); white-space: nowrap; font-size: 11px; opacity: .65; }
.timeline-event { position: absolute; top: 0; height: 22px; min-width: 12px; cursor: pointer; touch-action: pan-y; background: transparent; }
.timeline-event::before { content: ''; position: absolute; inset: 6px 0; border-radius: 2px; background: var(--event-color); opacity: .8; }
.timeline-event.selected { z-index: 2; } .timeline-event.selected::before,.timeline-event:focus-visible::before { outline: 2px solid white; opacity: 1; } .timeline-event.failed::before { background: #e67979; }
.timeline-cursor { position: absolute; top: 20px; bottom: 4px; width: 1px; background: #fff9; pointer-events: none; }
.events-scroller { position: relative; height: var(--event-list-height); overflow-y: auto; overflow-anchor: none; scrollbar-gutter: stable; display: flex; flex-direction: column; gap: 10px; }
.events-scroller::after { content: ''; flex: 0 0 calc(var(--event-list-height) - 80px); }
.virtual-events { position: relative; flex: 0 0 auto; }
.recording-event-row { position: absolute; height: 80px; overflow: hidden; cursor: pointer; }
.event-heading h3 { flex: 1; } .event-heading .v-select { max-width: 200px; }
.recording-event-row { display: flex; align-items: center; gap: 18px; width: 100%; padding: 14px 18px; border: 1px solid #829aaa22; border-radius: 12px; text-align: left; }
.recording-event-row.active { background: #65cde412; border-color: #65cde470; }
.recording-event-row time { font-size: 12px; opacity: .65; font-variant-numeric: tabular-nums; }
.recording-event-row div { flex: 1; min-width: 0; } .recording-event-row p { opacity: .7; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 13px; margin-top: 4px; }
.no-events { text-align: center; padding: 32px; opacity: .55; }
@media(max-width: 650px) { .recording-preview { height: 240px; } .date-toolbar { gap: 0; padding: 4px; flex-wrap: wrap; } .recording-event-row { gap: 10px; padding: 12px; } }
</style>
