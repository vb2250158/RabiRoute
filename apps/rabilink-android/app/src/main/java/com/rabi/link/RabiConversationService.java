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
import java.io.InputStream;
import java.io.File;
import java.util.UUID;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;

import androidx.core.app.NotificationCompat;

import com.rabi.link.modules.rokid.RabiGlassPcBackend;
import com.rabi.link.modules.rokid.RokidCxrController;
import com.rabi.link.modules.rokid.RokidNativeVoiceBridge;
import com.rabi.link.modules.conversation.RabiPhoneAudioCapture;
import com.rabi.link.modules.conversation.RabiBoundedAudioCache;
import com.rabi.link.modules.conversation.RabiMobileSpeechArchive;

/** Foreground phone client. Glasses are optional; this service works with the phone alone. */
public final class RabiConversationService extends Service {
    public static final String ACTION_START = "com.rabi.link.conversation.START";
    public static final String ACTION_STOP = "com.rabi.link.conversation.STOP";
    public static final String ACTION_REVIEW = "com.rabi.link.conversation.REVIEW";
    public static final String ACTION_MEDIA = "com.rabi.link.conversation.MEDIA";
    public static final String ACTION_TEXT = "com.rabi.link.conversation.TEXT";
    public static final String ACTION_RETRY = "com.rabi.link.conversation.RETRY";
    public static final String ACTION_CONFIG = "com.rabi.link.conversation.CONFIG";
    public static final String ACTION_RESTORE = "com.rabi.link.conversation.RESTORE";
    public static final String ACTION_PREFERENCE = "com.rabi.link.conversation.PREFERENCE";
    private static final String CHANNEL = "rabi_conversation";
    private static final String MESSAGE_CHANNEL = "rabi_messages";
    private static final int NOTIFICATION_ID = 7421;
    private static final int REVIEW_NOTIFICATION_ID = 7422;
    private static final long REVIEW_NOTIFICATION_REFRESH_MS = 6L * 60L * 60L * 1000L;
    private static final long NETWORK_EVENT_FALLBACK_CHECK_MS = 5L * 60L * 1000L;
    private static final String EXTRA_ROUTE_PROFILE_ID = "route_profile_id";
    private static final String EXTRA_CLIENT_MESSAGE_ID = "client_message_id";
    private static final String EXTRA_PROACTIVITY_PREFERENCE = "proactivity_preference";

    private RabiPhoneAudioCapture phoneAudioCapture;
    private RabiMobileSpeechArchive speechArchive;
    private RabiGlassPcBackend backend;
    private RabiChatStore chatStore;
    private RokidCxrController glassController;
    private RokidNativeVoiceBridge glassBridge;
    private ConnectivityManager connectivityManager;
    private ConnectivityManager.NetworkCallback networkCallback;
    private boolean shutdownComplete;
    private boolean networkKnownOffline;
    private boolean networkFallbackCheckScheduled;
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

    public static void restoreAfterBoot(Context context) {
        context.startForegroundService(new Intent(context, RabiConversationService.class).setAction(ACTION_RESTORE));
    }

