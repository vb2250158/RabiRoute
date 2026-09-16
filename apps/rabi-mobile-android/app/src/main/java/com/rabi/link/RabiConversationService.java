package com.rabi.link;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.media.AudioAttributes;
import android.media.AudioFormat;
import android.media.AudioTrack;
import android.net.ConnectivityManager;
import android.net.Network;
import android.net.Uri;
import android.os.IBinder;
import android.provider.OpenableColumns;

import java.io.ByteArrayOutputStream;
import java.io.FileInputStream;
import java.io.InputStream;
import java.io.File;
import java.io.IOException;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.util.Collections;
import java.util.HashSet;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;

import androidx.core.app.NotificationCompat;

import com.rabi.link.modules.rokid.RabiGlassPcBackend;
import com.rabi.link.modules.rokid.RokidCxrController;
import com.rabi.link.modules.rokid.RabiGlassBridge;
import com.rabi.link.modules.rokid.RabiGlassBridgeFactory;
import com.rabi.link.modules.conversation.RabiPhoneAudioCapture;
import com.rabi.link.modules.conversation.RabiBoundedAudioCache;
import com.rabi.link.modules.conversation.RabiMobileSpeechArchive;
import com.rabi.link.recording.AllDayRecordingSettings;
import com.rabi.link.modules.rokid.RabiLiveRecordingController;
import com.rabi.link.modules.wearable.WearableHealthController;

/** Foreground phone client. Glasses are optional; this service works with the phone alone. */
public final class RabiConversationService extends Service {
    private static RabiConversationService currentInstance;
    public static void pauseForLocalCapture() {
        RabiConversationService current = currentInstance;
        if (current != null) pauseRecording(current);
    }
    public static final String ACTION_RECORD = "com.rabi.link.recording.START";
    public static final String ACTION_PAUSE_RECORD = "com.rabi.link.recording.PAUSE";
    public static final String ACTION_HEALTH = "com.rabi.link.recording.HEALTH";
    public static final String ACTION_MARK = "com.rabi.link.recording.MARK";
    private RabiLiveRecordingController videoController;
    private WearableHealthController healthController;
    private com.rabi.link.modules.rokid.VideoAudioDerivation videoAudio;
    private AllDayRecordingSettings videoBinding;
    private String videoCaptureId = "";
    private com.rabi.link.modules.rokid.RabiGlassStatusPublisher glassStatusPublisher;
    private boolean captureTransition;
    private volatile long captureGeneration;
    private volatile long glassesGeneration;
    private boolean glassesAudioStarted;
    private boolean glassesConnected;
    private long lastGlassRetryAt;
    private final com.rabi.link.recording.AutomaticAudioSource automaticSource = new com.rabi.link.recording.AutomaticAudioSource();
    private final Runnable audioSourceWatchdog = new Runnable() {
        @Override public void run() {
            if (shutdownComplete || !AllDayRecordingSettings.load(RabiConversationService.this).running) return;
            reconcileAudioSource();
            long now = android.os.SystemClock.elapsedRealtime();
            if ("mobile".equals(automaticSource.preferred(now)) && now - lastGlassRetryAt >= 30000) {
                lastGlassRetryAt = now;
                try {
                    if (glassController == null) startGlassesBackend();
                    else if (glassesConnected) {
                        glassController.stopAudioStream();
                        glassesAudioStarted = glassController.startAudioStream();
                    }
                } catch (RuntimeException error) {
                    updateRuntime("glasses", "眼镜暂不可用 · 使用手机，稍后重试");
                }
            }
            notificationHandler.postDelayed(this, 1000);
        }
    };
    private String activeCaptureSource = "mobile";
    private boolean stopAfterCapture;
    private boolean captureSaveFailed;
    private String activeCaptureRoute = "";
    private String captureFailure = "";
    private String terminalCaptureError = "";
    private long lastCaptureUiAt;
    private String captureRecordId = "";
    private String captureStatus = "全天记录已暂停";

    public static RabiLiveRecordingController currentVideo() {
        RabiConversationService current = currentInstance;
        return current == null ? null : current.videoController;
    }
    private static long recordingStartPendingUntil;
    /** Persisted intent is not evidence of a live microphone owner after an app update or process death. */
    public static boolean recordingOwnerAvailable() {
        return (currentInstance != null && !currentInstance.shutdownComplete)
                || android.os.SystemClock.elapsedRealtime() < recordingStartPendingUntil;
    }
    public static void startRecording(Context context) {
        AllDayRecordingSettings s = AllDayRecordingSettings.load(context);
        s.withRunning(true, System.currentTimeMillis()).save(context);
        recordingStartPendingUntil = android.os.SystemClock.elapsedRealtime() + 15000;
        try { context.startForegroundService(new Intent(context, RabiConversationService.class).setAction(ACTION_RECORD)); }
        catch (RuntimeException error) {
            recordingStartPendingUntil = 0;
            s.withRunning(false, System.currentTimeMillis()).save(context);
            throw error;
        }
    }
    public static void pauseRecording(Context context) {
        AllDayRecordingSettings s = AllDayRecordingSettings.load(context);
        s.withRunning(false, System.currentTimeMillis()).save(context);
        context.startService(new Intent(context, RabiConversationService.class).setAction(ACTION_PAUSE_RECORD));
    }
    public static void syncHealth(Context context) {
        context.startForegroundService(new Intent(context, RabiConversationService.class).setAction(ACTION_HEALTH));
    }
    public static void markRecording(Context context) {
        context.startForegroundService(new Intent(context, RabiConversationService.class).setAction(ACTION_MARK));
    }
    public static final String ACTION_START = "com.rabi.link.conversation.START";
    public static final String ACTION_STOP = "com.rabi.link.conversation.STOP";
    public static final String ACTION_REVIEW = "com.rabi.link.conversation.REVIEW";
    public static final String ACTION_REFRESH_NOTIFICATION = "com.rabi.link.conversation.REFRESH_NOTIFICATION";
    public static final String ACTION_MEDIA = "com.rabi.link.conversation.MEDIA";
    public static final String ACTION_TEXT = "com.rabi.link.conversation.TEXT";
    public static final String ACTION_RETRY = "com.rabi.link.conversation.RETRY";
    public static final String ACTION_CONFIG = "com.rabi.link.conversation.CONFIG";
    public static final String ACTION_RESTORE = "com.rabi.link.conversation.RESTORE";
    public static final String ACTION_PREFERENCE = "com.rabi.link.conversation.PREFERENCE";
    public static final String ACTION_REPLAY_TTS = "com.rabi.link.conversation.REPLAY_TTS";
    public static final String ACTION_CLEAR_AUDIO_QUARANTINE = "com.rabi.link.conversation.CLEAR_AUDIO_QUARANTINE";
    private static final String LISTENING_CHANNEL = "rabi_all_day_status";
    private static final int REVIEW_NOTIFICATION_ID = 7422;
    private static final long REVIEW_NOTIFICATION_REFRESH_MS = 6L * 60L * 60L * 1000L;
    private static final long NETWORK_EVENT_FALLBACK_CHECK_MS = 5L * 60L * 1000L;
    private static final String EXTRA_ROUTE_PROFILE_ID = "route_profile_id";
    private static final String EXTRA_CLIENT_MESSAGE_ID = "client_message_id";
    private static final String EXTRA_PROACTIVITY_PREFERENCE = "proactivity_preference";
    private static final String EXTRA_TTS_MESSAGE_ID = "tts_message_id";
    private static final String EXTRA_TTS_LOCAL_PATH = "tts_local_path";
    private static final long MAX_REPLAY_WAV_BYTES = 32L * 1024L * 1024L;

    private RabiPhoneAudioCapture phoneAudioCapture;
    private RabiMobileSpeechArchive speechArchive;
    private volatile RabiGlassPcBackend backend;
    private final java.util.concurrent.ExecutorService initializationExecutor = java.util.concurrent.Executors.newSingleThreadExecutor();
    private final java.util.ArrayDeque<Runnable> pendingStarts = new java.util.ArrayDeque<>();
    private boolean initialized;
    private boolean initializing;
    private RabiChatStore chatStore;
    private RokidCxrController glassController;
    private RabiGlassBridge glassBridge;
    private ConnectivityManager connectivityManager;
    private ConnectivityManager.NetworkCallback networkCallback;
    private volatile boolean shutdownComplete;
    private boolean networkKnownOffline;
    private boolean networkFallbackCheckScheduled;
    private boolean voiceServiceActive;
    private final Object phonePlaybackLock = new Object();
    private final Set<String> pendingTtsReplayIds = Collections.synchronizedSet(new HashSet<>());
    private RabiConversationSettings.InputMode inputMode = RabiConversationSettings.InputMode.PAUSED;
    private final android.os.Handler notificationHandler = new android.os.Handler(android.os.Looper.getMainLooper());
    private final Runnable reviewNotificationRefresh = new Runnable() {
        @Override public void run() {
            postReviewShortcut();
            notificationHandler.postDelayed(this, REVIEW_NOTIFICATION_REFRESH_MS);
        }
    };
    private final Runnable networkEventFallbackCheck = new Runnable() {
        @Override public void run() {
            networkFallbackCheckScheduled = false;
            if (shutdownComplete || !networkKnownOffline) return;
            ConnectivityManager manager = connectivityManager;
            RabiGlassPcBackend target = backend;
            try {
                if (manager != null && manager.getActiveNetwork() != null) {
                    networkKnownOffline = false;
                    if (target != null) target.onNetworkAvailable();
                    return;
                }
            } catch (Throwable ignored) { }
            scheduleNetworkEventFallbackCheck();
        }
    };

