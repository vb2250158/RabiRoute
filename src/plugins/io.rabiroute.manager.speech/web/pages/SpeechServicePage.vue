<script setup lang="ts">
import { translateText } from "../../../../../ribiwebgui/src/i18n/index";
import { userFacingError } from "../../../../../ribiwebgui/src/userFacingError";
import { playbackOutputLabel } from "../speech/playbackPresentation";
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { storeToRefs } from "pinia";
import {
  type SpeechAudioStreamClient,
  type SpeechAudioStreamEvent,
  type SpeechIngressRecord,
  type SpeechProvider,
  type SpeechRecord,
  type SpeechRouteDeliveryHistory
} from "@shared/speechControlContract";
import SpeechParameterSlider from "../../../../../ribiwebgui/src/components/SpeechParameterSlider.vue";
import SpeechRecordsAndSpeakers from "../components/SpeechRecordsAndSpeakers.vue";
import SpeechHostMonitor from "../components/SpeechHostMonitor.vue";
import { useGatewayStore } from "../../../../../ribiwebgui/src/stores/gatewayStore";
import { useSpeechStore } from "../../../../../ribiwebgui/src/stores/speechStore";
import { gatewayAdapterTypes } from "../../../../../ribiwebgui/src/utils/gatewayHelpers";
import { copyTextToClipboard } from "../../../../../ribiwebgui/src/clipboard";
import { SpeechControlRequestError, speechControlClient } from "../speech/speechControlClient";
import { transcriptSpeakerPresentation } from "../speech/speechSpeakerPresentation";
import { pluginCatalogStore } from "../../../../../ribiwebgui/src/pluginCatalogStore";
import TrustedWebRendererHost from "../../../../../ribiwebgui/src/components/TrustedWebRendererHost.vue";
import { webRenderersAt } from "../../../../../ribiwebgui/src/pluginRenderers";
const store = useGatewayStore();
const speech = useSpeechStore();
const speechStatusRenderers = computed(() => webRenderersAt(pluginCatalogStore.statusRenderers.value, "route.speech.summary"));
const {
  status,
  microphone: microphoneStatus,
  playback,
  audioStream,
  recordsVersion,
  loading
} = storeToRefs(speech);
const activeKind = ref<"tts" | "asr">("tts");
const AUDIO_LOG_EXPANDED_STORAGE_KEY = "rabiroute:speech:audio-log-expanded";
const audioLogExpanded = ref(loadAudioLogExpanded());
const requestError = ref("");
const requestErrorDetail = ref("");
const requestErrorResolution = ref("");
const actionMessage = ref("");
const playbackBusy = computed(() => Boolean(playback.value?.current));
const playbackQueued = computed(() => Number(playback.value?.queued || 0));
const playbackVolume = ref(100);
const playbackVolumeSaving = ref(false);
const audioStreamSaving = ref(false);
const audioHistoryLoading = ref(false);
const durableAudioEvents = ref<SpeechAudioStreamEvent[]>([]);
const publicAudioTranscripts = ref<SpeechIngressRecord[]>([]);
const publicTranscriptDeliveries = ref<Record<string, SpeechRouteDeliveryHistory[]>>({});
const retainedAsrRecords = ref<Record<string, SpeechRecord>>({});
const audioEventsHaveMore = ref(false);
const audioTranscriptsHaveMore = ref(false);
const serviceEnabled = computed(() => status.value?.state === "online");
const runtimeStatusLabel = computed(() => {
  if (!status.value) {
    return !loading.value && (requestError.value || speech.error) ? "状态未知" : "检查中";
  }
  if (status.value.state === "online") return "在线";
  if (status.value.state === "invalid") return "配置无效";
  return status.value.error ? "未连接" : "待启动";
});
let playbackVolumeTimer = 0;
let pendingPlaybackVolume: number | null = null;

function clearRequestError(): void {
  requestError.value = "";
  requestErrorDetail.value = "";
  requestErrorResolution.value = "";
}

function recordRequestError(error: unknown): void {
  requestError.value = userFacingError(error);
  requestErrorDetail.value = error instanceof SpeechControlRequestError ? error.detail : "";
  requestErrorResolution.value = error instanceof SpeechControlRequestError ? error.resolution : "";
}

function loadAudioLogExpanded(): boolean {
  try {
    return window.localStorage.getItem(AUDIO_LOG_EXPANDED_STORAGE_KEY) === "true";
  } catch {
    return false;
  }
}

function toggleAudioLog(): void {
  audioLogExpanded.value = !audioLogExpanded.value;
  try {
    window.localStorage.setItem(AUDIO_LOG_EXPANDED_STORAGE_KEY, String(audioLogExpanded.value));
  } catch {
    // The control remains usable when storage is unavailable.
  }
  if (audioLogExpanded.value) void loadAudioHistory();
}

const providers = computed(() => status.value?.providers[activeKind.value] ?? []);
const computerName = computed(() => store.meta.rabiName || store.meta.computerName || "当前电脑");
const stateLabel = computed(() => ({
  online: "在线",
  offline: "未连接",
  invalid: "配置无效"
}[status.value?.state || "offline"]));
const stateColor = computed(() => ({
  online: "success",
  offline: "warning",
  invalid: "error"
}[status.value?.state || "offline"]));
const currentDefault = computed(() => status.value?.defaults[activeKind.value] || "未设置");
const speechStatusContext = computed(() => ({
  computerName: computerName.value,
  status: status.value,
  stateLabel: stateLabel.value,
  stateColor: stateColor.value
}));
const speechSubscriberRoutes = computed(() => store.gateways
  .filter(gateway => gateway.enabled !== false && gatewayAdapterTypes(gateway).includes("speech")));
