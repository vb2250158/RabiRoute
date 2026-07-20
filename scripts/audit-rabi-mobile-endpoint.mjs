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
const settings = read("apps/rabilink-android/app/src/main/java/com/rabi/link/RabiConversationSettings.java");
const backend = read("apps/rabilink-android/app/src/main/java/com/rabi/link/modules/rokid/RabiGlassPcBackend.java");
const conversationRules = read("apps/rabilink-android/app/src/main/java/com/rabi/link/RabiConversationRules.kt");
const sdk = read("packages/android-sdk/rabiroute-sdk/src/main/java/com/rabiroute/sdk/RabiRouteSdk.kt");
const glass = read("apps/rabilink-android/glass-app/src/main/java/com/rabi/link/glass/GlassAudioClientActivity.java");
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
  "startGlassesBackend()",
  "settings.autoPlayAgentVoice"
], "foreground conversation service");

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
  "submitMedia(byte[] data, String contentType, String fileName, String caption,"
], "phone-owned backend");

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
