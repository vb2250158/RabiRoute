
<script setup lang="ts">
import { computed, onMounted, onBeforeUnmount, ref, watch } from "vue";
import { useI18n } from "../../../../../ribiwebgui/src/i18n/index";
import { browserUuid } from "../../../../../ribiwebgui/src/browserUuid";
import { userFacingError } from "../../../../../ribiwebgui/src/userFacingError";
import type { ComputerTarget } from "./computerControlPresentation";
import type { ComputerControlClient } from "./computerControlClient";
import { ComputerControlFiles } from "./computerControlFiles";

const props = defineProps<{ client: ComputerControlClient; target: ComputerTarget; enabled: boolean }>();
const { t } = useI18n();
type WindowRow = { windowId: string; pid: number; title: string; minimized: boolean };
type RecordingFile = { path: string; size: number };
const state = ref("absent");
const id = ref("");
const windows = ref<WindowRow[]>([]);
const selected = ref<string[]>([]);
const startAt = ref("");
const endAt = ref("");
const pauseAt = ref("");
const resumeAt = ref("");
const permanent = ref(false);
const kept = ref(false);
const clipStart = ref("");
const clipEnd = ref("");
const error = ref("");
const busy = ref(false);
const progress = ref("");
const files = ref<RecordingFile[]>([]);
const cache = ref<{ cacheBytes: number; permanentBytes: number; cacheMaxGiB: number }>();
const expiry = ref<number>();
const refreshAt = ref<number>();
const controller = new AbortController();
const active = computed(() => ["scheduled", "recording", "paused", "clipping"].includes(state.value));
const call = (body: Record<string, unknown>, signal = controller.signal) => props.client.action(props.target, body, signal);
const labels: Record<string, string> = { scheduled: "待开始", recording: "录屏中", paused: "录屏已暂停", completed: "录屏已完成", cancelled: "录屏已取消", failed: "录屏失败", expired: "录像缓存已到期", clipping: "正在裁剪录像" };

