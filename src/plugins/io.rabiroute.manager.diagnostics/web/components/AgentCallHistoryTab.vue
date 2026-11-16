<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import { managerEventSource } from "../../../../../ribiwebgui/src/managerApi";
import { userFacingError } from "../../../../../ribiwebgui/src/userFacingError";

type Call = { callId: string; startedAt: string; source: string; agentType?: string; sessionId?: string; toolName?: string;
  operationId?: string; method?: string; pathname?: string; status: string; statusCode?: number; durationMs?: number;
  responseBytes?: number; truncated: boolean; summary?: string; boundary: string; captureState: string; businessCode?: string };
type Stage = { spanId: string; boundary: string; startedAt: string };
const items = ref<Call[]>([]);
const source = ref("");
const status = ref("");
const sessionId = ref("");
const query = ref("");
const from = ref("");
const to = ref("");
const appliedFilters = ref({ source: "", status: "", sessionId: "", query: "", from: "", to: "" });
const loading = ref(false);
const error = ref("");
const nextCursor = ref<string | null>(null);
const cursors = ref<(string | null)[]>([null]);
const page = ref(0);
const hasUpdates = ref(false);
const selected = ref<Call | null>(null);
const detail = ref<{ callId: string; stages: Stage[] } | null>(null);
const stageBodies = ref<Record<string, string>>({});
const stageErrors = ref<Record<string, string>>({});
const stageRequests = new Map<string, AbortController>();
const detailError = ref("");
const detailLoading = ref(false);
const settingsOpen = ref(false);
const config = ref({ enabled: true, captureBodies: true, maxBodyBytes: 4 * 1024 * 1024 });
const pending = ref(0);
const storageError = ref<string | null>(null);
const dropped = ref(0);
const conflicts = ref(0);
const saving = ref(false);
let listRequest: AbortController | undefined;
let detailRequest: AbortController | undefined;
let events: EventSource | undefined;
let refreshTimer: ReturnType<typeof setTimeout> | undefined;
let generation = 0;
let disposed = false;
let notifications = 0;
const captureMiB = computed({ get: () => config.value.maxBodyBytes / 1048576, set: value => { config.value.maxBodyBytes = Math.round(Number(value) * 1048576); } });
const statusNames: Record<string, string> = { running: "进行中", succeeded: "成功", accepted: "已受理", failed: "失败", cancelled: "已取消", uncertain: "结果待确认" };
const statusOptions = Object.entries(statusNames).map(([value, title]) => ({ value, title }));
const captureNames: Record<string, string> = { complete: "正文已保存", partial: "正文捕获不完整", metadata: "仅元数据", disabled: "正文记录已关闭", pending: "等待结果" };
const color = (value: string) => ({ succeeded: "success", failed: "error", cancelled: "grey", uncertain: "warning", running: "info", accepted: "info" }[value] || "grey");
const formatTime = (value: string) => new Date(value).toLocaleString();
const formatBytes = (value?: number) => value === undefined || value === null ? "—" : value < 1024 ? `${value} B` : `${(value / 1024).toFixed(1)} KiB`;
const stageKey = (stage: Stage) => stage.boundary + ":" + stage.spanId;

async function request(path: string, options: RequestInit = {}) {
  const response = await fetch(path, options);
  const body = await response.json();
  if (!response.ok || body.code !== 0) throw new Error(body.message || `HTTP ${response.status}`);
  return body.data;
}

