<script setup lang="ts">
type SpeechDocsMode = "tts" | "asr" | "benchmark";

defineProps<{ mode: SpeechDocsMode }>();

const reportUrl = "/reports/rabispeech-model-benchmark.html";

const ttsModels = [
  {
    model: "ONNX-VITS",
    use: "即时固定声线",
    voice: "147 个本地固定声线",
    clone: "否",
    controls: "语速、noise scale、seed",
    device: "CPU",
    result: "热态 RTF 0.37"
  },
  {
    model: "Qwen3-TTS 0.6B",
    use: "多语言参考音克隆",
    voice: "本地参考音",
    clone: "是",
    controls: "语言、参考音、采样参数",
    device: "CUDA",
    result: "热态 RTF 1.47；回译 CER 2.4%"
  },
  {
    model: "IndexTTS2",
    use: "中文克隆与情绪控制",
    voice: "本地零样本参考音",
    clone: "是",
    controls: "8 维情绪、情绪文本、拼音",
    device: "CUDA",
    result: "热态 RTF 1.06；冷首条 46.04 秒"
  }
];

const asrModels = [
  {
    model: "faster-whisper tiny",
    use: "健康检查 / 低资源草稿",
    load: "4.41 秒",
    warmup: "1.52 秒",
    warm: "0.19 秒/条",
    cer: "38.9%",
    recommendation: "非默认"
  },
  {
    model: "faster-whisper small",
    use: "默认本机识别",
    load: "8.12 秒",
    warmup: "1.64 秒",
    warm: "0.23 秒/条",
    cer: "22.2%",
    recommendation: "推荐常驻"
  }
];

const cases = [
  ["短句", "你好，这是本地语音服务的速度测试。"],
  ["中英混合", "请提醒我检查 RabiLink 服务器，并确认 ASR 与 TTS 接口正常。"],
  ["长指令", "如果网络暂时断开，请保留本地任务，等待连接恢复以后再重试，并把失败原因写进诊断报告。"]
];
</script>

<template>
  <div class="speech-docs-panel">
    <div class="speech-boundary">
      <v-icon size="19" color="info">mdi-shield-lock-outline</v-icon>
      <div>
        <strong>RabiSpeech 是独立本机插件，不是消息端或 Agent。</strong>
        <span>它只绑定 127.0.0.1；RabiLink 可用同一个应用 token 中转原始 TTS / ASR API，请求不会进入 Agent。</span>
      </div>
    </div>
    <v-alert type="warning" variant="tonal" density="compact">
      这里的性能数字来自报告标明的目标测试机，仅用于模型间对照；其他电脑的实际结果请到左侧“语音服务”查看当前能力，并在本机重跑同一基准。
    </v-alert>

    <template v-if="mode === 'tts'">
      <div class="speech-kpis">
        <div><span>默认即时路线</span><strong>ONNX-VITS</strong></div>
        <div><span>最佳回译可懂度</span><strong>Qwen · 2.4% CER</strong></div>
        <div><span>高级中文控制</span><strong>IndexTTS2</strong></div>
      </div>

      <section class="speech-block">
        <h3>TTS API</h3>
        <div class="endpoint-grid">
          <code>POST /v1/audio/speech</code>
          <code>POST /api/v1/services/audio/tts/SpeechSynthesizer</code>
        </div>
        <p>OpenAI-compatible 接口适合通用客户端；DashScope 风格接口用于迁移既有调用方。当前返回完整音频，不应把底层模型支持流式误写成 RabiSpeech 已交付流式首包。</p>
      </section>

      <section class="speech-block">
        <div class="speech-block-title">
          <h3>本地 TTS 路线</h3>
          <v-btn :href="reportUrl + '#tts'" target="_blank" size="small" color="secondary" variant="tonal" append-icon="mdi-open-in-new">完整性能表</v-btn>
        </div>
        <div class="speech-table-wrap">
          <table>
            <thead><tr><th>模型</th><th>场景</th><th>声线</th><th>克隆</th><th>控制</th><th>设备</th><th>本轮结果</th></tr></thead>
            <tbody><tr v-for="row in ttsModels" :key="row.model"><td><strong>{{ row.model }}</strong></td><td>{{ row.use }}</td><td>{{ row.voice }}</td><td>{{ row.clone }}</td><td>{{ row.controls }}</td><td>{{ row.device }}</td><td>{{ row.result }}</td></tr></tbody>
          </table>
        </div>
      </section>
    </template>

    <template v-else-if="mode === 'asr'">
      <div class="speech-kpis">
        <div><span>默认模型</span><strong>small</strong></div>
        <div><span>Ready 前总耗时</span><strong>9.75 秒</strong></div>
        <div><span>热态识别</span><strong>0.23 秒/条</strong></div>
      </div>

      <section class="speech-block">
        <h3>ASR API</h3>
        <div class="endpoint-grid">
          <code>POST /v1/audio/transcriptions</code>
          <code>POST /api/v1/services/audio/asr/transcription</code>
        </div>
        <p>默认只使用本机缓存模型，远程请求不能触发模型下载。启动时把模型加载和不计分预热前置，并通过 <code>/health</code> 暴露 <code>loaded_device</code> 与 <code>warmup_error</code>。</p>
      </section>

      <section class="speech-block">
        <div class="speech-block-title">
          <h3>本地 ASR 路线</h3>
          <v-btn :href="reportUrl + '#asr'" target="_blank" size="small" color="secondary" variant="tonal" append-icon="mdi-open-in-new">准确率报告</v-btn>
        </div>
        <div class="speech-table-wrap">
          <table>
            <thead><tr><th>模型</th><th>场景</th><th>加载</th><th>预热</th><th>热态</th><th>micro CER</th><th>建议</th></tr></thead>
            <tbody><tr v-for="row in asrModels" :key="row.model"><td><strong>{{ row.model }}</strong></td><td>{{ row.use }}</td><td>{{ row.load }}</td><td>{{ row.warmup }}</td><td>{{ row.warm }}</td><td>{{ row.cer }}</td><td>{{ row.recommendation }}</td></tr></tbody>
          </table>
        </div>
      </section>
    </template>

    <template v-else>
      <section class="speech-block">
        <div class="speech-block-title">
          <div>
            <h3>可重复闭环</h3>
            <p>固定文本 → 每个 TTS 生成 WAV → ASR 不计分预热 → 每个 ASR 识别全部 WAV → CER / RTF / 显存汇总。</p>
          </div>
          <v-btn :href="reportUrl" target="_blank" color="secondary" variant="flat" append-icon="mdi-open-in-new">独立打开报告</v-btn>
        </div>
        <div class="case-grid">
          <div v-for="([name, value], index) in cases" :key="name" class="case-card"><span>0{{ index + 1 }} · {{ name }}</span><strong>{{ value }}</strong></div>
        </div>
      </section>

      <section class="speech-block">
        <h3>HTML 报告预览</h3>
        <p>报告包含 TTS / ASR 功能表、性能表、柱状图、预热时间、逐句准确率、测试硬件和建议配置。它由同一基准脚本生成，不手工抄数字；结果仅代表报告中的目标测试机，具体性能以各自电脑实测为准。</p>
        <iframe class="report-frame" :src="reportUrl" title="RabiSpeech TTS 与 ASR 性能报告" loading="lazy" />
      </section>
    </template>
  </div>