const selectedAudioStream = computed(() => !audioStream.value || audioStream.value.source === "unavailable" || audioStream.value.selectionStorageError
  ? null : audioStream.value.source === "remote" && audioStream.value.selectedClientId
  ? `remote:${audioStream.value.selectedClientId}`
  : "local");
function remoteAudioClientName(client: SpeechAudioStreamClient): string {
  const model = client.deviceModel?.trim();
  if (!model || client.name.toLocaleLowerCase().includes(model.toLocaleLowerCase())) return client.name;
  return `${client.name} · ${model}`;
}
const audioStreamOptions = computed(() => [
  { title: `本机 · ${computerName.value}`, value: "local", subtitle: "使用当前电脑的麦克风和扬声器" },
  ...(audioStream.value?.clients || []).map(client => ({
    title: `${remoteAudioClientName(client)} · 远程 Rabi 语音客户端`,
    value: `remote:${client.id}`,
    subtitle: client.online
      ? [`在线 · ${client.sampleRate} Hz`, client.deviceModel ? `设备型号 ${client.deviceModel}` : ""].filter(Boolean).join(" · ")
      : [client.deviceModel ? `设备型号 ${client.deviceModel}` : "", "离线"].filter(Boolean).join(" · ")
  }))
]);
const selectedAudioStreamLabel = computed(() => {
  return playbackOutputLabel(audioStream.value, audioStreamOptions.value.find(item => item.value === selectedAudioStream.value)?.title);
});
const latestPlaybackFailure = computed(() => [...(playback.value?.jobs ?? [])].reverse().find(job => job.status === "error"));
const selectedAudioStreamClient = computed(() => audioStream.value?.clients.find(client => client.id === audioStream.value?.selectedClientId));
const selectedAudioStreamEvents = computed(() => {
  const merged = new Map<string, SpeechAudioStreamEvent>();
  for (const event of [...durableAudioEvents.value, ...(audioStream.value?.events || [])]) {
    const key = event.id || `sequence:${event.sequence}`;
    merged.set(key, event);
  }
  const sourceDeviceId = selectedAudioStreamClient.value?.sourceDeviceId;
  return [...merged.values()]
    .filter(event => (
      !selectedAudioStreamClient.value
      || event.sourceDeviceId === sourceDeviceId
      || (!event.sourceDeviceId && event.clientId === selectedAudioStreamClient.value.id)
    ))
    .sort((left, right) => right.sequence - left.sequence);
});
const selectedDeviceTranscripts = computed(() => {
  const sourceDeviceId = selectedAudioStreamClient.value?.sourceDeviceId;
  return publicAudioTranscripts.value.filter(record => !sourceDeviceId || record.sourceDeviceId === sourceDeviceId);
});
const unlinkedRabiTranscripts = computed(() => {
  const sourceDeviceId = selectedAudioStreamClient.value?.sourceDeviceId;
  return publicAudioTranscripts.value.filter(record => sourceDeviceId && record.sourceDeviceId !== sourceDeviceId);
});
const currentPipelineSummary = computed(() => {
  const stats = microphoneStatus.value?.stats;
  return {
    captured: Number(stats?.captured || 0),
    recognized: Number(stats?.recognized || 0),
    empty: Number(stats?.empty || 0),
    delivered: Number(stats?.delivered || 0),
    recorded: Number(stats?.recorded || 0),
    failed: Number(stats?.deliveryFailed || 0) + Number(stats?.submitFailed || 0)
  };
});

function audioBytesLabel(value: number | undefined): string {
  const bytes = Math.max(0, Number(value || 0));
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(2)} GiB`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(2)} MiB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${Math.round(bytes)} B`;
}

function audioEventTime(value: number): string {
  if (!value) return "-";
  return new Date(value * 1000).toLocaleTimeString("zh-CN", { hour12: false });
}

function audioEventDirection(event: SpeechAudioStreamEvent): { label: string; color: string; icon: string } {
  if (event.direction === "inbound") return { label: "接收", color: "success", icon: "mdi-arrow-down-bold" };
  if (event.direction === "outbound") return { label: "发送", color: "info", icon: "mdi-arrow-up-bold" };
  if (event.direction === "receipt") return { label: "回执", color: "secondary", icon: "mdi-check-circle-outline" };
  if (event.direction === "pipeline") return {
    label: event.stage === "vad" ? "切句" : event.stage === "asr" ? "识别" : event.stage === "route" ? "投递" : "处理",
    color: event.level === "error" ? "error" : event.level === "warning" ? "warning" : "info",
    icon: event.stage === "asr" ? "mdi-waveform" : event.stage === "route" ? "mdi-transit-connection-variant" : "mdi-tune-vertical"
  };
  return { label: "状态", color: "info", icon: "mdi-swap-horizontal" };
}

function mergeAudioEvents(events: SpeechAudioStreamEvent[], append = false): void {
  const merged = new Map<string, SpeechAudioStreamEvent>();
  for (const event of append ? [...durableAudioEvents.value, ...events] : events) {
    merged.set(event.id || `sequence:${event.sequence}`, event);
  }
  durableAudioEvents.value = [...merged.values()].sort((left, right) => right.sequence - left.sequence);
}

