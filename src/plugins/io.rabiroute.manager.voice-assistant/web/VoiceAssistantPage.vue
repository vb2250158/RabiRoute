<script setup lang="ts">
import {computed,onBeforeUnmount,onMounted,ref,shallowRef,watch} from 'vue';
import {mountAssistantPanel} from './assistant-app';
import {managerResourceUrl} from '../../../../ribiwebgui/src/managerApi';
import {managerAvatarUrl} from './avatar-resource-url.mjs';
import ComputerModelPicker from '../../../../ribiwebgui/src/components/ComputerModelPicker.vue';
import AssistantModelPicker from './AssistantModelPicker.vue';
import PeerServerSelect from '../../../../ribiwebgui/src/components/PeerServerSelect.vue';
import {userFacingError} from '../../../../ribiwebgui/src/userFacingError';
import type {SpeechTranscriptionResult} from '@shared/speechControlContract';
import SpeechRecognitionDetails from '../../io.rabiroute.manager.speech/web/components/SpeechRecognitionDetails.vue';
import {createSpeechControlClient,speechControlClient} from '../../io.rabiroute.manager.speech/web/speech/speechControlClient';

const container=ref<HTMLElement>();let dispose:(()=>void)|undefined;
type PickerProps = InstanceType<typeof AssistantModelPicker>['$props'];
const pickers=shallowRef<Record<string,{target:HTMLElement;props:PickerProps}>>({});
function setModelPicker(id:string,target:HTMLElement|null,props?:PickerProps) {
  const next={...pickers.value};
  if(target&&props)next[id]={target,props};
  else delete next[id];
  pickers.value=next;
}
const uploadOpen = ref(false);
const uploadFile = ref<File>();
const computeDeviceId = ref("");
const model = ref("");
const modelLabels = new Map<string, Map<string, string>>();
const modelLabel = computed(() => modelLabels.get(computeDeviceId.value)?.get(model.value) || model.value);
const result = ref<SpeechTranscriptionResult>();
const uploadError = ref("");
const transcribing = ref(false);
let activeUpload: AbortController | undefined;

async function loadRecognitionModels(device: string, signal: AbortSignal) {
  const { models } = await speechControlClient.models({ computeDeviceId: device, signal });
  const options = models.filter(item => item.capability === "asr" && item.enabled).map(item => ({
    title: item.name, value: item.id, disabled: !item.available,
    subtitle: item.available ? item.id : `${item.id} · 未就绪`
  }));
  if (!signal.aborted) modelLabels.set(device, new Map(options.map(item => [item.value, item.title])));
  return options;
}

function selectRecognitionModel(device: string, id: string) {
  computeDeviceId.value = device;
  model.value = id;
}

function selectAudioFile(event: Event) {
  uploadFile.value = (event.target as HTMLInputElement).files?.[0];
  uploadError.value = "";
  result.value = undefined;
}

async function transcribeAudio() {
  if (transcribing.value || !uploadFile.value || !model.value) return;
  const controller = new AbortController();
  activeUpload = controller;
  const target = new URLSearchParams({ computeDeviceId: computeDeviceId.value });
  const client = createSpeechControlClient((path, init) => fetch(`${path}?${target}`, init));
  uploadError.value = "";
  result.value = undefined;
  transcribing.value = true;
  try {
    const file = uploadFile.value;
    const transcript = await client.transcribe(file, file.name, model.value, undefined, undefined, undefined, controller.signal);
    if (!controller.signal.aborted) result.value = transcript;
  } catch (error) {
    if (!controller.signal.aborted) uploadError.value = userFacingError(error);
  } finally {
    if (activeUpload === controller) {
      activeUpload = undefined;
      transcribing.value = false;
    }
  }
}