    public static void start(Context context) {
        RabiConversationServiceState.setRestoreEnabled(context, true);
        Intent intent = new Intent(context, RabiConversationService.class).setAction(ACTION_START);
        context.startForegroundService(intent);
    }

    public static void stop(Context context) {
        RabiConversationServiceState.setRestoreEnabled(context, false);
        context.startService(new Intent(context, RabiConversationService.class).setAction(ACTION_STOP));
    }

    public static void requestReview(Context context) {
        RabiConversationServiceState.setRestoreEnabled(context, true);
        context.startForegroundService(new Intent(context, RabiConversationService.class).setAction(ACTION_REVIEW));
    }

    public static void enqueueMedia(Context context, Uri uri, String contentType, String routeProfileId) {
        RabiConversationServiceState.setRestoreEnabled(context, true);
        Intent intent = new Intent(context, RabiConversationService.class).setAction(ACTION_MEDIA)
                .setData(uri).putExtra("contentType", contentType == null ? "application/octet-stream" : contentType)
                .putExtra(EXTRA_ROUTE_PROFILE_ID, routeProfileId == null ? "" : routeProfileId)
                .putExtra(EXTRA_CLIENT_MESSAGE_ID, "phone-media-" + System.currentTimeMillis() + "-" + UUID.randomUUID())
                .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
        context.startForegroundService(intent);
    }

    public static void enqueueMedia(Context context, Uri uri, String contentType) {
        enqueueMedia(context, uri, contentType, RabiConversationTarget.load(context));
    }

    public static void sendText(Context context, String text, String routeProfileId) {
        RabiConversationServiceState.setRestoreEnabled(context, true);
        context.startForegroundService(new Intent(context, RabiConversationService.class).setAction(ACTION_TEXT)
                .putExtra("text", text == null ? "" : text)
                .putExtra(EXTRA_ROUTE_PROFILE_ID, routeProfileId == null ? "" : routeProfileId)
                .putExtra(EXTRA_CLIENT_MESSAGE_ID, "phone-text-" + System.currentTimeMillis() + "-" + UUID.randomUUID()));
    }

    public static void sendText(Context context, String text) {
        sendText(context, text, RabiConversationTarget.load(context));
    }

    public static void sendConfigurationRequest(Context context, String text, String routeProfileId) {
        RabiConversationServiceState.setRestoreEnabled(context, true);
        context.startForegroundService(new Intent(context, RabiConversationService.class).setAction(ACTION_CONFIG)
                .putExtra("text", text == null ? "" : text)
                .putExtra(EXTRA_ROUTE_PROFILE_ID, routeProfileId == null ? "" : routeProfileId)
                .putExtra(EXTRA_CLIENT_MESSAGE_ID, "phone-config-" + System.currentTimeMillis() + "-" + UUID.randomUUID()));
    }

    public static void sendConfigurationRequest(Context context, String text) {
        sendConfigurationRequest(context, text, RabiConversationTarget.load(context));
    }
    public static void retryFailed(Context context) {
        RabiConversationServiceState.setRestoreEnabled(context, true);
        context.startForegroundService(new Intent(context, RabiConversationService.class).setAction(ACTION_RETRY));
    }

    /** Replays only the locally retained WAV belonging to an Agent TTS chat message. */
    public static void replayTts(Context context, String messageId, String localPath) {
        Intent intent = new Intent(context, RabiConversationService.class).setAction(ACTION_REPLAY_TTS)
                .putExtra(EXTRA_TTS_MESSAGE_ID, messageId == null ? "" : messageId)
                .putExtra(EXTRA_TTS_LOCAL_PATH, localPath == null ? "" : localPath);
        context.startForegroundService(intent);
    }

    public static void restoreAfterBoot(Context context) {
        context.startForegroundService(new Intent(context, RabiConversationService.class).setAction(ACTION_RESTORE));
    }

    public static void clearAudioQuarantineAfterUserConfirmation(Context context) {
        context.startForegroundService(new Intent(context, RabiConversationService.class)
                .setAction(ACTION_CLEAR_AUDIO_QUARANTINE));
    }

    @Override
    public void onCreate() {
        currentInstance = this;
        super.onCreate();
        createChannel();
        chatStore = new RabiChatStore(this);
        glassStatusPublisher = new com.rabi.link.modules.rokid.RabiGlassStatusPublisher(this, () -> {
            if (glassStatusPublisher != null) updateRuntime("glassDeviceStatus", glassStatusPublisher.getStatus());
        });
        phoneAudioCapture = new RabiPhoneAudioCapture(this, new RabiPhoneAudioCapture.Listener() {
            @Override public void onPcm(byte[] pcm) {
                if (backend != null && inputMode == RabiConversationSettings.InputMode.PHONE) {
                    backend.streamPcmFromSource(pcm, RabiGlassPcBackend.SOURCE_PHONE);
                    captureReceived(pcm);
                }
            }
            @Override public void onPlaybackSuppressed() { }
            @Override public void onGap(String reason, long estimatedBytes) {
                RabiGlassPcBackend target = backend;
                if (target != null) target.recordAudioGap(reason, estimatedBytes, RabiGlassPcBackend.SOURCE_PHONE);
            }
            @Override public void onStatus(String status) { updateStatus(status); }
            @Override public void onDiagnostic(String event, String level, String state) {
                RabiGlassPcBackend target = backend;
                if (target != null) target.queueDiagnostic(event, level, state);
            }
        });
    }

    /** Queue recovery can inspect many files. It must never run on Android's main thread. */
    private void initializeBackend() {
        speechArchive = RabiMobileSpeechArchive.tryCreate(this);
        if (speechArchive != null) try { speechArchive.cleanup(); }
        catch (Throwable ignored) { }
        backend = new RabiGlassPcBackend(this, new RabiGlassPcBackend.Listener() {
            @Override public void onStatus(String status) { updateStatus(status); if (glassBridge != null) glassBridge.sendGlassAudioStatus(status); }
            @Override public void onTranscript(String text, String routeProfileId) { chatStore.append(null, "user", "voice", text, "", "audio/pcm", routeProfileId); updateRuntime("transcript", text); if (glassBridge != null) glassBridge.sendGlassTranscript(text); updateStatus("识别 · " + shortText(text)); }
            @Override public void onDeliveryState(String clientMessageId, String routeProfileId, String state, String failure) {
                chatStore.updateDelivery(clientMessageId, state, failure);
                updateRuntime("delivery", state + (failure == null || failure.trim().isEmpty() ? "" : " · " + friendlyError(failure)));
            }
            @Override public RabiGlassPcBackend.ReplyDeliveryResult onReply(String messageId, String routeProfileId, String text, byte[] pcm, org.json.JSONArray attachments) {
                String ttsPath = persistTtsMessage(text, routeProfileId, pcm);
                if ((text != null && !text.trim().isEmpty()) || (pcm != null && pcm.length > 0)) {
                    chatStore.append(messageId, "assistant", pcm != null && pcm.length > 0 ? "tts" : "text", text,
                            pcm != null && pcm.length > 0 ? "Agent-TTS.wav" : "", pcm != null && pcm.length > 0 ? "audio/wav" : "text/plain", routeProfileId, ttsPath);
                    if (pcm != null && pcm.length > 0 && !ttsPath.isEmpty()) chatStore.updatePlayback(messageId, "ready", "");
                }
                for (int index = 0; attachments != null && index < attachments.length(); index++) {
                    org.json.JSONObject item = attachments.optJSONObject(index); if (item == null) continue;
                    chatStore.append(messageId + ":attachment:" + index, "assistant", item.optString("kind", "file"), "",
                            item.optString("fileName", "attachment.bin"), item.optString("contentType", "application/octet-stream"),
                            routeProfileId, item.optString("localPath", ""));
                }
                String replySummary = text == null || text.trim().isEmpty()
                        ? "Agent 发来了 " + (attachments == null ? 0 : attachments.length()) + " 个附件"
                        : text;
                updateRuntime("reply", replySummary); showAgentMessage(messageId, routeProfileId, replySummary);
                RabiConversationSettings settings = RabiConversationSettings.load(RabiConversationService.this);
                if (inputMode == RabiConversationSettings.InputMode.GLASSES && glassBridge != null) {
                    glassBridge.sendGlassReplyText(replySummary);
                }
                boolean playbackRequested = settings.autoPlayAgentVoice && pcm != null && pcm.length > 0;
                boolean played = false;
                boolean glassesOutput = inputMode == RabiConversationSettings.InputMode.GLASSES;
                String outputDeviceKind = glassesOutput ? RabiGlassPcBackend.SOURCE_GLASSES : RabiGlassPcBackend.SOURCE_PHONE;
                String playbackFailure = "";
                if (playbackRequested) {
                    chatStore.updatePlayback(messageId, "playing", "");
                    if (glassesOutput) {
                        played = glassBridge != null && glassBridge.sendAudioPcmToGlass(messageId, pcm);
                        if (!played) playbackFailure = glassBridge == null ? "眼镜播放通道未连接" : "眼镜未确认播放完成";
                    } else {
                        played = playOnPhone(pcm);
                        if (!played) playbackFailure = "手机未确认播放完成";
                    }
                    chatStore.updatePlayback(messageId, played ? "played" : "failed", playbackFailure);
                    updateRuntime("ttsPlayback", played ? "语音播放完成" : "语音播放失败 · " + playbackFailure);
                }
                return new RabiGlassPcBackend.ReplyDeliveryResult(true, playbackRequested, played,
                        outputDeviceKind, playbackFailure);
            }
            @Override public void onPersonaAvatarChanged(String roleId, String avatarVersion, String avatarUrl) {
                String role = roleId == null ? "" : roleId.trim();
                if (role.isEmpty()) return;
                String version = avatarVersion == null ? "" : avatarVersion.trim();
                getSharedPreferences("rabi_persona_avatars", MODE_PRIVATE).edit()
                        .putString("version:" + role, version)
                        .putBoolean("configured:" + role, !version.isEmpty()).apply();
                sendBroadcast(new Intent(RabiPersonaAvatarEvents.ACTION_CHANGED)
                        .setPackage(getPackageName())
                        .putExtra(RabiPersonaAvatarEvents.EXTRA_ROLE_ID, role)
                        .putExtra(RabiPersonaAvatarEvents.EXTRA_AVATAR_VERSION, version)
                        .putExtra(RabiPersonaAvatarEvents.EXTRA_AVATAR_URL, avatarUrl == null ? "" : avatarUrl.trim()));
            }
            @Override public void onCaptureBlocked(String reason) {
                notificationHandler.post(() -> {
                    captureFailure = reason == null ? "采集被阻止" : reason;
                    terminalCaptureError = captureFailure;
                    AllDayRecordingSettings.load(RabiConversationService.this).withRunning(false, System.currentTimeMillis()).save(RabiConversationService.this);
                    pauseRecordingInternal(null);
                    setCaptureStatus("采集失败 · " + captureFailure);
                    updateRuntime("error", captureFailure);
                });
            }
            @Override public void onError(String message) {
                updateRuntime("error", friendlyError(message));
                updateStatus("错误 · " + friendlyError(message));
                if (backend != null) backend.queueDiagnostic("conversation.error", "error", "conversation backend error");
            }
        });
    }

