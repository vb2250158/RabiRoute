import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { voiceCommandSamples } from "../apps/rabilink-aiui/utils/voice-command.js";

const root = path.resolve(import.meta.dirname, "..");
const read = (relative) => fs.readFileSync(path.join(root, relative), "utf8");
const includes = (source, values, label) => {
  for (const value of values) assert(source.includes(value), `${label} is missing ${value}`);
};

export function auditMobileEndpoint(readSource = read) {
const read = readSource;
const manifest = read("apps/rabi-mobile-android/app/src/main/AndroidManifest.xml");
const activity = read("apps/rabi-mobile-android/app/src/main/java/com/rabi/link/MainActivity.kt");
const chatStore = read("apps/rabi-mobile-android/app/src/main/java/com/rabi/link/RabiChatStore.java");
const service = read("apps/rabi-mobile-android/app/src/main/java/com/rabi/link/RabiConversationService.java");
const serviceState = read("apps/rabi-mobile-android/app/src/main/java/com/rabi/link/RabiConversationServiceState.java");
const hub = read("apps/rabi-mobile-android/app/src/main/java/com/rabi/link/recording/RabiRecordingHubActivity.kt");
const recordingSettings = read("apps/rabi-mobile-android/app/src/main/java/com/rabi/link/recording/AllDayRecordingSettings.java");
const healthController = read("apps/rabi-mobile-android/app/src/main/java/com/rabi/link/modules/wearable/WearableHealthController.kt");
const healthCollector = read("apps/rabi-mobile-android/app/src/main/java/com/rabi/link/modules/wearable/WearableHealthCollector.kt");
const bootReceiver = read("apps/rabi-mobile-android/app/src/main/java/com/rabi/link/RabiConversationBootReceiver.java");
const phoneCapture = read("apps/rabi-mobile-android/app/src/main/java/com/rabi/link/modules/conversation/RabiPhoneAudioCapture.java");
const audioCache = read("apps/rabi-mobile-android/app/src/main/java/com/rabi/link/modules/conversation/RabiBoundedAudioCache.java");
const speechArchive = read("apps/rabi-mobile-android/app/src/main/java/com/rabi/link/modules/conversation/RabiMobileSpeechArchive.java");
const speechRecords = read("apps/rabi-mobile-android/app/src/main/java/com/rabi/link/modules/conversation/RabiMobileSpeechRecordStore.java");
const settings = read("apps/rabi-mobile-android/app/src/main/java/com/rabi/link/RabiConversationSettings.java");
const backend = read("apps/rabi-mobile-android/app/src/main/java/com/rabi/link/modules/rokid/RabiGlassPcBackend.java");
const reliableQueueFiles = read("apps/rabi-mobile-android/app/src/main/java/com/rabi/link/modules/rokid/RabiReliableQueueFiles.java");
const networkWakeGate = read("apps/rabi-mobile-android/app/src/main/java/com/rabi/link/modules/rokid/RabiNetworkWakeGate.java");
const audioSpool = read("apps/rabi-mobile-android/app/src/main/java/com/rabi/link/modules/rokid/RabiDurableAudioSpool.java");
const glassBridge = read("apps/rabi-mobile-android/app/src/main/java/com/rabi/link/modules/rokid/RokidNativeVoiceBridge.kt");
const conversationRules = read("apps/rabi-mobile-android/app/src/main/java/com/rabi/link/RabiConversationRules.kt");
const sdk = read("packages/android-sdk/rabiroute-sdk/src/main/java/com/rabiroute/sdk/RabiRouteSdk.kt");
const glass = read("apps/rabi-mobile-android/glass-app/src/main/java/com/rabi/link/glass/GlassAudioClientActivity.java");
const glassProtocol = read("apps/rabi-mobile-android/shared/src/main/java/com/rabi/link/protocol/RabiGlassAudioProtocol.java");
const glassPlaybackSession = read("apps/rabi-mobile-android/shared/src/main/java/com/rabi/link/protocol/RabiGlassPlaybackSession.java");
const phoneGradle = read("apps/rabi-mobile-android/app/build.gradle");
const glassGradle = read("apps/rabi-mobile-android/glass-app/build.gradle");
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
  "RabiConversationService.start(this)"
], "mobile chat");
assert.doesNotMatch(activity, /RabiConversationStartupPolicy|startRecording\(|applyInputMode\(|autoStartVoiceService\.isChecked/,
  "chat, login and settings must never grant capture consent");
includes(activity, [
  "ContextCompat.registerReceiver",
  "RUNTIME_UPDATED",
  "AllDayRecordingSettings.load(this)",
  "openAllDayRecording()",
  "恢复消息连接（不开启采集）",
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

// Inspect scoped bodies rather than allowing an unrelated token elsewhere to satisfy a guard.
const body = (source, start, end) => {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from + start.length);
  assert(from >= 0 && to > from, `audit scope missing: ${start}`);
  return source.slice(from, to);
};
const notification = body(service, "private Notification notification(", "private void showReviewShortcut(");
includes(notification, ["PendingIntent.getActivity", "RabiRecordingHubActivity.class", "ACTION_PAUSE_RECORD", "ACTION_MARK", "setOngoing(true)", "VISIBILITY_PRIVATE"], "single capture status notification");
assert.doesNotMatch(notification, /setAction\(ACTION_REVIEW\)|MainActivity.class/, "status click must open recording, not trigger Agent or chat");
const chatNotification = body(service, "private void showAgentMessage(", "public static void clearConversationNotification(");
includes(chatNotification, ['"rabi_chat_messages"', 'manager.notify("chat:" + conversationKey, 1, value)', "setAutoCancel(true)", "VISIBILITY_PRIVATE", "Uri.encode(conversationKey)", "EXTRA_ROUTE_PROFILE_ID"], "independent private per-conversation notification");
assert.doesNotMatch(chatNotification, /REVIEW_NOTIFICATION_ID|setOngoing\(true\)|setContentText\(text\)|bigText\(text\)/, "ordinary messages must not overwrite foreground state or expose text on lockscreen");
const serviceTags = [...manifest.matchAll(/<service\b[\s\S]*?\/>/g)].map(match => match[0]);
const declared = serviceTags.map(tag => tag.match(/android:name="([^"]+)"/)[1]).sort();
assert.deepEqual(declared, [".RabiConversationService", ".modules.xiaomi.MiHealthCloudProbeService"].sort(),
  "only the unified foreground owner and explicit temporary Xiaomi cloud diagnostic service may be registered");
assert.match(serviceTags.find(tag => tag.includes('".RabiConversationService"')), /android:exported="false"/, "capture owner must not be externally callable");
assert.doesNotMatch(manifest, /RabiLocalAudioService|RabiLiveRecordingService|WearableHealthSyncService|RokidDeviceStatusSyncService/, "retired independent services must not remain registered");
for (const relative of ["modules/rokid/RabiLiveRecordingController.kt", "modules/wearable/WearableHealthController.kt", "modules/rokid/RabiGlassStatusPublisher.kt"]) {
  const controller = read("apps/rabi-mobile-android/app/src/main/java/com/rabi/link/" + relative);
  assert.doesNotMatch(controller, /:\s*Service\s*\(|extends\s+Service\b|startForeground\s*\(|NotificationChannel\s*\(/, `${relative} must not own another foreground service/notification`);
}
const startTransport = body(service, "private void startConversation()", "private void captureReceived(");
assert.doesNotMatch(startTransport, /applyRecording|startPhoneCapture|startGlassesBackend|withRunning\(true/, "message start is transport-only");
assert.match(service, /if \(ACTION_RECORD.equals\(action\)\) \{\s*applyRecording\(\);/, "explicit recording action is the capture entry");
const startCapture = body(service, "public static void startRecording(", "public static void pauseRecording(");
includes(startCapture, ["withRunning(true, System.currentTimeMillis()).save(context)", "setAction(ACTION_RECORD)", "withRunning(false, System.currentTimeMillis()).save(context)"], "durable explicit start with failure rollback");
const restore = body(service, "if (ACTION_RESTORE.equals(action))", "if (ACTION_PREFERENCE.equals(action))");
assert.doesNotMatch(restore, /applyRecording|startPhoneCapture|startGlassesBackend|withRunning\(true/, "boot restore must not acquire capture consent");
const hubCreation = body(hub, "override fun onCreate(", "override fun onSaveInstanceState(");
assert.doesNotMatch(hubCreation, /startRecording\(|withRunning\(true|auto_video/, "opening Hub or legacy intent must not start recording");
includes(hub, ["RabiConversationService.startRecording(this)", "Manifest.permission.RECORD_AUDIO", "PackageManager.PERMISSION_GRANTED", "保存（不开始）", "AllDayRecordingSettings(false,", "RabiConversationService.pauseRecording", "transitionPending()"], "explicit Hub capture controls");
includes(recordingSettings, ['p.getBoolean("running", false)', 'p.getBoolean("autoResume", false)', 'value && !running ? now : windowStartedAt', '.commit()'], "capture consent and fresh resume window");
assert.doesNotMatch(recordingSettings, /getBoolean\("autoStartVoiceService"|getBoolean\("continuousListening"/, "upgrades must not import legacy automatic microphone consent");
const pauseCapture = body(service, "private void pauseRecordingInternal(", "private void finishCaptureTransition(");
includes(pauseCapture, ["++captureGeneration", "healthController.stop()", "phoneAudioCapture.pause()", "stopGlassesBackend()", "videoController.stop()", "backend.endCapture("], "pause stops every producer and drains admitted PCM");
includes(healthController, ["generation++", "job?.cancel()", "run.running", "run.windowStartedAt == window", "maxOf(window, participation)", "!allowed(epoch, window) || !stillParticipating()"], "pause excludes late health callbacks and resumed lookback");
includes(healthCollector, ["windowStart", "windowEnd", "TimeRangeFilter.between(start, end)", "WearableHealthWindow.contains"], "health collection bounded to consent window");

includes(conversationRules, [
  'LEGACY_CONVERSATION_ID = "__legacy_rabi__"',
  'it.equals("rabilink", ignoreCase = true)',
  "unreadCount"
], "conversation isolation rules");

includes(sdk, ["agentRoleId: String", "messageAdapters: List<String>"], "Android route contact contract");

includes(service, [
  "REVIEW_NOTIFICATION_ID = 7422",
  "ACTION_REVIEW",
  "ACTION_REFRESH_NOTIFICATION",
  "ACTION_RESTORE",
  "showAgentMessage(messageId, routeProfileId",
  "EXTRA_ROUTE_PROFILE_ID",
  "EXTRA_CLIENT_MESSAGE_ID",
  "chatStore.updateDelivery",
  "REVIEW_NOTIFICATION_ID",
  "Intent.FLAG_ACTIVITY_CLEAR_TOP | Intent.FLAG_ACTIVITY_SINGLE_TOP",
  "startPhoneCapture()",
  "RabiPhoneAudioCapture",
  "pauseAllCaptureModes()",
  "applyRecording()", "AllDayRecordingSettings" ,
  "RabiConversationSettings.InputMode inputMode",
  "setInputMode(RabiConversationSettings.InputMode.GLASSES)",
  "setInputMode(RabiConversationSettings.InputMode.PHONE)",
  "conversation.input_mode",
  "phoneAudioCapture.pause()",
  "stopGlassesBackend()",
  "startGlassesBackend()",
  "settings.autoPlayAgentVoice",
  "backend.streamPcmFromSource(chunk, RabiGlassPcBackend.SOURCE_GLASSES)",
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
assert.match(service, /phoneAudioCapture\.pause\(\);[\s\S]*?setInputMode\(RabiConversationSettings\.InputMode\.PAUSED\);[\s\S]*?startGlassesBackend\(\);/s,
  "glasses mode must release phone capture and remain paused before starting the glasses bridge");
const glassBt = body(service, "onGlassBtConnectionChanged(boolean connected)", "onGlassDeviceInfo");
includes(glassBt, ["acceptsGlassCallback(callbackGeneration)", "captureSettings.running", '"audio".equals(captureSettings.mode)', '"glasses".equals(captureSettings.source)', "glassController.startAudioStream()", "setInputMode(RabiConversationSettings.InputMode.GLASSES)"], "generation-fenced glasses Bluetooth capture gate");
assert.match(glassBt, /if \(connected\)[\s\S]*?startAudioStream\(\)[\s\S]*?setInputMode\(RabiConversationSettings\.InputMode\.GLASSES\)/s, "glasses capture requires connected callback and successful stream start");
assert.match(service, /setInputMode\(RabiConversationSettings\.InputMode\.PHONE\);\s*startPhoneCapture\(\);/s,
  "phone mode must start phone capture only after mode selection");
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
  "/api/rabilink/speech/v1/audio-streams/rabilink/keepalive",
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
  "nextPendingAudioSequence",
  "RabiSingleDrainGate",
  "audioStreamDrainGate",
  "audioStreamRecoveryGeneration",
  "requestAudioStreamDrain",
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
assert(!backend.includes("ArrayBlockingQueue"),
  "phone-owned backend must coalesce PCM wakeups instead of queueing one task per chunk");
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
assert.match(backend, /RabiDurableAudioSpool\.Segment pending = audioSpool\.nextUpload\(activeAudioStreamSource, activeAudioStreamRoute\);[\s\S]*request\("POST", path, "application\/octet-stream", pcm, 60000\)[\s\S]*audioSpool\.acknowledge\(pending\.id, serverSequence, pending\.bytes, pending\.sha256\);/s,
  "Android must commit a chunk sequence and clear durable PCM only after the PC acknowledges it");
assert.match(backend, /ScheduledExecutorService audioStreamExecutor = Executors\.newSingleThreadScheduledExecutor\(\);[\s\S]*RabiSingleDrainGate audioStreamDrainGate/,
  "PCM uploads must coalesce producer wakeups into one scheduled drain instead of an unbounded task queue");
assert.match(backend, /RabiDurableAudioSpool\.AppendResult written = audioSpool\.append\(item\.pcm, item\.source, item\.route, item\.captureId, item\.processingPolicy, item\.capturedAt, "received"\);[\s\S]*requestAudioStreamDrain\(\)/,
  "PCM pressure must remain bounded before durable acknowledgement-sensitive upload");
includes(backend, ["supportsCaptureProcessing", "expectedWorkerFencing", "processingPolicyFrozen", "processingPolicies"], "worker processing-policy fencing");
assert(backend.includes('captureStreamId(deviceId, suffix, route, processingPolicy, captureId)'),
  "each physical input source must reuse a stable stream id so retries can resume the server sequence");
assert(!backend.includes('glasses ? "rabi-glass" : deviceId'),
  "glasses input must target replies to its companion owner instead of a shared synthetic device id");
assert(!backend.includes('SOURCE_GLASSES.equals(sourceDeviceKind) ? "rabi-glass" : deviceId'),
  "glasses PCM must keep physical origin in sourceDeviceKind while sourceDeviceId remains the companion reply owner");

includes(audioSpool, [
  "Phone-local source of truth for continuous PCM",
  "Segment",
  "nextUpload()",
  "acknowledge(",
  "sha256"
], "durable PCM recovery state");

includes(service, [
  "backend.streamPcmFromSource(pcm, RabiGlassPcBackend.SOURCE_PHONE)",
  "glassController.startAudioStream()",
  "backend.beginCapture(s.source, s.routeProfileId, s.processingPolicy)",
  "backend.streamPcmFromSource(chunk, RabiGlassPcBackend.SOURCE_GLASSES)"
], "host-owned Android audio streaming");
includes(service, [
  "inputMode != RabiConversationSettings.InputMode.GLASSES" ,
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

assert.equal(voiceCommandSamples().length, 84, "the migrated configuration surface must retain all 84 AIUI allowlisted actions");
assert.equal(voiceCommandSamples().length, 84, "mobile endpoint retains migrated allowlisted actions; legacy parity is covered by source command inventory");
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

console.log("Rabi mobile endpoint audit passed: unified all-day recording owner, explicit capture consent, independent chat notifications, route isolation, attachments, receipts, reliable queues, host ASR and 84 configuration actions are wired.");
return true;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    auditMobileEndpoint();
  } catch (error) {
    console.error(`Rabi mobile endpoint audit failed: ${error.message}`);
    process.exitCode = 1;
  }
}
