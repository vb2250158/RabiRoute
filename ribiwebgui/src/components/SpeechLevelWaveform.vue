<script setup lang="ts">
import { computed } from "vue";

const props = withDefaults(defineProps<{
  levels?: number[];
  recordThreshold: number;
  transcribeThreshold: number;
  dynamicThreshold?: number;
  running?: boolean;
  state?: string;
}>(), {
  levels: () => [],
  dynamicThreshold: 0,
  running: false,
  state: "stopped"
});

const WIDTH = 960;
const HEIGHT = 140;
const BAR_WIDTH = 5;
const GAP = 3;
const MAX_BARS = Math.floor(WIDTH / (BAR_WIDTH + GAP));

type WaveBar = { x: number; y: number; height: number; color: string };

const safeLevels = computed(() => props.levels
  .slice(-MAX_BARS)
  .map(value => Number.isFinite(Number(value)) ? Math.max(0, Number(value)) : 0));
const scale = computed(() => Math.max(
  0.04,
  props.recordThreshold,
  props.transcribeThreshold,
  props.dynamicThreshold,
  ...safeLevels.value
) * 1.15);
const bars = computed<WaveBar[]>(() => {
  const values = safeLevels.value;
  const startX = WIDTH - values.length * (BAR_WIDTH + GAP);
  return values.map((value, index) => {
    const normalized = Math.min(value / scale.value, 1);
    const height = value > 0 ? Math.max(2, normalized * (HEIGHT - 8)) : 0;
    let color = "#9b8d85";
    if (value >= props.recordThreshold) color = "#18a5a7";
    if (value >= props.transcribeThreshold) color = "#269864";
    return { x: startX + index * (BAR_WIDTH + GAP), y: HEIGHT - height, height, color };
  });
});

function thresholdY(value: number): number {
  return HEIGHT - Math.min(Math.max(value, 0) / scale.value, 1) * HEIGHT;
}

const recordY = computed(() => thresholdY(props.recordThreshold));
const transcribeY = computed(() => thresholdY(props.transcribeThreshold));
const dynamicY = computed(() => thresholdY(props.dynamicThreshold));
const peak = computed(() => Math.max(0, ...safeLevels.value));
const stateLabel = computed(() => {
  if (!props.running) return "等待启动";
  if (props.state === "playback_suppressed") return "播放防回流中";
  if (props.state === "transcribing") return "正在转写";
  if (props.state === "recording") return "正在收音";
  return "实时预览中";
});
</script>

<template>
  <div class="speech-waveform" :class="{ 'is-running': running }">
    <svg :viewBox="`0 0 ${WIDTH} ${HEIGHT}`" preserveAspectRatio="none" role="img" :aria-label="`麦克风柱状波形，${stateLabel}`">
      <line v-for="index in 3" :key="`grid-${index}`" x1="0" :y1="HEIGHT * index / 4" :x2="WIDTH" :y2="HEIGHT * index / 4" class="grid-line" />
      <rect v-for="(bar, index) in bars" :key="index" :x="bar.x" :y="bar.y" :width="BAR_WIDTH" :height="bar.height" :fill="bar.color" />
      <line x1="0" :y1="recordY" :x2="WIDTH" :y2="recordY" class="threshold-line record-line" />
      <line x1="0" :y1="transcribeY" :x2="WIDTH" :y2="transcribeY" class="threshold-line transcribe-line" />
      <line v-if="dynamicThreshold > recordThreshold" x1="0" :y1="dynamicY" :x2="WIDTH" :y2="dynamicY" class="threshold-line dynamic-line" />
    </svg>
    <div v-if="!levels.length" class="wave-empty">{{ running ? "等待麦克风电平" : "任一 Route 订阅语音后显示主机实时柱状波形" }}</div>
    <div class="wave-overlay"><span>{{ stateLabel }}</span><span>峰值 {{ peak.toFixed(4) }}</span></div>
  </div>
</template>

<style scoped>
.speech-waveform { position: relative; height: 140px; overflow: hidden; border: 1px solid rgba(17, 32, 51, .08); border-radius: 10px; background: #f7f3ef; }
.speech-waveform svg { display: block; width: 100%; height: 100%; }
.grid-line { stroke: #e8ddd2; stroke-width: 1; vector-effect: non-scaling-stroke; }
.threshold-line { vector-effect: non-scaling-stroke; }
.record-line { stroke: #c55a61; stroke-width: 1.5; }
.transcribe-line { stroke: #c99b48; stroke-width: 1.5; stroke-dasharray: 7 5; }
.dynamic-line { stroke: #7666aa; stroke-width: 1; stroke-dasharray: 3 5; }
.wave-empty { position: absolute; inset: 0; display: grid; place-items: center; color: #8b817b; font-size: 11px; }
.wave-overlay { position: absolute; inset: 8px 10px auto; display: flex; justify-content: space-between; gap: 12px; color: #6f6660; font-size: 10px; font-weight: 800; text-shadow: 0 1px rgba(255, 255, 255, .9); }
.is-running { box-shadow: inset 0 0 0 1px rgba(24, 165, 167, .06); }
</style>
