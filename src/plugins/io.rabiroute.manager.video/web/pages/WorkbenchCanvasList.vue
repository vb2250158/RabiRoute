<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { visibleList, type CanvasCover, type CanvasPreview, type CanvasSummary } from "./workbenchEditor";

const props = defineProps<{
  rows: CanvasSummary[];
  disabled: boolean;
  resolveCover?: (preview?: CanvasPreview) => CanvasCover | undefined;
}>();
const emit = defineEmits<{ open: [id: string]; copy: [row: CanvasSummary] }>();
const cardWidth = 208, gap = 16, rowHeight = 178;
const scroller = ref<HTMLElement>(), top = ref(0), height = ref(480), width = ref(0);
const failedCovers = ref(new Set<string>());
const columns = computed(() => Math.max(1, Math.floor((width.value + gap) / (cardWidth + gap))));
const range = computed(() => visibleList(Math.ceil(props.rows.length / columns.value), top.value, height.value, rowHeight));
const cards = computed(() => props.rows.slice(range.value.start * columns.value, range.value.end * columns.value).map(row => {
  const cover = props.resolveCover?.(row.preview);
  return { row, cover: cover && !failedCovers.value.has(cover.url) ? cover : undefined };
}));
const gridStyle = computed(() => ({
  "--canvas-columns": String(columns.value),
  "--canvas-gap": gap + "px",
  "--canvas-row-height": rowHeight + "px",
}));
let observer: ResizeObserver | undefined;

function resize() {
  const element = scroller.value;
  if (!element) return;
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
watch(() => props.rows[0]?.id, reset);
onMounted(() => {
  resize();
  observer = new ResizeObserver(resize);
  if (scroller.value) observer.observe(scroller.value);
});
onBeforeUnmount(() => observer?.disconnect());
defineExpose({ reset });
</script>

<template>
  <div ref="scroller" class="canvas-list" role="list" aria-label="画布列表" tabindex="0" @scroll="top = ($event.target as HTMLElement).scrollTop">
    <div v-if="range.top" :style="{ height: range.top + 'px' }" aria-hidden="true"/>
    <div v-if="cards.length" class="canvas-grid" :style="gridStyle" role="presentation">
      <article v-for="{ row, cover } in cards" :key="row.id" class="canvas-tile" role="listitem">
        <button type="button" class="open-canvas" :title="row.name" :disabled="disabled" @click="emit('open', row.id)">
          <span class="canvas-cover">
            <img v-if="cover?.kind === 'image'" :src="cover.url" alt="" loading="lazy" @error="failedCovers.add(cover.url)"/>
            <video v-else-if="cover?.kind === 'video'" :src="cover.url" muted playsinline preload="metadata" aria-hidden="true"
              @error="failedCovers.add(cover.url)"/>
            <v-icon v-else icon="mdi-sitemap-outline" size="34" aria-hidden="true"/>
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
.canvas-tile:hover, .canvas-tile:focus-within { border-color: var(--rr-accent); }
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
  width: 100%;
  height: 100%;
  min-height: 0;
  object-fit: cover;
  pointer-events: none;
}
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
