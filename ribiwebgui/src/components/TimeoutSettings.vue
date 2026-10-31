<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue";
import { loadTimeoutSettings, saveTimeoutSettings, type TimeoutSettings } from "../timeoutSettingsClient";
import { copyTextToClipboard } from "../clipboard";
const settings = ref<TimeoutSettings>({ overrides: {}, catalog: [] });
const draft = ref<Record<string, number>>({});
const busy = ref(false);
const ready = ref(false);
const error = ref("");
const notice = ref("");
const search = ref("");
const page = ref(1);
const pageSize = 40;
const entries = computed(() => settings.value.catalog.filter(item => [item.label, item.key, item.scope].some(value => value.toLowerCase().includes(String(search.value || "").toLowerCase()))));
const pageCount = computed(() => Math.max(1, Math.ceil(entries.value.length / pageSize)));
const pageEntries = computed(() => entries.value.slice((page.value - 1) * pageSize, page.value * pageSize));
watch(search, () => { page.value = 1; });
watch(pageCount, count => { page.value = Math.min(page.value, count); });
const dirty = computed(() => JSON.stringify(draft.value) !== JSON.stringify(settings.value.overrides));
const valid = computed(() => Object.values(draft.value).every(value => Number.isSafeInteger(value) && value >= 1 && value <= 2147483647));
const exportJson = computed(() => JSON.stringify(Object.fromEntries(Object.entries(settings.value.overrides)
  .filter(([, value]) => Number.isSafeInteger(value) && value >= 1 && value <= 2147483647)), null, 2));
async function exportSettings() {
  error.value = ""; notice.value = "";
  try { await copyTextToClipboard(exportJson.value); notice.value = "独立服务超时设置已复制，仅包含已加载的已保存设置。"; }
  catch (reason) { error.value = reason instanceof Error ? reason.message : String(reason); }
}
function effectLabel(effect: string): string {
  if (/[\u3400-\u9fff]/.test(effect)) return effect;
  if (effect.includes("owner-initialization")) return "新操作或重新启动对应模块后生效";
  if (effect.includes("next-connection")) return "下次连接生效";
  if (effect.includes("next-close")) return "下次关闭对应模块时生效";
  if (/-start|startup|restart/.test(effect)) return "重启对应模块后生效";
  if (/request|operation|admission|next-use/.test(effect)) return "新操作生效";
  return "按对应模块说明生效";
}
function adopt(value: TimeoutSettings) { settings.value = value; draft.value = { ...value.overrides }; ready.value = true; }
async function load() {
  busy.value = true; error.value = "";
  try { adopt(await loadTimeoutSettings()); }
  catch (reason) { error.value = reason instanceof Error ? reason.message : String(reason); }
  finally { busy.value = false; }
}
async function save() {
  busy.value = true; error.value = ""; notice.value = "";
  try { adopt(await saveTimeoutSettings(settings.value.overrides, draft.value)); notice.value = "超时设置已保存并回读确认。新操作采用新设置；启动阶段设置按对应说明生效。"; }
  catch (reason) { error.value = reason instanceof Error ? reason.message : String(reason); }
  finally { busy.value = false; }
}
function change(key: string, value: unknown) {
  if (value === "" || value === null) delete draft.value[key];
  else draft.value[key] = Number(value);
}
onMounted(load);
</script>
<template>
  <v-card class="app-card glass-card section-card">
    <div class="section-title">超时设置</div>
    <div class="section-note mb-4">按操作设置等待时间，单位为毫秒。留空恢复默认；已开始的操作继续使用开始时的设置。</div>
    <v-text-field v-model="search" label="搜索操作或模块" density="compact" clearable @click:clear="search = ''" />
    <v-alert v-if="error" type="error" variant="tonal" class="mb-3">{{ error }}</v-alert>
    <v-alert v-if="notice" type="success" variant="tonal" class="mb-3">{{ notice }}</v-alert>
    <div class="form-grid" style="max-height: 480px; overflow-y: auto">
      <v-text-field v-for="item in pageEntries" :key="item.key" :model-value="draft[item.key] ?? ''"
        :label="item.label" :placeholder="String(item.defaultMs)" :hint="'默认 ' + item.defaultMs + ' 毫秒 · ' + effectLabel(item.effect)" :title="item.scope + ' · ' + item.key"
        type="number" min="1" max="2147483647" step="1" density="compact" persistent-hint :disabled="busy || !ready"
        @update:model-value="change(item.key, $event)" />
    </div>
    <div class="section-note mt-3">共 {{ entries.length }} 项 · 每页 {{ pageSize }} 项 · 第 {{ page }} / {{ pageCount }} 页</div>
    <v-pagination v-if="pageCount > 1" v-model="page" :length="pageCount" :total-visible="5" density="compact" />
    <v-alert v-if="!valid" type="error" variant="tonal" class="mt-3">请输入 1 到 2147483647 之间的整数毫秒。</v-alert>
    <div class="hero-actions mt-4">
      <v-btn color="primary" :loading="busy" :disabled="!ready || busy || !dirty || !valid" @click="save">保存超时设置</v-btn>
      <v-btn variant="text" :disabled="busy" @click="load">重新加载</v-btn>
    </div>
    <details class="mt-4">
      <summary>高级：独立服务设置</summary>
      <div class="section-note my-3">独立 Relay / 语音客户端需将此快照作为 RABIROUTE_TIMEOUT_OVERRIDES 环境变量用于对应服务启动；本机保存不会直接更新远程服务。只导出已加载的已保存设置，不包含未保存草稿、完整配置或凭据。</div>
      <v-btn variant="outlined" :disabled="busy || !ready" @click="exportSettings">导出独立服务设置</v-btn>
      <v-textarea :model-value="exportJson" label="超时快照 JSON（可手动复制）" readonly rows="4" class="mt-3" />
    </details>
  </v-card>
</template>
