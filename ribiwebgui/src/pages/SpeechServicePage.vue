<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { storeToRefs } from "pinia";
import {
  DEFAULT_SPEECH_ROUTE_PROFILE,
  type SpeechMicrophoneConfig,
  type SpeechProvider
} from "@shared/speechControlContract";
import SpeechParameterSlider from "../components/SpeechParameterSlider.vue";
import SpeechRecordsAndSpeakers from "../components/SpeechRecordsAndSpeakers.vue";
import SpeechHostMonitor from "../components/SpeechHostMonitor.vue";
import { useGatewayStore } from "../stores/gatewayStore";
import PersonaAvatar from "../components/PersonaAvatar.vue";
import { useSpeechStore } from "../stores/speechStore";
import { gatewayAdapterTypes } from "../utils/gatewayHelpers";

type AudioInput = { title: string; value: number; default?: boolean };

const store = useGatewayStore();
const speech = useSpeechStore();
const {
  status,
  models,
  personas,
  microphone: microphoneStatus,
  playback,
  audioStream,
  loading
} = storeToRefs(speech);
const activeKind = ref<"tts" | "asr">("tts");
const requestError = ref("");
const ttsModel = ref("");
const asrModel = ref("");
const voice = ref(DEFAULT_SPEECH_ROUTE_PROFILE.voice);
const ttsLanguage = ref(DEFAULT_SPEECH_ROUTE_PROFILE.language);
const asrLanguage = ref(DEFAULT_SPEECH_ROUTE_PROFILE.language);
const ttsText = ref("你好，我是由 RabiSpeech 语音服务驱动的声音。");
const instructions = ref("");
const speed = ref(1);
const queuePlayback = ref(true);
const ttsBusy = ref(false);
const asrBusy = ref(false);
const actionMessage = ref("");
const transcript = ref("");
const transcriptHistory = ref<Array<{ time: string; text: string; model: string }>>([]);
const listening = computed(() => microphoneStatus.value?.running === true);
const utteranceActive = computed(() => microphoneStatus.value?.utteranceActive === true);
const micLevel = computed(() => Number(microphoneStatus.value?.level || 0));
const threshold = ref(DEFAULT_SPEECH_ROUTE_PROFILE.recordThreshold);
const silenceMs = ref(DEFAULT_SPEECH_ROUTE_PROFILE.silenceMs);
const minUtteranceMs = ref(DEFAULT_SPEECH_ROUTE_PROFILE.minUtteranceMs);
const maxUtteranceMs = ref(DEFAULT_SPEECH_ROUTE_PROFILE.maxUtteranceMs);
const transcribeThreshold = ref(DEFAULT_SPEECH_ROUTE_PROFILE.transcribeThreshold);
const adaptiveThreshold = ref(DEFAULT_SPEECH_ROUTE_PROFILE.adaptiveThreshold);
const inputGain = ref(DEFAULT_SPEECH_ROUTE_PROFILE.inputGain);
const preRollMs = ref(DEFAULT_SPEECH_ROUTE_PROFILE.preRollMs);
const audioInputs = ref<AudioInput[]>([]);
const selectedAudioInput = ref<number | null>(null);
const microphoneConfigLoaded = ref(false);
const microphoneSettingsSaving = ref(false);
const playbackBusy = computed(() => Boolean(playback.value?.current));
const playbackQueued = computed(() => Number(playback.value?.queued || 0));
const playbackVolume = ref(100);
const playbackVolumeSaving = ref(false);
const audioStreamSaving = ref(false);
let playbackVolumeTimer = 0;
let pendingPlaybackVolume: number | null = null;
let microphoneSettingsTimer = 0;
let microphoneSettingsPending = false;

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
const ttsModels = computed(() => models.value.filter(item => item.capability === "tts"));
const asrModels = computed(() => models.value.filter(item => item.capability === "asr"));
const personaOptions = computed(() => personas.value.map(item => ({
  title: item.voiceReady ? `${item.id} · 已配置声线` : `${item.id} · 使用模型默认声线`,
  value: item.id,
  avatarUrl: item.avatarUrl || ""
})));
const selectedPersona = computed(() => personas.value.find(item => item.id === voice.value));
const speechSubscriberRoutes = computed(() => store.gateways
  .filter(gateway => gateway.enabled !== false && gatewayAdapterTypes(gateway).includes("speech")));
const micPercent = computed(() => Math.min(100, Math.round((micLevel.value / Math.max(threshold.value, 0.001)) * 50)));
const selectedAudioStream = computed(() => audioStream.value?.source === "remote" && audioStream.value.selectedClientId
  ? `remote:${audioStream.value.selectedClientId}`
  : "local");
