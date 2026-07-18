<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import { storeToRefs } from "pinia";
import { resolveSpeechRouteProfile, type SpeechEvent, type SpeechMicrophoneStats } from "@shared/speechControlContract";
import { useSpeechStore } from "../stores/speechStore";
import SpeechLevelWaveform from "./SpeechLevelWaveform.vue";

const props = defineProps<{
  routeId: string;
  routeName?: string;
  routeRunning?: boolean;
  routeVariables?: Record<string, string>;
}>();

const speech = useSpeechStore();
const { microphone: status, playback } = storeToRefs(speech);
const playbackJobs = computed(() => playback.value?.jobs ?? []);
const refreshing = ref(false);
const actionBusy = ref(false);
const localError = ref("");
const error = computed(() => localError.value || speech.error);
const showLog = ref(true);

const variables = computed(() => props.routeVariables ?? {});
const profile = computed(() => resolveSpeechRouteProfile(variables.value, props.routeId || "Rabi"));
const stats = computed<SpeechMicrophoneStats>(() => status.value?.stats ?? {
  captured: 0,
  recognized: 0,
  empty: 0,
  submitted: 0,
  submitFailed: 0,
  dropped: 0
});
const events = computed(() => status.value?.events ?? []);
const history = computed(() => status.value?.history ?? []);
const activeRouteId = computed(() => status.value?.config.routeId || "");
const routeMatches = computed(() => activeRouteId.value === props.routeId);
const autoSubmitActive = computed(() => status.value?.config.autoSubmit === true && routeMatches.value);
const latestRouteEvent = computed(() => events.value.find(item => item.stage === "route"));
const latestPlayback = computed(() => playbackJobs.value
  .filter(item => item.routeId === props.routeId)
  .sort((left, right) => Number(right.updatedAt || 0) - Number(left.updatedAt || 0))[0]);
type PipelineState = "idle" | "ready" | "active" | "success" | "warning" | "error";
type PipelineStage = { key: string; label: string; detail: string; state: PipelineState; icon: string };

const pipelineStages = computed<PipelineStage[]>(() => {
  const current = status.value;
  const routeEvent = latestRouteEvent.value;
  const playback = latestPlayback.value;
  const microphoneState: PipelineState = current?.state === "error" ? "error" : current?.running ? "success" : "idle";
  const vadState: PipelineState = current?.utteranceActive ? "active" : Number(stats.value.captured || 0) > 0 ? "success" : current?.running ? "ready" : "idle";
  const asrState: PipelineState = current?.state === "transcribing" ? "active" : events.value[0]?.kind === "transcription_failed" ? "error" : Number(stats.value.recognized || 0) > 0 ? "success" : current?.running ? "ready" : "idle";
  let routeState: PipelineState = props.routeRunning === false ? "warning" : "ready";
  if (!current?.running || !routeMatches.value || !autoSubmitActive.value) routeState = "warning";
  if (routeEvent?.kind === "route_submission_failed") routeState = "error";
  else if (routeEvent?.kind === "route_submission_started") routeState = "active";
  else if (Number(stats.value.submitted || 0) > 0 && routeMatches.value) routeState = "success";
  let playbackState: PipelineState = "idle";
  if (playback?.status === "playing" || playback?.status === "queued") playbackState = "active";
  else if (playback?.status === "done") playbackState = "success";
  else if (playback?.status === "error") playbackState = "error";

  return [
    {
      key: "microphone",
      label: "麦克风",
      detail: current?.running ? current.state === "playback_suppressed" ? "播放防回流" : "常驻监听中" : "未启动",
      state: microphoneState,
      icon: "mdi-microphone-outline"
    },
    {
      key: "vad",
      label: "VAD 切句",
      detail: current?.utteranceActive ? "正在收音" : `已捕获 ${Number(stats.value.captured || 0)} 段`,
      state: vadState,
      icon: "mdi-waveform"
    },
    {
      key: "asr",
      label: "本地 ASR",
      detail: current?.state === "transcribing" ? "正在识别" : `已识别 ${Number(stats.value.recognized || 0)} 段`,
      state: asrState,
      icon: "mdi-text-box-search-outline"
    },
    {
      key: "route",
      label: "Route 投递",
      detail: !routeMatches.value ? "未绑定当前 Route" : !autoSubmitActive.value ? "自动投递未启用" : routeEvent?.message || "等待语音消息",
      state: routeState,
      icon: "mdi-transit-connection-variant"
    },
    {
      key: "playback",
      label: "回复与播放",
      detail: playback ? playback.status === "playing" ? "正在播放" : playback.status === "queued" ? "等待播放" : playback.status === "done" ? "最近播放完成" : playback.status === "error" ? "播放失败" : playback.status : "尚无回复音频",
      state: playbackState,
      icon: "mdi-account-voice"
    }
  ];
});