    public static void updateProactivityPreference(Context context, String preference) {
        RabiConversationServiceState.setRestoreEnabled(context, true);
        context.startForegroundService(new Intent(context, RabiConversationService.class)
                .setAction(ACTION_PREFERENCE)
                .putExtra(EXTRA_PROACTIVITY_PREFERENCE, preference == null ? "agent_decides" : preference));
    }

    private void registerNetworkEvents() {
        connectivityManager = getSystemService(ConnectivityManager.class);
        if (connectivityManager == null || networkCallback != null) return;
        networkCallback = new ConnectivityManager.NetworkCallback() {
            @Override public void onAvailable(Network network) {
                markNetworkAvailable();
            }

            @Override public void onLost(Network network) {
                if (connectivityManager != null && connectivityManager.getActiveNetwork() != null) return;
                markNetworkUnavailable();
            }
        };
        try {
            connectivityManager.registerDefaultNetworkCallback(networkCallback, notificationHandler);
            if (connectivityManager.getActiveNetwork() == null) markNetworkUnavailable();
            else markNetworkAvailable();
        } catch (Throwable error) {
            networkCallback = null;
            networkKnownOffline = false;
            cancelNetworkEventFallbackCheck();
            RabiGlassPcBackend target = backend;
            if (target != null) target.onNetworkAvailable();
            updateStatus("系统网络事件不可用 · 保留连接退避恢复");
        }
    }

    private void markNetworkAvailable() {
        networkKnownOffline = false;
        cancelNetworkEventFallbackCheck();
        RabiGlassPcBackend target = backend;
        if (target != null) target.onNetworkAvailable();
        if (healthController != null) healthController.syncNow();
        if (glassStatusPublisher != null) glassStatusPublisher.onNetworkAvailable();
        drainVideoAudio();
    }

    private void markNetworkUnavailable() {
        networkKnownOffline = true;
        RabiGlassPcBackend target = backend;
        if (target != null) target.onNetworkUnavailable();
        scheduleNetworkEventFallbackCheck();
    }

    private void scheduleNetworkEventFallbackCheck() {
        if (shutdownComplete || !networkKnownOffline || networkFallbackCheckScheduled) return;
        networkFallbackCheckScheduled = true;
        // event-driven-allow: known-offline connectivity callback safety check; no business state is read.
        notificationHandler.postDelayed(networkEventFallbackCheck, NETWORK_EVENT_FALLBACK_CHECK_MS);
    }

    private void cancelNetworkEventFallbackCheck() {
        if (!networkFallbackCheckScheduled) return;
        notificationHandler.removeCallbacks(networkEventFallbackCheck);
        networkFallbackCheckScheduled = false;
    }