const audioStreamOptions = computed(() => [
  { title: `本机 · ${computerName.value}`, value: "local", subtitle: "使用当前电脑的麦克风和扬声器" },
  ...(audioStream.value?.clients || []).map(client => ({
    title: `${client.name} · 远程 Rabi 语音客户端`,
    value: `remote:${client.id}`,
    subtitle: client.online ? `在线 · ${client.sampleRate} Hz` : "离线"
  }))
]);
const selectedAudioStreamLabel = computed(() => audioStreamOptions.value.find(item => item.value === selectedAudioStream.value)?.title || "本机");

function providerName(provider: SpeechProvider): string {
  if (provider.id === "local-tts") return "RabiSpeech 本地 TTS 路由";
  if (provider.id === "faster-whisper") return "faster-whisper";
  return provider.id;
}

function providerModel(provider: SpeechProvider): string {
  if (provider.model) return provider.model;
  if (provider.kind === "tts" && provider.id === "local-tts") return "按人格与本地 worker 动态选择";
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
  requestError.value = "";
  try {
    await speech.refreshStatus();
  } catch (error) {
    requestError.value = error instanceof Error ? error.message : String(error);
  }
}

async function refreshModels(): Promise<void> {
  await speech.refreshModels();
  if (!ttsModels.value.some(item => item.id === ttsModel.value)) {
    ttsModel.value = ttsModels.value.find(item => item.available && item.id.endsWith("/gpt-sovits"))?.id
      || ttsModels.value.find(item => item.available)?.id
      || ttsModels.value[0]?.id
      || "tts-local";
  }
  if (!asrModels.value.some(item => item.id === asrModel.value)) {
    asrModel.value = asrModels.value.find(item => item.available && item.id.endsWith("/paraformer-v2"))?.id
      || asrModels.value.find(item => item.available && item.id.includes("faster-whisper/small"))?.id
      || asrModels.value.find(item => item.available)?.id
      || asrModels.value[0]?.id
      || "asr-local";
  }
}

async function refreshPersonas(): Promise<void> {
  await speech.refreshPersonas();
  if (!personas.value.some(item => item.id === voice.value) && personas.value[0]) voice.value = personas.value[0].id;
}

async function refreshPlayback(): Promise<void> {
  try {
    await speech.refreshPlayback();
  } catch {
    // Polling failures are surfaced by the shared speech store.
  }
}

async function synthesize(): Promise<void> {
  if (!ttsText.value.trim() || ttsBusy.value) return;
  ttsBusy.value = true;
  requestError.value = "";
  actionMessage.value = "首次调用可能需要加载模型，请稍候。";
  try {
    const result = await speech.synthesize({
      model: ttsModel.value,
      input: ttsText.value,
      voice: voice.value || "default",
      responseFormat: "wav",
      speed: speed.value,
      language: ttsLanguage.value || null,
      instructions: instructions.value || null,
      sampleRate: null,
      play: queuePlayback.value,
      sessionId: null,
      routeId: null
    });
    if (queuePlayback.value) {
      actionMessage.value = result.playbackJob ? `已进入全局播放队列：${result.playbackJob}` : "已完成合成并提交播放。";
    } else {
      if (!result.audio) throw new Error("TTS 没有返回可播放音频。");
      const audioUrl = URL.createObjectURL(result.audio);
      const audio = new Audio(audioUrl);
      audio.addEventListener("ended", () => URL.revokeObjectURL(audioUrl), { once: true });
      await audio.play();
      actionMessage.value = "正在当前浏览器试听（未进入主机队列）。";
    }
  } catch (error) {
    requestError.value = error instanceof Error ? error.message : String(error);
    actionMessage.value = "";
  } finally {
    ttsBusy.value = false;
  }
}

async function transcribeBlob(blob: Blob, name = "speech.wav"): Promise<void> {
  if (!asrModel.value) throw new Error("没有可用 ASR 模型。");
  asrBusy.value = true;
  requestError.value = "";
  actionMessage.value = "正在使用所选 ASR 模型识别……";
  try {
    const result = await speech.transcribe(
      blob,
      name,
      asrModel.value,
      asrLanguage.value || undefined,
      undefined,
      undefined
    );
    transcript.value = String(result.text || "").trim();
    if (!transcript.value) throw new Error("ASR 没有返回可用文本。");
    transcriptHistory.value.unshift({ time: new Date().toLocaleTimeString(), text: transcript.value, model: asrModel.value });
    transcriptHistory.value = transcriptHistory.value.slice(0, 20);
    actionMessage.value = "本机 ASR 识别完成。";
  } finally {
    asrBusy.value = false;
  }
}

async function onAudioFile(event: Event): Promise<void> {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  if (!file) return;
  try {
    await transcribeBlob(file, file.name);
  } catch (error) {
    requestError.value = error instanceof Error ? error.message : String(error);
  } finally {
    input.value = "";
  }
}

async function refreshAudioInputs(): Promise<void> {
  await speech.refreshAudioInputs();
  audioInputs.value = speech.audioInputs.map(device => ({
    title: `${device.name || `麦克风 ${device.index}`}${device.isDefault ? " · 系统默认" : ""}`,
    value: device.index,
    default: device.isDefault
  }));
  if (!audioInputs.value.some(item => item.value === selectedAudioInput.value)) {
    selectedAudioInput.value = audioInputs.value.find(item => item.default)?.value ?? audioInputs.value[0]?.value ?? null;
  }
}