    @Override
    public void onCreate() {
        super.onCreate();
        createChannel();
        chatStore = new RabiChatStore(this);
        phoneAudioCapture = new RabiPhoneAudioCapture(this, new RabiPhoneAudioCapture.Listener() {
            @Override public void onPcm(byte[] pcm) { if (backend != null) backend.streamPcmFromSource(pcm, RabiGlassPcBackend.SOURCE_PHONE); }
            @Override public void onPlaybackSuppressed() { }
            @Override public void onStatus(String status) { updateStatus(status); }
            @Override public void onDiagnostic(String event, String level, String state) {
                RabiGlassPcBackend target = backend;
                if (target != null) target.queueDiagnostic(event, level, state);
            }
        });
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
                    if (glassesOutput) {
                        played = glassBridge != null && glassBridge.sendAudioPcmToGlass(messageId, pcm);
                        if (!played) playbackFailure = glassBridge == null ? "眼镜播放通道未连接" : "眼镜未确认播放完成";
                    } else {
                        played = playOnPhone(pcm);
                        if (!played) playbackFailure = "手机未确认播放完成";
                    }
                }
                return new RabiGlassPcBackend.ReplyDeliveryResult(true, playbackRequested, played,
                        outputDeviceKind, playbackFailure);
            }
            @Override public void onError(String message) {
                updateRuntime("error", friendlyError(message));
                updateStatus("错误 · " + friendlyError(message));
                if (backend != null) backend.queueDiagnostic("conversation.error", "error", "conversation backend error");
            }
        });
        registerNetworkEvents();
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
        String action = intent == null ? ACTION_START : intent.getAction();
        if (ACTION_STOP.equals(action)) {
            RabiConversationServiceState.setRestoreEnabled(this, false);
            shutdown(true);
            return START_NOT_STICKY;
        }
        if (!ACTION_RESTORE.equals(action)) {
            RabiConversationServiceState.setRestoreEnabled(this, true);
        }
        if (ACTION_RESTORE.equals(action)) {
            promote("已恢复 Rabi 消息连接", false);
            showReviewShortcut();
            if (configureBackend()) {
                backend.start();
                updateStatus("消息连接已恢复 · 打开 App 恢复持续聆听");
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
        if (ACTION_REVIEW.equals(action)) {
            promote("正在提示 Rabi 审阅", false);
            if (configureBackend()) backend.start();
            if (backend != null) backend.requestConversationReview();
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
        promote("正在连接 Rabi PC", false);
        showReviewShortcut();
        startConversation();
        return START_STICKY;
    }

    private void startConversation() {
        RabiConversationSettings settings = RabiConversationSettings.load(this);
        updateRuntime("desiredMode", settings.inputMode.name());
        if (!configureBackend()) {
            updateStatus("等待手机配置 RabiLink");
            return;
        }
        updateRuntime("error", "");
        promote(settings.continuousListening ? "Rabi 移动端持续服务" : "Rabi 移动端消息连接", settings.continuousListening);
        backend.start();
        applyInputMode(settings);
    }

    private void applyInputMode(RabiConversationSettings settings) {
        if (settings.inputMode == RabiConversationSettings.InputMode.PAUSED) {
            pauseAllCaptureModes();
            updateStatus("已暂停采集 · 消息连接继续保持");
            return;
        }
        if (settings.inputMode == RabiConversationSettings.InputMode.GLASSES) {
            phoneAudioCapture.pause();
            backend.pauseAudioStream();
            setInputMode(RabiConversationSettings.InputMode.PAUSED);
            updateRuntime("glasses", "正在连接眼镜；连接完成前保持暂停，不会启用手机麦克风");
            startGlassesBackend();
            return;
        }
        stopGlassesBackend();
        backend.beginAudioStream(RabiGlassPcBackend.SOURCE_PHONE);
        startPhoneCapture();
        setInputMode(RabiConversationSettings.InputMode.PHONE);
        updateRuntime("glasses", "未使用眼镜输入");
    }

    private void pauseAllCaptureModes() {
        phoneAudioCapture.pause();
        stopGlassesBackend();
        if (backend != null) backend.pauseAudioStream();
        setInputMode(RabiConversationSettings.InputMode.PAUSED);
    }

    private void setInputMode(RabiConversationSettings.InputMode next) {
        boolean changed = inputMode != next;
        inputMode = next;
        updateRuntime("activeMode", next.name());
        updateRuntime("capture", next == RabiConversationSettings.InputMode.PHONE
                ? "手机麦克风采集中"
                : next == RabiConversationSettings.InputMode.GLASSES
                        ? "眼镜麦克风采集中" : "采集已暂停");
        if (changed) backend.queueDiagnostic("conversation.input_mode", "info", next.name().toLowerCase(java.util.Locale.ROOT));
    }

    private void promote(String text, boolean conversation) {
        int type = android.content.pm.ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC;
        if (conversation) {
            type |= RabiConversationSettings.load(this).glassesEnabled
                    ? android.content.pm.ServiceInfo.FOREGROUND_SERVICE_TYPE_CONNECTED_DEVICE
                    : android.content.pm.ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE;
        }
        startForeground(NOTIFICATION_ID, notification(text), type);
    }

    private void startGlassesBackend() {
        if (glassBridge != null || glassController != null) return;
        android.content.SharedPreferences values = getSharedPreferences("rokid_probe", MODE_PRIVATE);
        String token = values.getString("rokid_token", "");
        if (token == null || token.trim().isEmpty()) {
            updateRuntime("glasses", "眼镜模式不可用：尚未完成 Rokid 授权");
            updateStatus("眼镜模式不可用 · 请从设置打开眼镜后端并完成授权");
            return;
        }
        glassBridge = new RokidNativeVoiceBridge(this, new RokidNativeVoiceBridge.Listener() {
            @Override public void onNativeVoiceLog(String line) { }
            @Override public void onNativeAsrText(String text, String channel, String clientId) { }
            @Override public void onNativeTtsAck(String text, String channel, String clientId) { }
            @Override public void onNativeCommandAck(String kind, String text, String channel, String clientId) { }
            @Override public void onNativeStatus(String text, String channel, String clientId) { updateStatus("眼镜 · " + shortText(text)); }
            @Override public void onNativeVoiceError(String kind, String text, String channel, String clientId) { backend.queueDiagnostic("glasses." + kind, "error", "glasses bridge error"); }
            @Override public void onGlassAudioPcm(byte[] pcm) {
                if (backend != null && inputMode == RabiConversationSettings.InputMode.GLASSES) {
                    backend.streamPcmFromSource(pcm, RabiGlassPcBackend.SOURCE_GLASSES);
                }
            }
            @Override public void onGlassReviewRequested() { backend.requestConversationReview(RabiGlassPcBackend.SOURCE_GLASSES); }
        }, values.getString("native_voice_access_key", ""), values.getString("native_voice_secret_key", ""));
        glassBridge.start();
        glassController = new RokidCxrController(this, new RokidCxrController.Listener() {
            @Override public void onLog(String line) { }
            @Override public void onCxrConnectionChanged(boolean connected) {
                updateRuntime("glasses", connected ? "眼镜 CXR 已连接，等待蓝牙音频通道" : "眼镜模式不可用：CXR 未连接");
                updateStatus(connected ? "眼镜 CXR 已连接 · 等待蓝牙音频通道" : "等待眼镜 CXR 连接");
            }
            @Override public void onGlassBtConnectionChanged(boolean connected) {
                if (RabiConversationSettings.load(RabiConversationService.this).inputMode
                        != RabiConversationSettings.InputMode.GLASSES) return;
                if (connected) {
                    backend.beginAudioStream(RabiGlassPcBackend.SOURCE_GLASSES);
                    setInputMode(RabiConversationSettings.InputMode.GLASSES);
                    updateRuntime("glasses", "眼镜已连接，可使用麦克风、HUD 和扬声器");
                    updateStatus("眼镜蓝牙已连接 · 眼镜模式持续聆听");
                } else {
                    backend.pauseAudioStream();
                    setInputMode(RabiConversationSettings.InputMode.PAUSED);
                    updateRuntime("glasses", "眼镜模式不可用：蓝牙音频通道未连接；可切回手机模式");
                    updateStatus("眼镜已断开 · 采集保持暂停，可切回手机模式");
                }
            }
            @Override public void onGlassDeviceInfo(com.rokid.cxr.link.utils.GlassInfo info) { if (info != null && glassBridge != null) glassBridge.sendGlassDeviceState(info.batteryLevel, info.ischarging); }
            @Override public void onPhoto(byte[] data) { if (data != null && data.length > 0) backend.submitMediaFromSource(data, "image/jpeg", "rabi-glass-photo-" + System.currentTimeMillis() + ".jpg", "眼镜拍摄的照片", RabiGlassPcBackend.SOURCE_GLASSES); }
            @Override public void onGlassAppResult(String status, String summary, String error) { updateStatus("眼镜 App · " + shortText(status + " " + summary)); }
            @Override public void onNativeVoiceProtocol(String payload, String channel, String clientId) { if (glassBridge != null) glassBridge.handleIncomingProtocol(channel, payload, clientId); }
            @Override public void onAudioPcm(byte[] data, int offset, int length) {
                if (backend == null || inputMode != RabiConversationSettings.InputMode.GLASSES
                        || data == null || length <= 0) return;
                int safeOffset = Math.max(0, offset);
                int safeLength = Math.min(length, data.length - safeOffset);
                if (safeLength <= 0) return;
                byte[] chunk = new byte[safeLength];
                System.arraycopy(data, safeOffset, chunk, 0, safeLength);
                backend.streamPcmFromSource(chunk, RabiGlassPcBackend.SOURCE_GLASSES);
            }
        });
        boolean connectionStarted = glassController.connectGlassAppSession(token.trim());
        if (!connectionStarted) {
            updateRuntime("glasses", "眼镜模式不可用：Rokid 连接请求未启动");
            updateStatus("眼镜连接未启动 · 请检查 Rokid AI App、配对和授权");
            stopGlassesBackend();
            return;
        }
        new android.os.Handler(getMainLooper()).postDelayed(() -> {
            if (glassController != null) { glassController.startGlassAsrApp(); glassController.getGlassDeviceInfo(); }
        }, 1500);
        updateStatus("眼镜后台正在连接");
    }

    private void stopGlassesBackend() {
        if (glassController != null) {
            glassController.disconnect();
            glassController = null;
        }
        if (glassBridge != null) {
            glassBridge.stop();
            glassBridge = null;
        }
    }

    private boolean configureBackend() {
        RabiLinkRelayConfig relay = RabiLinkRelaySettings.load(this);
        if (!relay.getConfigured()) return false;
        backend.configure(relay.getBaseUrl(), relay.getToken(), "rabi-phone");
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
        if (pcm == null || pcm.length == 0) return false;
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
            if (track.getState() != AudioTrack.STATE_INITIALIZED) return false;
            int frames = Math.max(1, pcm.length / 2);
            track.setPlaybackPositionUpdateListener(new AudioTrack.OnPlaybackPositionUpdateListener() {
                @Override public void onMarkerReached(AudioTrack ignored) {
                    markerReached.set(true);
                    completed.countDown();
                }
                @Override public void onPeriodicNotification(AudioTrack ignored) { }
            }, new android.os.Handler(getMainLooper()));
            if (track.setNotificationMarkerPosition(frames) != AudioTrack.SUCCESS) return false;
            if (track.write(pcm, 0, pcm.length) != pcm.length) return false;
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
        if (normalized.contains("事件流已连接") || normalized.contains("消息连接已恢复")) {
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
        if (manager != null) manager.notify(NOTIFICATION_ID, notification(text));
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
        PendingIntent content = PendingIntent.getActivity(this, 0, new Intent(this, MainActivity.class),
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        return new NotificationCompat.Builder(this, CHANNEL)
                .setSmallIcon(com.rabi.link.R.drawable.rabiroute_icon)
                .setContentTitle("Rabi 持续会话")
                .setContentText(text)
                .setContentIntent(content)
                .setOngoing(true)
                .setOnlyAlertOnce(true)
                .build();
    }

    private void showReviewShortcut() {
        postReviewShortcut();
        notificationHandler.removeCallbacks(reviewNotificationRefresh);
        notificationHandler.postDelayed(reviewNotificationRefresh, REVIEW_NOTIFICATION_REFRESH_MS);
    }

    private void postReviewShortcut() {
        PendingIntent action = PendingIntent.getService(this, 7422,
                new Intent(this, RabiConversationService.class).setAction(ACTION_REVIEW),
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        Notification value = new NotificationCompat.Builder(this, CHANNEL)
                .setSmallIcon(com.rabi.link.R.drawable.rabiroute_icon).setContentTitle("提示 Rabi")
                .setContentText("点一下立即让 Agent 审阅当前会话").setContentIntent(action)
                .setOngoing(true).setOnlyAlertOnce(true).build();
        NotificationManager manager = getSystemService(NotificationManager.class);
        if (manager != null) manager.notify(REVIEW_NOTIFICATION_ID, value);
    }

    private void showAgentMessage(String messageId, String routeProfileId, String text) {
        Intent destination = new Intent(this, MainActivity.class)
                .addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP | Intent.FLAG_ACTIVITY_SINGLE_TOP)
                .putExtra(EXTRA_ROUTE_PROFILE_ID, routeProfileId == null ? "" : routeProfileId);
        String conversationKey = routeProfileId == null || routeProfileId.trim().isEmpty() ? "legacy" : routeProfileId.trim();
        int requestCode = conversationNotificationId(conversationKey);
        PendingIntent content = PendingIntent.getActivity(this, requestCode, destination,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        Notification value = new NotificationCompat.Builder(this, MESSAGE_CHANNEL)
                .setSmallIcon(com.rabi.link.R.drawable.rabiroute_icon).setContentTitle("Rabi · 新消息")
                .setContentText(shortText(text)).setStyle(new NotificationCompat.BigTextStyle().bigText(text))
                .setGroup("rabi-conversation:" + conversationKey)
                .setContentIntent(content).setAutoCancel(true).build();
        NotificationManager manager = getSystemService(NotificationManager.class);
        if (manager != null) manager.notify(conversationNotificationId(conversationKey), value);
    }

    public static void clearConversationNotification(Context context, String routeProfileId) {
        NotificationManager manager = context.getSystemService(NotificationManager.class);
        if (manager != null) manager.cancel(conversationNotificationId(routeProfileId == null || routeProfileId.trim().isEmpty() ? "legacy" : routeProfileId.trim()));
    }

    private static int conversationNotificationId(String conversationKey) {
        return 7500 + Math.abs(conversationKey.hashCode() % 20000);
    }

    private void createChannel() {
        NotificationManager manager = getSystemService(NotificationManager.class);
        if (manager != null) {
            manager.createNotificationChannel(new NotificationChannel(CHANNEL, "Rabi 持续会话", NotificationManager.IMPORTANCE_LOW));
            manager.createNotificationChannel(new NotificationChannel(MESSAGE_CHANNEL, "Rabi 消息", NotificationManager.IMPORTANCE_DEFAULT));
        }
    }

    private void shutdown(boolean explicitStop) {
        if (shutdownComplete) return;
        shutdownComplete = true;
        notificationHandler.removeCallbacks(reviewNotificationRefresh);
        unregisterNetworkEvents();
        if (phoneAudioCapture != null) {
            phoneAudioCapture.close(explicitStop);
        }
        if (backend != null) backend.stop();
        stopGlassesBackend();
        inputMode = RabiConversationSettings.InputMode.PAUSED;
        stopForeground(STOP_FOREGROUND_REMOVE);
        NotificationManager manager = getSystemService(NotificationManager.class);
        if (manager != null) manager.cancel(REVIEW_NOTIFICATION_ID);
        if (explicitStop) stopSelf();
    }

    @Override public void onDestroy() { shutdown(false); super.onDestroy(); }
    @Override public IBinder onBind(Intent intent) { return null; }
}