</template>

<style scoped>
.speech-docs-panel { display: grid; gap: 18px; }
.speech-boundary { display: flex; gap: 12px; padding: 14px 16px; border: 1px solid rgba(74, 169, 255, .24); border-radius: 14px; background: rgba(74, 169, 255, .07); }
.speech-boundary strong, .speech-boundary span { display: block; }
.speech-boundary span { margin-top: 3px; color: var(--text-muted, #9fb1c7); font-size: 13px; }
.speech-kpis { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 12px; }
.speech-kpis > div { padding: 15px; border: 1px solid rgba(148, 181, 218, .18); border-radius: 14px; background: rgba(101, 169, 255, .055); }
.speech-kpis span, .speech-kpis strong { display: block; }
.speech-kpis span { color: var(--text-muted, #9fb1c7); font-size: 12px; }
.speech-kpis strong { margin-top: 5px; font-size: 17px; }
.speech-block { padding: 18px; border: 1px solid rgba(148, 181, 218, .18); border-radius: 16px; background: rgba(13, 28, 45, .45); }
.speech-block h3, .speech-block p { margin-top: 0; }
.speech-block p { color: var(--text-muted, #9fb1c7); }
.speech-block-title { display: flex; align-items: center; justify-content: space-between; gap: 16px; margin-bottom: 12px; }
.speech-block-title h3, .speech-block-title p { margin-bottom: 0; }
.endpoint-grid { display: grid; gap: 8px; margin: 12px 0; }
.endpoint-grid code { padding: 9px 11px; overflow-wrap: anywhere; border-radius: 9px; background: rgba(101, 169, 255, .1); }
.speech-table-wrap { width: 100%; overflow-x: auto; border: 1px solid rgba(148, 181, 218, .16); border-radius: 12px; }
table { width: 100%; min-width: 820px; border-collapse: collapse; font-size: 12px; }
th, td { padding: 10px 11px; text-align: left; vertical-align: top; border-bottom: 1px solid rgba(148, 181, 218, .13); }
th { background: rgba(101, 169, 255, .09); color: var(--text-muted, #b8c8da); }
tr:last-child td { border-bottom: 0; }
.case-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 10px; margin-top: 14px; }
.case-card { padding: 14px; border-left: 3px solid rgb(var(--v-theme-secondary)); border-radius: 0 10px 10px 0; background: rgba(112, 220, 212, .055); }
.case-card span, .case-card strong { display: block; }
.case-card span { margin-bottom: 5px; color: var(--text-muted, #9fb1c7); font-size: 11px; }
.case-card strong { font-size: 13px; font-weight: 600; }
.report-frame { width: 100%; height: min(76vh, 920px); min-height: 680px; border: 1px solid rgba(148, 181, 218, .2); border-radius: 14px; background: #07111f; }
@media (max-width: 900px) { .speech-kpis, .case-grid { grid-template-columns: 1fr; } .speech-block-title { align-items: flex-start; flex-direction: column; } .report-frame { min-height: 560px; } }
</style>