function stageClass(state: PipelineState): string {
  return `is-${state}`;
}

function stageLabel(state: PipelineState): string {
  return ({
    idle: "未运行",
    ready: "等待",
    active: "处理中",
    success: "正常",
    warning: "需检查",
    error: "异常"
  } as Record<PipelineState, string>)[state];
}

function eventIcon(event: SpeechEvent): string {
  if (event.level === "error") return "mdi-alert-circle-outline";
  if (event.stage === "route") return "mdi-transit-connection-variant";
  if (event.stage === "asr") return "mdi-text-box-search-outline";
  if (event.stage === "vad") return "mdi-waveform";
  return "mdi-microphone-outline";
}

function formatTime(timestamp: number | undefined): string {
  if (!timestamp) return "-";
  return new Date(timestamp * 1000).toLocaleTimeString("zh-CN", { hour12: false });
}

function eventDetail(event: SpeechEvent): string {
  const details = event.details;
  const parts: string[] = [];
  if (details.duration != null) parts.push(`${Number(details.duration).toFixed(2)} 秒`);
  if (details.model) parts.push(String(details.model));
  if (details.routeId) parts.push(`Route: ${details.routeId}`);
  if (details.error) parts.push(String(details.error));
  return parts.join(" · ");
}

async function refresh(): Promise<void> {
  if (refreshing.value) return;
  refreshing.value = true;
  try {
    const [microphoneResponse, playbackResponse] = await Promise.all([
      speech.refreshMicrophone(),
      speech.refreshPlayback()
    ]);
    void microphoneResponse;
    void playbackResponse;
    localError.value = "";
  } catch (cause) {
    localError.value = cause instanceof Error ? cause.message : String(cause);
  } finally {
    refreshing.value = false;
  }
}

async function stopListening(): Promise<void> {
  actionBusy.value = true;
  try {
    await speech.stopMicrophone();
  } catch (cause) {
    localError.value = cause instanceof Error ? cause.message : String(cause);
  } finally {
    actionBusy.value = false;
  }
}

async function startListening(): Promise<void> {
  if (!props.routeId) return;
  actionBusy.value = true;
  try {
    if (status.value?.running) {
      await speech.stopMicrophone();
    }
    const previous = status.value?.config;
    await speech.startMicrophone({
      device: previous?.device ?? null,
      sampleRate: previous?.sampleRate ?? 16_000,
      chunkMs: previous?.chunkMs ?? 100,
      preRollMs: profile.value.preRollMs,
      recordThreshold: profile.value.recordThreshold,
      transcribeThreshold: profile.value.transcribeThreshold,
      adaptiveThreshold: profile.value.adaptiveThreshold,
      adaptiveMultiplier: previous?.adaptiveMultiplier ?? 2.5,
      adaptiveMargin: previous?.adaptiveMargin ?? 0.004,
      silenceMs: profile.value.silenceMs,
      minUtteranceMs: profile.value.minUtteranceMs,
      maxUtteranceMs: profile.value.maxUtteranceMs,
      inputGain: profile.value.inputGain,
      asrModel: profile.value.asrModel,
      language: profile.value.language || null,
      prompt: previous?.prompt ?? null,
      routeId: props.routeId,
      sessionId: routeMatches.value && previous?.sessionId ? previous.sessionId : `speech-${props.routeId}`,
      autoSubmit: profile.value.autoSubmit,
      suppressDuringPlayback: true
    });
  } catch (cause) {
    localError.value = cause instanceof Error ? cause.message : String(cause);
  } finally {
    actionBusy.value = false;
  }
}

let releaseSpeech: (() => void) | undefined;
onMounted(async () => {
  releaseSpeech = await speech.acquire();
});
onBeforeUnmount(() => releaseSpeech?.());
</script>

