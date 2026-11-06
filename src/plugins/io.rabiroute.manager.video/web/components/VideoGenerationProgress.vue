<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import { videoProgressPresentation, type VideoProgressJob } from "../pages/videoJobProgress";
const props = defineProps<{ job: VideoProgressJob }>();
const now = ref(Date.now());
const progress = computed(() => videoProgressPresentation(props.job, now.value));
let frame = 0;
// A rendering clock only: job state continues to arrive through Manager events.
function tick() {
  const time = Date.now();
  if (Math.floor(time / 1000) !== Math.floor(now.value / 1000)) now.value = time;
  frame = requestAnimationFrame(tick);
}
onMounted(tick);
onBeforeUnmount(() => cancelAnimationFrame(frame));
</script>

<template>
  <div class="generation-progress" aria-label="生成进度">
    <div class="progress-heading"><span>{{ progress.label }}</span><strong v-if="progress.percent !== null">{{ progress.percent }}%</strong></div>
    <v-progress-linear :model-value="progress.percent ?? 0" :indeterminate="progress.percent === null" height="6" rounded color="primary" :aria-label="progress.label" />
    <div class="progress-detail"><span>{{ progress.count || (progress.percent === null ? '等待后端进度' : '当前阶段进度') }}</span><span>{{ progress.elapsed }}</span></div>
  </div>
</template>

<style scoped>
.generation-progress { width:100%; min-width:200px; margin-top:12px; text-align:left; }
.progress-heading,.progress-detail { display:flex; justify-content:space-between; gap:12px; align-items:center; }
.progress-heading { font-size:12px; margin-bottom:7px; }
.progress-detail { font-size:11px; margin-top:7px; color:#b4b4c2; }
</style>