    private void unregisterNetworkEvents() {
        cancelNetworkEventFallbackCheck();
        networkKnownOffline = false;
        ConnectivityManager manager = connectivityManager;
        ConnectivityManager.NetworkCallback callback = networkCallback;
        networkCallback = null;
        connectivityManager = null;
        if (manager == null || callback == null) return;
        try { manager.unregisterNetworkCallback(callback); }
        catch (Throwable ignored) { }
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        String action = intent == null ? ACTION_RESTORE : intent.getAction();
        if (intent == null && !initialized) {
            // Android process restoration is not foreground microphone consent.
            AllDayRecordingSettings.load(RabiConversationService.this).withRunning(false, System.currentTimeMillis()).save(RabiConversationService.this);
            captureStatus = "系统恢复后采集已暂停，请打开记录页恢复";
            updateRuntime("allDayStatus", captureStatus);
        }
        if (!initialized && !ACTION_STOP.equals(action)) {
            startForeground(REVIEW_NOTIFICATION_ID, new NotificationCompat.Builder(this, LISTENING_CHANNEL)
                    .setSmallIcon(com.rabi.link.R.drawable.rabiroute_icon).setContentTitle("正在恢复消息记录")
                    .setContentText("后台读取历史队列，等待恢复结果").setOngoing(true).build(),
                    android.content.pm.ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC);
            Intent deferred = intent == null ? null : new Intent(intent);
            pendingStarts.add(() -> onStartCommand(deferred, flags, startId));
            if (!initializing) {
                initializing = true;
                initializationExecutor.execute(() -> {
                    try {
                        initializeBackend();
                        if (shutdownComplete) { if (backend != null) backend.stop(); return; }
                        notificationHandler.post(() -> {
                            if (shutdownComplete) return;
                            initialized = true; initializing = false;
                            videoAudio = new com.rabi.link.modules.rokid.VideoAudioDerivation(this, () -> {
                                if (videoAudio != null && !shutdownComplete) {
                                    updateRuntime("videoProcessing", videoAudio.getStatus());
                                    drainVideoAudio();
                                }
                            });
                            ensureHealthController();
                            videoAudio.resume();
                            drainVideoAudio();
                            registerNetworkEvents();
                            while (!pendingStarts.isEmpty() && !shutdownComplete) pendingStarts.removeFirst().run();
                        });
                    } catch (Exception error) {
                        notificationHandler.post(() -> {
                            if (shutdownComplete) return;
                            initializing = false; pendingStarts.clear();
                            AllDayRecordingSettings.load(RabiConversationService.this).withRunning(false, System.currentTimeMillis()).save(RabiConversationService.this);
                            setCaptureStatus("队列恢复失败，已保留原文件，未启动采集");
                            updateStatus("消息队列恢复失败，已保留原文件；请稍后重试");
                            android.util.Log.e("RabiConversation", "queue_initialization_failed", error);
                            shutdown(false); stopSelf();
                        });
                    }
                });
            }
            return START_NOT_STICKY;
        }
        updateRuntime("serviceAction", action == null ? ACTION_START : action);
        if (ACTION_STOP.equals(action)) {
            AllDayRecordingSettings.load(RabiConversationService.this).withRunning(false, System.currentTimeMillis()).save(RabiConversationService.this);
            RabiConversationServiceState.setRestoreEnabled(this, false);
            stopAfterCapture = true;
            if (!initialized) { shutdown(true); return START_NOT_STICKY; }
            pauseRecordingInternal(null);
            return START_NOT_STICKY;
        }
        if (ACTION_RECORD.equals(action)) {
            applyRecording();
            return START_STICKY;
        }
        if (ACTION_PAUSE_RECORD.equals(action)) {
            AllDayRecordingSettings.load(RabiConversationService.this).withRunning(false, System.currentTimeMillis()).save(RabiConversationService.this);
            pauseRecordingInternal(null);
            return START_STICKY;
        }
        if (ACTION_HEALTH.equals(action)) {
            ensureHealthController();
            if (healthController != null) healthController.syncNow();
            promote("健康同步", voiceServiceActive);
            return START_STICKY;
        }
        if (ACTION_MARK.equals(action)) {
            if (!AllDayRecordingSettings.load(this).running || captureTransition) {
                promote(captureStatus, voiceServiceActive);
                return START_STICKY;
            }
            try {
                com.rabi.link.recording.RecordingMarkerStore.add(this, captureRecordId, System.currentTimeMillis());
                updateRuntime("marker", "已标记此刻");
            } catch (Exception error) { updateRuntime("error", "标记保存失败"); }
            promote("已标记此刻", voiceServiceActive);
            return START_STICKY;
        }
        if (!ACTION_RESTORE.equals(action)) {
            RabiConversationServiceState.setRestoreEnabled(this, true);
        }
        if (ACTION_RESTORE.equals(action)) {
            if (voiceServiceActive || captureTransition || (videoController != null && videoController.getActive())
                    || (healthController != null && AllDayRecordingSettings.load(this).running)) {
                // A delayed boot/transport restore must never downgrade an already running
                // user-started microphone session.
                promote(personaDisplayName() + " 移动端持续服务", true);
                showReviewShortcut();
                if (configureBackend()) backend.start();
                return START_STICKY;
            }
            voiceServiceActive = false;
            pauseAllCaptureModes();
            promote(personaDisplayName() + " 消息连接正常", false);
            showReviewShortcut();
            if (configureBackend()) {
                backend.start();
                updateStatus("消息连接正常 · 语音采集未启动");
            } else {
                updateStatus("等待手机重新配置 RabiLink");
            }
            return START_STICKY;
        }
        if (ACTION_PREFERENCE.equals(action)) {
            promote("正在保存主动性偏好", false);
            showReviewShortcut();
            if (configureBackend()) backend.start();
            backend.submitProactivityPreference(intent.getStringExtra(EXTRA_PROACTIVITY_PREFERENCE));
            return START_STICKY;
        }
        if (ACTION_REFRESH_NOTIFICATION.equals(action)) {
            promote(personaDisplayName() + " 消息连接", false);
            showReviewShortcut();
            return START_STICKY;
        }
        if (ACTION_REVIEW.equals(action)) {
            promote("正在提示 " + personaDisplayName() + " 审阅", false);
            showReviewShortcut();
            if (configureBackend()) backend.start();
            if (backend != null) backend.requestConversationReview();
            return START_STICKY;
        }
        if (ACTION_REPLAY_TTS.equals(action)) {
            promote("正在重播夜雨语音", false);
            String messageId = intent.getStringExtra(EXTRA_TTS_MESSAGE_ID);
            String localPath = intent.getStringExtra(EXTRA_TTS_LOCAL_PATH);
            queueTtsReplay(messageId, localPath);
            return START_STICKY;
        }
        if (ACTION_MEDIA.equals(action)) {
            promote("正在保存媒体到可靠队列", false);
            if (configureBackend()) backend.start();
            Uri uri = intent.getData();
            String contentType = intent.getStringExtra("contentType");
            String routeProfileId = intent.getStringExtra(EXTRA_ROUTE_PROFILE_ID);
            String clientMessageId = intent.getStringExtra(EXTRA_CLIENT_MESSAGE_ID);
            new Thread(() -> enqueueMedia(uri, contentType, routeProfileId, clientMessageId), "rabi-phone-media-import").start();
            return START_STICKY;
        }
        if (ACTION_TEXT.equals(action) || ACTION_CONFIG.equals(action)) {
            promote("正在发送文本消息", false); showReviewShortcut(); if (configureBackend()) backend.start();
            String text = intent.getStringExtra("text");
            String routeProfileId = intent.getStringExtra(EXTRA_ROUTE_PROFILE_ID);
            if (routeProfileId == null || routeProfileId.trim().isEmpty()) routeProfileId = RabiConversationTarget.load(this);
            String clientMessageId = intent.getStringExtra(EXTRA_CLIENT_MESSAGE_ID);
            if (clientMessageId == null || clientMessageId.trim().isEmpty()) clientMessageId = "phone-text-" + System.currentTimeMillis() + "-" + UUID.randomUUID();
            if (text != null && !text.trim().isEmpty()) {
                chatStore.append(clientMessageId, "user", ACTION_CONFIG.equals(action) ? "configuration" : "text", text.trim(), "", "text/plain",
                        routeProfileId, "", clientMessageId, "queued", "");
                if (ACTION_CONFIG.equals(action)) backend.submitConfigurationRequest(text, routeProfileId, clientMessageId);
                else backend.submitText(text, routeProfileId, clientMessageId);
            }
            return START_STICKY;
        }
        if (ACTION_RETRY.equals(action)) {
            promote("正在重试失败消息", false); showReviewShortcut(); if (configureBackend()) backend.start(); backend.retryFailedItems();
            return START_STICKY;
        }
        if (ACTION_CLEAR_AUDIO_QUARANTINE.equals(action)) {
            promote("正在清理隔离录音", false);
            boolean cleared = backend != null && backend.clearAudioQuarantineAfterUserConfirmation();
            updateStatus(cleared ? "隔离录音已按你的确认清理" : "隔离录音清理失败 · 原文件仍保留");
            updateRuntime("queue", backend == null ? "服务尚未初始化" : backend.reliableQueueSummary());
            return START_STICKY;
        }
        promote("正在连接 " + personaDisplayName(), false);
        showReviewShortcut();
        startConversation();
        return START_STICKY;
    }

    private void ensureHealthController() {
        if (shutdownComplete || healthController != null) return;
        healthController = new WearableHealthController(this, () -> {
            if (healthController != null && !shutdownComplete) {
                updateRuntime("healthStatus", healthController.getStatus());
                getSharedPreferences("rabi_conversation_runtime", MODE_PRIVATE).edit()
                        .putLong("healthLastReceivedAt", healthController.getLastReceivedAt()).apply();
            }
        });
    }

    private void startConversation() {
        ensureHealthController();
        if (healthController != null) healthController.syncNow();
        configureBackend();
        backend.start();
        promote("消息连接", voiceServiceActive);
        updateStatus(backend.configured() ? "消息连接已启动" : "未配置电脑 · 本地记录仍可使用");
    }

    private void captureReceived(byte[] pcm) {
        if (pcm == null || pcm.length == 0) return;
        com.rabi.link.recording.AudioLevels.accept(pcm, android.os.SystemClock.elapsedRealtime());
        boolean signal = false;
        for (byte value : pcm) { if (value != 0) { signal = true; break; } }
        final boolean hasSignal = signal;
        final long generation = captureGeneration;
        final String recordId = captureRecordId;
        long now = System.currentTimeMillis();
        if (now - lastCaptureUiAt < 1000) return;
        lastCaptureUiAt = now;
        notificationHandler.post(() -> {
            if (shutdownComplete || generation != captureGeneration || !recordId.equals(captureRecordId) || !AllDayRecordingSettings.load(this).running) return;
            getSharedPreferences("rabi_conversation_runtime", MODE_PRIVATE).edit()
                    .putLong("captureLastReceivedAt", now).putBoolean("captureHasSignal", hasSignal).apply();
            setCaptureStatus(("glasses".equals(activeCaptureSource) ? "眼镜" : "手机") + (hasSignal ? " · 正在接收声音" : " · 收到静音数据，请检查麦克风占用"));
        });
    }

    private void setCaptureStatus(String value) {
        captureStatus = value;
        updateRuntime("allDayStatus", value);
        NotificationManager manager = getSystemService(NotificationManager.class);
        if (manager != null && !shutdownComplete) manager.notify(REVIEW_NOTIFICATION_ID, notification(value));
    }

