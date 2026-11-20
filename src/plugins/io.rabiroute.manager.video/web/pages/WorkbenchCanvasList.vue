<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { visibleList, type CanvasCover, type CanvasPreview, type CanvasSummary } from "./workbenchEditor";
import type { CanvasThumbnail } from "../../workbenchThumbnail.mjs";

const props = defineProps<{
  rows: CanvasSummary[];
  disabled: boolean;
  resolveCover?: (preview?: CanvasPreview) => CanvasCover | undefined;
  projectId?: string;
  focusedId?: string;
  hidden?: boolean;
}>();
const emit = defineEmits<{ open: [id: string]; copy: [row: CanvasSummary] }>();
const cardWidth = 208, gap = 16, rowHeight = 178;
const scroller = ref<HTMLElement>(), top = ref(0), height = ref(480), width = ref(0);
const failedCovers = ref(new Set<string>());
const readyCovers = ref(new Set<string>());
const thumbnails = ref(new Map<string, CanvasThumbnail | null>());
const mounted = ref(false);
const columns = computed(() => Math.max(1, Math.floor((width.value + gap) / (cardWidth + gap))));
const range = computed(() => visibleList(Math.ceil(props.rows.length / columns.value), top.value, height.value, rowHeight));
const cards = computed(() => props.rows.slice(range.value.start * columns.value, range.value.end * columns.value).map(row => {
  const cover = props.resolveCover?.(row.preview);
  const key = `${row.id}:${row.revision}`;
  return { row, cover: cover && !failedCovers.value.has(cover.url) ? cover : undefined, key, thumbnail: thumbnails.value.get(`${props.projectId}/${key}`) };
}));
const previewRequests = computed(() => mounted.value && !props.hidden && props.projectId ? cards.value.filter(card => !card.cover) : []);
const gridStyle = computed(() => ({
  "--canvas-columns": String(columns.value),
  "--canvas-gap": gap + "px",
  "--canvas-row-height": rowHeight + "px",
}));
let observer: ResizeObserver | undefined;

function resize() {
  const element = scroller.value;
  if (!element || !element.clientWidth || props.hidden) return;
  const previousColumns = columns.value;
  const firstCard = Math.floor(top.value / rowHeight) * previousColumns;
  width.value = element.clientWidth;
  height.value = element.clientHeight || 480;
  if (previousColumns !== columns.value) element.scrollTop = Math.floor(firstCard / columns.value) * rowHeight;
  top.value = element.scrollTop;
}
function reset() {
  top.value = 0;
  if (scroller.value) scroller.value.scrollTop = 0;
  failedCovers.value.clear();
}
function markCoverReady(url: string) {
  readyCovers.value.add(url);
  if (readyCovers.value.size > 300) readyCovers.value.delete(readyCovers.value.values().next().value!);
}
watch(() => props.rows[0]?.id, reset);
watch(() => props.hidden, async hidden => {
  if (hidden) return;
  const previousTop = top.value;
  await nextTick();
  if (!scroller.value || props.hidden) return;
  scroller.value.scrollTop = previousTop;
  resize();
});
watch([() => props.projectId, () => previewRequests.value.map(card => card.key).join("/")], async (_next, _previous, onCleanup) => {
  const project = props.projectId;
  if (!project) return;
  const controller = new AbortController();
  onCleanup(() => controller.abort());
  const requests = previewRequests.value.filter(card => !thumbnails.value.has(`${project}/${card.key}`));
  for (let index = 0; index < requests.length && !controller.signal.aborted; index += 4) {
    await Promise.allSettled(requests.slice(index, index + 4).map(async ({ row, key }) => {
      const response = await fetch(`/api/video/v2/projects/${encodeURIComponent(project)}/canvases/${encodeURIComponent(row.id)}/thumbnail?revision=${row.revision}`, { signal: AbortSignal.any([controller.signal, AbortSignal.timeout(5000)]) });
      if (!response.ok) return;
      const result = await response.json() as { revision: number; thumbnail: CanvasThumbnail | null };
      if (controller.signal.aborted || result.revision !== row.revision) return;
      thumbnails.value.set(`${project}/${key}`, result.thumbnail);
      if (thumbnails.value.size > 80) thumbnails.value.delete(thumbnails.value.keys().next().value!);
    }));
  }
});
onMounted(() => {
  mounted.value = true;
  resize();
  observer = new ResizeObserver(resize);
  if (scroller.value) observer.observe(scroller.value);
});
onBeforeUnmount(() => observer?.disconnect());
defineExpose({ reset });
</script>

