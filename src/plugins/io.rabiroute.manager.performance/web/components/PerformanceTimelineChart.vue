<script setup lang="ts">
import { computed } from "vue";

type PerformanceChartSeries = {
  id: string;
  name: string;
  color: string;
  values: Array<{ time: string; value: number }>;
};

const props = defineProps<{
  title: string;
  eyebrow: string;
  unit: string;
  series: PerformanceChartSeries[];
}>();

const gridPatternId = `performance-grid-${Math.random().toString(36).slice(2)}`;

const width = 760;
const height = 220;
const padding = { left: 42, right: 18, top: 24, bottom: 30 };
const values = computed(() => props.series.flatMap(item => item.values.map(point => point.value)).filter(Number.isFinite));
const maximum = computed(() => values.value.length ? Math.max(...values.value) : 0);
const scaleMaximum = computed(() => Math.max(1, maximum.value));
const times = computed(() => props.series.flatMap(item => item.values.map(point => Date.parse(point.time))).filter(Number.isFinite));
const minimumTime = computed(() => times.value.length ? Math.min(...times.value) : Date.now() - 60_000);
const maximumTime = computed(() => times.value.length ? Math.max(...times.value) : Date.now());

function pathFor(series: PerformanceChartSeries): string {
  return series.values.map((point, index) => {
    return `${index ? "L" : "M"}${xFor(point).toFixed(1)},${yFor(point).toFixed(1)}`;
  }).join(" ");
}

function xFor(point: { time: string }): number {
  const innerWidth = width - padding.left - padding.right;
  const duration = maximumTime.value - minimumTime.value;
  if (duration <= 0) return padding.left + innerWidth / 2;
  return padding.left + ((Date.parse(point.time) - minimumTime.value) / duration) * innerWidth;
}

function yFor(point: { value: number }): number {
  const innerHeight = height - padding.top - padding.bottom;
  return padding.top + innerHeight - (Math.max(0, point.value) / scaleMaximum.value) * innerHeight;
}

function displayValue(value: number): string {
  if (props.unit === "MB") return `${value.toFixed(value >= 100 ? 0 : 1)} MB`;
  if (props.unit === "%") return `${value.toFixed(1)}%`;
  return `${value.toFixed(value >= 100 ? 0 : 1)} ms`;
}
</script>

<template>
  <section class="perf-chart">
    <header>
      <div>
        <span>{{ eyebrow }}</span>
        <h3>{{ title }}</h3>
      </div>
      <strong>{{ displayValue(maximum) }}</strong>
    </header>
    <div v-if="values.length" class="perf-chart-canvas">
      <svg :viewBox="`0 0 ${width} ${height}`" role="img" :aria-label="title">
        <defs>
          <pattern :id="gridPatternId" width="38" height="38" patternUnits="userSpaceOnUse">
            <path d="M 38 0 L 0 0 0 38" fill="none" stroke="rgba(129, 219, 221, .11)" stroke-width="1" />
          </pattern>
        </defs>
        <rect width="100%" height="100%" :fill="`url(#${gridPatternId})`" />
        <line :x1="padding.left" :x2="padding.left" :y1="padding.top" :y2="height - padding.bottom" class="axis" />
        <line :x1="padding.left" :x2="width - padding.right" :y1="height - padding.bottom" :y2="height - padding.bottom" class="axis" />
        <path
          v-for="item in series"
          :key="item.id"
          :d="pathFor(item)"
          fill="none"
          :stroke="item.color"
          stroke-width="3"
          stroke-linecap="round"
          stroke-linejoin="round"
        />
        <g v-for="item in series" :key="`points-${item.id}`">
          <circle
            v-for="point in item.values"
            :key="point.time"
            :cx="xFor(point)"
            :cy="yFor(point)"
            r="3.5"
            :fill="item.color"
            class="data-point"
          />
        </g>
      </svg>
    </div>
    <div v-else class="perf-chart-empty">等待性能样本</div>
    <footer>
      <span v-for="item in series" :key="item.id"><i :style="{ background: item.color }" />{{ item.name }}</span>
    </footer>
  </section>
</template>

<style scoped>
.perf-chart { min-width: 0; border: 1px solid rgba(136, 218, 218, .15); border-radius: 22px; padding: 18px; background: linear-gradient(160deg, #102b35, #081b24 72%); box-shadow: 0 18px 40px rgba(7, 26, 35, .2); color: #e9ffff; }
.perf-chart header { display: flex; align-items: flex-start; justify-content: space-between; gap: 18px; margin-bottom: 10px; }
.perf-chart header span { color: #6ec6c8; font-size: 10px; font-weight: 900; letter-spacing: .16em; text-transform: uppercase; }
.perf-chart h3 { margin: 3px 0 0; font-family: Georgia, "Times New Roman", serif; font-size: 22px; font-weight: 700; }
.perf-chart header strong { color: #ffcc66; font-size: 12px; font-variant-numeric: tabular-nums; }
.perf-chart-canvas { overflow: hidden; border-radius: 14px; background: rgba(3, 16, 23, .58); }
.perf-chart svg { display: block; width: 100%; height: 220px; }
.axis { stroke: rgba(203, 249, 249, .18); stroke-width: 1; }
.data-point { stroke: #0a2029; stroke-width: 2; }
.perf-chart-empty { display: grid; height: 220px; place-items: center; border-radius: 14px; background: rgba(3, 16, 23, .58); color: #78969e; font-size: 12px; }
.perf-chart footer { display: flex; flex-wrap: wrap; gap: 12px; margin-top: 12px; color: #b5d0d3; font-size: 11px; }
.perf-chart footer span { display: inline-flex; align-items: center; gap: 6px; }
.perf-chart footer i { width: 14px; height: 3px; border-radius: 999px; }
</style>
