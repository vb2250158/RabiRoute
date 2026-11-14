<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import { useRoute } from "vue-router";
import { useGatewayStore } from "../../../../ribiwebgui/src/stores/gatewayStore";
import { managerEventSource } from "../../../../ribiwebgui/src/managerApi";
import { createSpeechControlClient } from "../../io.rabiroute.manager.speech/web/speech/speechControlClient";
import { createDesktopAssistant, type DesktopAssistantEvent } from "./speech/desktopAssistant";
import type { SpeechPersona, SpeechModel } from "@shared/speechControlContract";

const gatewayStore = useGatewayStore();
const pageRoute = useRoute();
const routeChoices = computed(() => gatewayStore.routeSummaries.filter(value =>
  typeof pageRoute.query.roleId !== "string" || value.agentRoleId === pageRoute.query.roleId));
const client = createSpeechControlClient();
const routeId = ref(""), asrModel = ref(""), ttsModel = ref(""), draft = ref("");
const personas = ref<SpeechPersona[]>([]), models = ref<SpeechModel[]>([]);
const outputEnabled = ref(true);
const active = ref(false), loading = ref(true), status = ref("选择角色路由与语音模型"), error = ref("");
const capture = ref<"starting" | "listening" | "stopped">("stopped");
const messages = ref<{ id: string; kind: string; text: string }[]>([]);
let owner: ReturnType<typeof createDesktopAssistant> | undefined;
const route = computed(() => gatewayStore.routeSummaries.find(value => value.id === routeId.value));
const persona = computed(() => personas.value.find(value => value.id === route.value?.agentRoleId));
const available = (capability: string) => models.value.filter(value => value.capability === capability && value.available && value.enabled);
const ready = computed(() => Boolean(route.value?.running && persona.value?.voiceReady && asrModel.value && ttsModel.value));
const rememberError = (value: unknown) => { error.value = value instanceof Error ? value.message : String(value); };
function append(kind: string, text: string, id: string = crypto.randomUUID()) {
  if (!messages.value.some(message => message.id === id)) messages.value.push({ id, kind, text });
  if (messages.value.length > 200) messages.value.splice(0, messages.value.length - 200);
}
function event(value: DesktopAssistantEvent) {
  if (value.type === "input") { append("你", value.text); status.value = "正在提交"; }
  if (value.type === "reply") { append(persona.value?.id || "助手", value.reply.text, value.reply.messageId); status.value = "回复已送达"; }
  if (value.type === "admission") status.value = value.admission.uncertain ? "提交结果尚待确认，请勿重复发送" : "助手已接收，正在处理";
  if (value.type === "status") status.value = value.text;
  if (value.type === "capture") capture.value = value.state;
  if (value.type === "error") rememberError(value.error);
}
function start() {
  if (owner || !ready.value || !persona.value) return;
  error.value = "";
  try {
    owner = createDesktopAssistant({ gatewayId: routeId.value, persona: persona.value,
      asrModel: asrModel.value, ttsModel: ttsModel.value }, { fetch: (...args) => fetch(...args), openEvents: managerEventSource, onEvent: event });
    active.value = true;
    owner.setOutputEnabled(outputEnabled.value);
    owner.setVisible(document.visibilityState === "visible");
    status.value = "会话已开启";
    owner.activate();
  } catch (value) { rememberError(value); void stop(); }
}
function pauseVoice() {
  outputEnabled.value = false;
  owner?.pauseVoice();
  status.value = "语音已暂停，文字回复和任务继续";
}
function toggleOutput() {
  outputEnabled.value = !outputEnabled.value;
  owner?.setOutputEnabled(outputEnabled.value);
}
function visibilityChanged() { owner?.setVisible(document.visibilityState === "visible"); }
function pageHidden() { owner?.setVisible(false); }
async function stop() {
  const previous = owner; owner = undefined; active.value = false;
  status.value = "语音已停止；已提交的任务继续执行";
  try { await previous?.dispose(); } catch (value) { rememberError(value); }
}
function submit() {
  if (!owner || !draft.value.trim()) return;
  if (owner.submitText(draft.value)) draft.value = "";
}
onMounted(async () => {
  document.addEventListener("visibilitychange", visibilityChanged);
  window.addEventListener("pagehide", pageHidden);
  window.addEventListener("pageshow", visibilityChanged);
  try {
    const [voiceData, modelData] = await Promise.all([client.personas(), client.models(), gatewayStore.loadRouteSummaries()]);
    personas.value = voiceData.personas; models.value = modelData.models;
    if (pageRoute.query.roleId && routeChoices.value.length === 1) routeId.value = routeChoices.value[0]!.id;
  } catch (value) { rememberError(value); } finally { loading.value = false; }
});
onBeforeUnmount(() => {
  document.removeEventListener("visibilitychange", visibilityChanged);
  window.removeEventListener("pagehide", pageHidden);
  window.removeEventListener("pageshow", visibilityChanged);
  void stop();
});
</script>

