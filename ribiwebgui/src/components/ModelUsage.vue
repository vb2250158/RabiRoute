<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useI18n } from "../i18n/index";

type Metric = { value: number; measured: number };
type Usage = { requests: number | null; metrics: Record<string, Metric>; cacheRate?: Metric; credits?: boolean; source: string; limited?: boolean };
const props = defineProps<{ kind: string; modelId: string; deviceId?: string }>();
const { isEnglish } = useI18n();
const label = (zh: string, en: string) => isEnglish.value ? en : zh;
const usage = ref<Usage>();
const loading = ref(false);
const failed = ref(false);

watch(() => [props.kind, props.modelId, props.deviceId] as const, async ([kind, modelId, deviceId], _previous, onCleanup) => {
  const controller = new AbortController();
  onCleanup(() => controller.abort());
  loading.value = true;
  usage.value = undefined;
  failed.value = false;
  const query = new URLSearchParams({ kind, id: modelId, ...(deviceId !== undefined ? { deviceId } : {}) });
  try {
    const response = await fetch("/api/model-services/usage?" + query, { signal: controller.signal, cache: "no-store" });
    const body = await response.json();
    if (!response.ok || body.code !== 0) throw Error("MODEL_USAGE_UNAVAILABLE");
    if (!controller.signal.aborted) usage.value = body.data;
  } catch {
    if (!controller.signal.aborted) failed.value = true;
  } finally {
    if (!controller.signal.aborted) loading.value = false;
  }
}, { immediate: true });

const fields = computed<[string, string, string][]>(() => {
  if (props.kind === "llm") return [
    ["inputTokens", label("输入 Token", "Input tokens"), ""],
    ["outputTokens", label("输出 Token", "Output tokens"), ""],
    ["cachedTokens", label("缓存命中 Token", "Cache-hit tokens"), ""],
    ["uncachedTokens", label("未命中输入 Token", "Uncached input tokens"), ""],
    ["cacheRate", label("缓存命中率", "Cache-hit rate"), "%"],
    ...(usage.value?.credits ? [["credits", label("供应商报告的积分", "Provider-reported credits"), ""] as [string,string,string]] : []),
  ];
  if (props.kind === "asr" || props.kind === "tts") return [["audioSeconds", label("音频时长", "Audio duration"), label(" 秒", " s")]];
  return [];
});
function metricValue(key: string, unit: string) {
  const metric = key === "cacheRate" ? usage.value?.cacheRate : usage.value?.metrics[key];
  if (!metric || !metric.measured) return label("未知", "Unknown");
  const value = key === "cacheRate" ? metric.value * 100 : metric.value;
  return new Intl.NumberFormat(isEnglish.value ? "en" : "zh-CN", { maximumFractionDigits: 2 }).format(value) + unit;
}
</script>

<template>
  <section class="model-usage" :aria-label="label('用量统计', 'Usage statistics')">
    <h3>{{ label("用量统计", "Usage statistics") }}</h3>
    <v-progress-linear v-if="loading" indeterminate />
    <p v-else-if="failed || usage?.requests === null" role="status">{{ label("用量未知", "Usage is unknown") }}</p>
    <p v-else-if="usage?.requests === 0" role="status">{{ label("暂无用量", "No usage yet") }}</p>
    <dl v-else-if="usage">
      <div><dt>{{ label("调用次数", "Requests") }}</dt><dd>{{ usage.requests.toLocaleString() }}</dd></div>
      <div v-for="[field, title, unit] in fields" :key="field"><dt>{{ title }}</dt><dd>{{ metricValue(field, unit) }}</dd></div>
    </dl>
    <p v-if="usage?.limited" class="model-usage-note">{{ label("按该设备最近 1,000 条语音记录统计。", "Based on the device's 1,000 most recent speech records.") }}</p>
    <p v-if="usage?.source === 'manager-media-jobs'" class="model-usage-note">{{ label("按当前工作台保留的任务记录统计。", "Based on retained jobs in this workbench.") }}</p>
  </section>
</template>

<style scoped>
.model-usage { display: grid; gap: 10px; margin-block: 10px; }
.model-usage h3, .model-usage p, .model-usage dl, .model-usage dd { margin: 0; }
.model-usage h3 { font-size: 15px; }
.model-usage dl { display: grid; grid-template-columns: repeat(auto-fit, minmax(130px, 1fr)); gap: 10px; }
.model-usage dl > div { padding: 7px 10px; background: var(--rr-input); border-radius: 6px; }
.model-usage dt, .model-usage-note { font-size: 12px; color: var(--rr-muted-soft); }
.model-usage dd { font-weight: 600; font-variant-numeric: tabular-nums; }
</style>
