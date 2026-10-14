<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from "vue";
import type { CompanionSession, CompanionSnapshot } from "@shared/companionActivity";
import { companionRequest, setCompanionMode } from "../companionActivityClient";
import { managerEventSource } from "../managerApi";
import { speechControlClient } from "../speech/speechControlClient";
import { userFacingError } from "../userFacingError";

const props = defineProps<{ roleId: string; gatewayId: string }>();
const snapshot = ref<CompanionSnapshot>({ presets: [], session: null });
const session = computed(() => snapshot.value.session);
const active = computed(() => !!session.value && session.value.status !== "ended");
const busy = ref(false), error = ref(""), mode = ref("adaptive"), title = ref(""), discussion = ref("");
const working = computed(() => session.value?.activityKind === "work"
  || snapshot.value.presets.find(preset => preset.id === mode.value)?.activityKind === "work");
const autoReview = ref(true), voice = ref(false), saveSummary = ref(false);
const video = ref<HTMLVideoElement | null>(null), fileInput = ref<HTMLInputElement | null>(null), subtitleInput = ref<HTMLInputElement | null>(null);
const videoUrl = ref(""), subtitleUrl = ref(""), source = ref<"window" | "player" | null>(null);
const lastSummary = ref<CompanionSession | null>(null), microphoneRecording = ref(false);
const sourceReady = computed(() => !!source.value && !!video.value && video.value.readyState >= 2);
const stateLabel = computed(() => !active.value ? "未开始" : session.value?.status === "paused" ? "已暂停" : source.value || session.value?.observationOwner === "desktop" ? "正在陪伴" : "来源已中断");
const reviewLabel = computed(() => ({ dispatching: "正在交给 Agent", delivered: "Agent 已接收，等待回应", replied: "已回应", failed: "投递失败", expired: "上一段回应已过期" }[session.value?.review?.status || "replied"]));
let events: EventSource | null = null, stream: MediaStream | null = null, micStream: MediaStream | null = null;
let micDeadline: ReturnType<typeof setTimeout> | undefined;
let recorder: MediaRecorder | null = null, frameHandle = 0, sequence = 0, epoch = 0, alive = true;
let lastCaptureAt = 0, captureBusy = false;
let commandQueue: Promise<unknown> = Promise.resolve();
const canvas = document.createElement("canvas");
let unloadHandler: (() => void) | null = null;

