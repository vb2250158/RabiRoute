import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { voiceCommandSamples } from "../apps/rabilink-aiui/utils/voice-command.js";

const root = path.resolve(import.meta.dirname, "..");
const read = (relative) => fs.readFileSync(path.join(root, relative), "utf8");
const includes = (source, values, label) => {
  for (const value of values) assert(source.includes(value), `${label} is missing ${value}`);
};

const manifest = read("apps/rabilink-android/app/src/main/AndroidManifest.xml");
const activity = read("apps/rabilink-android/app/src/main/java/com/rabi/link/MainActivity.kt");
const chatStore = read("apps/rabilink-android/app/src/main/java/com/rabi/link/RabiChatStore.java");
const service = read("apps/rabilink-android/app/src/main/java/com/rabi/link/RabiConversationService.java");
const phoneCapture = read("apps/rabilink-android/app/src/main/java/com/rabi/link/modules/conversation/RabiPhoneAudioCapture.java");
const audioCache = read("apps/rabilink-android/app/src/main/java/com/rabi/link/modules/conversation/RabiBoundedAudioCache.java");
const speechArchive = read("apps/rabilink-android/app/src/main/java/com/rabi/link/modules/conversation/RabiMobileSpeechArchive.java");
const speechRecords = read("apps/rabilink-android/app/src/main/java/com/rabi/link/modules/conversation/RabiMobileSpeechRecordStore.java");
const settings = read("apps/rabilink-android/app/src/main/java/com/rabi/link/RabiConversationSettings.java");
const backend = read("apps/rabilink-android/app/src/main/java/com/rabi/link/modules/rokid/RabiGlassPcBackend.java");
const glassBridge = read("apps/rabilink-android/app/src/main/java/com/rabi/link/modules/rokid/RokidNativeVoiceBridge.kt");
const conversationRules = read("apps/rabilink-android/app/src/main/java/com/rabi/link/RabiConversationRules.kt");
const sdk = read("packages/android-sdk/rabiroute-sdk/src/main/java/com/rabiroute/sdk/RabiRouteSdk.kt");
const glass = read("apps/rabilink-android/glass-app/src/main/java/com/rabi/link/glass/GlassAudioClientActivity.java");
const glassProtocol = read("apps/rabilink-android/shared/src/main/java/com/rabi/link/protocol/RabiGlassAudioProtocol.java");
const phoneGradle = read("apps/rabilink-android/app/build.gradle");
const glassGradle = read("apps/rabilink-android/glass-app/build.gradle");
const packet = read("src/routing/agentPacket.ts");
const relay = read("scripts/rabilink-relay-server.mjs");

includes(manifest, [
  "android.permission.FOREGROUND_SERVICE_MICROPHONE",
  "microphone|dataSync|connectedDevice",
  ".RabiConversationBootReceiver",
  "android.permission.POST_NOTIFICATIONS",
  'android:launchMode="singleTop"'
], "Android manifest");

includes(activity, [
  "showConversationList()",
  "showConversationDetail(routeProfileId",
  "RabiConversationRules.isChatCapable",
  "store.unreadCount",
  "store.markRead(activeRouteId)",
  "saveDraft(activeRouteId",
  "showConfigurationAssistant()",
  "独立于普通聊天",
  "RabiConversationService.sendText(this, text, activeRouteId)",
  "pickPhoneMedia()",
  '"image" ->',
  '"video" ->',
  '"audio-file" ->',
  '"file" ->',
  "getMobileRoutes",
  "route_profile_id"
], "mobile chat");
assert(!activity.includes("toggleChatMode"), "configuration assistant must not remain a normal-chat mode");

includes(settings, [
  "continuousListening",
  "glassesEnabled",
  "autoPlayAgentVoice",
  "asrModel",
  "ttsModel",
  "ttsVoice"
], "conversation settings");

includes(chatStore, [
  "AtomicFile", "startWrite()", "finishWrite(output)", "failWrite(output)",
  "conversation-state.json", "unreadCount", "markRead", "saveDraft", "migrateLegacyMessages",
  "deliveryState", "updateDelivery"
], "durable conversation ledger");

includes(conversationRules, [
  'LEGACY_CONVERSATION_ID = "__legacy_rabi__"',
  'it.equals("rabilink", ignoreCase = true)',
  "unreadCount"
], "conversation isolation rules");

includes(sdk, ["agentRoleId: String", "messageAdapters: List<String>"], "Android route contact contract");