function readStatus(result: Record<string, unknown>) {
  state.value = String(result.state);
  id.value = String(result.recordingId ?? "");
  files.value = Array.isArray(result.files) ? result.files : [];
  kept.value = result.permanent === true;
  expiry.value = typeof result.expiresAt === "number" ? result.expiresAt : undefined;
  if (typeof result.error === "string") error.value = result.error;
  const pauses = Array.isArray(result.pauses) ? result.pauses : [];
  const deadlines = [result.startAt, result.endAt, ...pauses.flatMap(pause => [pause?.startAt, pause?.endAt])];
  const now = Date.now();
  const next = deadlines.filter((time): time is number => typeof time === "number" && Number.isFinite(time) && time > now);
  const finishDeadline = typeof result.endAt === "number" ? result.endAt + 10_000 : 0;
  refreshAt.value = undefined;
  if (active.value && next.length) refreshAt.value = Math.min(...next) + 350;
  else if (active.value && finishDeadline > now) refreshAt.value = finishDeadline;
}
async function run(work: () => Promise<void>) {
  if (busy.value || controller.signal.aborted) return;
  busy.value = true;
  error.value = "";
  try { await work(); }
  catch (reason) { if (!controller.signal.aborted) error.value = userFacingError(reason); }
  finally { busy.value = false; }
}
const status = () => run(async () => readStatus(await call({ action: "recording.status", ...(id.value ? { recordingId: id.value } : {}) })));
const cacheStatus = () => run(async () => {
  const result = await call({ action: "recording.cache.status" });
  cache.value = { cacheBytes: Number(result.cacheBytes), permanentBytes: Number(result.permanentBytes), cacheMaxGiB: Number(result.cacheMaxGiB) };
});
const listWindows = () => run(async () => {
  const result = await call({ action: "windows.list", limit: 200 });
  windows.value = Array.isArray(result.windows) ? result.windows.filter(row => !row.minimized) : [];
  selected.value = selected.value.filter(key => windows.value.some(row => windowKey(row) === key));
});
const windowKey = (row: WindowRow) => row.windowId + ":" + row.pid;
function start() {
  void run(async () => {
    const endTime = new Date(endAt.value).getTime();
    const startTime = startAt.value ? new Date(startAt.value).getTime() : Date.now();
    if (!(endTime > Math.max(startTime, Date.now()))) throw new Error(t("请选择晚于开始时间的结束时间"));
    if (Boolean(pauseAt.value) !== Boolean(resumeAt.value)) throw new Error(t("请同时填写暂停和恢复时间"));
    const pauses = pauseAt.value ? [{ startAt: new Date(pauseAt.value).getTime(), endAt: new Date(resumeAt.value).getTime() }] : [];
    id.value = browserUuid();
    state.value = "submitting";
    const body = { action: "recording.start", recordingId: id.value, startAt: startTime, endAt: endTime, pauses, permanent: permanent.value,
      windows: windows.value.filter(row => selected.value.includes(windowKey(row))).map(({ windowId, pid }) => ({ windowId, pid })) };
    readStatus(await call(body));
  });
}
function command(action: string) { void run(async () => readStatus(await call({ action, recordingId: id.value }))); }
function clip() {
  void run(async () => {
    const from = new Date(clipStart.value).getTime();
    const until = new Date(clipEnd.value).getTime();
    if (!(until > from)) throw new Error(t("请选择有效的裁剪时间段"));
    const original = id.value;
    id.value = browserUuid();
    state.value = "submitting";
    readStatus(await call({ action: "recording.clip", recordingId: id.value, sourceRecordingId: original, startAt: from, endAt: until, permanent: permanent.value }));
  });
}
function download(file: RecordingFile) {
  void run(async () => {
    const name = file.path.split(/[\\/]/).pop() || "recording.mkv";
    const adapter = new ComputerControlFiles(call);
    const onProgress = (update: { offset: number; size: number }) => { progress.value = update.offset + " / " + update.size; };
    const browser = window as Window & { showSaveFilePicker?(options: { suggestedName: string }): Promise<FileSystemFileHandle> };
    if (browser.showSaveFilePicker) {
      const handle = await browser.showSaveFilePicker({ suggestedName: name });
      const stream = await handle.createWritable();
      try {
        await adapter.downloadTo(file.path, controller.signal, onProgress, bytes => stream.write(bytes));
        await stream.close();
      } catch (error) { await stream.abort().catch(() => {}); throw error; }
      finally { progress.value = ""; }
      return;
    }
    if (file.size > 128 * 1024 ** 2) throw new Error(t("此浏览器无法直接保存大型录像，请通过 Agent 下载。"));
    const blob = await adapter.download(file.path, controller.signal, onProgress);
    if (controller.signal.aborted) return;
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = name;
    anchor.click();
    progress.value = "";
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  });
}
let refresh: ReturnType<typeof setTimeout> | undefined;
function scheduleStatus() {
  clearTimeout(refresh);
  if (refreshAt.value === undefined || busy.value || document.hidden || controller.signal.aborted) return;
  refresh = setTimeout(() => {
    if (refreshAt.value === undefined || busy.value || document.hidden) return;
    if (refreshAt.value > Date.now()) { scheduleStatus(); return; }
    refreshAt.value = undefined;
    void status();
  }, Math.min(2_147_483_647, Math.max(0, refreshAt.value - Date.now())));
}
function visibilityChanged() {
  scheduleStatus();
  if (!document.hidden) void status();
}
watch([refreshAt, busy], scheduleStatus);
onMounted(() => {
  document.addEventListener("visibilitychange", visibilityChanged);
  void status();
});
onBeforeUnmount(() => {
  document.removeEventListener("visibilitychange", visibilityChanged);
  clearTimeout(refresh);
  controller.abort();
});
</script>