function accept(next: CompanionSnapshot) {
  if (!alive) return;
  if (next.session?.id === session.value?.id && next.session && session.value && next.session.revision < session.value.revision) return;
  if (next.session?.id === session.value?.id && next.session && session.value && next.session.version < session.value.version) return;
  snapshot.value = next;
  if (next.session && next.session.status !== "ended") mode.value = next.session.presetId;
  else if (!next.presets.some(preset => preset.id === mode.value)) mode.value = next.presets[0]?.id || "";
}
async function changeMode(presetId: string) {
  if (!active.value || busy.value) return;
  busy.value = true; error.value = "";
  const work = commandQueue.catch(() => undefined).then(async () => {
    const s = session.value;
    if (!s || s.status === "ended" || s.presetId === presetId) return;
    const next = await setCompanionMode(props.roleId, s, presetId);
    sequence = 0; epoch++; accept(next);
  });
  commandQueue = work;
  try { await work; }
  catch (cause) { mode.value = session.value?.presetId || mode.value; error.value = userFacingError(cause); }
  finally { busy.value = false; }
}
async function action(name: "pause" | "resume" | "seek" | "stop" | "interrupt", positionSeconds?: number) {
  const work = commandQueue.catch(() => undefined).then(async () => {
    if (!active.value) return;
    const s = session.value!;
    const next = await companionRequest(props.roleId, "command", { sessionId: s.id, revision: s.revision, action: name, positionSeconds });
    sequence = 0; epoch++; accept(next);
  });
  commandQueue = work; return work;
}
function releaseSource() {
  epoch++;
  if (video.value && frameHandle) video.value.cancelVideoFrameCallback(frameHandle);
  frameHandle = 0;
  const previous = stream; stream = null;
  previous?.getTracks().forEach(track => { track.onended = null; track.onmute = null; track.stop(); });
  if (video.value) { video.value.pause(); video.value.srcObject = null; }
  source.value = null;
  if (videoUrl.value) URL.revokeObjectURL(videoUrl.value);
  if (subtitleUrl.value) URL.revokeObjectURL(subtitleUrl.value);
  videoUrl.value = ""; subtitleUrl.value = "";
}
async function begin() {
  const next = await companionRequest(props.roleId, "start", { requestId: crypto.randomUUID(), gatewayId: props.gatewayId,
    presetId: mode.value, title: title.value, autoReview: autoReview.value, voice: voice.value, saveSummary: saveSummary.value });
  accept(next); sequence = 0;
}
async function shareWindow() {
  if (busy.value) return;
  busy.value = true; error.value = "";
  try {
    if (active.value && session.value?.observationOwner === "desktop") { await action("resume"); return; }
    if (active.value) await action("stop");
    releaseSource();
    accept(await companionRequest(props.roleId, "start", { requestId: crypto.randomUUID(), gatewayId: props.gatewayId,
      presetId: mode.value, title: title.value, autoReview: autoReview.value, voice: voice.value, saveSummary: saveSummary.value, observationOwner: "desktop" }));
  } catch (cause) { error.value = userFacingError(cause); }
  finally { busy.value = false; }
}
async function chooseFile(event: Event) {
  const file = (event.target as HTMLInputElement).files?.[0];
  if (!file) return;
  busy.value = true; error.value = "";
  try {
    if (active.value) await action("stop");
    releaseSource(); source.value = "player"; title.value ||= file.name;
    videoUrl.value = URL.createObjectURL(file);
    await nextTick(); video.value!.load();
    await begin();
  } catch (cause) { releaseSource(); error.value = userFacingError(cause); }
  finally { busy.value = false; (event.target as HTMLInputElement).value = ""; }
}
function chooseSubtitles(event: Event) {
  const file = (event.target as HTMLInputElement).files?.[0];
  if (!file) return;
  if (!file.name.toLowerCase().endsWith(".vtt") || file.size > 1024 * 1024) { error.value = "请选择不超过 1 MiB 的 WebVTT 字幕"; return; }
  if (subtitleUrl.value) URL.revokeObjectURL(subtitleUrl.value);
  subtitleUrl.value = URL.createObjectURL(file);
  (event.target as HTMLInputElement).value = "";
}
function subtitleText() {
  const lines: string[] = [];
  if (source.value === "player" && video.value) {
    for (const track of Array.from(video.value.textTracks)) {
      if (track.mode === "disabled") track.mode = "hidden";
      for (const cue of Array.from(track.activeCues || [])) if ("text" in cue) lines.push(String(cue.text));
    }
  }
  return lines.join("\n").slice(0, 2000);
}
async function capture(force = false) {
  if (captureBusy || !active.value || !video.value || video.value.readyState < 2 || !source.value) return;
  if (!force && session.value?.status !== "active") return;
  const localEpoch = epoch, s = session.value!, element = video.value, capturedSource = source.value;
  captureBusy = true;
  try {
    const width = Math.min(960, element.videoWidth), height = Math.round(width * element.videoHeight / element.videoWidth);
    if (!width || !height) return;
    canvas.width = width; canvas.height = height; canvas.getContext("2d")!.drawImage(element, 0, 0, width, height);
    const jpeg = canvas.toDataURL("image/jpeg", 0.72).split(",")[1];
    if (!alive || localEpoch !== epoch) return;
    const next = await companionRequest(props.roleId, "observation", { sessionId: s.id, revision: s.revision,
      observation: { sequence: ++sequence, capturedAt: Date.now(), source: capturedSource, jpeg, subtitle: subtitleText(),
        ...(capturedSource === "player" ? { positionSeconds: element.currentTime, paused: element.paused } : {}) } });
    if (localEpoch === epoch) accept(next);
  } catch (cause) { if (alive && localEpoch === epoch) error.value = userFacingError(cause); }
  finally { captureBusy = false; }
}
function scheduleFrames() {
  if (!video.value || !source.value || !alive) return;
  if (frameHandle) video.value.cancelVideoFrameCallback(frameHandle);
  frameHandle = video.value.requestVideoFrameCallback(() => {
    frameHandle = 0;
    if (Date.now() - lastCaptureAt >= 1000) { lastCaptureAt = Date.now(); void capture(); }
    scheduleFrames();
  });
}
async function playerEvent(name: "pause" | "resume" | "seek") {
  if (source.value !== "player" || !active.value || busy.value) return;
  try {
    if (name === "seek") await action("seek", video.value?.currentTime);
    else if ((name === "pause") !== (session.value?.status === "paused")) await action(name);
    await capture(true); if (name !== "pause") scheduleFrames();
  } catch (cause) { error.value = userFacingError(cause); }
}
async function togglePause() {
  if (!active.value) return;
  try {
    const resume = session.value?.status === "paused";
    await action(resume ? "resume" : "pause");
    if (source.value === "player") { if (resume) await video.value?.play(); else video.value?.pause(); }
    await capture(true); scheduleFrames();
  } catch (cause) { error.value = userFacingError(cause); }
}
async function stop() {
  busy.value = true;
  try { await action("stop"); releaseSource(); }
  catch (cause) { error.value = userFacingError(cause); }
  finally { busy.value = false; }
}
async function ask() {
  if (!discussion.value.trim() || !active.value || busy.value) return;
  busy.value = true; error.value = "";
  try {
    if (session.value?.observationOwner !== "desktop") { await action("interrupt"); await capture(true); }
    const s = session.value!; const text = discussion.value;
    accept(await companionRequest(props.roleId, "review", { sessionId: s.id, revision: s.revision, text }));
    discussion.value = "";
  } catch (cause) { error.value = userFacingError(cause); }
  finally { busy.value = false; }
}
async function toggleMicrophone() {
  if (recorder && microphoneRecording.value) { recorder.stop(); microphoneRecording.value = false; return; }
  try {
    if (session.value?.observationOwner !== "desktop") await action("interrupt");
    const selected = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
    micStream = selected; const chunks: Blob[] = []; const localEpoch = epoch;
    recorder = new MediaRecorder(selected);
    const recording = recorder; let bytes = 0;
    recorder.ondataavailable = event => { if (event.data.size) { bytes += event.data.size; if (bytes <= 5 * 1024 * 1024) chunks.push(event.data); else if (recording.state === "recording") recording.stop(); } };
    recorder.onstop = () => {
      clearTimeout(micDeadline); microphoneRecording.value = false;
      selected.getTracks().forEach(track => track.stop()); micStream = null;
      void (async () => {
        if (!alive || epoch !== localEpoch) return;
        const status = await speechControlClient.status();
        if (status.state !== "online" || !status.defaults.asr) throw new Error("请先在语音服务中启用 ASR 模型");
        const result = await speechControlClient.transcribe(new Blob(chunks, { type: recording.mimeType || "audio/webm" }), "companion-user.webm", status.defaults.asr);
        if (!alive || epoch !== localEpoch) return;
        discussion.value = result.text; await ask();
      })().catch(cause => { if (alive) error.value = userFacingError(cause); });
    };
    recorder.start(1000); microphoneRecording.value = true;
    micDeadline = setTimeout(() => { if (recording.state === "recording") recording.stop(); }, 30_000);
  } catch (cause) { micStream?.getTracks().forEach(track => track.stop()); error.value = userFacingError(cause); }
}
onMounted(async () => {
  try {
    accept(await companionRequest(props.roleId));
    const response = await fetch(`/api/roles/${encodeURIComponent(props.roleId)}/companion/last`, { signal: AbortSignal.timeout(12_000) });
    if (response.ok) lastSummary.value = (await response.json()).data;
    events = managerEventSource("/api/events");
    events.addEventListener("companion_changed", event => {
      const update = JSON.parse((event as MessageEvent).data);
      if (update.roleId === props.roleId) accept({ ...snapshot.value, session: update.session });
    });
    events.onerror = () => { error.value = "Manager 连接中断；采集会在会话期限内暂停"; };
    unloadHandler = () => { stream?.getTracks().forEach(track => track.stop()); micStream?.getTracks().forEach(track => track.stop()); };
    window.addEventListener("pagehide", unloadHandler);
  } catch (cause) { error.value = userFacingError(cause); }
});
onBeforeUnmount(() => {
  const s = session.value;
  alive = false; events?.close(); if (unloadHandler) window.removeEventListener("pagehide", unloadHandler);
  clearTimeout(micDeadline); micStream?.getTracks().forEach(track => track.stop()); if (recorder?.state === "recording") recorder.stop();
  releaseSource();
  if (s && s.status === "active" && s.observationOwner === "browser") void companionRequest(props.roleId, "command", { sessionId: s.id, revision: s.revision, action: "pause" }).catch(() => undefined);
});
</script>

