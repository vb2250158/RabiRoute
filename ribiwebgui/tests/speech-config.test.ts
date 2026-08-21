import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import {
  DEFAULT_RECENT_MESSAGE_LIMIT,
  MAX_RECENT_MESSAGE_LIMIT,
  RECENT_MESSAGE_ENDPOINTS
} from "../../src/shared/gatewayConfigModel";
import {
  isSpeechRouteVariableKey,
  SPEECH_ROUTE_VARIABLE_KEYS
} from "../../src/shared/speechControlContract";
import {
  hotDeliveryEnabled,
  SPEECH_ROUTE_AUTO_SUBMIT,
  speechPushModeForHotDelivery
} from "../src/speech/speechDeliveryMode";
import {
  transcriptSpeakerPresentation,
  unknownVoiceprintGroupLabel,
  voiceprintPresentation
} from "../src/speech/speechSpeakerPresentation";
import {
  speechHistoryDeliveryPresentation,
  speechMessageResultText
} from "../src/speech/speechDeliveryPresentation";
import {
  formatSpeechEpochSeconds,
  speechAudioCacheReferenceKind
} from "../src/speech/speechRecordPresentation";

test("maps the speech hot-delivery switch to the route push mode", () => {
  assert.equal(speechPushModeForHotDelivery(true), "hot");
  assert.equal(speechPushModeForHotDelivery(false), "keyword");
  assert.equal(hotDeliveryEnabled(undefined), true);
  assert.equal(hotDeliveryEnabled("keyword"), false);
});

test("exposes one recent-context limit for every message endpoint", () => {
  assert.equal(DEFAULT_RECENT_MESSAGE_LIMIT, 12);
  assert.equal(MAX_RECENT_MESSAGE_LIMIT, 200);
  assert.deepEqual(RECENT_MESSAGE_ENDPOINTS, [
    "napcat",
    "remoteAgent",
    "heartbeat",
    "rolePanel",
    "speech",
    "fennenote",
    "xiaoai",
    "rabilink",
    "wearable",
    "webhook",
    "wecom",
    "weixin",
    "feishu"
  ]);
});

test("keeps the legacy Route auto-submit field enabled so keyword mode can record before deciding delivery", () => {
  assert.equal(SPEECH_ROUTE_AUTO_SUBMIT, true);
});

test("speech workbench exposes exact VAD inputs and one host playback volume control", () => {
  const source = fs.readFileSync(new URL("../src/pages/SpeechServicePage.vue", import.meta.url), "utf8");
  const controlPlane = fs.readFileSync(new URL("../../src/manager/controlPlaneRoutes.ts", import.meta.url), "utf8");
  assert.doesNotMatch(source, /投递 Route|会话 ID|送入所选 Route|selectedGatewayId|v-model="autoSubmit"/);
  assert.equal(source.match(/<SpeechParameterSlider\b/g)?.length, 8);
  assert.equal(source.match(/label="主机播放音量"/g)?.length, 1);
  assert.match(source, /:min="0"[\s\S]*:max="100"[\s\S]*@update:model-value="schedulePlaybackVolume"/);
  assert.match(source, /speech\.setPlaybackVolume\(nextVolume\)/);
  assert.match(source, /speech\.updateMicrophoneSettings\(microphoneSettingsCommand\(\)\)/);
  assert.match(source, /具体原因：/);
  assert.match(source, /处理方法：/);
  assert.match(source, /label="开启 ASR 串流"/);
  assert.match(source, /@update:model-value="changeAsrStreamingEnabled"/);
  assert.match(source, /streamingEnabled: asrStreamingEnabled\.value/);
  assert.match(source, /麦克风不会持续录音/);
  assert.match(source, /没有 Route 订阅时只保存主机记录/);
  assert.match(source, /同一段 ASR 会广播给全部/);
  assert.match(source, /<SpeechHostMonitor[^>]+:subscriber-count="speechSubscriberRoutes\.length"/);
  assert.match(controlPlane, /"manager:speech": ctx =>[\s\S]*reconcileActiveSpeech = reconcile/);
  assert.match(controlPlane, /managerPluginActive\("manager:speech"\)[\s\S]*reconcileActiveSpeech\(\)/);
  assert.match(controlPlane, /active = false[\s\S]*speechRuntimeControl\.stop\(\)/);
  assert.doesNotMatch(controlPlane, /reconcileSpeechMicrophone\("gateway save"\)/);
  assert.doesNotMatch(controlPlane, /reconcileSpeechMicrophone\("manual reload"\)/);
  const monitorSource = fs.readFileSync(new URL("../src/components/SpeechHostMonitor.vue", import.meta.url), "utf8");
  assert.match(monitorSource, /主机语音链路/);
  assert.match(monitorSource, /运行日志与转写预览/);
  assert.match(monitorSource, /广播投递/);
});

