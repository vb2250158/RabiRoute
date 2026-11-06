<script setup lang="ts">
import { computed } from "vue";
import type { SpeechRecognitionMetadata, SpeechTranscriptSegment } from "@shared/speechControlContract";

const props = defineProps<{ result: SpeechRecognitionMetadata & { segments?: SpeechTranscriptSegment[] } }>();
const emotions = computed(() => [...new Set([
  ...(props.result.emotion ? [props.result.emotion] : []),
  ...(props.result.emotionLabels || [])
])]);
const words = computed(() => props.result.segments?.flatMap(segment => segment.words || []) || []);
function seconds(value: number | undefined): string {
  return typeof value === "number" && Number.isFinite(value) ? value.toFixed(3) : "-";
}
</script>

<template>
  <div class="speech-recognition-details">
    <div v-if="emotions.length || result.audioEvents?.length || result.confidence != null" class="recognition-observations">
      <span v-if="emotions.length">模型情绪：<b data-no-i18n>{{ emotions.join(" / ") }}</b></span>
      <span v-if="result.audioEvents?.length">音频事件：<b data-no-i18n>{{ result.audioEvents.join(" / ") }}</b></span>
      <span v-if="result.confidence != null">整句置信度：<b>{{ result.confidence.toFixed(3) }}</b></span>
    </div>
    <details v-if="result.rawTags?.length">
      <summary>原始标签（{{ result.rawTags.length }}）</summary>
      <code data-no-i18n>{{ result.rawTags.join(" ") }}</code>
    </details>
    <details v-if="words.length">
      <summary>逐词时间（{{ words.length }}）</summary>
      <div class="recognition-word-table">
        <table>
          <thead><tr><th>词</th><th>开始（秒）</th><th>结束（秒）</th><th>词概率 / 置信度</th></tr></thead>
          <tbody><tr v-for="(word, index) in words" :key="index">
            <td>{{ word.word }}</td><td>{{ seconds(word.start) }}</td><td>{{ seconds(word.end) }}</td>
            <td>{{ seconds(word.probability ?? word.confidence) }}</td>
          </tr></tbody>
        </table>
      </div>
    </details>
  </div>
</template>

<style scoped>
.speech-recognition-details { display: grid; gap: 7px; margin-top: 7px; font-size: 12px; }
.recognition-observations { display: flex; flex-wrap: wrap; gap: 7px 16px; color: var(--rr-muted); }
.recognition-observations b { color: var(--rr-text); }
summary { cursor: pointer; color: var(--rr-muted); }
code { display: block; margin-top: 6px; white-space: pre-wrap; overflow-wrap: anywhere; }
.recognition-word-table { max-height: 260px; overflow: auto; margin-top: 6px; }
table { border-collapse: collapse; width: 100%; }
th, td { padding: 5px 8px; text-align: left; border-bottom: 1px solid var(--rr-border); }
</style>