<template>
  <section class="speech-route-monitor" aria-label="语音 Route 实时监视器">
    <header class="monitor-toolbar">
      <div>
        <div class="monitor-kicker">FENNE-STYLE LIVE ROUTE</div>
        <h4>{{ routeName || routeId }} · 语音链路</h4>
        <p>消息端总开关只启用配置；麦克风是否真正监听，以这里的运行状态为准。</p>
      </div>
      <div class="monitor-actions">
        <v-chip :color="status?.running ? routeMatches ? 'success' : 'warning' : 'grey'" variant="tonal">
          {{ status?.running ? routeMatches ? "当前 Route 监听中" : `其他 Route 监听中：${activeRouteId || '-'}` : "麦克风未启动" }}
        </v-chip>
        <v-btn size="small" variant="text" prepend-icon="mdi-refresh" :loading="refreshing" @click="refresh">刷新</v-btn>
        <v-btn
          v-if="!status?.running || !routeMatches"
          color="primary"
          prepend-icon="mdi-microphone"
          :loading="actionBusy"
          :disabled="!routeId"
          @click="startListening"
        >{{ status?.running ? "切换并启动此 Route" : "开始语音聊天" }}</v-btn>
        <v-btn v-else color="error" variant="tonal" prepend-icon="mdi-stop" :loading="actionBusy" @click="stopListening">停止监听</v-btn>
        <v-btn variant="tonal" prepend-icon="mdi-tune-variant" href="#/speech">详细控制台</v-btn>
      </div>
    </header>

    <v-alert v-if="error" type="error" variant="tonal" density="compact" class="mb-3">{{ error }}</v-alert>
    <v-alert v-else-if="!status?.running" type="warning" variant="tonal" density="compact" class="mb-3">
      当前只是“语音消息端配置已启用”，麦克风并未监听。点击“开始语音聊天”后，说话才会进入 VAD、ASR 和 Route。
    </v-alert>
    <v-alert v-else-if="!routeMatches || !autoSubmitActive" type="warning" variant="tonal" density="compact" class="mb-3">
      麦克风正在运行，但没有自动投递到当前 Route。点击“切换并启动此 Route”应用本页配置。
    </v-alert>

    <div class="pipeline-strip">
      <article v-for="stage in pipelineStages" :key="stage.key" class="pipeline-stage" :class="stageClass(stage.state)">
        <div class="pipeline-icon"><v-icon size="22">{{ stage.icon }}</v-icon></div>
        <div class="pipeline-copy"><strong>{{ stage.label }}</strong><span>{{ stage.detail }}</span></div>
        <em>{{ stageLabel(stage.state) }}</em>
      </article>
    </div>

    <div class="monitor-meter">
      <div class="meter-head">
        <span>实时电平 <b>{{ Number(status?.level || 0).toFixed(4) }}</b></span>
        <span>底噪 {{ Number(status?.noiseFloor || 0).toFixed(4) }}</span>
        <span>动态阈值 {{ Number(status?.dynamicThreshold || profile.recordThreshold).toFixed(4) }}</span>
      </div>
      <SpeechLevelWaveform
        :levels="status?.levelHistory || []"
        :record-threshold="profile.recordThreshold"
        :transcribe-threshold="profile.transcribeThreshold"
        :dynamic-threshold="Number(status?.dynamicThreshold || 0)"
        :running="status?.running"
        :state="status?.state"
      />
      <div class="meter-thresholds">
        <span>录音线 {{ profile.recordThreshold.toFixed(3) }}</span>
        <span>转写线 {{ profile.transcribeThreshold.toFixed(3) }}</span>
        <span>待识别 {{ status?.pending || 0 }}</span>
      </div>
    </div>

    <div class="monitor-counters">
      <div><span>捕获片段</span><b>{{ Number(stats.captured || 0) }}</b></div>
      <div><span>识别成功</span><b>{{ Number(stats.recognized || 0) }}</b></div>
      <div><span>Route 已受理</span><b>{{ Number(stats.submitted || 0) }}</b></div>
      <div :class="Number(stats.submitFailed || 0) ? 'counter-error' : ''"><span>投递失败</span><b>{{ Number(stats.submitFailed || 0) }}</b></div>
      <div :class="Number(stats.dropped || 0) ? 'counter-warning' : ''"><span>队列丢弃</span><b>{{ Number(stats.dropped || 0) }}</b></div>
    </div>

    <div class="log-toolbar">
      <div><strong>运行日志与转写预览</strong><span>来自 RabiSpeech 当前进程；不会因为刷新页面丢失。</span></div>
      <v-btn size="small" variant="text" :prepend-icon="showLog ? 'mdi-chevron-up' : 'mdi-chevron-down'" @click="showLog = !showLog">{{ showLog ? "收起日志" : "展开日志" }}</v-btn>
    </div>
    <div v-if="showLog" class="monitor-log-grid">
      <div class="monitor-log-panel">
        <div class="panel-title">最近事件</div>
        <div v-if="events.length" class="event-list">
          <div v-for="event in events.slice(0, 20)" :key="event.sequence" class="event-row" :class="`event-${event.level}`">
            <v-icon size="17">{{ eventIcon(event) }}</v-icon>
            <time>{{ formatTime(event.time) }}</time>
            <div><strong>{{ event.message }}</strong><span v-if="eventDetail(event)">{{ eventDetail(event) }}</span></div>
          </div>
        </div>
        <div v-else class="empty-log">暂无事件。点击“开始语音聊天”后，这里会逐步显示收音、识别和 Route 投递。</div>
      </div>
      <div class="monitor-log-panel">
        <div class="panel-title">最近转写</div>
        <div v-if="history.length" class="transcript-list">
          <div v-for="item in history.slice(0, 8)" :key="`${item.time}-${item.text}`">
            <div><time>{{ formatTime(item.time) }}</time><v-chip size="x-small" :color="item.submitError ? 'error' : item.submitted ? 'success' : 'grey'" variant="tonal">{{ item.submitError ? "投递失败" : item.submitted ? "已送入 Route" : "仅转写" }}</v-chip></div>
            <p>{{ item.text }}</p>
            <span>{{ item.provider }}/{{ item.model }} · {{ Number(item.duration || 0).toFixed(2) }} 秒</span>
          </div>
        </div>
        <div v-else class="empty-log">还没有转写结果。</div>
      </div>
    </div>
  </section>
