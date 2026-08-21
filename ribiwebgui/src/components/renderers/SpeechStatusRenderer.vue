<script setup lang="ts">
type SpeechStatusContext = Readonly<{
  computerName: string;
  status?: {
    latencyMs?: number;
    providers: { tts: readonly unknown[]; asr: readonly unknown[] };
    defaults: { tts?: string; asr?: string };
  };
  stateLabel: string;
  stateColor: string;
}>;

defineProps<{ context: SpeechStatusContext }>();
</script>

<template>
  <section class="speech-status-grid" aria-label="语音服务摘要">
    <v-card class="app-card glass-card speech-stat-card">
      <div class="stat-label">当前电脑</div>
      <div class="stat-value speech-stat-value">{{ context.computerName }}</div>
      <div class="stat-note">每台 Rabi 独立探测</div>
    </v-card>
    <v-card class="app-card glass-card speech-stat-card">
      <div class="stat-label">RabiSpeech</div>
      <div class="speech-stat-line">
        <div class="stat-value speech-stat-value">{{ context.stateLabel }}</div>
        <v-chip size="small" :color="context.stateColor" variant="tonal">{{ context.status ? context.stateLabel : "检查中" }}</v-chip>
      </div>
      <div class="stat-note">{{ context.status?.latencyMs != null ? `${context.status.latencyMs} ms 状态检查` : "等待本机服务" }}</div>
    </v-card>
    <v-card class="app-card glass-card speech-stat-card">
      <div class="stat-label">TTS provider</div>
      <div class="stat-value speech-stat-value">{{ context.status?.providers.tts.length ?? "-" }}</div>
      <div class="stat-note">默认 {{ context.status?.defaults.tts || "未发现" }}</div>
    </v-card>
    <v-card class="app-card glass-card speech-stat-card">
      <div class="stat-label">ASR provider</div>
      <div class="stat-value speech-stat-value">{{ context.status?.providers.asr.length ?? "-" }}</div>
      <div class="stat-note">默认 {{ context.status?.defaults.asr || "未发现" }}</div>
    </v-card>
  </section>
</template>

<style scoped>
.speech-status-grid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 16px; margin-bottom: 18px; }
.speech-stat-card { padding: 20px; }
.stat-label, .stat-note { color: var(--text-muted); }
.stat-label { font-size: 12px; font-weight: 800; letter-spacing: .08em; text-transform: uppercase; }
.stat-value { margin-top: 8px; font-size: 28px; font-weight: 900; }
.stat-note { margin-top: 6px; font-size: 12px; }
.speech-stat-line { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.speech-stat-value { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
@media (max-width: 1100px) { .speech-status-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
@media (max-width: 700px) { .speech-status-grid { grid-template-columns: 1fr; } }
</style>