<template>
  <div ref="scroller" class="canvas-list" role="list" aria-label="画布列表" tabindex="0" @scroll="!hidden && (top = ($event.target as HTMLElement).scrollTop)">
    <div v-if="range.top" :style="{ height: range.top + 'px' }" aria-hidden="true"/>
    <div v-if="cards.length" class="canvas-grid" :style="gridStyle" role="presentation">
      <article v-for="{ row, cover, thumbnail } in cards" :key="row.id" class="canvas-tile" :class="{'canvas-tile-current': row.id === focusedId}" role="listitem">
        <button type="button" class="open-canvas" :title="row.name" :aria-current="row.id === focusedId ? 'true' : undefined" :disabled="disabled" @click="emit('open', row.id)">
          <span class="canvas-cover">
            <template v-if="!cover || !readyCovers.has(cover.url)">
              <svg v-if="thumbnail" :viewBox="thumbnail.viewBox" role="img" aria-label="画布缩略图">
                <path v-for="(wire, index) in thumbnail.wires" :key="index" :d="wire" vector-effect="non-scaling-stroke"/>
                <rect v-for="node in thumbnail.nodes" :key="node.id" :x="node.x" :y="node.y" :width="node.width" :height="node.height" :class="{ inactive: !node.enabled }" rx="12"/>
              </svg>
              <v-icon v-else icon="mdi-sitemap-outline" size="34" aria-hidden="true"/>
            </template>
            <img v-if="cover?.kind === 'image'" :class="{ 'cover-ready': readyCovers.has(cover.url) }" :src="cover.url" alt="" loading="lazy"
              @load="markCoverReady(cover.url)" @error="failedCovers.add(cover.url)"/>
            <video v-else-if="cover?.kind === 'video'" :class="{ 'cover-ready': readyCovers.has(cover.url) }" :src="`${cover.url}#t=0.1`" muted playsinline preload="metadata" aria-hidden="true"
              @loadeddata="markCoverReady(cover.url)" @error="failedCovers.add(cover.url)"/>
          </span>
          <span class="canvas-card-label">
            <strong>{{ row.name }}</strong>
            <small>{{ row.nodeCount }} 个节点</small>
          </span>
        </button>
        <button type="button" class="copy-canvas" :disabled="disabled" :aria-label="'复制画布 ' + row.name" title="复制画布" @click="emit('copy', row)">
          <v-icon icon="mdi-content-copy" size="17" aria-hidden="true"/>
        </button>
      </article>
    </div>
    <div v-if="range.bottom" :style="{ height: range.bottom + 'px' }" aria-hidden="true"/>
    <p v-if="!rows.length" class="empty-list">暂无画布</p>
  </div>
</template>

<style scoped>
.canvas-list {
  max-height: min(64vh, 680px);
  overflow: auto;
  overscroll-behavior: contain;
  scrollbar-gutter: stable;
  margin: 0 24px;
  padding-top: 4px;
}
.canvas-grid {
  display: grid;
  grid-template-columns: repeat(var(--canvas-columns), minmax(0, 1fr));
  column-gap: var(--canvas-gap);
  grid-auto-rows: var(--canvas-row-height);
}
.canvas-tile {
  position: relative;
  min-width: 0;
  margin-bottom: var(--canvas-gap);
  border: 1px solid var(--rr-border-strong);
  border-radius: 14px;
  background: var(--rr-surface);
  color: var(--rr-text);
}
.canvas-tile:hover, .canvas-tile:focus-within, .canvas-tile-current { border-color: var(--rr-accent); }
.open-canvas {
  display: flex;
  flex-direction: column;
  gap: 8px;
  width: 100%;
  height: 100%;
  padding: 10px 10px 12px;
  border-radius: inherit;
  text-align: left;
  color: inherit;
}
.canvas-cover {
  position: relative;
  display: grid;
  flex: 1;
  place-items: center;
  width: 100%;
  min-height: 0;
  overflow: hidden;
  border-radius: 8px;
  background: var(--rr-subtle);
  color: var(--rr-muted);
}
.canvas-cover img, .canvas-cover video {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  min-height: 0;
  object-fit: cover;
  pointer-events: none;
  opacity: 0;
}
.canvas-cover .cover-ready { opacity: 1; }
.canvas-cover svg { width: 100%; height: 100%; }
.canvas-cover path { fill: none; stroke: var(--rr-muted); stroke-width: 1; }
.canvas-cover rect { fill: var(--rr-accent); opacity: .78; }
.canvas-cover rect.inactive { opacity: .35; }
.canvas-card-label { width: 100%; padding: 0 33px 0 2px; }
.canvas-card-label strong { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 600; }
.canvas-card-label small { display: block; color: var(--rr-muted); }
.copy-canvas {
  position: absolute;
  right: 9px;
  bottom: 9px;
  display: grid;
  width: 32px;
  height: 32px;
  place-items: center;
  border-radius: 7px;
  color: var(--rr-muted);
}
.copy-canvas:hover { background: var(--rr-subtle); color: var(--rr-text); }
button:disabled { opacity: .55; }
.canvas-list:focus-visible, button:focus-visible { outline: 2px solid var(--rr-accent); outline-offset: -2px; }
.empty-list { margin: 0; padding: 32px 0; color: var(--rr-muted); text-align: center; }
</style>