async function loadAudioHistory(options: { earlierEvents?: boolean; earlierTranscripts?: boolean } = {}): Promise<void> {
  const client = selectedAudioStreamClient.value;
  if (!client) {
    durableAudioEvents.value = [];
    publicAudioTranscripts.value = [];
    publicTranscriptDeliveries.value = {};
    retainedAsrRecords.value = {};
    return;
  }
  audioHistoryLoading.value = true;
  try {
    const eventBefore = options.earlierEvents
      ? Math.min(...durableAudioEvents.value.map(event => event.sequence))
      : undefined;
    const transcriptBefore = options.earlierTranscripts
      ? Math.min(...publicAudioTranscripts.value.map(record => record.time))
      : undefined;
    const [eventsPayload, transcriptPayload, retainedPayload] = await Promise.all([
      speechControlClient.audioStreamEvents({
        limit: 200,
        sourceDeviceId: client.sourceDeviceId,
        beforeSequence: Number.isFinite(eventBefore) ? eventBefore : undefined
      }),
      speechControlClient.speechMessages({
        limit: 200,
        messageAdapterType: "rabilink",
        before: Number.isFinite(transcriptBefore) ? transcriptBefore : undefined
      }),
      speechControlClient.records({
        limit: 1000,
        kind: "asr",
        sourceDeviceId: client.sourceDeviceId
      })
    ]);
    mergeAudioEvents(eventsPayload.events, options.earlierEvents === true);
    audioEventsHaveMore.value = eventsPayload.events.length === 200;
    const transcriptMap = new Map<string, SpeechIngressRecord>();
    for (const record of options.earlierTranscripts
      ? [...publicAudioTranscripts.value, ...transcriptPayload.records]
      : transcriptPayload.records) {
      transcriptMap.set(record.id, record);
    }
    publicAudioTranscripts.value = [...transcriptMap.values()].sort((left, right) => right.time - left.time);
    publicTranscriptDeliveries.value = {
      ...(options.earlierTranscripts ? publicTranscriptDeliveries.value : {}),
      ...transcriptPayload.deliveriesByRecordId
    };
    audioTranscriptsHaveMore.value = transcriptPayload.records.length === 200;
    retainedAsrRecords.value = Object.fromEntries(retainedPayload.records.map(record => [record.id, record]));
  } catch (error) {
    recordRequestError(error);
  } finally {
    audioHistoryLoading.value = false;
  }
}

function transcriptTime(record: SpeechIngressRecord): string {
  return new Date(record.time * 1000).toLocaleString("zh-CN", { hour12: false });
}

function transcriptSpeaker(record: SpeechIngressRecord): string {
  return transcriptSpeakerPresentation(record.segments);
}

function deliverySummary(recordId: string): string {
  const deliveries = publicTranscriptDeliveries.value[recordId] || [];
  if (!deliveries.length) return "尚无 Route 回执";
  const delivered = deliveries.filter(item => item.status === "delivered").length;
  const recorded = deliveries.filter(item => item.status === "recorded").length;
  return [
    delivered ? `${delivered} 个 Route 已投递` : "",
    recorded ? `${recorded} 个 Route 仅记录` : ""
  ].filter(Boolean).join(" · ") || "已有回执";
}

function retainedAudio(recordId: string): SpeechRecord | undefined {
  return retainedAsrRecords.value[recordId];
}

function retainedAudioAvailable(recordId: string): boolean {
  const record = retainedAudio(recordId);
  return Boolean(record?.audioFile && (!record.audioExpiresAt || record.audioExpiresAt > Date.now() / 1000));
}

function providerName(provider: SpeechProvider): string {
  if (provider.id === "local-tts") return "RabiSpeech 本地 TTS 路由";
  if (provider.id === "faster-whisper") return "faster-whisper";
  return provider.id;
}

function providerModel(provider: SpeechProvider): string {
  if (provider.model) return provider.model;
  if (provider.kind === "tts" && provider.id === "local-tts") return "按角色与本地 worker 动态选择";
  return "由 provider 决定";
}

function deviceLabel(provider: SpeechProvider): string {
  if (provider.kind === "tts") return provider.transport === "http" ? "本机 worker" : provider.transport || "本机";
  if (provider.loadedDevice) return provider.loadedDevice.toUpperCase();
  if (provider.loaded === false) return "尚未加载";
  return "待首次识别确认";
}

function checkedAtLabel(value: string | undefined): string {
  if (!value) return "尚未检查";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString("zh-CN", { hour12: false });
}

async function refreshStatus(): Promise<void> {
  clearRequestError();
  try {
    await speech.refreshStatus();
    await refreshHostDiagnostics();
    if (audioLogExpanded.value) await loadAudioHistory();
  } catch (error) {
    recordRequestError(error);
  }
}

async function refreshHostDiagnostics(): Promise<void> {
  // Audio I/O is local even when the active speech provider is remote.
  await Promise.allSettled([speech.refreshAudioStreams(), speech.refreshPlayback(), speech.refreshMicrophone()]);
}

async function chooseAudioStream(value: string | null): Promise<void> {
  if (!value || audioStreamSaving.value || (value === selectedAudioStream.value && !audioStream.value?.selectionStorageError)) return;
  audioStreamSaving.value = true;
  clearRequestError();
  try {
    if (value === "local") {
      await speech.selectAudioStream({ source: "local" });
    } else {
      await speech.selectAudioStream({ source: "remote", clientId: value.slice("remote:".length) });
    }
    actionMessage.value = audioStream.value?.selectionRecovery
      ? "已重新选择音频设备，原设置已保留备份。"
      : value === "local"
      ? "音频流已切换到本机麦克风和扬声器。"
      : "音频流已切换到远程 Rabi 语音客户端；VAD、ASR、Route 广播和 TTS 队列仍由本机控制。";
  } catch (error) {
    recordRequestError(error);
  } finally {
    audioStreamSaving.value = false;
  }
}

async function copyAudioStreamToken(): Promise<void> {
  clearRequestError();
  try {
    const token = await speech.audioStreamToken();
    await copyTextToClipboard(token);
    actionMessage.value = "客户端连接密钥已复制；只粘贴到会议室电脑的私有 config.json。";
  } catch (error) {
    recordRequestError(error);
  }
}