</template>

<style scoped>
.speech-route-monitor { grid-column: 1 / -1; padding: 18px; border: 1px solid rgba(15, 139, 141, .24); border-radius: 16px; background: linear-gradient(145deg, rgba(244, 253, 253, .95), rgba(248, 251, 253, .9)); }
.monitor-toolbar { display: flex; align-items: flex-start; justify-content: space-between; gap: 20px; margin-bottom: 14px; }
.monitor-kicker { color: #0f8b8d; font-size: 10px; font-weight: 900; letter-spacing: .13em; }
.monitor-toolbar h4 { margin: 4px 0; color: #0c2a4a; font-size: 18px; }
.monitor-toolbar p { margin: 0; color: #607487; font-size: 12px; }
.monitor-actions { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 8px; }
.pipeline-strip { display: grid; grid-template-columns: repeat(5, minmax(0, 1fr)); gap: 8px; margin: 14px 0; }
.pipeline-stage { position: relative; display: grid; grid-template-columns: 36px minmax(0, 1fr); gap: 8px; align-items: center; min-height: 76px; padding: 11px; border: 1px solid rgba(17, 32, 51, .1); border-radius: 13px; background: rgba(255, 255, 255, .72); }
.pipeline-stage:not(:last-child)::after { position: absolute; z-index: 2; top: 50%; right: -9px; width: 10px; height: 2px; content: ""; background: rgba(15, 139, 141, .28); }
.pipeline-icon { display: grid; width: 34px; height: 34px; place-items: center; border-radius: 10px; color: #738394; background: rgba(17, 32, 51, .06); }
.pipeline-copy { display: grid; min-width: 0; gap: 2px; }
.pipeline-copy strong { color: #29445a; font-size: 12px; }
.pipeline-copy span { overflow: hidden; color: #718293; font-size: 10px; text-overflow: ellipsis; white-space: nowrap; }
.pipeline-stage em { grid-column: 1 / -1; color: #83909d; font-size: 10px; font-style: normal; font-weight: 800; text-align: right; }
.pipeline-stage.is-success { border-color: rgba(25, 145, 88, .28); background: rgba(236, 249, 242, .85); }
.pipeline-stage.is-success .pipeline-icon { color: #198f58; background: rgba(25, 145, 88, .1); }
.pipeline-stage.is-active { border-color: rgba(220, 147, 24, .36); background: rgba(255, 248, 230, .92); box-shadow: 0 0 0 2px rgba(220, 147, 24, .08); }
.pipeline-stage.is-active .pipeline-icon { color: #b8780d; background: rgba(220, 147, 24, .12); }
.pipeline-stage.is-warning { border-color: rgba(220, 147, 24, .3); background: rgba(255, 249, 235, .82); }
.pipeline-stage.is-error { border-color: rgba(201, 62, 68, .35); background: rgba(255, 240, 241, .86); }
.pipeline-stage.is-error .pipeline-icon { color: #c93e44; background: rgba(201, 62, 68, .1); }
.monitor-meter { padding: 13px 14px; border: 1px solid rgba(17, 32, 51, .08); border-radius: 13px; background: rgba(255, 255, 255, .66); }
.meter-head, .meter-thresholds { display: flex; flex-wrap: wrap; justify-content: space-between; gap: 8px 18px; color: #607487; font-size: 11px; }
.meter-head { margin-bottom: 8px; }
.meter-thresholds { margin-top: 7px; }
.monitor-counters { display: grid; grid-template-columns: repeat(5, minmax(0, 1fr)); gap: 8px; margin: 12px 0; }
.monitor-counters > div { display: flex; align-items: baseline; justify-content: space-between; padding: 9px 11px; border-radius: 10px; background: rgba(17, 32, 51, .045); }
.monitor-counters span { color: #718293; font-size: 10px; }
.monitor-counters b { color: #24435a; font-size: 16px; }
.monitor-counters .counter-error b { color: #c93e44; }
.monitor-counters .counter-warning b { color: #b8780d; }
.log-toolbar { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding-top: 12px; border-top: 1px solid rgba(17, 32, 51, .08); }
.log-toolbar > div { display: grid; gap: 2px; }
.log-toolbar strong { color: #29445a; font-size: 13px; }
.log-toolbar span { color: #7b8c9b; font-size: 10px; }
.monitor-log-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px; margin-top: 10px; }
.monitor-log-panel { min-width: 0; max-height: 310px; overflow: auto; padding: 12px; border: 1px solid rgba(17, 32, 51, .08); border-radius: 12px; background: rgba(255, 255, 255, .72); }
.panel-title { margin-bottom: 8px; color: #456177; font-size: 11px; font-weight: 900; }
.event-list, .transcript-list { display: grid; gap: 7px; }
.event-row { display: grid; grid-template-columns: 20px 62px minmax(0, 1fr); gap: 7px; align-items: start; padding: 7px; border-radius: 8px; color: #4f6679; background: rgba(17, 32, 51, .03); }
.event-row time, .transcript-list time { color: #81909e; font-size: 10px; }
.event-row > div { display: grid; min-width: 0; gap: 2px; }
.event-row strong { color: #385369; font-size: 11px; }
.event-row span { overflow-wrap: anywhere; color: #7b8c9b; font-size: 10px; }
.event-row.event-error { color: #c93e44; background: rgba(201, 62, 68, .07); }
.transcript-list > div { padding: 8px; border-radius: 8px; background: rgba(17, 32, 51, .03); }
.transcript-list > div > div { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.transcript-list p { margin: 6px 0 3px; color: #29445a; font-size: 12px; line-height: 1.5; }
.transcript-list > div > span { color: #81909e; font-size: 10px; }
.empty-log { padding: 18px 8px; color: #81909e; font-size: 11px; text-align: center; }
@media (max-width: 1100px) { .monitor-toolbar { align-items: stretch; flex-direction: column; } .monitor-actions { justify-content: flex-start; } .pipeline-strip { grid-template-columns: repeat(2, minmax(0, 1fr)); } .pipeline-stage::after { display: none; } }
@media (max-width: 720px) { .pipeline-strip, .monitor-counters, .monitor-log-grid { grid-template-columns: 1fr; } }
</style>