watch(uploadOpen, open => {
  if (open) return;
  activeUpload?.abort();
  uploadFile.value = undefined;
  result.value = undefined;
  uploadError.value = "";
});
onMounted(()=>{if(container.value)dispose=mountAssistantPanel(container.value,{setModelPicker,resolveAvatarUrl:url=>managerAvatarUrl(url,managerResourceUrl,window.location.href)})});
onBeforeUnmount(()=>{activeUpload?.abort();dispose?.()});
</script>
<template>
  <section class="rabi-voice-assistant">
    <div class="assistant-page-heading">
      <h1>语音助手</h1>
      <div class="d-flex flex-wrap ga-1">
        <v-btn variant="text" prepend-icon="mdi-history"
          :to="{ path: '/model-services', query: { settings: '1', section: 'speech-diagnostics' } }">转写记录</v-btn>
        <v-btn variant="text" prepend-icon="mdi-file-music-outline" @click="uploadOpen = true">上传音频转写</v-btn>
      </div>
    </div>
    <div ref="container" class="rabi-voice-assistant-body" />
    <Teleport v-for="(picker,id) in pickers" :key="id" :to="picker.target">
      <AssistantModelPicker v-bind="picker.props" />
    </Teleport>
    <v-dialog v-model="uploadOpen" max-width="720">
      <v-card title="上传音频转写" class="app-card">
        <v-card-text class="assistant-upload-form">
          <label>
            <span class="d-block mb-2">音频文件</span>
            <input type="file" accept="audio/*,.wav,.mp3,.flac,.m4a,.ogg,.opus,.webm" :disabled="transcribing" @change="selectAudioFile" />
          </label>
          <PeerServerSelect v-if="uploadOpen" :model-value="computeDeviceId" v-slot="computers">
            <ComputerModelPicker label="转写模型" :model-id="model" :model-label="modelLabel" :device-id="computeDeviceId"
              :computers="computers" :load-models="loadRecognitionModels" :choose="selectRecognitionModel" :disabled="transcribing" />
          </PeerServerSelect>
          <v-alert v-if="uploadError" type="error" variant="tonal">{{ uploadError }}</v-alert>
          <template v-if="result">
            <v-textarea v-if="result.text" label="转写文本" :model-value="result.text" readonly />
            <v-alert v-else type="info" variant="tonal">这段音频没有识别出文字。</v-alert>
            <SpeechRecognitionDetails :result="result" />
          </template>
        </v-card-text>
        <v-card-actions>
          <v-spacer />
          <v-btn @click="uploadOpen = false">关闭</v-btn>
          <v-btn color="primary" :loading="transcribing" :disabled="transcribing || !uploadFile || !model" @click="transcribeAudio">开始转写</v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>
  </section>
</template>
<style scoped>
.rabi-voice-assistant {
  box-sizing: border-box;
  height: var(--rr-content-height, calc(100dvh - var(--v-layout-top, 64px) - var(--v-layout-bottom, 0px)));
  min-height: 0;
  min-width: 0;
  display: flex;
  flex-direction: column;
  padding: 18px 24px;
}
.assistant-page-heading {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  flex-shrink: 0;
  margin-bottom: 8px;
}
.assistant-page-heading h1 {
  font-size: 22px;
  margin: 0;
}
.assistant-upload-form { display: grid; gap: 16px; }
.rabi-voice-assistant-body {
  flex: 1;
  min-height: 0;
  min-width: 0;
  overflow: hidden;
}
.rabi-voice-assistant-body :deep(.va-panel) { width: 100%; }
.rabi-voice-assistant-body :deep(.va-full-page) { overflow: auto; }
.rabi-voice-assistant-body :deep(.rabi-assistant-settings) {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
}
.rabi-voice-assistant-body :deep(.rabi-settings-heading) { flex-shrink: 0; }
.rabi-voice-assistant-body :deep(.va-settings) {
  flex: 1;
  width: 100%;
  height: auto;
  min-height: 0;
}
/* Supply the native controls that the standalone page normally styles. */
:where(.rabi-voice-assistant-body) :deep(button) {
  border: 1px solid var(--va-line, #31454f);
  border-radius: 8px;
  padding: 8px 12px;
  background: var(--rr-surface-glass, #14242d);
  color: inherit;
  font: inherit;
  cursor: pointer;
}
:where(.rabi-voice-assistant-body) :deep(button:disabled) {
  opacity: .5;
  cursor: not-allowed;
}
:where(.rabi-voice-assistant-body) :deep(button:focus-visible),
.rabi-voice-assistant-body :deep(.va-compose input:focus-visible) {
  outline: 2px solid var(--va-accent, #69d6bd);
  outline-offset: 2px;
}
.rabi-voice-assistant-body :deep(.va-compose input) {
  border: 1px solid var(--va-line, #31454f);
  border-radius: 8px;
  padding: 10px 12px;
  background: var(--rr-surface-glass, #14242d);
  color: inherit;
  font: inherit;
}
@media (max-width: 600px) {
  .rabi-voice-assistant { padding: 12px; }
}
</style>
