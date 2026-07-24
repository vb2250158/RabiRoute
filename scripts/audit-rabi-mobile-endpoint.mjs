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
const serviceState = read("apps/rabilink-android/app/src/main/java/com/rabi/link/RabiConversationServiceState.java");
const bootReceiver = read("apps/rabilink-android/app/src/main/java/com/rabi/link/RabiConversationBootReceiver.java");
const phoneCapture = read("apps/rabilink-android/app/src/main/java/com/rabi/link/modules/conversation/RabiPhoneAudioCapture.java");
const audioCache = read("apps/rabilink-android/app/src/main/java/com/rabi/link/modules/conversation/RabiBoundedAudioCache.java");
const speechArchive = read("apps/rabilink-android/app/src/main/java/com/rabi/link/modules/conversation/RabiMobileSpeechArchive.java");
const speechRecords = read("apps/rabilink-android/app/src/main/java/com/rabi/link/modules/conversation/RabiMobileSpeechRecordStore.java");
const settings = read("apps/rabilink-android/app/src/main/java/com/rabi/link/RabiConversationSettings.java");
const backend = read("apps/rabilink-android/app/src/main/java/com/rabi/link/modules/rokid/RabiGlassPcBackend.java");
const reliableQueueFiles = read("apps/rabilink-android/app/src/main/java/com/rabi/link/modules/rokid/RabiReliableQueueFiles.java");
const networkWakeGate = read("apps/rabilink-android/app/src/main/java/com/rabi/link/modules/rokid/RabiNetworkWakeGate.java");
const pcmUploadBuffer = read("apps/rabilink-android/app/src/main/java/com/rabi/link/modules/rokid/RabiPcmUploadBuffer.java");
const glassBridge = read("apps/rabilink-android/app/src/main/java/com/rabi/link/modules/rokid/RokidNativeVoiceBridge.kt");
const conversationRules = read("apps/rabilink-android/app/src/main/java/com/rabi/link/RabiConversationRules.kt");
const sdk = read("packages/android-sdk/rabiroute-sdk/src/main/java/com/rabiroute/sdk/RabiRouteSdk.kt");
const glass = read("apps/rabilink-android/glass-app/src/main/java/com/rabi/link/glass/GlassAudioClientActivity.java");
const glassProtocol = read("apps/rabilink-android/shared/src/main/java/com/rabi/link/protocol/RabiGlassAudioProtocol.java");
const glassPlaybackSession = read("apps/rabilink-android/shared/src/main/java/com/rabi/link/protocol/RabiGlassPlaybackSession.java");
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
  "route_profile_id",
  "RabiConversationServiceState.shouldRestore(this)",
  "RabiConversationService.restoreAfterBoot(this)"
], "mobile chat");
assert.match(activity, /RabiConversationServiceState\.shouldRestore\(this\)[\s\S]*conversation\.inputMode != RabiConversationSettings\.InputMode\.PHONE[\s\S]*RabiConversationService\.start\(this\)[\s\S]*RabiConversationService\.restoreAfterBoot\(this\)/s,
  "opening the app must restore durable message transport even when microphone capture cannot resume yet");
includes(activity, [
  "ContextCompat.registerReceiver",
  "RUNTIME_UPDATED",
  "已暂停（保留消息连接）",
  "手机模式",
  "眼镜模式",
  "由 Agent 人格综合决定",
  "最近错误："
], "event-driven mode and runtime UI");
assert(!activity.includes("runtimeTick"), "runtime UI must react to service events instead of one-second polling");
assert(!activity.includes("toggleChatMode"), "configuration assistant must not remain a normal-chat mode");