async function load(reset = false) {
  if (disposed) return;
  if (reset) { cursors.value = [null]; page.value = 0; }
  const current = ++generation;
  const observedNotifications = notifications;
  let refreshAfter = false;
  listRequest?.abort();
  const controller = new AbortController();
  listRequest = controller;
  loading.value = true; error.value = "";
  try {
    const parameters = new URLSearchParams({ limit: "50" });
    const filters = appliedFilters.value;
    for (const [key, value] of Object.entries({ source: filters.source, status: filters.status, sessionId: filters.sessionId, query: filters.query, cursor: cursors.value[page.value] })) {
      if (value) parameters.set(key, value);
    }
    if (filters.from) parameters.set("from", new Date(filters.from).toISOString());
    if (filters.to) parameters.set("to", new Date(filters.to).toISOString());
    const data = await request("/api/diagnostics/calls?" + parameters, { signal: controller.signal });
    if (disposed || current !== generation) return;
    items.value = data.items; nextCursor.value = data.nextCursor;
    if (!settingsOpen.value) config.value = { enabled: data.recording.enabled, captureBodies: data.recording.captureBodies, maxBodyBytes: data.recording.maxBodyBytes };
    pending.value = data.recording.pending; storageError.value = data.recording.lastError;
    dropped.value = data.recording.dropped; conflicts.value = data.recording.conflicts;
    hasUpdates.value = notifications !== observedNotifications;
    refreshAfter = hasUpdates.value;
  } catch (failure) {
    if (!controller.signal.aborted && current === generation) error.value = userFacingError(failure);
  } finally {
    if (current === generation) {
      loading.value = false;
      if (refreshAfter && !page.value && !settingsOpen.value && !controller.signal.aborted) scheduleRefresh();
    }
  }
}

function applyFilters() {
  appliedFilters.value = { source: source.value, status: status.value, sessionId: sessionId.value,
    query: query.value, from: from.value, to: to.value };
  void load(true);
}

function move(direction: number) {
  if (direction > 0 && nextCursor.value) { cursors.value[page.value + 1] = nextCursor.value; page.value++; }
  else if (direction < 0 && page.value > 0) page.value--;
  else return;
  void load();
}

async function open(call: Call) {
  selected.value = call; detail.value = null; detailError.value = ""; detailLoading.value = true;
  for (const controller of stageRequests.values()) controller.abort();
  stageRequests.clear(); stageBodies.value = {}; stageErrors.value = {};
  detailRequest?.abort();
  const controller = new AbortController(); detailRequest = controller;
  try {
    const value = await request("/api/diagnostics/calls/" + encodeURIComponent(call.callId), { signal: controller.signal });
    if (!controller.signal.aborted && selected.value?.callId === call.callId) detail.value = value;
  } catch (failure) { if (!controller.signal.aborted) detailError.value = userFacingError(failure); }
  finally { if (detailRequest === controller) detailLoading.value = false; }
}

async function loadStage(stage: Stage) {
  const callId = selected.value?.callId;
  const key = stageKey(stage);
  if (!callId || stageBodies.value[key] || stageRequests.has(key)) return;
  const controller = new AbortController(); stageRequests.set(key, controller);
  try {
    const params = new URLSearchParams({ spanId: stage.spanId, boundary: stage.boundary });
    const value = await request("/api/diagnostics/calls/" + encodeURIComponent(callId) + "?" + params, { signal: controller.signal });
    if (!controller.signal.aborted && selected.value?.callId === callId) stageBodies.value[key] = JSON.stringify(value.stages[0], null, 2);
  } catch (failure) { if (!controller.signal.aborted) stageErrors.value[key] = userFacingError(failure); }
  finally { if (stageRequests.get(key) === controller) stageRequests.delete(key); }
}

function downloadStage(stage: Stage) {
  const value = stageBodies.value[stageKey(stage)];
  if (!value) return;
  const url = URL.createObjectURL(new Blob([value], { type: "application/json" }));
  const link = document.createElement("a"); link.href = url; link.download = `${selected.value?.callId}-${stage.boundary}.json`; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function save() {
  saving.value = true;
  try {
    await request("/api/diagnostics/calls/config", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(config.value) });
    settingsOpen.value = false; await load(true);
  } catch (failure) { error.value = userFacingError(failure); }
  finally { saving.value = false; }
}

function changed() {
  notifications++;
  hasUpdates.value = true;
  scheduleRefresh();
}
function scheduleRefresh() {
  if (page.value || settingsOpen.value || loading.value || refreshTimer) return;
  refreshTimer = setTimeout(() => { refreshTimer = undefined; void load(); }, 250);
}