async function stopPlayback(): Promise<void> {
  await speech.stopPlayback();
}

function normalizePlaybackVolume(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.min(100, Math.max(0, Math.round(parsed))) : 100;
}

async function flushPlaybackVolume(): Promise<void> {
  if (playbackVolumeSaving.value || pendingPlaybackVolume == null) return;
  const nextVolume = pendingPlaybackVolume;
  pendingPlaybackVolume = null;
  playbackVolumeSaving.value = true;
  try {
    const next = await speech.setPlaybackVolume(nextVolume);
    if (pendingPlaybackVolume == null) playbackVolume.value = normalizePlaybackVolume(next.volume);
    clearRequestError();
  } catch (error) {
    recordRequestError(error);
  } finally {
    playbackVolumeSaving.value = false;
    if (pendingPlaybackVolume != null) void flushPlaybackVolume();
  }
}

function schedulePlaybackVolume(value: number): void {
  const normalized = normalizePlaybackVolume(value);
  playbackVolume.value = normalized;
  pendingPlaybackVolume = normalized;
  window.clearTimeout(playbackVolumeTimer);
  playbackVolumeTimer = window.setTimeout(() => {
    playbackVolumeTimer = 0;
    void flushPlaybackVolume();
  }, 120);
}

watch(() => playback.value?.volume, volume => {
  if (playbackVolumeSaving.value || playbackVolumeTimer || pendingPlaybackVolume != null) return;
  if (volume != null) playbackVolume.value = normalizePlaybackVolume(volume);
}, { immediate: true });
watch(
  () => selectedAudioStreamClient.value?.sourceDeviceId || "",
  () => {
    if (audioLogExpanded.value) void loadAudioHistory();
  },
  { immediate: true }
);
watch(
  () => audioStream.value?.events?.[0]?.sequence,
  () => {
    if (audioStream.value?.events?.length) mergeAudioEvents(audioStream.value.events, true);
  }
);
watch(recordsVersion, () => {
  if (audioLogExpanded.value) void loadAudioHistory();
});

let releaseSpeech: (() => void) | undefined;
let disposed = false;
onMounted(async () => {
  const release = await speech.acquire(unsubscribe => { releaseSpeech = unsubscribe; });
  if (disposed) {
    release();
    return;
  }
  releaseSpeech = release;
  if (!audioStream.value) await refreshHostDiagnostics();
});
onBeforeUnmount(() => {
  disposed = true;
  window.clearTimeout(playbackVolumeTimer);
  releaseSpeech?.();
});
</script>