    private void applyRecording() {
        if (captureTransition) { afterCaptureStopped = this::applyRecording; setCaptureStatus("正在保存上一段，完成后应用新模式"); return; }
        AllDayRecordingSettings s = AllDayRecordingSettings.load(this);
        if (!s.running) { pauseRecordingInternal(null); return; }
        if (voiceServiceActive || (videoController != null && videoController.getActive())) {
            pauseRecordingInternal(this::applyRecording);
            return;
        }
        terminalCaptureError = "";
        activeCaptureSource = "video".equals(s.mode) ? "glasses" : "mobile";
        activeCaptureRoute = s.routeProfileId;
        captureSaveFailed = false;
        final long generation = ++captureGeneration;
        configureBackend();
        backend.setProcessingEnabled(s.uploadEnabled);
        backend.start();
        ensureHealthController();
        if (s.healthEnabled || "health".equals(s.mode)) {
            if (!s.healthEnabled && "health".equals(s.mode)) {
                s = new AllDayRecordingSettings(s.running, s.mode, s.source, s.processingPolicy,
                        s.routeProfileId, true, s.uploadEnabled, false, s.windowStartedAt);
                s.save(this);
            }
            healthController.start();
        }
        if ("health".equals(s.mode)) {
            setCaptureStatus("仅健康记录 · 等待设备样本");
            promote(captureStatus, false);
            return;
        }
        if ("video".equals(s.mode)) {
            videoBinding = s;
            videoCaptureId = UUID.randomUUID().toString();
            try { backend.registerCaptureEndpoint(videoCaptureId); }
            catch (Exception error) {
                AllDayRecordingSettings.load(RabiConversationService.this).withRunning(false, System.currentTimeMillis()).save(RabiConversationService.this);
                setCaptureStatus("无法保存视频归属，未开始录像");
                return;
            }
            if (videoController != null) videoController.close();
            final RabiLiveRecordingController[] ownedVideo = new RabiLiveRecordingController[1];
            videoController = new RabiLiveRecordingController(this, () -> {
                RabiLiveRecordingController video = videoController;
                if (video != null && generation == captureGeneration) {
                    updateRuntime("video", video.getStatus());
                    setCaptureStatus(video.getStatus());
                    if (video.getReceiving()) getSharedPreferences("rabi_conversation_runtime", MODE_PRIVATE)
                            .edit().putLong("videoFirstReceivedAt", video.getReceivedAt()).apply();
                }
                return kotlin.Unit.INSTANCE;
            }, () -> {
                if (shutdownComplete || videoController != ownedVideo[0]) return kotlin.Unit.INSTANCE;
                captureSaveFailed = !videoController.getSaveSucceeded();
                if (!captureTransition) {
                    AllDayRecordingSettings.load(this).withRunning(false, System.currentTimeMillis()).save(this);
                    if (healthController != null) healthController.stop();
                    captureTransition = true;
                    afterCaptureStopped = null;
                }
                if (captureSaveFailed) {
                    terminalCaptureError = "视频保存清单失败，禁止自动重新启动";
                    AllDayRecordingSettings.load(this).withRunning(false, System.currentTimeMillis()).save(this);
                }
                if (!captureTransition) setCaptureStatus(captureSaveFailed ? terminalCaptureError : "视频已停止，已有记录保留");
                submitVideoAudio();
                finishCaptureTransition();
                return kotlin.Unit.INSTANCE;
            });
            ownedVideo[0] = videoController;
            promote("等待眼镜推流", false);
            videoController.start(false, videoCaptureId, "glasses", s.routeProfileId, s.processingPolicy);
            return;
        }
        automaticSource.disconnected();
        startSelectedAudio("mobile");
        if (voiceServiceActive) {
            try { startGlassesBackend(); }
            catch (RuntimeException error) { updateRuntime("glasses", "眼镜暂不可用 · 使用手机"); }
            notificationHandler.removeCallbacks(audioSourceWatchdog);
            notificationHandler.postDelayed(audioSourceWatchdog, 1000);
        }
    }

    private void startSelectedAudio(String source) {
        AllDayRecordingSettings s = AllDayRecordingSettings.load(this);
        if (!s.running || shutdownComplete || !"audio".equals(s.mode)) return;
        try {
            com.rabi.link.recording.AudioLevels.reset();
            activeCaptureSource = source;
            captureRecordId = backend.beginCapture(source, s.routeProfileId, s.processingPolicy);
            updateRuntime("recordId", captureRecordId);
            updateRuntime("actualAudioSource", source);
            voiceServiceActive = true;
            promote("准备录音", true);
            if ("glasses".equals(source)) setInputMode(RabiConversationSettings.InputMode.GLASSES);
            else {
                setInputMode(RabiConversationSettings.InputMode.PHONE);
                startPhoneCapture();
            }
            setCaptureStatus(("glasses".equals(source) ? "眼镜" : "手机") + " · 等待实际声音数据");
        } catch (Throwable error) {
            AllDayRecordingSettings.load(this).withRunning(false, System.currentTimeMillis()).save(this);
            terminalCaptureError = "录音未启动 · " + friendlyError(error.getMessage());
            pauseRecordingInternal(null);
        }
    }

    /** Seal the old physical source before accepting the new one; keep CXR monitoring alive. */
    private void reconcileAudioSource() {
        if (captureTransition || shutdownComplete || !voiceServiceActive) return;
        AllDayRecordingSettings s = AllDayRecordingSettings.load(this);
        if (!s.running || !"audio".equals(s.mode)) return;
        String next = automaticSource.preferred(android.os.SystemClock.elapsedRealtime());
        if (next.equals(activeCaptureSource)) return;
        backend.recordAudioGap("automatic_source_switch", 0, activeCaptureSource);
        backend.queueDiagnostic("conversation.source_switch", "info", activeCaptureSource + " -> " + next);
        captureTransition = true;
        setInputMode(RabiConversationSettings.InputMode.PAUSED);
        phoneAudioCapture.pause();
        voiceServiceActive = false;
        updateRuntime("actualAudioSource", "");
        setCaptureStatus("正在保存并自动切换声音设备");
        afterCaptureStopped = () -> startSelectedAudio(automaticSource.preferred(android.os.SystemClock.elapsedRealtime()));
        backend.endCapture(() -> notificationHandler.post(this::finishCaptureTransition));
    }

    private void applyUploadPolicy() {
        if (backend != null) backend.setProcessingEnabled(AllDayRecordingSettings.load(this).uploadEnabled);
    }

    private void drainVideoAudio() {
        if (videoAudio == null || backend == null || shutdownComplete) return;
        videoAudio.drainReady((source, route, policy, recordId, file) -> {
            try { return backend.appendImportedCapture(source, route, policy, recordId, file); }
            catch (Exception error) { updateRuntime("videoProcessing", "视频音轨处理失败，原文件保留"); return false; }
        });
    }

    private void submitVideoAudio() {
        RabiLiveRecordingController video = videoController;
        AllDayRecordingSettings binding = videoBinding;
        if (video == null || binding == null || videoAudio == null || shutdownComplete) return;
        String id = video.getSessionId();
        String frozenCaptureId = videoCaptureId;
        initializationExecutor.execute(() -> {
            try {
                for (com.rabi.link.recording.RecordingStore.Entry entry : new com.rabi.link.recording.RecordingStore(this).list()) {
                    if (id.equals(entry.getId())) {
                        videoAudio.submit(id, "glasses", binding.routeProfileId, binding.processingPolicy, frozenCaptureId, entry.getFiles());
                        break;
                    }
                }
            } catch (Exception error) { updateRuntime("videoProcessing", "视频音轨任务未提交，原视频保留"); }
        });
    }

    private Runnable afterCaptureStopped;
    private void pauseRecordingInternal(Runnable after) {
        if (captureTransition) {
            afterCaptureStopped = after;
            notificationHandler.removeCallbacks(audioSourceWatchdog);
            stopGlassesBackend();
            if (healthController != null) healthController.stop();
            return;
        }
        notificationHandler.removeCallbacks(audioSourceWatchdog);
        captureTransition = true;
        afterCaptureStopped = after;
        ++captureGeneration;
        setCaptureStatus("正在停止并保存");
        if (healthController != null) healthController.stop();
        if (phoneAudioCapture != null) phoneAudioCapture.pause();
        stopGlassesBackend();
        setInputMode(RabiConversationSettings.InputMode.PAUSED);
        voiceServiceActive = false;
        updateRuntime("actualAudioSource", "");
        if (videoController != null && videoController.getActive()) {
            videoController.stop();
        } else if (backend != null) {
            backend.endCapture(() -> notificationHandler.post(this::finishCaptureTransition));
        } else finishCaptureTransition();
    }

    private void finishCaptureTransition() {
        if (!captureTransition) return;
        captureTransition = false;
        if (stopAfterCapture) {
            stopAfterCapture = false;
            afterCaptureStopped = null;
            shutdown(true);
            return;
        }
        com.rabi.link.recording.AudioLevels.reset();
        captureRecordId = "";
        updateRuntime("recordId", "");
        setCaptureStatus(terminalCaptureError.isEmpty() ? "全天记录已暂停 · 已保存内容仍可处理" : "全天记录已停止 · " + terminalCaptureError);
        Runnable after = afterCaptureStopped;
        afterCaptureStopped = null;
        if (!shutdownComplete) {
            promote(captureStatus, after != null && AllDayRecordingSettings.load(this).running);
            if (com.rabi.link.recording.CaptureCompletionPolicy.mayRestart(after != null,
                    AllDayRecordingSettings.load(this).running, captureSaveFailed, shutdownComplete)) after.run();
            else {
                drainVideoAudio();
                if (healthController != null) healthController.syncNow();
            }
        }
    }

    private void pauseAllCaptureModes() {
        if (phoneAudioCapture != null) phoneAudioCapture.pause();
        stopGlassesBackend();
        if (backend != null) backend.pauseAudioStream();
        setInputMode(RabiConversationSettings.InputMode.PAUSED);
        com.rabi.link.recording.CaptureOwnership.release("conversation");
    }

    private void setInputMode(RabiConversationSettings.InputMode next) {
        boolean changed = inputMode != next;
        inputMode = next;
        updateRuntime("activeMode", next.name());
        updateRuntime("capture", next == RabiConversationSettings.InputMode.PHONE
                ? "手机麦克风采集中"
                : next == RabiConversationSettings.InputMode.GLASSES
                        ? "眼镜麦克风采集中" : "采集已暂停");
        if (changed && backend != null) backend.queueDiagnostic("conversation.input_mode", "info", next.name().toLowerCase(java.util.Locale.ROOT));
    }