includes(settings, [
  "enum InputMode",
  "PAUSED",
  "PHONE",
  "GLASSES",
  "enum ProactivityPreference",
  "agent_decides",
  "autoPlayAgentVoice",
  "ttsModel",
  "ttsVoice"
], "conversation settings");
for (const hostOwnedSetting of ["asrModel", "asrLanguage", "vadThreshold", "silenceMs"]) {
  assert(!settings.includes(`public final ${hostOwnedSetting === "vadThreshold" || hostOwnedSetting === "silenceMs" ? "int" : "String"} ${hostOwnedSetting}`),
    `Android conversation settings must not own host-side ${hostOwnedSetting}`);
}

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
  "RabiConversationSettings.InputMode inputMode",
  "setInputMode(RabiConversationSettings.InputMode.GLASSES)",
  "setInputMode(RabiConversationSettings.InputMode.PHONE)",
  "conversation.input_mode",
  "phoneAudioCapture.pause()",
  "stopGlassesBackend()",
  "startGlassesBackend()",
  "settings.autoPlayAgentVoice",
  "backend.streamPcmFromSource(pcm, RabiGlassPcBackend.SOURCE_GLASSES)",
  "backend.requestConversationReview(RabiGlassPcBackend.SOURCE_GLASSES)",
  "RabiGlassPcBackend.SOURCE_GLASSES",
  "registerDefaultNetworkCallback",
  "registerDefaultNetworkCallback(networkCallback, notificationHandler)",
  "target.onNetworkAvailable()",
  "target.onNetworkUnavailable()",
  "connectivityManager.getActiveNetwork() == null",
  "NETWORK_EVENT_FALLBACK_CHECK_MS = 5L * 60L * 1000L",
  "networkKnownOffline",
  "scheduleNetworkEventFallbackCheck()",
  "cancelNetworkEventFallbackCheck()",
  "notificationHandler.postDelayed(networkEventFallbackCheck, NETWORK_EVENT_FALLBACK_CHECK_MS)",
  "unregisterNetworkCallback",
  "ReplyDeliveryResult",
  "setNotificationMarkerPosition",
  "CountDownLatch"
], "foreground conversation service");
includes(serviceState, [
  "restoreEnabled",
  "values.contains(KEY_RESTORE_ENABLED)",
  "RabiConversationSettings.load(context).continuousListening",
  "commit()"
], "durable conversation service intent");
includes(bootReceiver, [
  "RabiConversationServiceState.shouldRestore(context)",
  "RabiConversationService.restoreAfterBoot(context)"
], "boot transport recovery");
assert.match(service, /public static void stop\(Context context\) \{\s*RabiConversationServiceState\.setRestoreEnabled\(context, false\);/s,
  "explicit stop must prevent a later reboot from silently restoring the service");
assert.match(service, /public static void start\(Context context\) \{\s*RabiConversationServiceState\.setRestoreEnabled\(context, true\);/s,
  "an explicitly started message connection must survive process and device restart");
assert.match(service, /if \(settings\.inputMode == RabiConversationSettings\.InputMode\.GLASSES\) \{\s*phoneAudioCapture\.pause\(\);\s*backend\.pauseAudioStream\(\);\s*setInputMode\(RabiConversationSettings\.InputMode\.PAUSED\);[\s\S]*startGlassesBackend\(\);/s,
  "glasses mode must release phone capture and remain paused before starting the glasses bridge");
assert.match(service, /onGlassBtConnectionChanged\(boolean connected\)[\s\S]*if \(connected\) \{\s*backend\.beginAudioStream\(RabiGlassPcBackend\.SOURCE_GLASSES\);\s*setInputMode\(RabiConversationSettings\.InputMode\.GLASSES\);/s,
  "glasses capture may become active only after a real Bluetooth connection event");
assert.match(service, /stopGlassesBackend\(\);\s*backend\.beginAudioStream\(RabiGlassPcBackend\.SOURCE_PHONE\);\s*startPhoneCapture\(\);\s*setInputMode\(RabiConversationSettings\.InputMode\.PHONE\);/s,
  "phone mode must release the glasses bridge before starting phone capture");
assert.match(service, /private void shutdown\(boolean explicitStop\) \{[\s\S]*unregisterNetworkEvents\(\);[\s\S]*backend\.stop\(\);/s,
  "network events must remain registered for the service lifetime and unregister only during shutdown");
assert.match(service, /private void markNetworkUnavailable\(\) \{[\s\S]*target\.onNetworkUnavailable\(\);[\s\S]*scheduleNetworkEventFallbackCheck\(\);/s,
  "known-offline state must arm the minute-scale callback safety check");
assert.match(service, /private void markNetworkAvailable\(\) \{[\s\S]*cancelNetworkEventFallbackCheck\(\);[\s\S]*target\.onNetworkAvailable\(\);/s,
  "a real connectivity event or safety recovery must cancel the offline fallback before waking transport");
assert.match(service, /networkEventFallbackCheck[\s\S]*getActiveNetwork\(\) != null[\s\S]*target\.onNetworkAvailable\(\);[\s\S]*scheduleNetworkEventFallbackCheck\(\);/s,
  "the offline fallback may inspect only system connectivity and must rearm only while still offline");
assert.doesNotMatch(service, /private void showReviewShortcut\(\) \{[\s\S]*unregisterNetworkEvents\(\);[\s\S]*postDelayed/s,
  "notification refresh must not disable connectivity recovery events");

includes(phoneCapture, [
  "PARTIAL_WAKE_LOCK",
  "audio_read_stalled",
  "scheduleStallDeadline",
  "checkStallDeadline",
  "scheduleRestart",
  "MAX_RESTART_DELAY_MS",
  "public void pause()",
  "public void close(boolean sessionEnded)",
  "lifecycleGeneration",
  "scheduledGeneration != lifecycleGeneration.get()",
  "runtimeSummary",
  "conversation.audio.restart"
], "supervised long-running phone capture");
assert(!phoneCapture.includes("scheduleWithFixedDelay"),
  "phone audio stall detection must use a one-shot deadline instead of a fixed watchdog poll");

includes(audioCache, [
  "RETENTION_MILLIS = 24L * 60L * 60L * 1000L",
  "relativePath",
  "Audio cache root identity changed",
  "Files.isSymbolicLink"
], "bounded mobile audio cache");

includes(speechArchive, [
  '"audio-cache/tts-audio"',
  '"speech-records"',
  '"audio_expires_at"',
  "retainTts"
], "mobile speech archive contract");
assert(!speechArchive.includes("retainAsr") && !speechArchive.includes("completeAsr") && !speechArchive.includes("audio-cache/asr-audio"),
  "Android must not retain or finalize host-owned ASR audio records");

includes(speechRecords, [
  "Append-only mobile TTS metadata ledger",
  '"audio_file"',
  '"yyyy-MM-dd"',
  "safeRelativePath"
], "mobile speech record ledger");

includes(backend, [
  "/api/rabilink/devices/input",
  "/api/rabilink/devices/messages",
  "/api/rabilink/devices/media",
  "/api/rabilink/speech/v1/audio-streams/rabilink/start",
  "/api/rabilink/speech/v1/audio-streams/rabilink/chunk",
  "/api/rabilink/speech/v1/audio-streams/rabilink/stop",
  "/api/rabilink/speech/v1/audio/speech",
  "controlQueueDirectory",
  "mediaQueueDirectory",
  "receiptQueueDirectory",
  "/api/rabilink/devices/message-receipts",
  "ReplyDeliveryResult",
  'put("terminal", terminal)',
  "ensureQueueCapacity",
  "sourceAttachments",
  "routeProfileId",
  "onDeliveryState",
  "submitText(String text, String routeProfileId, String clientMessageId)",
  "submitMedia(byte[] data, String contentType, String fileName, String caption,",
  'put("sourceDeviceKind", sourceDeviceKind)',
  'put("source_device_id", deviceId)',
  'put("sourceDeviceId", deviceId)',
  'put("sessionId", deviceId)',
  "pendingAudioSequence",
  "MAX_AUDIO_STREAM_QUEUE_CHUNKS",
  "ArrayBlockingQueue",
  "audioStreamOverflowRecoveryScheduled",
  "audioStreamRecoveryGeneration",
  "enqueueAudioChunk",
  "resetAudioStreamTransportForRetry",
  "scheduleAudioStreamRecovery",
  "onNetworkAvailable",
  "onNetworkUnavailable",
  "networkWakeGate.awaitAvailable()",
  "networkWakeGate.awaitRetry(delayMs)",
  "eventReconnectDelayMs",
  "EVENT_STREAM_READ_TIMEOUT_MS = 45_000",
  "connection.setReadTimeout(EVENT_STREAM_READ_TIMEOUT_MS)",
  "page.optBoolean(\"cursorReset\", false)",
  "RabiLink 下行游标已重建",
  '"&chunkId=" + encode(pending.id)',
  "normalizedSourceKind"
], "phone-owned backend");
includes(backend, [
  "submitProactivityPreference",
  'put("proactivityPreference", settings.proactivityPreference.wireValue)',
  'put("channelType", "media")',
  'put("source_device_kind", sourceDeviceKind)',
  'put("channel_type", "audio_stream")',
  "reliableQueueSummary",
  "RabiReliableQueueFiles.writeAtomically",
  "readQueueJson"
], "active-intelligence mobile metadata and reliable queues");
includes(reliableQueueFiles, [
  "output.getFD().sync()",
  "StandardCopyOption.ATOMIC_MOVE",
  "quarantine",
  "cleanupTemporaryFiles"
], "crash-safe reliable queue files");
assert(!backend.includes("Thread.sleep(2500)"),
  "known-offline SSE recovery must wait for a connectivity event instead of fixed reconnect wakeups");
includes(networkWakeGate, [
  "while (!available && !closed) wait()",
  "signalVersion",
  "notifyAll()",
  "awaitRetry(long delayMs)",
  "void close()"
], "Android network event gate");
assert(!backend.includes("pruneControlQueue") && !backend.includes("pruneMediaQueue"),
  "reliable control and media queues must reject new overflow instead of silently deleting unconfirmed items");
assert(!backend.includes('pruneFiles(receiptQueueDirectory'),
  "device delivery/playback receipts must remain durable until the Relay acknowledges them");
assert(!backend.includes("/api/rabilink/speech/v1/audio/transcriptions")
    && !backend.includes("/api/rabilink/speech/messages")
    && !backend.includes("audioQueueDirectory")
    && !backend.includes("submitPcm"),
  "Android production backend must use the host PCM stream instead of a whole-utterance ASR bypass");
assert.match(backend, /RabiPcmUploadBuffer\.PendingChunk pending = audioUploadBuffer\.preparePending\(\);[\s\S]*request\("POST", path, "application\/octet-stream", pending\.pcm, 60000\);\s*audioStreamSequence = pendingAudioSequence;\s*audioUploadBuffer\.acknowledgePending\(\);/s,
  "Android must commit a chunk sequence and clear pending PCM only after the PC acknowledges it");
assert(!backend.includes("audioStreamExecutor = Executors.newSingleThreadExecutor()"),
  "PCM uploads must use a bounded executor instead of an unbounded single-thread queue");
assert.match(backend, /audioStreamExecutor\.getQueue\(\)\.clear\(\);[\s\S]*resetAudioStreamTransportForRetry\(\);[\s\S]*已丢弃过期 PCM 并重新建立连接/,
  "PCM queue overflow must discard stale queued callbacks while retaining the acknowledgement-sensitive chunk");
assert.match(backend, /safeStreamId\(deviceId \+ "-" \+ suffix \+ "-audio-"[\s\S]*UUID\.randomUUID\(\)/,
  "each PCM connection must receive a transient stream id instead of reusing the reply-device identity");
assert(!backend.includes('glasses ? "rabi-glass" : deviceId'),
  "glasses input must target replies to its companion owner instead of a shared synthetic device id");
assert(!backend.includes('SOURCE_GLASSES.equals(sourceDeviceKind) ? "rabi-glass" : deviceId'),
  "glasses PCM must keep physical origin in sourceDeviceKind while sourceDeviceId remains the companion reply owner");

includes(pcmUploadBuffer, [
  "one acknowledgement-sensitive chunk",
  "DEFAULT_MAX_BUFFERED_BYTES",
  "PendingChunk",
  "preparePending()",
  "acknowledgePending()",
  "Arrays.copyOfRange"
], "bounded PCM recovery state");
assert.match(pcmUploadBuffer, /pending = new PendingChunk\(id\.trim\(\), buffered\);\s*buffered = new byte\[0\];/s,
  "pending PCM must receive a stable chunk identity before the live buffer is cleared");

includes(service, [
  "backend.streamPcmFromSource(pcm, RabiGlassPcBackend.SOURCE_PHONE)",
  "backend.beginAudioStream(RabiGlassPcBackend.SOURCE_GLASSES)",
  "backend.beginAudioStream(RabiGlassPcBackend.SOURCE_PHONE)",
  "backend.streamPcmFromSource(chunk, RabiGlassPcBackend.SOURCE_GLASSES)"
], "host-owned Android audio streaming");
includes(service, [
  "settings.inputMode == RabiConversationSettings.InputMode.GLASSES",
  "phoneAudioCapture.pause()",
  "backend.pauseAudioStream()",
  "onGlassBtConnectionChanged(boolean connected)",
  "setInputMode(RabiConversationSettings.InputMode.GLASSES)",
  "眼镜已断开 · 采集保持暂停",
  "ACTION_PREFERENCE"
], "single-source phone/glasses mode switching");
assert(!service.includes("segmenter.accept("), "Android main conversation path must not perform VAD segmentation");
assert(!activity.includes("VAD 阈值") && !activity.includes("静音切句"), "Android settings must not expose host-owned VAD controls");
assert(!activity.includes("Rabi PC ASR 模型") && !activity.includes("识别语言"),
  "Android settings must not duplicate the target PC ASR model or language");
assert(!glassBridge.includes("RabiPcmSegmenter") && !glassBridge.includes("glassAudioSegmenter"),
  "glasses PCM must stream to RabiSpeech without phone-side segmentation");

includes(glassBridge, [
  "RabiGlassAudioProtocol",
  "readyForAudioPlayback",
  "if (!channel.readyForAudioPlayback)",
  "glasses audio channel is not ready",
  "PREFIX_PLAYBACK_BEGIN",
  "PREFIX_PLAYBACK_END",
  "PREFIX_PLAYBACK_RECEIPT",
  "CountDownLatch",
  "sendAudioStreamDataByClassicBT",
  "sendTextMessageByClassicBT"
], "glasses audio delivery gate");
assert.match(glassBridge, /if \(pendingGlassPlaybackId\.isNotEmpty\(\) && pendingGlassPlaybackState\.isEmpty\(\)\)[\s\S]*pendingGlassPlaybackLatch\?\.countDown\(\)/,
  "stopping the phone bridge must release a pending glasses playback wait");

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
  'PREFIX_DEVICE = "RABI_GLASS_DEVICE:"',
  'PREFIX_PLAYBACK_BEGIN = "RABI_GLASS_PLAYBACK_BEGIN:"',
  'PREFIX_PLAYBACK_END = "RABI_GLASS_PLAYBACK_END:"',
  'PREFIX_PLAYBACK_RECEIPT = "RABI_GLASS_PLAYBACK_RECEIPT:"'
], "shared glasses protocol");
includes(glassPlaybackSession, [
  "WAITING_FOR_MARKER",
  "PLAYED",
  "PLAYBACK_FAILED",
  "receivedBytes != expectedBytes",
  "markerReached()"
], "shared glasses playback state");
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
  "自动重连中",
  "RabiGlassPlaybackSession",
  "setNotificationMarkerPosition",
  "onMarkerReached",
  "sendPhonePlaybackReceipt",
  "sendTextMessageByClassicBT",
  "PLAYBACK_COMPLETION_GRACE_MS",
  "pauseCaptureForPlaybackAndWait()",
  "眼镜播放界面已关闭",
  "lastPlaybackReceiptMessageId"
], "glasses client");
assert.match(glass, /onMarkerReached\(AudioTrack track\)[\s\S]*playbackSession\.markerReached\(\)[\s\S]*finishFramedPlayback\("played"/,
  "glasses may report played only after the AudioTrack marker is reached");
assert.match(glass, /if \(!pauseCaptureForPlaybackAndWait\(\)\)[\s\S]*replacePlaybackTrack\(markerFrames\)/,
  "glasses must confirm capture pause before accepting framed playback PCM");

assert.equal(voiceCommandSamples().length, 85, "the migrated configuration surface must retain all 85 AIUI allowlisted actions");
includes(packet, ["移动端配置助手", "现有动作安全门和审批", "复核读回结果"], "PC configuration assistant gate");
includes(relay, [
  "attachments.length === 0",
  "routeProfileId",
  "targetDeviceKinds",
  "proactivityPreference",
  "preferenceKind",
  "explicitPreference",
  "channelType"
], "portable Relay envelope");

console.log("Rabi mobile endpoint audit passed: QQ-style conversation navigation, route isolation, unread/drafts, explicit delivery targets, phone backend, optional glasses, notifications, media, speech, recovery, and 85 configuration actions are wired.");