<template>
  <v-card class="app-card glass-card section-card companion-panel">
    <div class="section-title-row"><h2 class="section-title">共同活动</h2><v-chip>{{ stateLabel }}</v-chip></div>
    <v-alert v-if="error || session?.error" type="error" variant="tonal" class="my-3">{{ error || session?.error }}</v-alert>
    <div class="companion-settings">
      <v-select v-model="mode" :items="snapshot.presets" item-title="label" item-value="id" label="陪伴方式" :disabled="busy" @update:model-value="changeMode" />
      <v-text-field v-model="title" label="活动名称（可选）" maxlength="200" :disabled="active" />
    </div>
    <div v-if="!active" class="companion-options">
      <v-checkbox v-model="autoReview" label="随内容变化主动回应" hide-details />
      <v-checkbox v-model="voice" label="使用人格语音" hide-details />
      <v-checkbox v-model="saveSummary" label="结束时保存进度与本次讨论" hide-details />
    </div>
    <p class="section-note">陪伴模式跟随前台窗口，可自动识别，也可选择观看、游戏、工作或安静陪伴。工作时保持安静，需要帮助时再开口。当前画面会交给本人格的 Agent；语音按钮只在按下后录入你的话。</p>
    <div class="companion-controls">
      <v-btn color="primary" :loading="busy" @click="shareWindow">开启陪伴模式</v-btn>
      <v-btn :disabled="busy" @click="fileInput?.click()">打开本地视频</v-btn>
      <v-btn v-if="source === 'player'" @click="subtitleInput?.click()">加载 VTT 字幕</v-btn>
      <v-btn v-if="active" :disabled="busy" @click="togglePause">{{ session?.status === 'paused' ? '继续' : '暂停' }}</v-btn>
      <v-btn v-if="active" :disabled="busy" @click="stop">结束</v-btn>
    </div>
    <input ref="fileInput" type="file" accept="video/*" hidden @change="chooseFile" />
    <input ref="subtitleInput" type="file" accept=".vtt" hidden @change="chooseSubtitles" />
    <video ref="video" class="companion-video" :class="{ 'companion-video-empty': !source }" :src="videoUrl || undefined"
      :controls="source === 'player'" playsinline @play="playerEvent('resume')" @pause="playerEvent('pause')" @seeked="playerEvent('seek')" @loadeddata="capture(true)" @ended="stop">
      <track v-if="subtitleUrl" :src="subtitleUrl" kind="subtitles" label="字幕" default />
    </video>
    <p v-if="active" class="section-note">{{ reviewLabel }}<span v-if="session?.positionSeconds !== null"> · {{ Math.floor(session?.positionSeconds || 0) }} 秒</span></p>
    <v-alert v-if="session?.review?.error" type="warning" variant="tonal">{{ session.review.error }}</v-alert>
    <div v-if="active" class="companion-discussion">
      <v-text-field v-model="discussion" :label="working ? '需要帮忙时告诉我' : '和我聊刚才的内容'" :disabled="busy" @keyup.enter="ask" hide-details />
      <v-btn :disabled="busy || (!source && session?.observationOwner !== 'desktop')" :color="microphoneRecording ? 'error' : undefined" @click="toggleMicrophone">{{ microphoneRecording ? '说完了' : '说话' }}</v-btn>
      <v-btn color="secondary" :disabled="busy || !discussion.trim() || (!source && session?.observationOwner !== 'desktop')" @click="ask">聊聊</v-btn>
    </div>
    <div v-if="session?.notes.length" class="companion-notes" aria-live="polite">
      <p v-for="(note, index) in session.notes.slice(-8)" :key="`${session.id}-${note.at}-${index}`"><b>{{ note.speaker === 'user' ? '你' : '回应' }}</b> {{ note.text }}</p>
    </div>
    <p v-if="!active && lastSummary" class="section-note">上次：{{ lastSummary.title || lastSummary.presetId }}<span v-if="lastSummary.positionSeconds !== null"> · {{ Math.floor(lastSummary.positionSeconds) }} 秒</span>。开启陪伴模式后继续。</p>
  </v-card>
</template>

<style scoped>
.companion-settings { display: grid; grid-template-columns: minmax(180px, 1fr) minmax(240px, 2fr); gap: 16px; margin-top: 20px; }
.companion-options, .companion-controls { display: flex; flex-wrap: wrap; gap: 12px; align-items: center; }
.companion-controls { margin: 16px 0; }
.companion-video { display: block; width: 100%; max-height: 55vh; background: #111; border-radius: 12px; }
.companion-video-empty { height: 1px; }
.companion-discussion { display: flex; align-items: center; gap: 12px; margin-top: 16px; }
.companion-notes { max-height: 260px; overflow: auto; margin-top: 16px; }
.companion-notes p { margin: 10px 0; white-space: pre-wrap; }
@media (max-width: 700px) { .companion-settings { grid-template-columns: 1fr; gap: 0; } .companion-discussion { flex-wrap: wrap; } }
</style>