includes(service, [
  "NOTIFICATION_ID = 7421",
  "REVIEW_NOTIFICATION_ID = 7422",
  "ACTION_REVIEW",
  "ACTION_RESTORE",
  "点一下立即让 Agent 审阅当前会话",
  "showAgentMessage(messageId, routeProfileId",
  "EXTRA_ROUTE_PROFILE_ID",
  "EXTRA_CLIENT_MESSAGE_ID",
  "chatStore.updateDelivery",
  "conversationNotificationId",
  "Intent.FLAG_ACTIVITY_CLEAR_TOP | Intent.FLAG_ACTIVITY_SINGLE_TOP",
  "startPhoneCapture()",
  "RabiPhoneAudioCapture",
  "pauseAllCaptureModes()",
  "applyInputMode(settings)",
  "private enum InputMode",
  "setInputMode(InputMode.GLASSES)",
  "setInputMode(InputMode.PHONE)",
  "conversation.input_mode",
  "phoneAudioCapture.pause()",
  "stopGlassesBackend()",
  "startGlassesBackend()",
  "settings.autoPlayAgentVoice",
  "backend.submitPcmFromSource(pcm, RabiGlassPcBackend.SOURCE_GLASSES)",
  "backend.requestConversationReview(RabiGlassPcBackend.SOURCE_GLASSES)",
  "RabiGlassPcBackend.SOURCE_GLASSES"
], "foreground conversation service");
assert.match(service, /if \(settings\.glassesEnabled\) \{\s*phoneAudioCapture\.pause\(\);\s*startGlassesBackend\(\);\s*setInputMode\(InputMode\.GLASSES\);/s,
  "glasses mode must release phone capture before starting the glasses bridge");
assert.match(service, /stopGlassesBackend\(\);\s*startPhoneCapture\(\);\s*setInputMode\(InputMode\.PHONE\);/s,
  "phone mode must release the glasses bridge before starting phone capture");

includes(phoneCapture, [
  "PARTIAL_WAKE_LOCK",
  "audio_read_stalled",
  "scheduleRestart",
  "MAX_RESTART_DELAY_MS",
  "public void pause()",
  "public void close(boolean sessionEnded)",
  "lifecycleGeneration",
  "scheduledGeneration != lifecycleGeneration.get()",
  "runtimeSummary",
  "conversation.audio.restart"
], "supervised long-running phone capture");

includes(audioCache, [
  "RETENTION_MILLIS = 24L * 60L * 60L * 1000L",
  "relativePath",
  "Audio cache root identity changed",
  "Files.isSymbolicLink"
], "bounded mobile audio cache");

includes(speechArchive, [
  '"audio-cache/asr-audio"',
  '"audio-cache/tts-audio"',
  '"speech-records"',
  '"audio_expires_at"',
  "completeAsr"
], "mobile speech archive contract");

includes(speechRecords, [
  "Append-only ASR/TTS metadata ledger",
  '"audio_file"',
  '"yyyy-MM-dd"',
  "safeRelativePath"
], "mobile speech record ledger");

includes(backend, [
  "/api/rabilink/devices/input",
  "/api/rabilink/devices/messages",
  "/api/rabilink/devices/media",
  "/api/rabilink/speech/v1/audio/transcriptions",
  "/api/rabilink/speech/v1/audio/speech",
  "controlQueueDirectory",
  "audioQueueDirectory",
  "mediaQueueDirectory",
  "sourceAttachments",
  "routeProfileId",
  "onDeliveryState",
  "submitText(String text, String routeProfileId, String clientMessageId)",
  "submitMedia(byte[] data, String contentType, String fileName, String caption,",
  'put("sourceDeviceKind", sourceDeviceKind)',
  'put("sessionId", deviceId)',
  "normalizedSourceKind"
], "phone-owned backend");

includes(glassBridge, [
  "RabiGlassAudioProtocol",
  "readyForAudioPlayback",
  "if (!channel.readyForAudioPlayback)",
  "glasses audio channel is not ready"
], "glasses audio delivery gate");

includes(glassProtocol, [
  'CLIENT_ID = "GlassSample"',
  'AUDIO_STREAM_TAG = "RabiGlassAudioPcm"',
  'COMMAND_START = "RABI_GLASS_AUDIO_START"',
  'COMMAND_STOP = "RABI_GLASS_AUDIO_STOP"',
  'COMMAND_REVIEW = "RABI_GLASS_REVIEW_REQUEST"',
  'COMMAND_STATUS_REQUEST = "RABI_GLASS_AUDIO_STATUS_REQUEST"',
  'PREFIX_STATUS = "RABI_GLASS_AUDIO_STATUS:"',
  'PREFIX_TRANSCRIPT = "RABI_GLASS_TRANSCRIPT:"',
  'PREFIX_REPLY = "RABI_GLASS_REPLY:"',
  'PREFIX_DEVICE = "RABI_GLASS_DEVICE:"'
], "shared glasses protocol");
includes(phoneGradle, ['java.srcDir("$rootDir/shared/src/main/java")'], "phone shared protocol source");
includes(glassGradle, ['java.srcDir("$rootDir/shared/src/main/java")'], "glasses shared protocol source");
assert(!glass.includes('private static final String START = "RABI_GLASS_AUDIO_START"'), "glasses protocol literals must not be duplicated in the glasses activity");
assert(!glassBridge.includes('const val GLASS_AUDIO_START_CMD = "RABI_GLASS_AUDIO_START"'), "glasses protocol literals must not be duplicated in the phone bridge");

includes(glass, [
  "startCapture(true)",
  "持续聆听中 · 单击可提示 Rabi",
  '"立即推送"',
  "versionName()",
  "clockTick",
  "battery",
  "scheduleReconnect()",
  "自动重连中"
], "glasses client");

assert.equal(voiceCommandSamples().length, 85, "the migrated configuration surface must retain all 85 AIUI allowlisted actions");
includes(packet, ["移动端配置助手", "现有动作安全门和审批", "复核读回结果"], "PC configuration assistant gate");
includes(relay, ["attachments.length === 0", "routeProfileId", "targetDeviceKinds"], "portable Relay envelope");

console.log("Rabi mobile endpoint audit passed: QQ-style conversation navigation, route isolation, unread/drafts, explicit delivery targets, phone backend, optional glasses, notifications, media, speech, recovery, and 85 configuration actions are wired.");
