<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import { useGatewayStore } from "../stores/gatewayStore";

type SpeechProvider = {
  id: string;
  kind: "tts" | "asr";
  enabled: boolean;
  model?: string;
  transport?: string;
  formats: string[];
  voiceBinding?: string;
  loaded?: boolean;
  loadedDevice?: string;
  preload?: boolean;
  localFilesOnly?: boolean;
  warmupError?: string;
};

type SpeechStatus = {
  state: "online" | "offline" | "invalid";
  checkedAt: string;
  configuredUrl: string;
  latencyMs?: number;
  service?: string;
  localOnly?: boolean;
  relaySafe?: boolean;
  streaming?: boolean;
  defaults: { tts?: string; asr?: string };
  providers: { tts: SpeechProvider[]; asr: SpeechProvider[] };
  error?: string;
};

const store = useGatewayStore();
const activeKind = ref<"tts" | "asr">("tts");
const loading = ref(false);
const requestError = ref("");
const status = ref<SpeechStatus | null>(null);

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

function providerName(provider: SpeechProvider): string {
  if (provider.id === "oumuq") return "OumuQ 本机 TTS 路由";
  if (provider.id === "faster-whisper") return "faster-whisper";
  return provider.id;
}

function providerModel(provider: SpeechProvider): string {
  if (provider.model) return provider.model;
  if (provider.kind === "tts" && provider.id === "oumuq") return "按角色与 worker 动态选择";
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
  if (loading.value) return;
  loading.value = true;
  requestError.value = "";
  try {
    const response = await fetch("/api/speech/status", { headers: { accept: "application/json" } });
    const body = await response.json();
    if (!response.ok || body.code !== 0 || !body.data) throw new Error(body.message || `HTTP ${response.status}`);
    status.value = body.data as SpeechStatus;
  } catch (error) {
    requestError.value = error instanceof Error ? error.message : String(error);
  } finally {
    loading.value = false;
  }
}

let refreshTimer = 0;
onMounted(async () => {
  await refreshStatus();
  refreshTimer = window.setInterval(refreshStatus, 15000);
});
onBeforeUnmount(() => window.clearInterval(refreshTimer));
</script>

<template>
  <div class="page-shell speech-page">
    <div class="page-header speech-page-header">
      <div>
        <div class="speech-eyebrow">LOCAL SPEECH RUNTIME</div>
        <h1 class="page-title">语音服务</h1>
        <div class="page-subtitle">查看这台电脑实际安装并运行的 TTS / ASR；不同电脑会得到不同结果。</div>
      </div>
      <div class="page-actions">
        <v-btn variant="tonal" prepend-icon="mdi-chart-box-outline" href="/reports/rabispeech-model-benchmark.html" target="_blank">目标测试机报告</v-btn>
        <v-btn color="primary" prepend-icon="mdi-refresh" :loading="loading" @click="refreshStatus">刷新状态</v-btn>
      </div>
    </div>

    <v-alert v-if="requestError" type="error" variant="tonal" class="mb-4">Manager 状态读取失败：{{ requestError }}</v-alert>

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
          <v-chip size="small" :color="stateColor" variant="tonal">{{ status?.state || "检查中" }}</v-chip>
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

    <v-card class="app-card glass-card speech-workbench">
      <div class="speech-tabs-head">
        <v-tabs v-model="activeKind" color="primary" grow class="speech-tabs" aria-label="切换 TTS 与 ASR">
          <v-tab value="tts" prepend-icon="mdi-account-voice">TTS 语音合成</v-tab>
          <v-tab value="asr" prepend-icon="mdi-waveform">ASR 语音识别</v-tab>
        </v-tabs>
      </div>

      <div class="speech-panel-head">
        <div>
          <div class="speech-eyebrow">{{ activeKind === "tts" ? "TEXT TO SPEECH" : "AUTOMATIC SPEECH RECOGNITION" }}</div>
          <h2>{{ activeKind === "tts" ? "当前 TTS 能力" : "当前 ASR 能力" }}</h2>
          <p>{{ activeKind === "tts" ? "OumuQ 负责在本机角色、声线与 worker 之间路由；实际模型随当前电脑配置变化。" : "模型、加载设备和预热状态来自当前 RabiSpeech 进程，不使用报告里的静态假设。" }}</p>
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
          <span>DashScope 兼容</span>
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
.speech-workbench { overflow: hidden; padding: 0; }
.speech-tabs-head { padding: 0 24px; border-bottom: 1px solid rgba(17, 32, 51, .1); background: rgba(246, 250, 252, .82); }
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
@media (max-width: 1100px) { .speech-status-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); } .speech-api-strip { grid-template-columns: 1fr; } .speech-api-strip > div { border-right: 0; border-bottom: 1px solid rgba(17, 32, 51, .08); } }
@media (max-width: 700px) { .speech-page-header, .speech-panel-head { align-items: stretch; flex-direction: column; } .speech-status-grid { grid-template-columns: 1fr; } .speech-panel-head, .speech-provider-grid { padding-right: 18px; padding-left: 18px; } .speech-tabs-head { padding: 0 8px; } .speech-tabs :deep(.v-btn__content) { font-size: 12px; } .speech-offline { margin-right: 18px; margin-left: 18px; } .speech-api-strip > div { padding: 17px 18px; } }
</style>