function applyMicrophoneConfig(config: SpeechMicrophoneConfig): void {
  if (typeof config.device === "number") selectedAudioInput.value = config.device;
  if (config.asrModel) asrModel.value = config.asrModel;
  if (typeof config.language === "string") asrLanguage.value = config.language;
  threshold.value = config.recordThreshold;
  transcribeThreshold.value = config.transcribeThreshold;
  adaptiveThreshold.value = config.adaptiveThreshold;
  silenceMs.value = config.silenceMs;
  minUtteranceMs.value = config.minUtteranceMs;
  maxUtteranceMs.value = config.maxUtteranceMs;
  preRollMs.value = config.preRollMs;
  inputGain.value = config.inputGain;
}

async function refreshMicrophone(): Promise<void> {
  try {
    await speech.refreshMicrophone();
    const next = microphoneStatus.value;
    if (!next) return;
    if (!microphoneConfigLoaded.value || next.running) {
      applyMicrophoneConfig(next.config);
      microphoneConfigLoaded.value = true;
    }
    transcriptHistory.value = (next.history || []).slice(0, 20).map(item => ({
      time: new Date(item.time * 1000).toLocaleTimeString(),
      text: item.text,
      model: `${item.provider}/${item.model}`
    }));
    if (next.history?.[0]?.text && transcript.value !== next.history[0].text) transcript.value = next.history[0].text;
  } catch (error) {
    if (listening.value) requestError.value = error instanceof Error ? error.message : String(error);
  }
}

function microphoneSettingsCommand() {
  const previous = microphoneStatus.value?.config;
  return {
    device: selectedAudioInput.value,
    sampleRate: previous?.sampleRate ?? 16_000,
    chunkMs: previous?.chunkMs ?? 100,
    preRollMs: preRollMs.value,
    recordThreshold: threshold.value,
    transcribeThreshold: Math.max(threshold.value, transcribeThreshold.value),
    adaptiveThreshold: adaptiveThreshold.value,
    adaptiveMultiplier: previous?.adaptiveMultiplier ?? 2.5,
    adaptiveMargin: previous?.adaptiveMargin ?? 0.004,
    silenceMs: silenceMs.value,
    minUtteranceMs: minUtteranceMs.value,
    maxUtteranceMs: maxUtteranceMs.value,
    inputGain: inputGain.value,
    asrModel: asrModel.value,
    language: asrLanguage.value || null,
    prompt: previous?.prompt ?? null,
    suppressDuringPlayback: true
  };
}

async function flushMicrophoneSettings(): Promise<void> {
  if (!microphoneConfigLoaded.value || microphoneSettingsSaving.value || !microphoneSettingsPending) return;
  microphoneSettingsPending = false;
  microphoneSettingsSaving.value = true;
  try {
    await speech.updateMicrophoneSettings(microphoneSettingsCommand());
    requestError.value = "";
    actionMessage.value = listening.value
      ? "主机语音设置已保存，常驻监听已按新参数恢复。"
      : "主机语音设置已保存；开启任意 Route 的语音消息端后会自动开始监听。";
  } catch (error) {
    requestError.value = error instanceof Error ? error.message : String(error);
  } finally {
    microphoneSettingsSaving.value = false;
    if (microphoneSettingsPending) void flushMicrophoneSettings();
  }
}

async function chooseAudioStream(value: string | null): Promise<void> {
  if (!value || audioStreamSaving.value || value === selectedAudioStream.value) return;
  audioStreamSaving.value = true;
  requestError.value = "";
  try {
    if (value === "local") {
      await speech.selectAudioStream({ source: "local" });
    } else {
      await speech.selectAudioStream({ source: "remote", clientId: value.slice("remote:".length) });
    }
    actionMessage.value = value === "local"
      ? "音频流已切换到本机麦克风和扬声器。"
      : "音频流已切换到远程 Rabi 语音客户端；VAD、ASR、Route 广播和 TTS 队列仍由本机控制。";
  } catch (error) {
    requestError.value = error instanceof Error ? error.message : String(error);
  } finally {
    audioStreamSaving.value = false;
  }
}

async function copyAudioStreamToken(): Promise<void> {
  requestError.value = "";
  try {
    const token = await speech.audioStreamToken();
    await navigator.clipboard.writeText(token);
    actionMessage.value = "客户端连接密钥已复制；只粘贴到会议室电脑的私有 config.json。";
  } catch (error) {
    requestError.value = error instanceof Error ? error.message : String(error);
  }
}

