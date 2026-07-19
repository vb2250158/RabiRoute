import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { voiceCommandSamples } from "../examples/rabilink-aiui/utils/voice-command.js";

const root = path.resolve(import.meta.dirname, "..");
const read = (relative) => fs.readFileSync(path.join(root, relative), "utf8");
const includes = (source, values, label) => {
  for (const value of values) assert(source.includes(value), `${label} is missing ${value}`);
};

const manifest = read("examples/android-rabi-link-probe/app/src/main/AndroidManifest.xml");
const activity = read("examples/android-rabi-link-probe/app/src/main/java/com/rabi/link/MainActivity.kt");
const chatStore = read("examples/android-rabi-link-probe/app/src/main/java/com/rabi/link/RabiChatStore.java");
const service = read("examples/android-rabi-link-probe/app/src/main/java/com/rabi/link/RabiConversationService.java");
const settings = read("examples/android-rabi-link-probe/app/src/main/java/com/rabi/link/RabiConversationSettings.java");
const backend = read("examples/android-rabi-link-probe/app/src/main/java/com/rabi/link/modules/rokid/RabiGlassPcBackend.java");
const glass = read("examples/android-rabi-link-probe/glass-asr/src/main/java/com/rabi/link/glass/GlassAudioClientActivity.java");
const packet = read("src/routing/agentPacket.ts");
const relay = read("scripts/rabilink-relay-server.mjs");

includes(manifest, [
  "android.permission.FOREGROUND_SERVICE_MICROPHONE",
  "microphone|dataSync|connectedDevice",
  ".RabiConversationBootReceiver",
  "android.permission.POST_NOTIFICATIONS"
], "Android manifest");

includes(activity, [
  "showingSettings = !saved.configured",
  "Rabi 移动端",
  "配置助手",
  "给 Rabi 发消息",
  "pickPhoneMedia()",
  '"image" ->',
  '"video" ->',
  '"audio-file" ->',
  '"file" ->',
  "getMobileRoutes",
  "route_profile_id"
], "mobile chat");

includes(settings, [
  "continuousListening",
  "glassesEnabled",
  "autoPlayAgentVoice",
  "asrModel",
  "ttsModel",
  "ttsVoice"
], "conversation settings");

includes(chatStore, ["AtomicFile", "startWrite()", "finishWrite(output)", "failWrite(output)"], "durable chat ledger");

includes(service, [
  "NOTIFICATION_ID = 7421",
  "REVIEW_NOTIFICATION_ID = 7422",
  "ACTION_REVIEW",
  "ACTION_RESTORE",
  "点一下立即让 Agent 审阅当前会话",
  "showAgentMessage(messageId, routeProfileId",
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
  "routeProfileId"
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

console.log("Rabi mobile endpoint audit passed: standalone chat, phone backend, optional glasses, notifications, media, personas, speech, recovery, and 85 configuration actions are wired.");