    private void promote(String text, boolean conversation) {
        AllDayRecordingSettings settings = AllDayRecordingSettings.load(this);
        int type = android.content.pm.ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC;
        // Transport commands must not remove the type of a microphone already in use.
        if (voiceServiceActive || conversation) {
            // Retain microphone eligibility during automatic glasses capture so fallback can
            // occur with the screen off. The foreground type does not open AudioRecord.
            type |= android.content.pm.ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE;
            if (checkSelfPermission(android.Manifest.permission.BLUETOOTH_CONNECT) == android.content.pm.PackageManager.PERMISSION_GRANTED)
                type |= android.content.pm.ServiceInfo.FOREGROUND_SERVICE_TYPE_CONNECTED_DEVICE;
        }
        if (settings.running && "video".equals(settings.mode)) {
            type |= android.content.pm.ServiceInfo.FOREGROUND_SERVICE_TYPE_CONNECTED_DEVICE;
        }
        startForeground(REVIEW_NOTIFICATION_ID, notification(text), type);
    }

    private boolean acceptsGlassCallback(long generation) {
        AllDayRecordingSettings s = AllDayRecordingSettings.load(this);
        return generation == captureGeneration && generation == glassesGeneration
                && !shutdownComplete && s.running && "audio".equals(s.mode);
    }

    private void startGlassesBackend() {
        if (glassBridge != null || glassController != null) return;
        if (checkSelfPermission(android.Manifest.permission.BLUETOOTH_CONNECT) != android.content.pm.PackageManager.PERMISSION_GRANTED
                || checkSelfPermission(android.Manifest.permission.BLUETOOTH_SCAN) != android.content.pm.PackageManager.PERMISSION_GRANTED) {
            updateRuntime("glasses", "附近设备权限未授予 · 使用手机");
            return;
        }
        final long callbackGeneration = captureGeneration;
        glassesGeneration = callbackGeneration;
        android.content.SharedPreferences values = getSharedPreferences("rokid_probe", MODE_PRIVATE);
        String token = values.getString("rokid_token", "");
        if (token == null || token.trim().isEmpty()) {
            updateRuntime("glasses", "眼镜模式不可用：尚未完成 Rokid 授权");
            updateStatus("眼镜模式不可用 · 请从设置打开眼镜后端并完成授权");
            return;
        }
        glassBridge = RabiGlassBridgeFactory.create(this, new RabiGlassBridge.Listener() {
            @Override public void onNativeVoiceLog(String line) { }
            @Override public void onNativeAsrText(String text, String channel, String clientId) { }
            @Override public void onNativeTtsAck(String text, String channel, String clientId) { }
            @Override public void onNativeCommandAck(String kind, String text, String channel, String clientId) { }
            @Override public void onNativeStatus(String text, String channel, String clientId) { if (!acceptsGlassCallback(callbackGeneration)) return; updateStatus("眼镜 · " + shortText(text)); }
            @Override public void onNativeVoiceError(String kind, String text, String channel, String clientId) { if (!acceptsGlassCallback(callbackGeneration)) return; backend.queueDiagnostic("glasses." + kind, "error", "glasses bridge error"); }
            @Override public void onGlassAudioPcm(byte[] pcm) {
                // CXR-L is the selected capture provider; do not ingest a second native stream.
            }
            @Override public void onGlassReviewRequested() { if (!acceptsGlassCallback(callbackGeneration)) return; backend.requestConversationReview(RabiGlassPcBackend.SOURCE_GLASSES); }
            @Override public void onGlassVideoH264(byte[] bytes) { /* Video uses the selected local receiver only. */ }
            @Override public void onGlassVideoState(String state) { if (!acceptsGlassCallback(callbackGeneration)) return; updateRuntime("video", state); }
        }, values.getString("native_voice_access_key", ""), values.getString("native_voice_secret_key", ""));
        if (glassBridge != null) {
            glassBridge.start();
        } else {
            updateRuntime("glasses-bridge", "手机精简包未加载可选 Rokid Phone SDK；RabiPC 语音主链不受影响");
        }
        glassController = new RokidCxrController(this, new RokidCxrController.Listener() {
            @Override public void onLog(String line) { }
            @Override public void onCxrConnectionChanged(boolean connected) {
                notificationHandler.post(() -> {
                    if (!acceptsGlassCallback(callbackGeneration)) return;
                    updateRuntime("glasses", connected ? "眼镜 CXR 已连接，等待声音" : "眼镜未连接 · 使用手机");
                    if (!connected) glassConnectionChanged(false, callbackGeneration);
                });
            }
            @Override public void onGlassBtConnectionChanged(boolean connected) {
                notificationHandler.post(() -> glassConnectionChanged(connected, callbackGeneration));
            }
            @Override public void onGlassDeviceInfo(com.rokid.cxr.link.utils.GlassInfo info) {
                if (!acceptsGlassCallback(callbackGeneration) || info == null) return;
                if (glassBridge != null) glassBridge.sendGlassDeviceState(info.batteryLevel, info.ischarging);
                if (glassStatusPublisher != null) glassStatusPublisher.accept(info.batteryLevel, info.ischarging);
            }
            @Override public void onPhoto(byte[] data) { if (!acceptsGlassCallback(callbackGeneration)) return; if (data != null && data.length > 0) backend.submitMediaFromSource(data, "image/jpeg", "rabi-glass-photo-" + System.currentTimeMillis() + ".jpg", "眼镜拍摄的照片", RabiGlassPcBackend.SOURCE_GLASSES); }
            @Override public void onGlassAppResult(String status, String summary, String error) { if (!acceptsGlassCallback(callbackGeneration)) return; updateStatus("眼镜 App · " + shortText(status + " " + summary)); }
            @Override public void onNativeVoiceProtocol(String payload, String channel, String clientId) { if (!acceptsGlassCallback(callbackGeneration)) return; if (glassBridge != null) glassBridge.handleIncomingProtocol(channel, payload, clientId); }
            @Override public void onAudioPcm(byte[] data, int offset, int length) {
                if (data == null || offset < 0 || length <= 0 || offset > data.length - length) return;
                byte[] chunk = java.util.Arrays.copyOfRange(data, offset, offset + length);
                notificationHandler.post(() -> {
                    if (!acceptsGlassCallback(callbackGeneration) || !glassesConnected || !glassesAudioStarted) return;
                    automaticSource.receivedGlassesPcm(android.os.SystemClock.elapsedRealtime());
                    reconcileAudioSource();
                    if (!captureTransition && voiceServiceActive && inputMode == RabiConversationSettings.InputMode.GLASSES) {
                        backend.streamPcmFromSource(chunk, RabiGlassPcBackend.SOURCE_GLASSES);
                        captureReceived(chunk);
                    }
                });
            }
        });
        glassController.disableDiagnosticAudioBuffer();
        boolean connectionStarted = glassController.connectCustomViewSession(token.trim());
        if (!connectionStarted) {
            updateRuntime("glasses", "眼镜模式不可用：Rokid 连接请求未启动");
            updateStatus("眼镜连接未启动 · 请检查 Rokid AI App、配对和授权");
            stopGlassesBackend();
            return;
        }
        new android.os.Handler(getMainLooper()).postDelayed(() -> {
            if (acceptsGlassCallback(callbackGeneration) && glassController != null) {
                glassController.getGlassDeviceInfo();
            }
        }, 1500);
        updateStatus("眼镜后台正在连接");
    }

    private void glassConnectionChanged(boolean connected, long generation) {
        if (!acceptsGlassCallback(generation)) return;
        glassesConnected = connected;
        if (connected) {
            if (glassController != null && !glassesAudioStarted) {
                lastGlassRetryAt = android.os.SystemClock.elapsedRealtime();
                glassesAudioStarted = glassController.startAudioStream();
            }
            updateRuntime("glasses", "眼镜已连接 · 等待真实音频");
        } else {
            automaticSource.disconnected();
            glassesAudioStarted = false;
            if (glassController != null) glassController.stopAudioStream();
            updateRuntime("glasses", "眼镜已断开 · 自动使用手机");
            reconcileAudioSource();
        }
    }

    private void stopGlassesBackend() {
        glassesGeneration = -1;
        glassesConnected = false;
        automaticSource.disconnected();
        glassesAudioStarted = false;
        if (glassController != null) {
            RokidCxrController old = glassController;
            glassController = null;
            old.stopAudioStream();
            old.disconnect();
        }
        if (glassBridge != null) {
            glassBridge.stop();
            glassBridge = null;
        }
    }

    private boolean configureBackend() {
        RabiLinkRelayConfig relay = RabiLinkRelaySettings.load(this);
        if (!relay.getConfigured()) {
            if (backend != null) {
                backend.configure("", "", RabiMobileDeviceIdentity.load(this));
                backend.setTargetWorkerId("");
                backend.setProcessingEnabled(false);
            }
            return false;
        }
        backend.configure(relay.getBaseUrl(), relay.getToken(), RabiMobileDeviceIdentity.load(this));
        applyUploadPolicy();
        backend.setTargetWorkerId(com.rabi.link.recording.TargetWorkerIdentity.load(this, relay.getBaseUrl(), relay.getToken()));
        backend.reloadSettings();
        return true;
    }