<template>
  <section class="voice-assistant">
    <header><h1>语音助手</h1><span role="status">{{ status }}</span></header>
    <p v-if="active" role="status">{{ capture === 'listening' ? '麦克风正在聆听' : capture === 'starting' ? '正在等待麦克风权限与设备启动' : '麦克风未开启，仍可输入文字' }}</p>
    <v-alert v-if="error" type="error" variant="tonal" closable @click:close="error = ''">{{ error }}</v-alert>
    <div class="voice-settings">
      <v-select v-model="routeId" label="角色路由" :items="routeChoices" item-title="name" item-value="id" :disabled="active || loading" />
      <v-select v-model="asrModel" label="语音识别" :items="available('asr')" item-title="name" item-value="id" :disabled="active || loading" />
      <v-select v-model="ttsModel" label="语音合成" :items="available('tts')" item-title="name" item-value="id" :disabled="active || loading" />
    </div>
    <p v-if="route && !route.running">请先启动所选路由。</p>
    <p v-else-if="route && !persona?.voiceReady">请先配置所选角色的声音。</p>
    <div class="voice-controls">
      <v-btn v-if="!active" color="primary" prepend-icon="mdi-microphone" :disabled="!ready" @click="start">开始对话</v-btn>
      <v-btn v-else color="primary" prepend-icon="mdi-stop" @click="pauseVoice">暂停语音</v-btn>
      <v-btn :disabled="!active" variant="outlined" @click="toggleOutput">{{ outputEnabled ? "关闭朗读" : "开启朗读" }}</v-btn>
      <v-btn v-if="active && capture === 'stopped'" variant="outlined" @click="owner?.activate()">重新开启麦克风</v-btn>
    </div>
    <div class="voice-messages" aria-live="polite">
      <article v-for="message in messages" :key="message.id"><strong>{{ message.kind }}</strong><p>{{ message.text }}</p></article>
      <p v-if="!messages.length">开始后可以直接说话，也可以输入文字。</p>
    </div>
    <form class="voice-input" @submit.prevent="submit">
      <v-text-field v-model="draft" label="说点什么" :disabled="!active" maxlength="4000" hide-details />
      <v-btn type="submit" :disabled="!active || !draft.trim()">发送</v-btn>
    </form>
  </section>
</template>

<style scoped>
.voice-assistant { max-width: 960px; margin: 0 auto; padding: 24px; display: grid; gap: 20px; }
header { display: flex; align-items: baseline; justify-content: space-between; gap: 16px; flex-wrap: wrap; }
h1 { font-size: 1.6rem; } header span { opacity: .72; }
.voice-settings { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 12px; }
.voice-controls, .voice-input { display: flex; align-items: center; gap: 12px; }
.voice-messages { min-height: 240px; max-height: 52vh; overflow: auto; display: flex; flex-direction: column; gap: 18px; }
.voice-messages p { white-space: pre-wrap; overflow-wrap: anywhere; margin-top: 5px; }
.voice-messages strong { font-size: .85rem; opacity: .65; }
@media (max-width: 640px) { .voice-settings { grid-template-columns: 1fr; } .voice-assistant { padding: 16px; } }
</style>