test("speech workbench renders one mode switch and keeps device logs collapsed by default", () => {
  const source = fs.readFileSync(new URL("../src/pages/SpeechServicePage.vue", import.meta.url), "utf8");
  assert.equal(source.match(/aria-label="切换 TTS 与 ASR"/g)?.length, 1);
  assert.ok(source.indexOf("speech-audio-stream-card") < source.indexOf('aria-label="切换 TTS 与 ASR"'));
  assert.match(source, /const audioLogExpanded = ref\(loadAudioLogExpanded\(\)\)/);
  assert.match(source, /localStorage\.getItem\(AUDIO_LOG_EXPANDED_STORAGE_KEY\) === "true"/);
  assert.match(source, /:aria-expanded="audioLogExpanded"/);
  assert.match(source, /aria-controls="speech-device-log-panel"/);
  assert.match(source, /v-if="audioLogExpanded"[\s\S]*id="speech-device-log-panel"[\s\S]*role="region"/);
});

test("speech workbench owns model management in a lazy dialog instead of the sidebar", () => {
  const page = fs.readFileSync(new URL("../src/pages/SpeechServicePage.vue", import.meta.url), "utf8");
  const app = fs.readFileSync(new URL("../src/App.vue", import.meta.url), "utf8");
  const router = fs.readFileSync(new URL("../src/router.ts", import.meta.url), "utf8");

  assert.match(page, /defineAsyncComponent\(\(\) => import\("\.\/ModelManagementPage\.vue"\)\)/);
  assert.match(page, /prepend-icon="mdi-package-variant-closed"[^>]+@click="modelManagementDialog = true"[^>]*>模型管理<\/v-btn>/);
  assert.match(page, /<v-dialog v-model="modelManagementDialog"[^>]+scrollable>/);
  assert.match(page, /<ModelManagementPage v-if="modelManagementDialog" \/>/);
  assert.doesNotMatch(app, /title: "模型管理"[^\n]+to: "\/models"/);
  assert.match(router, /\{ path: "\/models", redirect: "\/speech" \}/);
  assert.doesNotMatch(router, /const ModelManagementPage/);
});

test("persona route variables hide speech settings owned by dedicated controls", () => {
  assert.ok(SPEECH_ROUTE_VARIABLE_KEYS.includes("speechAutoSubmit"));
  assert.ok(SPEECH_ROUTE_VARIABLE_KEYS.includes("speechAutoPlay"));
  assert.equal(isSpeechRouteVariableKey("speechThreshold"), true);
  assert.equal(isSpeechRouteVariableKey("projectAlias"), false);
  const source = fs.readFileSync(new URL("../src/pages/PersonaTemplatePage.vue", import.meta.url), "utf8");
  assert.match(source, /filter\(\(\[key\]\) => !isSpeechRouteVariableKey\(key\)\)/);
  const routeSource = fs.readFileSync(new URL("../src/pages/RouteConfigPage.vue", import.meta.url), "utf8");
  assert.doesNotMatch(routeSource, /<SpeechParameterSlider/);
  assert.doesNotMatch(routeSource, /SpeechHostMonitor|运行日志与转写预览|实时电平/);
  assert.match(routeSource, /label="热投递"/);
  assert.match(routeSource, /Agent 回复自动排队播放/);
  assert.match(routeSource, /ASR 模型、麦克风、VAD 与切句参数属于整台电脑/);
});

test("never presents an unsupported voiceprint capability as available or experimental", () => {
  const presentation = voiceprintPresentation({
    scope: "loopback-only",
    mode: "manual_session_label_binding",
    manualBinding: true,
    bindingScope: "session_speaker_label",
    aliasesAreMetadataOnly: true,
    diarizationLabelsAreBiometricIdentity: false,
    storesRawEnrollmentAudio: false,
    voiceprint: {
      supported: false,
      experimental: true,
      reason: "No validated matcher is installed."
    }
  });

  assert.deepEqual(presentation, { label: "自动声纹识别不可用", color: "grey" });
  assert.doesNotMatch(presentation.label, /实验/);
});