    private void enqueueMedia(Uri uri, String contentType, String routeProfileId, String clientMessageId) {
        if (uri == null) { updateStatus("媒体选择无效"); return; }
        try {
            String fileName = "phone-media-" + System.currentTimeMillis();
            try (android.database.Cursor cursor = getContentResolver().query(uri,
                    new String[]{OpenableColumns.DISPLAY_NAME}, null, null, null)) {
                if (cursor != null && cursor.moveToFirst()) fileName = cursor.getString(0);
            }
            byte[] data;
            try (InputStream input = getContentResolver().openInputStream(uri);
                 ByteArrayOutputStream output = new ByteArrayOutputStream()) {
                if (input == null) throw new IllegalStateException("无法读取媒体");
                byte[] buffer = new byte[32768];
                int read;
                int total = 0;
                while ((read = input.read(buffer)) >= 0) {
                    total += read;
                    if (total > 64 * 1024 * 1024) throw new IllegalArgumentException("媒体超过 64 MiB");
                    output.write(buffer, 0, read);
                }
                data = output.toByteArray();
            }
            String stableRoute = routeProfileId == null ? "" : routeProfileId.trim();
            String stableClientMessageId = clientMessageId == null || clientMessageId.trim().isEmpty()
                    ? "phone-media-" + System.currentTimeMillis() + "-" + UUID.randomUUID() : clientMessageId.trim();
            String kind = contentType != null && contentType.startsWith("image/") ? "image"
                    : contentType != null && contentType.startsWith("video/") ? "video"
                    : contentType != null && contentType.startsWith("audio/") ? "audio-file" : "file";
            chatStore.append(stableClientMessageId, "user", kind, "", fileName, contentType, stableRoute, uri.toString(),
                    stableClientMessageId, "queued", "");
            backend.submitMedia(data, contentType, fileName, "手机发送的媒体消息", stableRoute, stableClientMessageId);
        } catch (Throwable error) {
            updateStatus("媒体导入失败 · " + error.getMessage());
        }
    }

    private void startPhoneCapture() {
        phoneAudioCapture.start();
    }