function scheduleMicrophoneSettingsSave(): void {
  if (!microphoneConfigLoaded.value) return;
  microphoneSettingsPending = true;
  window.clearTimeout(microphoneSettingsTimer);
  microphoneSettingsTimer = window.setTimeout(() => {
    microphoneSettingsTimer = 0;
    void flushMicrophoneSettings();
  }, 500);
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
    requestError.value = "";
  } catch (error) {
    requestError.value = error instanceof Error ? error.message : String(error);
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
watch(selectedPersona, persona => {
  if (!persona) return;
  if (persona.defaultModel) ttsModel.value = persona.defaultModel;
  if (persona.language) ttsLanguage.value = persona.language;
  instructions.value = persona.instructions || persona.voiceStyleSummary || "";
  speed.value = persona.speed ?? 1;
});
watch([
  asrModel,
  asrLanguage,
  selectedAudioInput,
  threshold,
  transcribeThreshold,
  adaptiveThreshold,
  silenceMs,
  minUtteranceMs,
  maxUtteranceMs,
  preRollMs,
  inputGain
], scheduleMicrophoneSettingsSave);

let releaseSpeech: (() => void) | undefined;
onMounted(async () => {
  releaseSpeech = await speech.acquire();
  await Promise.all([refreshModels(), refreshPersonas(), refreshAudioInputs(), refreshMicrophone()]).catch(error => {
    requestError.value = error instanceof Error ? error.message : String(error);
  });
});
onBeforeUnmount(() => {
  window.clearTimeout(playbackVolumeTimer);
  window.clearTimeout(microphoneSettingsTimer);
  releaseSpeech?.();
});
</script>

<template>
  <div class="page-shell speech-page">
    <div class="page-header speech-page-header">
      <div>
        <div class="speech-eyebrow">LOCAL SPEECH RUNTIME</div>
        <h1 class="page-title">语音消息端</h1>
        <div class="page-subtitle">常驻麦克风、声音阈值、本机 ASR、人格 TTS 与整台电脑唯一的排队播放入口。</div>
      </div>
      <div class="page-actions">
        <v-btn variant="tonal" prepend-icon="mdi-chart-box-outline" href="reports/rabispeech-model-benchmark.html" target="_blank">目标测试机报告</v-btn>
        <v-btn color="primary" prepend-icon="mdi-refresh" :loading="loading" @click="refreshStatus">刷新状态</v-btn>
      </div>
    </div>

    <v-alert v-if="requestError || speech.error" type="error" variant="tonal" class="mb-4">Manager 状态读取失败：{{ requestError || speech.error }}</v-alert>

    <v-card class="app-card glass-card speech-mode-tabs">
      <v-tabs v-model="activeKind" color="primary" grow class="speech-tabs" aria-label="切换 TTS 与 ASR">
        <v-tab value="tts" prepend-icon="mdi-account-voice">TTS 语音合成</v-tab>
        <v-tab value="asr" prepend-icon="mdi-waveform">ASR 语音识别</v-tab>
      </v-tabs>
    </v-card>

    <v-card class="app-card glass-card speech-audio-stream-card">
      <div class="speech-audio-stream-copy">
        <div class="speech-audio-stream-icon"><v-icon>mdi-access-point</v-icon></div>
        <div>
          <div class="stat-label">音频流</div>
          <strong>{{ selectedAudioStreamLabel }}</strong>
          <p>客户端只提供远程麦克风和喇叭；切句、ASR、Route 投递、人格 TTS 与防回流仍在当前 Rabi 主机执行。</p>
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
        <v-btn variant="tonal" prepend-icon="mdi-content-copy" :disabled="!audioStream?.enabled" @click="copyAudioStreamToken">复制客户端连接密钥</v-btn>
      </div>
    </v-card>

    <section class="speech-status-grid" aria-label="语音服务摘要">
      <v-card class="app-card glass-card speech-stat-card">
        <div class="stat-label">当前电脑</div>
        <div class="stat-value speech-stat-value">{{ computerName }}</div>
        <div class="stat-note">每台 Rabi 独立探测</div>
      </v-card>
      <v-card class="app-card glass-card speech-stat-card">
        <div class="stat-label">RabiSpeech</div>
        <div class="speech-stat-line">
          <div class="stat-value speech-stat-value">{{ stateLabel }}</div>
          <v-chip size="small" :color="stateColor" variant="tonal">{{ status ? stateLabel : "检查中" }}</v-chip>
        </div>
        <div class="stat-note">{{ status?.latencyMs != null ? `${status.latencyMs} ms 状态检查` : "等待本机服务" }}</div>
      </v-card>
      <v-card class="app-card glass-card speech-stat-card">
        <div class="stat-label">TTS provider</div>
        <div class="stat-value speech-stat-value">{{ status?.providers.tts.length ?? "-" }}</div>
        <div class="stat-note">默认 {{ status?.defaults.tts || "未发现" }}</div>
      </v-card>
      <v-card class="app-card glass-card speech-stat-card">
        <div class="stat-label">ASR provider</div>
        <div class="stat-value speech-stat-value">{{ status?.providers.asr.length ?? "-" }}</div>
        <div class="stat-note">默认 {{ status?.defaults.asr || "未发现" }}</div>
      </v-card>
    </section>

    <v-alert class="speech-boundary" type="info" variant="tonal" icon="mdi-transit-connection-variant">
      <strong>边界：</strong>RabiLink 是整个系统内置的转接服务，不是消息端。语音 API 可在本机直接调用，也可由 RabiLink 中转；眼镜、手机或其他客户端才是消息来源/调用端。
    </v-alert>

    <v-alert v-if="actionMessage" class="mb-4" type="success" variant="tonal" closable @click:close="actionMessage = ''">{{ actionMessage }}</v-alert>

    <section class="speech-console-grid">
      <v-card v-if="activeKind === 'tts'" class="app-card glass-card speech-console-card">
        <div class="speech-console-head">
          <div>
            <div class="speech-eyebrow">DIRECT ROLEPLAY TTS</div>
            <h2>独立 TTS 角色扮演</h2>
            <p>不需要配置 Route 或接入 Agent；人格名会解析到 <code>data/roles/&lt;人格&gt;/voice</code>。</p>
          </div>
          <v-chip color="primary" variant="tonal">{{ ttsModels.filter(item => item.available).length }} 个可用模型</v-chip>
        </div>
        <v-textarea v-model="ttsText" label="要说的话" rows="4" counter="10000" :disabled="ttsBusy" />
        <div class="speech-form-grid">
          <v-select v-model="voice" label="人格 / 声线" :items="personaOptions" :disabled="ttsBusy">
            <template #item="{ props: itemProps, item }">
              <v-list-item v-bind="itemProps">
                <template #prepend><PersonaAvatar :role-id="String(item.raw.value || '')" :avatar-url="item.raw.avatarUrl" :size="32" /></template>
              </v-list-item>
            </template>
            <template #selection="{ item }">
              <div class="d-flex align-center ga-2">
                <PersonaAvatar :role-id="String(item.raw.value || '')" :avatar-url="item.raw.avatarUrl" :size="26" />
                <span>{{ item.raw.title }}</span>
              </div>
            </template>
          </v-select>
          <v-text-field :model-value="ttsModel || '由人格配置'" label="TTS 模型" readonly />
          <v-text-field :model-value="ttsLanguage || '由人格配置'" label="语言" readonly />
          <v-text-field :model-value="speed" label="语速" readonly />
        </div>
        <v-text-field :model-value="instructions || '由人格 voice-profile 配置'" label="情绪 / 风格指令" readonly />
        <div class="section-note mb-3">模型、声线、语言、语速和表达方式统一来自所选人格的 <code>voice/voice-profile.json</code>。</div>
        <div class="speech-action-row">
          <v-switch v-model="queuePlayback" color="primary" label="进入主机全局 FIFO 播放队列" hide-details />
          <v-btn color="primary" size="large" prepend-icon="mdi-account-voice" :loading="ttsBusy" :disabled="!ttsText.trim() || !voice" @click="synthesize">合成并播放</v-btn>
        </div>
      </v-card>

      <v-card v-else class="app-card glass-card speech-console-card">
        <div class="speech-console-head">
          <div>
            <div class="speech-eyebrow">ALWAYS-ON LOCAL ASR</div>
            <h2>常驻转录与消息投递</h2>
            <p>RabiSpeech 本机服务只采集和识别一次，再把文字广播给所有已开启语音消息端的 Route；本页只维护整台电脑共用的麦克风、ASR 与 VAD 参数。</p>
          </div>
          <v-chip :color="microphoneStatus?.state === 'error' ? 'error' : listening ? utteranceActive ? 'warning' : 'success' : 'grey'" variant="tonal">
            {{ microphoneStatus?.state === "transcribing" ? "正在识别" : microphoneStatus?.state === "playback_suppressed" ? "播放防回流" : microphoneStatus?.state === "error" ? "异常" : listening ? utteranceActive ? "正在收音" : "服务监听中" : "已停止" }}
          </v-chip>
        </div>
        <div class="speech-form-grid">
          <v-select v-model="asrModel" label="ASR 模型" :items="asrModels" item-title="name" item-value="id" :disabled="asrBusy || microphoneSettingsSaving">
            <template #item="{ props, item }">
              <v-list-item v-bind="props" :subtitle="`${item.raw.id} · ${item.raw.available ? '可用' : item.raw.installed ? '未启用' : '未安装'}`" />
            </template>
          </v-select>
          <v-select v-model="selectedAudioInput" :label="audioStream?.source === 'remote' ? '远程客户端麦克风' : '本机麦克风设备'" :items="audioInputs" :disabled="microphoneSettingsSaving || audioStream?.source === 'remote'" @click="refreshAudioInputs" />
        </div>
        <div class="vad-meter">
          <div class="vad-meter-head"><span>实时声音 {{ micLevel.toFixed(4) }} · 底噪 {{ Number(microphoneStatus?.noiseFloor || 0).toFixed(4) }}</span><b>动态阈值 {{ Number(microphoneStatus?.dynamicThreshold || threshold).toFixed(3) }}</b></div>
          <v-progress-linear :model-value="micPercent" :color="utteranceActive ? 'warning' : micLevel >= threshold ? 'success' : 'primary'" height="12" rounded />
        </div>
        <div class="speech-slider-grid">
          <SpeechParameterSlider v-model="threshold" label="开始录音阈值" :min="0.001" :max="0.2" :step="0.001" :decimals="3" :disabled="microphoneSettingsSaving" hint="超过此 RMS 才开始采集语段" />
          <SpeechParameterSlider v-model="transcribeThreshold" label="值得转写阈值" :min="0.001" :max="0.3" :step="0.001" :decimals="3" :disabled="microphoneSettingsSaving" hint="语段峰值不足时不送入 ASR" />
          <SpeechParameterSlider v-model="silenceMs" label="静音收尾" :min="200" :max="3000" :step="50" suffix="ms" :disabled="microphoneSettingsSaving" hint="连续静音多久后切分语段" />
          <SpeechParameterSlider v-model="minUtteranceMs" label="最短语音" :min="100" :max="3000" :step="50" suffix="ms" :disabled="microphoneSettingsSaving" hint="短于此时长的片段会被丢弃" />
          <SpeechParameterSlider v-model="maxUtteranceMs" label="最长语音" :min="3000" :max="120000" :step="1000" suffix="ms" :disabled="microphoneSettingsSaving" hint="达到上限时强制切段" />
          <SpeechParameterSlider v-model="preRollMs" label="前置缓存" :min="0" :max="3000" :step="50" suffix="ms" :disabled="microphoneSettingsSaving" hint="保留触发阈值前的句首音频" />
          <SpeechParameterSlider v-model="inputGain" label="输入增益" :min="0.1" :max="5" :step="0.1" :decimals="1" suffix="×" :disabled="microphoneSettingsSaving" hint="仅放大送入检测与识别的输入" />
        </div>
        <div class="speech-action-row">
          <div class="speech-inline-switches">
            <v-switch v-model="adaptiveThreshold" color="primary" label="动态底噪阈值" hide-details :disabled="microphoneSettingsSaving" />
          </div>
          <v-chip :color="listening ? 'success' : speechSubscriberRoutes.length ? 'warning' : 'grey'" variant="tonal">
            {{ microphoneSettingsSaving ? "正在应用主机语音设置" : listening ? `常驻监听中 · ${speechSubscriberRoutes.length} 个 Route 已订阅` : speechSubscriberRoutes.length ? "等待 RabiSpeech 恢复监听" : "没有 Route 订阅语音消息" }}
          </v-chip>
        </div>
        <div class="section-note mt-3">
          Route 的语音消息端开关是订阅真源；同一段 ASR 会广播给全部 {{ speechSubscriberRoutes.length }} 个已启用 Route，各自再执行热投递或人格关键词判断。
          待识别 {{ microphoneStatus?.pending || 0 }} 段 · 丢弃 {{ microphoneStatus?.dropped || 0 }} 段<span v-if="microphoneStatus?.lastSubmitError"> · 广播异常：{{ microphoneStatus.lastSubmitError }}</span>
        </div>
        <v-alert v-if="microphoneStatus?.error" class="mt-4" type="error" variant="tonal" density="compact">{{ microphoneStatus.error }}</v-alert>
        <v-alert class="mt-4" type="warning" variant="tonal" density="compact">
          主机正在播放 TTS 时，服务会清空当前片段并暂停触发，避免语音回流；仍请勿选择会混入扬声器的虚拟麦克风。
        </v-alert>
      </v-card>
      <SpeechHostMonitor v-if="activeKind === 'asr'" :subscriber-count="speechSubscriberRoutes.length" />
    </section>

    <v-card v-if="activeKind === 'asr'" class="app-card glass-card transcript-card">
      <div class="speech-console-head">
        <div>
          <div class="speech-eyebrow">TRANSCRIPTION RESULT</div>
          <h2>实机 ASR 测试</h2>
          <p>可上传已有音频，也可查看常驻监听刚刚识别的文本。</p>
        </div>
        <label class="audio-upload-button">
          <input type="file" accept="audio/*,.wav,.mp3,.flac,.m4a,.ogg,.opus,.webm" :disabled="asrBusy" @change="onAudioFile" />
          <v-icon>mdi-file-music-outline</v-icon>
          {{ asrBusy ? "识别中……" : "选择音频测试" }}
        </label>
      </div>
      <v-textarea v-model="transcript" label="识别文本" rows="3" :loading="asrBusy" />
      <div v-if="transcriptHistory.length" class="transcript-history">
        <div v-for="item in transcriptHistory" :key="`${item.time}-${item.text}`">
          <span>{{ item.time }} · {{ item.model }}</span>
          <p>{{ item.text }}</p>
        </div>
      </div>
      <div class="section-note mt-3">上方仅保留当前页面运行期的转写预览；下方读取按日期持久化的最近 ASR/TTS 双向记录。</div>
      <SpeechRecordsAndSpeakers />
    </v-card>

    <v-card class="app-card glass-card playback-card">
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
        :disabled="status?.state !== 'online'"
        @update:model-value="schedulePlaybackVolume"
      />
    </v-card>

    <v-card class="app-card glass-card speech-workbench">
      <div class="speech-panel-head">
        <div>
          <div class="speech-eyebrow">{{ activeKind === "tts" ? "TEXT TO SPEECH" : "AUTOMATIC SPEECH RECOGNITION" }}</div>
          <h2>{{ activeKind === "tts" ? "当前 TTS 能力" : "当前 ASR 能力" }}</h2>
          <p>{{ activeKind === "tts" ? "RabiSpeech 直接在本机人格、声线与 worker 之间路由；不再依赖 OumuQ。" : "模型、加载设备和预热状态来自当前 RabiSpeech 进程，不再依赖 FenneNote。" }}</p>
        </div>
        <v-chip color="secondary" variant="tonal">默认：{{ currentDefault }}</v-chip>
      </div>

      <div v-if="status?.state !== 'online'" class="speech-offline">
        <v-icon size="40" color="warning">mdi-server-off</v-icon>
        <div>
          <strong>本机语音服务尚未连通</strong>
          <span>{{ status?.error || "正在检查 RabiSpeech。" }}</span>
          <code>{{ status?.configuredUrl || "http://127.0.0.1:8781" }}</code>
        </div>
      </div>

      <div v-else-if="providers.length === 0" class="speech-offline">
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
            <v-chip size="small" :color="provider.enabled ? 'success' : 'grey'" variant="tonal">{{ provider.enabled ? "已启用" : "已关闭" }}</v-chip>
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
  </div>
</template>

<style scoped>
.speech-page { max-width: 1540px; }
.speech-eyebrow { color: #0f8b8d; font-size: 11px; font-weight: 900; letter-spacing: .13em; }
.speech-status-grid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 16px; margin-bottom: 18px; }
.speech-stat-card { min-height: 142px; padding: 22px; }
.speech-stat-value { overflow: hidden; font-size: clamp(24px, 2.2vw, 34px); text-overflow: ellipsis; white-space: nowrap; }
.speech-stat-line { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.speech-boundary { margin-bottom: 18px; }
.speech-mode-tabs { margin-bottom: 18px; padding: 0 24px; border: 1px solid rgba(15, 139, 141, .16); }
.speech-audio-stream-card { display: grid; grid-template-columns: minmax(0, 1fr) minmax(320px, 520px); gap: 24px; align-items: center; margin-bottom: 18px; padding: 18px 22px; }
.speech-audio-stream-copy { display: flex; gap: 14px; align-items: center; min-width: 0; }
.speech-audio-stream-copy strong { display: block; margin-top: 3px; color: #0c2a4a; font-size: 17px; }
.speech-audio-stream-copy p { margin: 4px 0 0; color: #607487; font-size: 12px; line-height: 1.55; }
.speech-audio-stream-icon { display: grid; flex: 0 0 44px; width: 44px; height: 44px; place-items: center; border-radius: 13px; color: #0f8b8d; background: rgba(25, 191, 193, .12); }
.speech-audio-stream-controls { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 10px; align-items: center; }
.speech-console-grid { display: grid; grid-template-columns: minmax(0, 1fr); gap: 18px; margin-bottom: 18px; }
.speech-console-card { min-width: 0; padding: 26px; }
.speech-console-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 18px; margin-bottom: 22px; }
.speech-console-head h2 { margin: 6px 0 6px; color: #0c2a4a; font-size: 23px; }
.speech-console-head p { margin: 0; color: #607487; font-size: 13px; line-height: 1.65; }
.speech-console-head code { color: #0c5f68; }
.speech-form-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 4px 14px; }
.speech-action-row { display: flex; align-items: center; justify-content: space-between; gap: 18px; margin-top: 10px; }
.speech-inline-switches { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 20px; }
.vad-meter { margin: 4px 0 18px; padding: 16px; border: 1px solid rgba(17, 32, 51, .09); border-radius: 14px; background: rgba(246, 250, 252, .74); }
.vad-meter-head { display: flex; justify-content: space-between; gap: 12px; margin-bottom: 9px; color: #536a7e; font-size: 12px; }
.speech-slider-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 0 18px; }
.transcript-card { margin-bottom: 18px; padding: 26px; }
.transcript-actions { margin-top: 0; }
.audio-upload-button { display: flex; align-items: center; gap: 8px; padding: 10px 15px; border: 1px solid rgba(15, 139, 141, .34); border-radius: 12px; color: #0b696b; background: rgba(25, 191, 193, .08); font-size: 13px; font-weight: 800; cursor: pointer; }
.audio-upload-button input { position: absolute; width: 1px; height: 1px; opacity: 0; pointer-events: none; }
.transcript-history { display: grid; gap: 9px; margin-top: 18px; }
.transcript-history > div { padding: 12px 15px; border: 1px solid rgba(17, 32, 51, .08); border-radius: 12px; background: rgba(248, 251, 253, .8); }
.transcript-history span { color: #7b8c9b; font-size: 11px; }
.transcript-history p { margin: 5px 0 0; color: #29445a; }
.playback-card { display: grid; gap: 14px; margin-bottom: 18px; padding: 18px 22px; }
.playback-card-head { display: flex; align-items: center; justify-content: space-between; gap: 18px; }
.playback-card-summary { display: flex; gap: 14px; align-items: baseline; }
.playback-card span { color: #607487; font-size: 13px; }
.speech-workbench { overflow: hidden; padding: 0; }
.speech-tabs { max-width: 620px; }
.speech-panel-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 24px; padding: 32px 32px 22px; }
.speech-panel-head h2 { margin: 7px 0 8px; color: #0c2a4a; font-size: 28px; }
.speech-panel-head p { max-width: 760px; margin: 0; color: #52677a; font-size: 14px; line-height: 1.7; }
.speech-provider-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 390px), 1fr)); gap: 18px; padding: 0 32px 30px; }
.speech-provider-card { padding: 24px; border: 1px solid rgba(17, 32, 51, .11); border-radius: 18px; background: rgba(248, 251, 253, .9); }
.speech-provider-top { display: grid; grid-template-columns: 44px minmax(0, 1fr) auto; gap: 13px; align-items: center; }
.speech-provider-icon { display: grid; width: 44px; height: 44px; place-items: center; border-radius: 13px; color: #0f8b8d; background: rgba(25, 191, 193, .12); }
.speech-provider-top h3 { margin: 0; color: #0c2a4a; font-size: 17px; }
.speech-facts { display: grid; gap: 0; margin: 22px 0 18px; }
.speech-facts > div { display: grid; grid-template-columns: 96px minmax(0, 1fr); gap: 16px; padding: 11px 0; border-top: 1px solid rgba(17, 32, 51, .08); }
.speech-facts dt { color: #8491a0; font-size: 12px; font-weight: 800; }
.speech-facts dd { margin: 0; color: #29445a; font-size: 13px; font-weight: 750; text-align: right; overflow-wrap: anywhere; }
.speech-formats { display: flex; flex-wrap: wrap; gap: 7px; }
.speech-formats span { padding: 5px 9px; border-radius: 999px; color: #31515d; background: rgba(17, 32, 51, .06); font-size: 11px; font-weight: 800; text-transform: uppercase; }
.speech-offline { display: flex; align-items: center; gap: 18px; margin: 0 32px 30px; padding: 28px; border: 1px dashed rgba(184, 125, 25, .34); border-radius: 18px; background: rgba(255, 249, 235, .72); }
.speech-offline div { display: grid; gap: 5px; min-width: 0; }
.speech-offline strong { color: #6a4610; }
.speech-offline span { color: #7b6a4b; font-size: 13px; }
.speech-offline code, .speech-api-strip code { overflow-wrap: anywhere; color: #0c5f68; font-size: 12px; }
.speech-api-strip { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); border-top: 1px solid rgba(17, 32, 51, .09); background: rgba(246, 250, 252, .7); }
.speech-api-strip > div { display: grid; gap: 7px; min-width: 0; padding: 20px 24px; border-right: 1px solid rgba(17, 32, 51, .08); }
.speech-api-strip > div:last-child { border-right: 0; }
.speech-api-strip span { color: #8491a0; font-size: 11px; font-weight: 900; letter-spacing: .06em; text-transform: uppercase; }
.speech-footnote { display: flex; align-items: flex-start; gap: 9px; margin: 18px 4px 0; color: #687b8e; font-size: 12px; line-height: 1.6; }
@media (max-width: 1100px) { .speech-console-grid { grid-template-columns: 1fr; } .speech-status-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); } .speech-api-strip { grid-template-columns: 1fr; } .speech-api-strip > div { border-right: 0; border-bottom: 1px solid rgba(17, 32, 51, .08); } }
@media (max-width: 700px) { .speech-page-header, .speech-panel-head, .speech-console-head, .speech-action-row { align-items: stretch; flex-direction: column; } .speech-status-grid, .speech-form-grid, .speech-slider-grid, .speech-audio-stream-card, .speech-audio-stream-controls { grid-template-columns: 1fr; } .speech-console-card, .transcript-card { padding: 18px; } .playback-card-head, .playback-card-summary { align-items: stretch; flex-direction: column; } .speech-panel-head, .speech-provider-grid { padding-right: 18px; padding-left: 18px; } .speech-mode-tabs { padding: 0 8px; } .speech-tabs :deep(.v-btn__content) { font-size: 12px; } .speech-offline { margin-right: 18px; margin-left: 18px; } .speech-api-strip > div { padding: 17px 18px; } }
</style>