test("presents unknown and tentative voiceprints as unverified instead of a definite identity", () => {
  assert.equal(unknownVoiceprintGroupLabel("opaque-B843"), "未知声纹（未验证） B843");
  for (const speakerDecision of ["voiceprint_unknown_cluster", "voiceprint_tentative_known", "voiceprint_overlapping_speech"]) {
    assert.equal(transcriptSpeakerPresentation([{
      id: 0,
      start: 0,
      end: 1,
      text: "测试",
      speakerName: "可能的姓名",
      voiceprintId: "opaque-cluster",
      speakerDecision
    }]), "未知声纹（未验证）");
  }
  assert.equal(transcriptSpeakerPresentation([{
    id: 0,
    start: 0,
    end: 1,
    text: "测试",
    speakerName: "已确认姓名",
    speakerDecision: "voiceprint_auto_match"
  }]), "已确认姓名");
});

test("distinguishes clustering from explicitly enabled experimental auto assignment", () => {
  const base = {
    scope: "loopback-only",
    mode: "record_embedding_matching",
    manualBinding: true,
    bindingScope: "record_speaker_label",
    aliasesAreMetadataOnly: true,
    diarizationLabelsAreBiometricIdentity: false as const,
    storesRawEnrollmentAudio: false as const
  };
  assert.deepEqual(voiceprintPresentation({
    ...base,
    voiceprint: { supported: false, available: true, experimental: true, autoAssign: false }
  }), { label: "声纹聚类可用，自动认人待校准", color: "warning" });
  assert.deepEqual(voiceprintPresentation({
    ...base,
    voiceprint: { supported: false, available: true, experimental: true, autoAssign: true }
  }), { label: "自动声纹识别（实验性）", color: "warning" });
});

test("ASR page keeps human speaker settings with unknown and known latest-ten previews", () => {
  const page = fs.readFileSync(new URL("../src/pages/SpeechServicePage.vue", import.meta.url), "utf8");
  const panel = fs.readFileSync(new URL("../src/components/SpeechRecordsAndSpeakers.vue", import.meta.url), "utf8");
  assert.match(page, /<SpeechRecordsAndSpeakers/);
  assert.match(panel, /说话人 \/ 声纹设置/);
  assert.match(panel, /未知说话人/);
  assert.match(panel, /已知说话人/);
  assert.match(panel, /lines\.slice\(0, 10\)/);
  assert.match(panel, /这个分段说话人的最近/);
  assert.match(panel, /sessionId.*speakerLabel/s);
});

test("presents speech delivery receipts without treating Route acceptance as Desktop delivery", () => {
  assert.deepEqual(speechHistoryDeliveryPresentation({
    time: 1,
    text: "继续讨论",
    provider: "fake",
    model: "fake",
    duration: 1,
    submitted: true,
    deliveryStatus: "recorded",
    segments: []
  }), { label: "仅记录，未唤醒", color: "warning" });
  assert.match(speechMessageResultText({
    routeId: "voice-route",
    messageId: "speech-one",
    sessionId: "meeting-one",
    status: "delivered"
  }), /Desktop 目标任务已接收/);
  assert.doesNotMatch(speechMessageResultText({
    routeId: "voice-route",
    messageId: "speech-two",
    sessionId: "meeting-one",
    status: "recorded",
    reason: "keyword_not_matched"
  }), /已送入 Route|Route 已受理/);
});

test("presents persona cache references without depending on host absolute paths", () => {
  assert.equal(
    speechAudioCacheReferenceKind("XinghaiBuilder/voice/cache/tts-audio/speech.wav"),
    "relative-cache-path"
  );
  assert.equal(speechAudioCacheReferenceKind("legacy.wav"), "legacy-filename");
  assert.equal(speechAudioCacheReferenceKind(""), null);
  assert.notEqual(formatSpeechEpochSeconds(1_700_000_000, "zh-CN"), "-");
  assert.notEqual(formatSpeechEpochSeconds(1_700_000_000, "en"), "-");
  assert.equal(formatSpeechEpochSeconds(0, "en"), "-");

  const source = fs.readFileSync(new URL("../src/components/SpeechRecordsAndSpeakers.vue", import.meta.url), "utf8");
  assert.match(source, /相对缓存路径/);
  assert.match(source, /缓存文件（旧记录）/);
  assert.match(source, /预计过期时间/);
  assert.doesNotMatch(source, /file:\/\/|audioFile\}\}"\s+href/);
});