    private boolean playOnPhone(byte[] pcm) {
        synchronized (phonePlaybackLock) {
            if (pcm == null || pcm.length < 4) return false;
            phoneAudioCapture.setPlaybackSuppressed(true);
            int minimum = AudioTrack.getMinBufferSize(16000, AudioFormat.CHANNEL_OUT_MONO, AudioFormat.ENCODING_PCM_16BIT);
            AudioTrack track = new AudioTrack.Builder()
                    .setAudioAttributes(new AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_ASSISTANCE_ACCESSIBILITY)
                            .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH).build())
                    .setAudioFormat(new AudioFormat.Builder().setSampleRate(16000).setChannelMask(AudioFormat.CHANNEL_OUT_MONO)
                            .setEncoding(AudioFormat.ENCODING_PCM_16BIT).build())
                    .setBufferSizeInBytes(Math.max(minimum, pcm.length))
                    .setTransferMode(AudioTrack.MODE_STATIC)
                    .build();
            CountDownLatch completed = new CountDownLatch(1);
            AtomicBoolean markerReached = new AtomicBoolean(false);
            try {
                int markerFrames = phonePlaybackMarkerFrames(pcm.length);
                int trackState = track.getState();
                if (!phonePlaybackStateReadyForWrite(trackState)) return false;
                track.setPlaybackPositionUpdateListener(new AudioTrack.OnPlaybackPositionUpdateListener() {
                    @Override public void onMarkerReached(AudioTrack ignored) {
                        markerReached.set(true);
                        completed.countDown();
                    }
                    @Override public void onPeriodicNotification(AudioTrack ignored) { }
                }, new android.os.Handler(getMainLooper()));
                int written = track.write(pcm, 0, pcm.length);
                if (written != pcm.length) return false;
                int markerResult = track.setNotificationMarkerPosition(markerFrames);
                if (markerResult != AudioTrack.SUCCESS) return false;
                track.play();
                long timeoutMs = Math.max(5000, (pcm.length * 1000L) / 32000L + 5000L);
                if (!completed.await(timeoutMs, TimeUnit.MILLISECONDS)) return false;
                return markerReached.get();
            } catch (InterruptedException interrupted) {
                Thread.currentThread().interrupt();
                return false;
            } catch (Throwable ignored) {
                return false;
            } finally {
                try { track.stop(); } catch (Throwable ignored) { }
                track.release();
                phoneAudioCapture.setPlaybackSuppressed(false);
            }
        }
    }

    private void queueTtsReplay(String messageId, String localPath) {
        String safeId = messageId == null ? "" : messageId.trim();
        String safePath = localPath == null ? "" : localPath.trim();
        if (safeId.isEmpty() || safePath.isEmpty() || !pendingTtsReplayIds.add(safeId)) return;
        chatStore.updatePlayback(safeId, "queued", "");
        updateRuntime("ttsPlayback", "语音等待重播");
        new Thread(() -> {
            String failure = "";
            boolean played = false;
            try {
                chatStore.updatePlayback(safeId, "playing", "");
                updateRuntime("ttsPlayback", "正在重播夜雨语音");
                played = playOnPhone(readCachedTtsPcm(safePath));
                if (!played) failure = "手机未确认播放完成";
            } catch (Throwable error) {
                failure = replayFailure(error);
            } finally {
                pendingTtsReplayIds.remove(safeId);
                chatStore.updatePlayback(safeId, played ? "played" : "failed", failure);
                updateRuntime("ttsPlayback", played ? "语音重播完成" : "语音重播失败 · " + failure);
                // A foreground service must remain visible, but its transient replay
                // label must not get stuck after AudioTrack reaches its marker.
                notificationHandler.post(() -> promote("持续会话就绪", false));
            }
        }, "rabi-phone-tts-replay").start();
    }

    private byte[] readCachedTtsPcm(String localPath) throws IOException {
        File cacheRoot = new File(getFilesDir(), "rabi-conversation/audio-cache/tts-audio").getCanonicalFile();
        File file = new File(localPath).getCanonicalFile();
        if (!file.getParentFile().equals(cacheRoot)) throw new IOException("语音缓存位置无效");
        if (!file.isFile() || file.length() < 44L) throw new IOException("语音缓存已失效");
        if (file.length() > MAX_REPLAY_WAV_BYTES) throw new IOException("语音缓存过大");
        byte[] wav = new byte[(int) file.length()];
        try (FileInputStream input = new FileInputStream(file)) {
            int offset = 0;
            while (offset < wav.length) {
                int count = input.read(wav, offset, wav.length - offset);
                if (count < 0) throw new IOException("语音缓存读取不完整");
                offset += count;
            }
        }
        return pcmFromWav(wav);
    }

    static byte[] pcmFromWav(byte[] wav) throws IOException {
        if (wav == null || wav.length < 44 || wav[0] != 'R' || wav[1] != 'I' || wav[2] != 'F' || wav[3] != 'F'
                || wav[8] != 'W' || wav[9] != 'A' || wav[10] != 'V' || wav[11] != 'E') throw new IOException("不是 WAV 语音缓存");
        ByteBuffer values = ByteBuffer.wrap(wav).order(ByteOrder.LITTLE_ENDIAN);
        int offset = 12;
        int channels = 0, sampleRate = 0, bitsPerSample = 0, dataOffset = -1, dataSize = 0;
        while (offset + 8 <= wav.length) {
            int chunkSize = values.getInt(offset + 4);
            if (chunkSize < 0 || offset + 8L + chunkSize > wav.length) throw new IOException("WAV 数据损坏");
            boolean format = wav[offset] == 'f' && wav[offset + 1] == 'm' && wav[offset + 2] == 't' && wav[offset + 3] == ' ';
            boolean data = wav[offset] == 'd' && wav[offset + 1] == 'a' && wav[offset + 2] == 't' && wav[offset + 3] == 'a';
            if (format) {
                if (chunkSize < 16 || values.getShort(offset + 8) != 1) throw new IOException("WAV 编码不受支持");
                channels = values.getShort(offset + 10); sampleRate = values.getInt(offset + 12); bitsPerSample = values.getShort(offset + 22);
            } else if (data) { dataOffset = offset + 8; dataSize = chunkSize; break; }
            offset += 8 + chunkSize + (chunkSize & 1);
        }
        if (channels != 1 || sampleRate != 16000 || bitsPerSample != 16 || dataOffset < 0 || dataSize < 4) throw new IOException("语音格式不受支持");
        byte[] pcm = new byte[dataSize];
        System.arraycopy(wav, dataOffset, pcm, 0, dataSize);
        return pcm;
    }

    private static String replayFailure(Throwable error) {
        String message = error == null ? "未知错误" : error.getMessage();
        return message == null || message.trim().isEmpty() ? "未知错误" : shortText(message);
    }

    static int phonePlaybackMarkerFrames(int pcmByteCount) {
        return Math.max(1, (pcmByteCount / 2) - 1);
    }

    static boolean phonePlaybackStateReadyForWrite(int state) {
        return state == AudioTrack.STATE_INITIALIZED || state == AudioTrack.STATE_NO_STATIC_DATA;
    }

    private String persistTtsMessage(String text, String routeProfileId, byte[] pcm) {
        if (pcm == null || pcm.length == 0 || speechArchive == null) return "";
        try {
            speechArchive.cleanup();
            RabiConversationSettings settings = RabiConversationSettings.load(this);
            RabiBoundedAudioCache.Entry retained = speechArchive.retainTts(
                    pcm, text, "rabi-phone", routeProfileId, settings.ttsModel, settings.ttsVoice);
            return retained.file.getAbsolutePath();
        } catch (Throwable ignored) { return ""; }
    }

    private void updateStatus(String text) {
        android.content.SharedPreferences.Editor runtime = getSharedPreferences("rabi_conversation_runtime", MODE_PRIVATE).edit()
                .putString("status", text)
                .putLong("updatedAt", System.currentTimeMillis());
        if (backend != null) runtime.putString("queue", backend.reliableQueueSummary());
        String normalized = text == null ? "" : text;
        if (normalized.contains("事件流已连接") || normalized.contains("消息连接已恢复") || normalized.contains("消息连接正常")) {
            runtime.putString("connection", "已连接 Rabi PC");
        } else if (normalized.contains("网络已断开")) {
            runtime.putString("connection", "网络离线，等待系统联网事件");
        } else if (normalized.contains("等待手机配置") || normalized.contains("等待配置")) {
            runtime.putString("connection", "RabiLink 尚未配置");
        } else if (normalized.startsWith("错误")) {
            runtime.putString("connection", "连接异常，可靠队列保留待重试");
        }
        runtime.apply();
        broadcastRuntimeUpdated();
        NotificationManager manager = getSystemService(NotificationManager.class);
        if (manager != null) manager.notify(REVIEW_NOTIFICATION_ID, notification(text));
    }

    private void updateRuntime(String key, String value) {
        getSharedPreferences("rabi_conversation_runtime", MODE_PRIVATE).edit()
                .putString(key, value).putLong("updatedAt", System.currentTimeMillis()).apply();
        broadcastRuntimeUpdated();
    }

    private void broadcastRuntimeUpdated() {
        sendBroadcast(new Intent("com.rabi.link.conversation.RUNTIME_UPDATED").setPackage(getPackageName()));
    }

    private static String shortText(String text) {
        String value = text == null ? "" : text.replace('\n', ' ').trim();
        return value.length() > 80 ? value.substring(0, 80) : value;
    }

    private static String friendlyError(String message) {
        String value = message == null ? "连接失败" : message.trim();
        String lower = value.toLowerCase(java.util.Locale.ROOT);
        if (lower.contains("unauthorized") || lower.contains("http 401")) return "RabiLink 登录已失效，请进入设置重新登录";
        return shortText(value);
    }

    private Notification notification(String text) {
        AllDayRecordingSettings s = AllDayRecordingSettings.load(this);
        PendingIntent content = PendingIntent.getActivity(this, REVIEW_NOTIFICATION_ID,
                new Intent(this, com.rabi.link.recording.RabiRecordingHubActivity.class),
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        PendingIntent pause = PendingIntent.getService(this, REVIEW_NOTIFICATION_ID + 1,
                new Intent(this, RabiConversationService.class).setAction(ACTION_PAUSE_RECORD),
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        PendingIntent mark = PendingIntent.getService(this, REVIEW_NOTIFICATION_ID + 2,
                new Intent(this, RabiConversationService.class).setAction(ACTION_MARK),
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        NotificationCompat.Builder builder = new NotificationCompat.Builder(this, LISTENING_CHANNEL)
                .setSmallIcon(com.rabi.link.R.drawable.rabiroute_icon)
                .setContentTitle(s.running ? "Rabi · 全天记录" : "Rabi · 记录已暂停")
                .setContentText(captureStatus)
                .setContentIntent(content).setOngoing(true).setOnlyAlertOnce(true).setSilent(true)
                .setVisibility(NotificationCompat.VISIBILITY_PRIVATE);
        if (s.running) builder.addAction(0, "暂停", pause).addAction(0, "标记", mark);
        return builder.build();
    }

    private void showReviewShortcut() { postReviewShortcut(); }

    private void postReviewShortcut() {
        NotificationManager manager = getSystemService(NotificationManager.class);
        if (manager != null) manager.notify(REVIEW_NOTIFICATION_ID, notification(captureStatus));
    }

    private String personaDisplayName() {
        return personaDisplayName(RabiConversationTarget.load(this));
    }

    private String personaDisplayName(String routeProfileId) {
        String id = routeProfileId == null ? "" : routeProfileId.trim();
        try {
            RabiLinkRelayConfig relay = RabiLinkRelaySettings.load(this);
            if (relay.getConfigured()) {
                for (com.rabiroute.sdk.RabiRouteInfo route : RabiRouteMetadataCache.INSTANCE.load(this, relay)) {
                    if (id.equals(route.getId())) {
                        String display = RabiConversationRules.INSTANCE.personaDisplayName(
                                route.getPersonaDisplayName(), route.getAgentRoleId(), route.getName(),
                                route.getConfigName(), route.getId());
                        if (display != null && !display.trim().isEmpty()) return display.trim();
                    }
                }
            }
        } catch (Throwable ignored) { }
        if (!id.isEmpty()) {
            String lower = id.toLowerCase(java.util.Locale.ROOT);
            if (lower.equals("yeyu") || lower.equals("night-rain") || lower.equals("night_rain") || id.contains("夜雨")) {
                return "夜雨";
            }
        }
        return "Rabi";
    }

    private void showAgentMessage(String messageId, String routeProfileId, String text) {
        // Ordinary chat notifications must never overwrite the capture foreground status.
        Intent destination = new Intent(this, MainActivity.class)
                .addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP | Intent.FLAG_ACTIVITY_SINGLE_TOP)
                .putExtra(EXTRA_ROUTE_PROFILE_ID, routeProfileId == null ? "" : routeProfileId);
        String conversationKey = routeProfileId == null || routeProfileId.trim().isEmpty() ? "legacy" : routeProfileId.trim();
        String persona = personaDisplayName(conversationKey);
        destination.setData(Uri.parse("rabi-link://conversation/" + Uri.encode(conversationKey)));
        PendingIntent content = PendingIntent.getActivity(this, 0, destination,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        Notification value = new NotificationCompat.Builder(this, "rabi_chat_messages")
                .setSmallIcon(com.rabi.link.R.drawable.rabiroute_icon).setContentTitle(persona + " · 新消息")
                .setContentText("收到新消息，打开会话查看")
                .setContentIntent(content).setAutoCancel(true).setVisibility(NotificationCompat.VISIBILITY_PRIVATE).build();
        NotificationManager manager = getSystemService(NotificationManager.class);
        if (manager != null) manager.notify("chat:" + conversationKey, 1, value);
    }

    public static void clearConversationNotification(Context context, String routeProfileId) {
        NotificationManager manager = context.getSystemService(NotificationManager.class);
        if (manager != null) {
            manager.cancel(legacyConversationNotificationId(routeProfileId));
            String key = routeProfileId == null || routeProfileId.trim().isEmpty() ? "legacy" : routeProfileId.trim();
            manager.cancel("chat:" + key, 1);
        }
        context.startService(new Intent(context, RabiConversationService.class).setAction(ACTION_REFRESH_NOTIFICATION));
    }

    /** Clears notifications emitted by pre-unification builds; new messages never use this ID. */
    private static int legacyConversationNotificationId(String routeProfileId) {
        String key = routeProfileId == null || routeProfileId.trim().isEmpty() ? "legacy" : routeProfileId.trim();
        return 7500 + Math.abs(key.hashCode() % 20000);
    }

    private void createChannel() {
        NotificationManager manager = getSystemService(NotificationManager.class);
        if (manager != null) {
            manager.createNotificationChannel(new NotificationChannel(LISTENING_CHANNEL, "Rabi 全天记录状态", NotificationManager.IMPORTANCE_LOW));
            manager.createNotificationChannel(new NotificationChannel("rabi_chat_messages", "Rabi 聊天消息", NotificationManager.IMPORTANCE_DEFAULT));
            for (int id : new int[]{7440, 7430, 4103, 1703}) manager.cancel(id);
        }
    }

    private void shutdown(boolean explicitStop) {
        if (shutdownComplete) return;
        shutdownComplete = true;
        pendingStarts.clear();
        ++captureGeneration;
        if (healthController != null) healthController.close();
        if (videoController != null) videoController.close();
        if (videoAudio != null) videoAudio.close();
        if (glassStatusPublisher != null) glassStatusPublisher.close();
        notificationHandler.removeCallbacks(reviewNotificationRefresh);
        notificationHandler.removeCallbacks(audioSourceWatchdog);
        unregisterNetworkEvents();
        RabiAudioShutdownSequence.run(
                () -> { if (phoneAudioCapture != null) phoneAudioCapture.close(explicitStop); },
                this::stopGlassesBackend,
                () -> { if (backend != null) backend.stop(); });
        inputMode = RabiConversationSettings.InputMode.PAUSED;
        stopForeground(STOP_FOREGROUND_REMOVE);
        com.rabi.link.recording.CaptureOwnership.release("conversation");
        NotificationManager manager = getSystemService(NotificationManager.class);
        if (manager != null) manager.cancel(REVIEW_NOTIFICATION_ID);
        if (explicitStop) stopSelf();
    }

    @Override public void onDestroy() {
        if (currentInstance == this) currentInstance = null;
        initializationExecutor.shutdown();
        shutdown(false);
        super.onDestroy();
    }
    @Override public IBinder onBind(Intent intent) { return null; }
}