<template>
  <section class="speech-page" aria-label="语音服务诊断">
    <div class="page-header speech-page-header">
      <div>
        <h3>语音服务诊断</h3>
        <p class="section-note">查看引擎状态、音频流、播放队列和历史记录。</p>
      </div>
      <div class="page-actions">
        <v-chip size="small" role="status">{{ runtimeStatusLabel }}</v-chip>
        <v-btn color="secondary" variant="tonal" prepend-icon="mdi-chart-box-outline" href="reports/rabispeech-model-benchmark.html" target="_blank">目标测试机报告</v-btn>
        <v-btn icon="mdi-refresh" variant="text" :loading="loading" aria-label="刷新语音服务状态" @click="refreshStatus" />
      </div>
    </div>

    <v-alert v-if="requestError || speech.error" type="error" variant="tonal" class="mb-4">
      <div>语音服务操作失败：{{ requestError || speech.error }}</div>
      <div v-if="requestErrorDetail" class="mt-2"><strong>具体原因：</strong>{{ requestErrorDetail }}</div>
      <div v-if="requestErrorResolution" class="mt-2"><strong>处理方法：</strong>{{ requestErrorResolution }}</div>
    </v-alert>
    <v-alert v-if="actionMessage" class="mb-4" type="success" variant="tonal" closable @click:close="actionMessage = ''">{{ actionMessage }}</v-alert>

    <template v-if="audioStream">
    <v-card class="app-card glass-card speech-audio-stream-card">
      <div class="speech-audio-stream-copy">
        <div class="speech-audio-stream-icon"><v-icon>mdi-access-point</v-icon></div>
        <div>
          <div class="stat-label">音频流</div>
          <strong>{{ selectedAudioStreamLabel }}</strong>
          <p>客户端只提供远程麦克风和喇叭；切句、ASR、Route 投递、角色 TTS 与防回流仍在当前 Rabi 主机执行。</p>
        </div>
      </div>
      <div class="speech-audio-stream-controls">
        <v-select
          :model-value="selectedAudioStream"
          :items="audioStreamOptions"
          item-title="title"
          item-value="value"
          label="音频流类型"
          hide-details
          :loading="audioStreamSaving"
          :disabled="audioStreamSaving || status?.state !== 'online'"
          @update:model-value="chooseAudioStream"
        >
          <template #item="{ props, item }">
            <v-list-item v-bind="props" :subtitle="item.raw.subtitle" />
          </template>
        </v-select>
        <v-btn color="secondary" variant="tonal" prepend-icon="mdi-content-copy" :disabled="!audioStream?.enabled" @click="copyAudioStreamToken">复制客户端连接密钥</v-btn>
      </div>
      <v-alert v-if="audioStream?.selectionStorageError || audioStream?.source === 'unavailable'" type="warning" variant="tonal" class="mt-3">
        <strong>音频设备选择暂不可用。请重新选择设备；原设置会保留备份。</strong>
        <div v-if="audioStream?.selectionStorageError">{{ translateText(audioStream.selectionStorageError) }}</div>
      </v-alert>
      <div class="speech-audio-stream-log">
        <div class="speech-audio-log-head">
          <div class="speech-audio-log-copy">
            <strong>当前设备收发日志</strong>
            <span v-if="selectedAudioStreamClient">
              {{ selectedAudioStreamClient.deviceModel ? `设备型号 ${selectedAudioStreamClient.deviceModel} · ` : "" }}
              PCM 已接收 {{ audioBytesLabel(selectedAudioStreamClient.receivedBytes) }} ·
              {{ selectedAudioStreamClient.acceptedChunks }} 块
              <template v-if="selectedAudioStreamClient.lastSequence != null"> · 序号 {{ selectedAudioStreamClient.lastSequence }}</template>
            </span>
            <span v-else>本机音频不经过远端客户端传输。</span>
          </div>
          <div class="speech-audio-log-actions">
            <v-chip size="small" :color="audioStream?.selectedOnline ? 'success' : 'warning'" variant="tonal">
              {{ audioStream?.source === "unavailable" ? "请重新选择音频设备" : audioStream?.selectedOnline ? "通道在线" : "所选设备离线" }}
            </v-chip>
            <v-btn
              size="small"
              variant="text"
              :prepend-icon="audioLogExpanded ? 'mdi-chevron-up' : 'mdi-chevron-down'"
              :aria-expanded="audioLogExpanded"
              aria-controls="speech-device-log-panel"
              @click="toggleAudioLog"
            >
              {{ audioLogExpanded ? "收起收发日志" : "展开收发日志" }}
            </v-btn>
          </div>
        </div>
        <v-expand-transition>
          <div
            v-if="audioLogExpanded"
            id="speech-device-log-panel"
            class="speech-audio-log-panel"
            role="region"
            aria-label="当前设备收发日志详情"
          >
            <div v-if="selectedAudioStreamClient" class="speech-pipeline-summary">
              <span><b>{{ currentPipelineSummary.captured }}</b> 段进入切句</span>
              <span><b>{{ currentPipelineSummary.recognized }}</b> 段识别成功</span>
              <span><b>{{ currentPipelineSummary.empty }}</b> 段无有效文字</span>
              <span><b>{{ currentPipelineSummary.delivered }}</b> 次投递 Agent</span>
              <span><b>{{ currentPipelineSummary.recorded }}</b> 次仅记录</span>
              <span v-if="currentPipelineSummary.failed"><b>{{ currentPipelineSummary.failed }}</b> 次失败</span>
            </div>
            <div class="section-note">
              PCM 字节/块数只证明声音数据到达电脑；只有经过 VAD 切句、ASR 得到有效文本后，才会出现在下方公共转写记录里。
            </div>
            <div v-if="selectedAudioStreamEvents.length" class="speech-audio-log-rows">
              <div v-for="event in selectedAudioStreamEvents" :key="event.sequence" class="speech-audio-log-row">
                <time>{{ audioEventTime(event.time) }}</time>
                <v-chip
                  size="x-small"
                  :color="audioEventDirection(event).color"
                  variant="tonal"
                  :prepend-icon="audioEventDirection(event).icon"
                >
                  {{ audioEventDirection(event).label }}
                </v-chip>
                <span>{{ event.message }}</span>
                <code>
                  <template v-if="event.bytes">{{ audioBytesLabel(event.bytes) }}</template>
                  <template v-if="event.streamSequence != null"> · seq {{ event.streamSequence }}</template>
                  <template v-if="event.totalBytes"> · 累计 {{ audioBytesLabel(event.totalBytes) }}</template>
                </code>
              </div>
              <v-btn
                v-if="audioEventsHaveMore"
                size="small"
                variant="text"
                prepend-icon="mdi-history"
                :loading="audioHistoryLoading"
                @click="loadAudioHistory({ earlierEvents: true })"
              >
                加载更早的收发与处理日志
              </v-btn>
            </div>
            <div v-else class="speech-audio-log-empty">
              <v-icon>mdi-text-box-search-outline</v-icon>
              <span>{{ selectedAudioStreamClient ? "等待这台设备产生新的连接、PCM 接收、音频发送或播放回执。" : "选择远端设备后显示该设备的收发事件。" }}</span>
            </div>
            <div v-if="selectedAudioStreamClient?.messageAdapterType === 'rabilink'" class="section-note">
              RabiLink 手机的麦克风 PCM 在这里记录为“接收”；Agent 角色 TTS 使用独立 Relay 下行与终端播放回执，不会把本机播放误记成远端“发送成功”。
            </div>
            <div class="speech-device-transcripts">
              <div class="speech-device-transcript-head">
                <div>
                  <strong>公共 ASR 转写与 Route 回执</strong>
                  <span>从主机通用转写账本按稳定 record ID 解析；它与夜雨角色会话记录分开保存。</span>
                </div>
                <v-btn
                  size="small"
                  variant="text"
                  prepend-icon="mdi-refresh"
                  :loading="audioHistoryLoading"
                  @click="loadAudioHistory()"
                >
                  刷新历史
                </v-btn>
              </div>
              <div v-if="selectedDeviceTranscripts.length" class="speech-device-transcript-list">
                <article v-for="record in selectedDeviceTranscripts" :key="record.id">
                  <div class="speech-device-transcript-meta">
                    <time>{{ transcriptTime(record) }}</time>
                    <v-chip size="x-small" color="info" variant="tonal">{{ transcriptSpeaker(record) }}</v-chip>
                    <span>{{ record.provider || "ASR" }}/{{ record.model || "默认模型" }}</span>
                    <span>{{ deliverySummary(record.id) }}</span>
                  </div>
                  <p>{{ record.text }}</p>
                  <audio
                    v-if="retainedAudioAvailable(record.id)"
                    controls
                    preload="none"
                    :src="`/api/speech/records/${encodeURIComponent(record.id)}/audio`"
                  />
                  <small v-else>
                    {{ retainedAudio(record.id)?.audioExpiresAt ? "这条原声缓存已过期或不可用。" : "旧记录没有短期原声缓存；新转写会保留 24 小时。" }}
                  </small>
                </article>
                <v-btn
                  v-if="audioTranscriptsHaveMore"
                  size="small"
                  variant="text"
                  prepend-icon="mdi-history"
                  :loading="audioHistoryLoading"
                  @click="loadAudioHistory({ earlierTranscripts: true })"
                >
                  加载更早的公共转写
                </v-btn>
              </div>
              <div v-else class="speech-audio-log-empty">
                <v-icon>mdi-waveform</v-icon>
                <span>当前稳定设备还没有有效公共转写；收到 PCM 不代表已经越过 VAD/ASR 阈值。</span>
              </div>
              <details v-if="unlinkedRabiTranscripts.length" class="speech-unlinked-transcripts">
                <summary>另有 {{ unlinkedRabiTranscripts.length }} 条旧设备或其他 RabiLink 设备转写</summary>
                <div v-for="record in unlinkedRabiTranscripts" :key="record.id">
                  <time>{{ transcriptTime(record) }}</time>
                  <span>{{ record.sourceDeviceName || record.sourceDeviceId || "旧 RabiLink 设备" }}</span>
                  <p>{{ record.text }}</p>
                </div>
              </details>
            </div>
          </div>
        </v-expand-transition>
      </div>
    </v-card>

    </template>

    <template v-if="serviceEnabled">
    <TrustedWebRendererHost :renderers="speechStatusRenderers" :context="speechStatusContext" />
    <SpeechHostMonitor :subscriber-count="speechSubscriberRoutes.length" />
    <SpeechRecordsAndSpeakers />
    </template>

    <v-card v-if="playback" class="app-card glass-card playback-card">
      <div class="playback-card-head">
        <div class="playback-card-summary">
          <strong>全局播放队列</strong>
          <span>{{ playbackBusy ? "正在播放" : "空闲" }} · 等待 {{ playbackQueued }} 条 · 输出到 {{ selectedAudioStreamLabel }}</span>
        </div>
        <v-btn variant="tonal" color="error" prepend-icon="mdi-stop-circle-outline" :disabled="!playbackBusy && playbackQueued === 0" @click="stopPlayback">停止并清空</v-btn>
      </div>
      <SpeechParameterSlider
        :model-value="playbackVolume"
        label="主机播放音量"
        :min="0"
        :max="100"
        :step="1"
        suffix="%"
        hint="主机级设置；新值从下一条开始播放的音频生效。"
        @update:model-value="schedulePlaybackVolume"
      />
      <v-alert v-if="latestPlaybackFailure" class="mt-4" type="error" variant="tonal" role="alert">
        最近一次播放失败：{{ latestPlaybackFailure.error || '请检查音频设备连接和 RabiSpeech 日志。' }}
      </v-alert>
    </v-card>

    <template v-if="serviceEnabled">
    <v-card class="app-card glass-card speech-mode-tabs">
      <v-tabs v-model="activeKind" color="primary" grow class="speech-tabs" aria-label="切换 TTS 与 ASR">
        <v-tab value="tts" prepend-icon="mdi-account-voice">TTS 语音合成</v-tab>
        <v-tab value="asr" prepend-icon="mdi-waveform">ASR 语音识别</v-tab>
      </v-tabs>
    </v-card>
    <v-card class="app-card glass-card speech-workbench">
      <div class="speech-panel-head">
        <div>
          <div class="speech-eyebrow">{{ activeKind === "tts" ? "TEXT TO SPEECH" : "AUTOMATIC SPEECH RECOGNITION" }}</div>
          <h2>{{ activeKind === "tts" ? "当前 TTS 能力" : "当前 ASR 能力" }}</h2>
          <p>{{ activeKind === "tts" ? "RabiSpeech 直接在本机角色、声线与 worker 之间路由；不再依赖 OumuQ。" : "模型、加载设备和预热状态来自当前 RabiSpeech 进程，不再依赖 FenneNote。" }}</p>
        </div>
        <v-chip color="secondary" variant="tonal">默认：{{ currentDefault }}</v-chip>
      </div>

      <div v-if="providers.length === 0" class="speech-offline">
        <v-icon size="40" color="warning">mdi-puzzle-remove-outline</v-icon>
        <div><strong>没有启用 {{ activeKind.toUpperCase() }} provider</strong><span>页面只展示这台电脑实际注册的本地 provider。</span></div>
      </div>

      <div v-else class="speech-provider-grid">
        <article v-for="provider in providers" :key="provider.id" class="speech-provider-card">
          <div class="speech-provider-top">
            <div class="speech-provider-icon"><v-icon>{{ provider.kind === "tts" ? "mdi-account-voice" : "mdi-waveform" }}</v-icon></div>
            <div class="min-w-0">
              <h3>{{ providerName(provider) }}</h3>
              <div class="section-note">provider: {{ provider.id }}</div>
            </div>
            <v-chip size="small" :color="provider.enabled ? 'success' : 'grey'" :variant="provider.enabled ? 'tonal' : 'outlined'">{{ provider.enabled ? "已启用" : "已关闭" }}</v-chip>
          </div>
          <dl class="speech-facts">
            <div><dt>当前模型</dt><dd>{{ providerModel(provider) }}</dd></div>
            <div><dt>运行设备</dt><dd>{{ deviceLabel(provider) }}</dd></div>
            <div v-if="provider.kind === 'asr'"><dt>模型状态</dt><dd>{{ provider.loaded ? "已加载" : "尚未加载" }} · {{ provider.preload ? "启动时预热" : "按需加载" }}</dd></div>
            <div v-if="provider.kind === 'tts'"><dt>声线选择</dt><dd>{{ provider.voiceBinding || "由 provider 决定" }}</dd></div>
            <div><dt>本地约束</dt><dd>{{ provider.localFilesOnly === false ? "允许非本地模型" : "本地模型 / 本机 worker" }}</dd></div>
          </dl>
          <div class="speech-formats">
            <span v-for="format in provider.formats" :key="format">{{ format }}</span>
          </div>
          <v-alert v-if="provider.warmupError" type="warning" variant="tonal" density="compact" class="mt-4">预热异常：{{ provider.warmupError }}</v-alert>
        </article>
      </div>

      <div class="speech-api-strip">
        <div>
          <span>本机 API</span>
          <code>{{ activeKind === "tts" ? "POST /v1/audio/speech" : "POST /v1/audio/transcriptions" }}</code>
        </div>
        <div>
          <span>本地兼容协议（不调用云）</span>
          <code>{{ activeKind === "tts" ? "POST /api/v1/services/audio/tts/SpeechSynthesizer" : "POST /api/v1/services/audio/asr/transcription" }}</code>
        </div>
        <div>
          <span>能力来源</span>
          <code>GET /api/speech/status</code>
        </div>
      </div>
    </v-card>

    <div class="speech-footnote">
      <v-icon size="18">mdi-information-outline</v-icon>
      <span>性能报告仅代表报告中标明的目标测试机、当次模型与测试条件；你自己的实际性能应以本页所在电脑重新运行同一套基准后的结果为准。最后检查：{{ checkedAtLabel(status?.checkedAt) }}。</span>
    </div>
    </template>
  </section>
