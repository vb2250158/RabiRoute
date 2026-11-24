<script setup lang="ts">
import { rabiLinkModelServices, type RabiLinkModelScope, type RabiLinkModelService } from "@shared/rabiLinkModelServices";
import { useI18n } from "../../../../../ribiwebgui/src/i18n/index";

defineProps<{ providing: boolean }>();
const scope = defineModel<RabiLinkModelScope>({ required: true });
const { t } = useI18n();
const labels: Record<RabiLinkModelService, { title: string; description: string; icon: string }> = {
  tts: { title: "语音合成（TTS）", description: "将文字转换为语音。", icon: "mdi-waveform" },
  asr: { title: "语音识别（ASR）", description: "将音频转写为文字。", icon: "mdi-microphone-outline" },
  workbench: { title: "工作台模型", description: "为工作台提供图像和视频生成算力。", icon: "mdi-video-outline" }
};
</script>

<template>
  <section>
    <h3 class="section-title">模型范围</h3>
    <p v-if="!providing" class="section-note mt-1">提供模型服务已关闭。开启后应用此处保存的范围。</p>
    <v-list bg-color="transparent" lines="two" class="mt-2">
      <template v-for="(id, index) in rabiLinkModelServices" :key="id">
        <v-divider v-if="index" />
        <v-list-item :prepend-icon="labels[id].icon" :title="t(labels[id].title)" :subtitle="t(labels[id].description)">
          <template #append>
            <v-switch :model-value="scope[id]" :label="t(labels[id].title)" class="model-scope-switch"
              color="success" density="compact" inset hide-details
              @update:model-value="value => scope = { ...scope, [id]: value === true }" />
          </template>
        </v-list-item>
      </template>
    </v-list>
  </section>
</template>

<style scoped>
.model-scope-switch :deep(.v-label) { position: absolute; width: 1px; height: 1px; clip-path: inset(50%); overflow: hidden; }
</style>