onMounted(() => {
  void load(true);
  events = managerEventSource("/api/diagnostics/calls/events");
  events.addEventListener("changed", changed);
});
onBeforeUnmount(() => {
  disposed = true; generation++;
  listRequest?.abort(); detailRequest?.abort(); events?.close();
  for (const controller of stageRequests.values()) controller.abort();
  if (refreshTimer) clearTimeout(refreshTimer);
});
</script>

<template>
  <section class="call-history" aria-label="调用记录">
    <div class="call-toolbar">
      <div class="d-flex ga-2 align-center">
        <v-chip :color="config.enabled ? 'success' : 'grey'" size="small" variant="tonal">{{ config.enabled ? '记录中' : '记录已关闭' }}</v-chip>
        <span v-if="pending" class="text-caption">{{ pending }} 条待写入</span>
      </div>
      <div class="d-flex ga-2">
        <v-btn v-if="hasUpdates" variant="tonal" color="primary" @click="load(true)">有新记录</v-btn>
        <v-btn prepend-icon="mdi-refresh" variant="text" :loading="loading" @click="load(true)">刷新</v-btn>
        <v-btn prepend-icon="mdi-cog-outline" variant="text" @click="settingsOpen = true">记录设置</v-btn>
      </div>
    </div>
    <v-alert v-if="error || storageError" type="error" variant="tonal" class="mb-4">{{ error || storageError }}</v-alert>
    <v-alert v-if="dropped || conflicts" type="warning" variant="tonal">{{ dropped }} 条观察记录未保存，{{ conflicts }} 条重复回执内容存在差异。已保存的原记录可继续查看。</v-alert>
    <form class="call-filters" @submit.prevent="applyFilters">
      <v-text-field v-model="query" label="接口、工具或调用 ID" hide-details density="compact" clearable />
      <v-text-field v-model="sessionId" label="会话 ID" hide-details density="compact" clearable />
      <v-select v-model="source" :items="['mcp', 'cli', 'http', 'sdk']" label="来源" clearable hide-details density="compact" />
      <v-select v-model="status" :items="statusOptions" label="状态" clearable hide-details density="compact" />
      <v-text-field v-model="from" type="datetime-local" label="开始时间" hide-details density="compact" />
      <v-text-field v-model="to" type="datetime-local" label="结束时间" hide-details density="compact" />
      <v-btn type="submit" color="primary" :loading="loading">查询</v-btn>
    </form>
    <v-card class="app-card call-table">
      <v-table hover>
        <thead><tr><th>时间</th><th>来源 / Agent</th><th>接口 / 工具</th><th>结果</th><th>耗时 / 大小</th><th>摘要</th></tr></thead>
        <tbody>
          <tr v-for="call in items" :key="call.callId" tabindex="0" @click="open(call)" @keydown.enter="open(call)">
            <td class="text-no-wrap">{{ formatTime(call.startedAt) }}</td>
            <td><strong>{{ call.source.toUpperCase() }}</strong><div class="text-caption">{{ call.agentType || '身份未知' }}</div><div v-if="call.sessionId" class="call-id" :title="call.sessionId">{{ call.sessionId }}</div></td>
            <td><strong>{{ call.operationId || call.toolName || call.pathname }}</strong><div class="call-id">{{ call.method }} {{ call.pathname }}</div></td>
            <td><v-chip :color="color(call.status)" size="small" variant="tonal">{{ statusNames[call.status] || call.status }}</v-chip><div class="text-caption mt-1">{{ captureNames[call.captureState] || call.captureState }}{{ call.businessCode ? ` · code ${call.businessCode}` : '' }}</div></td>
            <td class="text-no-wrap">{{ call.durationMs == null ? '—' : `${Math.round(call.durationMs)} ms` }}<div class="text-caption">{{ formatBytes(call.responseBytes) }}</div></td>
            <td class="call-summary">{{ call.summary || '—' }}</td>
          </tr>
          <tr v-if="!items.length && !loading"><td colspan="6" class="text-center pa-8">当前条件下暂无已记录调用。</td></tr>
        </tbody>
      </v-table>
      <div class="call-pagination"><span>第 {{ page + 1 }} 页 · {{ items.length }} 条</span><v-btn variant="text" :disabled="!page || loading" @click="move(-1)">上一页</v-btn><v-btn variant="text" :disabled="!nextCursor || loading" @click="move(1)">下一页</v-btn></div>
    </v-card>
    <v-dialog :model-value="Boolean(selected)" max-width="1100" scrollable @update:model-value="value => { if (!value) { selected = null; detailRequest?.abort(); } }">
      <v-card>
        <v-card-title class="d-flex justify-space-between align-center">调用详情<v-btn icon="mdi-close" variant="text" @click="selected = null; detailRequest?.abort()" /></v-card-title>
        <v-card-text>
          <div class="text-caption mb-3">{{ selected?.callId }} · 凭据字段已脱敏</div>
          <v-progress-linear v-if="detailLoading" indeterminate />
          <v-alert v-if="detailError" type="error" variant="tonal">{{ detailError }}</v-alert>
          <v-expansion-panels v-if="detail" multiple>
            <v-expansion-panel v-for="(stage, index) in detail.stages" :key="index">
              <v-expansion-panel-title @click="loadStage(stage)">{{ stage.boundary === 'server' ? '服务端' : stage.boundary === 'tool' ? '工具实际返回' : '客户端传输' }} · {{ formatTime(stage.startedAt) }} · {{ stage.spanId }}</v-expansion-panel-title>
              <v-expansion-panel-text>
                <v-alert v-if="stageErrors[stageKey(stage)]" type="error" variant="tonal">{{ stageErrors[stageKey(stage)] }}</v-alert>
                <div class="d-flex ga-2 mb-2"><v-btn v-if="!stageBodies[stageKey(stage)]" variant="text" @click="loadStage(stage)">读取请求与返回</v-btn><v-btn v-else variant="text" @click="downloadStage(stage)">下载完整阶段 JSON</v-btn></div>
                <pre class="call-payload">{{ stageBodies[stageKey(stage)]?.slice(0, 65536) || '正在读取…' }}</pre>
                <div v-if="stageBodies[stageKey(stage)]?.length > 65536" class="text-caption">当前预览前 65,536 个字符，完整已保存内容可下载。</div>
              </v-expansion-panel-text>
            </v-expansion-panel>
          </v-expansion-panels>
        </v-card-text>
      </v-card>
    </v-dialog>
    <v-dialog v-model="settingsOpen" max-width="520">
      <v-card title="调用记录设置"><v-card-text>
        <v-switch v-model="config.enabled" label="服务端记录调用" color="primary" hide-details />
        <v-switch v-model="config.captureBodies" label="保存脱敏后的请求和返回正文" color="primary" hide-details />
        <v-text-field v-model.number="captureMiB" type="number" min="1" max="16" label="单侧正文捕获上限（MiB）" class="mt-4" />
        <div class="text-caption">超过上限时标记捕获不完整。记录按天压缩保存，当前版本保留历史。</div>
      </v-card-text><v-card-actions><v-spacer /><v-btn @click="settingsOpen = false">取消</v-btn><v-btn color="primary" :loading="saving" @click="save">保存</v-btn></v-card-actions></v-card>
    </v-dialog>
  </section>
</template>

<style scoped>
.call-history { display: grid; gap: 18px; }
.call-toolbar, .call-pagination { display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap; }
.call-filters { display: grid; grid-template-columns: 2fr 2fr 1fr 1fr; gap: 12px; align-items: center; }
.call-table { overflow: hidden; }
.call-table tbody tr { cursor: pointer; }
.call-id { max-width: 300px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 12px; opacity: .72; }
.call-summary { max-width: 280px; overflow-wrap: anywhere; }
.call-pagination { padding: 12px 18px; justify-content: flex-end; }
.call-pagination > span { margin-right: auto; font-size: 13px; opacity: .75; }
.call-payload { white-space: pre-wrap; overflow-wrap: anywhere; font-size: 12px; line-height: 1.65; max-height: 65vh; overflow: auto; }
@media (max-width: 900px) { .call-filters { grid-template-columns: 1fr 1fr; } }
@media (max-width: 540px) { .call-filters { grid-template-columns: 1fr; } }
</style>