<template>
  <section class="recording-panel" :aria-label="t('录屏')">
    <div class="recording-actions">
      <h4>{{ t('录屏') }}</h4>
      <span v-if="labels[state]" role="status">{{ t(labels[state]) }}</span>
      <v-btn size="small" variant="text" :disabled="busy" @click="status">{{ t('刷新状态') }}</v-btn>
    </div>
    <div class="recording-actions">
      <v-btn size="small" variant="text" :disabled="busy" @click="cacheStatus">{{ t('查看录屏容量') }}</v-btn>
      <span v-if="cache">{{ t('缓存') }} {{ (cache.cacheBytes / 1024 ** 3).toFixed(2) }} / {{ cache.cacheMaxGiB }} GiB · {{ t('已永久保存') }} {{ (cache.permanentBytes / 1024 ** 3).toFixed(2) }} GiB</span>
    </div>
    <template v-if="!active && state !== 'submitting'">
      <div class="recording-actions">
        <v-select v-model="selected" :items="windows.map(row => ({ title: row.title || row.windowId, value: windowKey(row) }))"
          :label="t('录制窗口（留空录制桌面）')" multiple chips density="compact" hide-details :disabled="!enabled || busy" />
        <v-btn size="small" variant="text" :disabled="!enabled || busy" @click="listWindows">{{ t('读取窗口') }}</v-btn>
      </div>
      <div class="recording-times">
        <v-text-field v-model="startAt" :label="t('开始时间（留空立即开始）')" type="datetime-local" density="compact" hide-details />
        <v-text-field v-model="endAt" :label="t('结束时间')" type="datetime-local" density="compact" hide-details />
        <v-text-field v-model="pauseAt" :label="t('暂停时间（可选）')" type="datetime-local" density="compact" hide-details />
        <v-text-field v-model="resumeAt" :label="t('恢复时间（可选）')" type="datetime-local" density="compact" hide-details />
      </div>
      <v-checkbox v-model="permanent" :label="t('永久保存录像')" hide-details density="compact" />
      <v-btn class="recording-start" size="small" variant="tonal" :disabled="!enabled || busy || !endAt" @click="start">{{ t('开始录屏') }}</v-btn>
    </template>
    <div v-else-if="id" class="recording-actions">
      <v-btn v-if="state === 'paused'" size="small" variant="tonal" :disabled="!enabled || busy" @click="command('recording.resume')">{{ t('恢复录屏') }}</v-btn>
      <v-btn v-else-if="active && state !== 'clipping'" size="small" variant="tonal" :disabled="!enabled || busy" @click="command('recording.pause')">{{ t('暂停录屏') }}</v-btn>
      <v-btn size="small" variant="tonal" :disabled="busy" @click="command('recording.stop')">{{ t('结束录屏') }}</v-btn>
    </div>
    <div v-if="files.length" class="recording-actions">
      <v-btn v-if="!kept" size="small" variant="text" :disabled="!enabled || busy" @click="command('recording.save')">{{ t('永久保存当前录像') }}</v-btn>
      <span v-else>{{ t('已永久保存') }}</span>
      <time v-if="expiry">{{ t('缓存到期') }} {{ new Date(expiry).toLocaleString() }}</time>
      <v-btn v-for="(file, index) in files" :key="file.path" size="small" variant="text" :disabled="busy" @click="download(file)">{{ t('下载录屏') }} {{ index + 1 }}</v-btn>
    </div>
    <div v-if="files.length && !active" class="recording-times">
      <v-text-field v-model="clipStart" :label="t('裁剪起点')" type="datetime-local" step="1" density="compact" hide-details />
      <v-text-field v-model="clipEnd" :label="t('裁剪终点')" type="datetime-local" step="1" density="compact" hide-details />
      <v-btn size="small" :disabled="!enabled || busy || !clipStart || !clipEnd" @click="clip">{{ t('裁剪录像') }}</v-btn>
    </div>
    <p v-if="progress" role="status">{{ progress }}</p>
    <v-alert v-if="error" type="error" variant="tonal" density="compact">{{ error }}</v-alert>
  </section>
</template>

<style scoped>
.recording-panel { display: grid; gap: 10px; margin-top: 16px; }
.recording-actions { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; }
.recording-times { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 200px), 1fr)); gap: 8px; }
.recording-start { justify-self: start; }
</style>