</template>

<style scoped>
.speech-page { max-width: 1540px; }
.speech-page :deep(.v-list-item-subtitle) { color: var(--rr-muted-soft) !important; opacity: 1 !important; }
.speech-eyebrow { color: var(--rr-accent-text); font-size: 11px; font-weight: 900; letter-spacing: .13em; }
.speech-mode-tabs { margin-bottom: 18px; padding: 0 24px; border: 1px solid var(--rr-accent-border); }
.speech-audio-stream-card { display: grid; grid-template-columns: minmax(0, 1fr) minmax(320px, 520px); gap: 24px; align-items: center; margin-bottom: 18px; padding: 18px 22px; }
.speech-audio-stream-copy { display: flex; gap: 14px; align-items: center; min-width: 0; }
.speech-audio-stream-copy strong { display: block; margin-top: 3px; color: var(--rr-heading); font-size: 17px; }
.speech-audio-stream-copy p { margin: 4px 0 0; color: var(--rr-muted); font-size: 12px; line-height: 1.55; }
.speech-audio-stream-icon { display: grid; flex: 0 0 44px; width: 44px; height: 44px; place-items: center; border-radius: 13px; color: var(--rr-accent-text); background: var(--rr-accent-surface); }
.speech-audio-stream-controls { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 10px; align-items: center; }
.speech-audio-stream-log { display: grid; grid-column: 1 / -1; gap: 10px; padding-top: 14px; border-top: 1px solid var(--rr-border); }
.speech-audio-log-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 18px; }
.speech-audio-log-copy { display: grid; gap: 3px; min-width: 0; }
.speech-audio-log-actions { display: flex; flex: 0 0 auto; flex-wrap: wrap; align-items: center; justify-content: flex-end; gap: 6px; }
.speech-audio-log-head strong { color: var(--rr-heading); font-size: 13px; }
.speech-audio-log-head span { color: var(--rr-muted); font-size: 12px; overflow-wrap: anywhere; }
.speech-audio-log-panel { display: grid; gap: 10px; }
.speech-audio-log-rows { display: grid; overflow: auto; max-height: 520px; border: 1px solid var(--rr-border); border-radius: 12px; background: var(--rr-subtle); }
.speech-audio-log-row { display: grid; grid-template-columns: 72px 76px minmax(180px, 1fr) minmax(140px, auto); gap: 10px; align-items: center; min-height: 38px; padding: 7px 11px; border-bottom: 1px solid var(--rr-border); }
.speech-audio-log-row:last-child { border-bottom: 0; }
.speech-audio-log-row time { color: var(--rr-muted-faint); font-variant-numeric: tabular-nums; font-size: 11px; }
.speech-audio-log-row > span { min-width: 0; color: var(--rr-text); font-size: 12px; overflow-wrap: anywhere; }
.speech-audio-log-row code { color: var(--rr-muted); font-size: 11px; text-align: right; white-space: normal; }
.speech-audio-log-empty { display: flex; align-items: center; gap: 9px; min-height: 46px; padding: 10px 12px; border: 1px dashed var(--rr-border-strong); border-radius: 12px; color: var(--rr-muted-faint); font-size: 12px; }
.speech-pipeline-summary { display: flex; flex-wrap: wrap; gap: 8px; }
.speech-pipeline-summary span { padding: 6px 9px; border-radius: 999px; color: var(--rr-muted); background: var(--rr-accent-surface); font-size: 11px; }
.speech-pipeline-summary b { color: var(--rr-accent-text); font-size: 13px; }
.speech-device-transcripts { display: grid; gap: 10px; margin-top: 8px; padding-top: 16px; border-top: 1px solid var(--rr-border); }
.speech-device-transcript-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; }
.speech-device-transcript-head > div { display: grid; gap: 3px; }
.speech-device-transcript-head strong { color: var(--rr-heading); font-size: 13px; }
.speech-device-transcript-head span { color: var(--rr-muted); font-size: 12px; }
.speech-device-transcript-list { display: grid; gap: 9px; }
.speech-device-transcript-list article { display: grid; gap: 7px; padding: 12px 14px; border: 1px solid var(--rr-border); border-radius: 12px; background: var(--rr-subtle); }
.speech-device-transcript-list p { margin: 0; color: var(--rr-text); font-size: 13px; line-height: 1.65; white-space: pre-wrap; }
.speech-device-transcript-list audio { width: min(100%, 520px); height: 34px; }
.speech-device-transcript-list small { color: var(--rr-muted-faint); }
.speech-device-transcript-meta { display: flex; flex-wrap: wrap; gap: 7px 10px; align-items: center; color: var(--rr-muted); font-size: 11px; }
.speech-unlinked-transcripts { color: var(--rr-muted); font-size: 12px; }
.speech-unlinked-transcripts summary { cursor: pointer; font-weight: 800; }
.speech-unlinked-transcripts > div { display: grid; grid-template-columns: auto minmax(120px, 220px) minmax(0, 1fr); gap: 10px; padding: 8px 0; border-bottom: 1px solid var(--rr-border); }
.speech-unlinked-transcripts p { margin: 0; color: var(--rr-text); }
.playback-card { display: grid; gap: 14px; margin-bottom: 18px; padding: 18px 22px; }
.playback-card-head { display: flex; align-items: center; justify-content: space-between; gap: 18px; }
.playback-card-summary { display: flex; gap: 14px; align-items: baseline; }
.playback-card span { color: var(--rr-muted); font-size: 13px; }
.speech-workbench { overflow: hidden; padding: 0; }
.speech-tabs { max-width: 620px; }
.speech-panel-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 24px; padding: 32px 32px 22px; }
.speech-panel-head h2 { margin: 7px 0 8px; color: var(--rr-heading); font-size: 28px; }
.speech-panel-head p { max-width: 760px; margin: 0; color: var(--rr-muted); font-size: 14px; line-height: 1.7; }
.speech-provider-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 390px), 1fr)); gap: 18px; padding: 0 32px 30px; }
.speech-provider-card { padding: 24px; border: 1px solid var(--rr-border); border-radius: 18px; background: var(--rr-subtle); }
.speech-provider-top { display: grid; grid-template-columns: 44px minmax(0, 1fr) auto; gap: 13px; align-items: center; }
.speech-provider-icon { display: grid; width: 44px; height: 44px; place-items: center; border-radius: 13px; color: var(--rr-accent-text); background: var(--rr-accent-surface); }
.speech-provider-top h3 { margin: 0; color: var(--rr-heading); font-size: 17px; }
.speech-facts { display: grid; gap: 0; margin: 22px 0 18px; }
.speech-facts > div { display: grid; grid-template-columns: 96px minmax(0, 1fr); gap: 16px; padding: 11px 0; border-top: 1px solid var(--rr-border); }
.speech-facts dt { color: var(--rr-muted-faint); font-size: 12px; font-weight: 800; }
.speech-facts dd { margin: 0; color: var(--rr-text); font-size: 13px; font-weight: 750; text-align: right; overflow-wrap: anywhere; }
.speech-formats { display: flex; flex-wrap: wrap; gap: 7px; }
.speech-formats span { padding: 5px 9px; border-radius: 999px; color: var(--rr-text); background: var(--rr-subtle); font-size: 11px; font-weight: 800; text-transform: uppercase; }
.speech-offline { display: flex; align-items: center; gap: 18px; margin: 0 32px 30px; padding: 28px; border: 1px dashed var(--rr-warning-border); border-radius: 18px; background: var(--rr-warning-surface); }
.speech-offline div { display: grid; gap: 5px; min-width: 0; }
.speech-offline strong { color: var(--rr-heading); }
.speech-offline span { color: var(--rr-muted); font-size: 13px; }
.speech-offline code, .speech-api-strip code { overflow-wrap: anywhere; color: var(--rr-accent-text); font-size: 12px; }
.speech-api-strip { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); border-top: 1px solid var(--rr-border); background: var(--rr-subtle); }
.speech-api-strip > div { display: grid; gap: 7px; min-width: 0; padding: 20px 24px; border-right: 1px solid var(--rr-border); }
.speech-api-strip > div:last-child { border-right: 0; }
.speech-api-strip span { color: var(--rr-muted-faint); font-size: 11px; font-weight: 900; letter-spacing: .06em; text-transform: uppercase; }
.speech-footnote { display: flex; align-items: flex-start; gap: 9px; margin: 18px 4px 0; color: var(--rr-muted); font-size: 12px; line-height: 1.6; }
@media (max-width: 1100px) {
  .speech-api-strip { grid-template-columns: 1fr; }
  .speech-api-strip > div { border-right: 0; border-bottom: 1px solid var(--rr-border); }
}
@media (max-width: 700px) {
  .speech-page-header, .speech-panel-head, .speech-audio-log-head, .speech-device-transcript-head, .playback-card-head, .playback-card-summary { align-items: stretch; flex-direction: column; }
  .speech-audio-stream-card, .speech-audio-stream-controls, .speech-audio-log-row, .speech-unlinked-transcripts > div { grid-template-columns: 1fr; }
  .speech-audio-log-row code { text-align: left; }
  .speech-panel-head, .speech-provider-grid { padding-right: 18px; padding-left: 18px; }
  .speech-mode-tabs { padding: 0 8px; }
  .speech-tabs :deep(.v-btn__content) { font-size: 12px; }
  .speech-offline { margin-right: 18px; margin-left: 18px; }
  .speech-api-strip > div { padding: 17px 18px; }
}
</style>
