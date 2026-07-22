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
import android.net.Uri;
import android.os.IBinder;
import android.provider.OpenableColumns;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.util.UUID;

import androidx.core.app.NotificationCompat;

import com.rabi.link.modules.rokid.RabiGlassPcBackend;
import com.rabi.link.modules.rokid.RabiPcmSegmenter;
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
    private static final String CHANNEL = "rabi_conversation";
    private static final String MESSAGE_CHANNEL = "rabi_messages";
    private static final int NOTIFICATION_ID = 7421;
    private static final int REVIEW_NOTIFICATION_ID = 7422;
    private static final long REVIEW_NOTIFICATION_REFRESH_MS = 6L * 60L * 60L * 1000L;
    private static final String EXTRA_ROUTE_PROFILE_ID = "route_profile_id";
    private static final String EXTRA_CLIENT_MESSAGE_ID = "client_message_id";

    private RabiPhoneAudioCapture phoneAudioCapture;
    private RabiMobileSpeechArchive speechArchive;
    private RabiGlassPcBackend backend;
    private RabiPcmSegmenter segmenter;
    private RabiChatStore chatStore;
    private RokidCxrController glassController;
    private RokidNativeVoiceBridge glassBridge;
    private boolean shutdownComplete;
    private InputMode inputMode = InputMode.PAUSED;
    private final android.os.Handler notificationHandler = new android.os.Handler(android.os.Looper.getMainLooper());
    private final Runnable reviewNotificationRefresh = new Runnable() {
        @Override public void run() {
            postReviewShortcut();
            notificationHandler.postDelayed(this, REVIEW_NOTIFICATION_REFRESH_MS);
        }
    };

    private enum InputMode {
        PAUSED,
        PHONE,
        GLASSES
    }

    public static void start(Context context) {
        Intent intent = new Intent(context, RabiConversationService.class).setAction(ACTION_START);
        context.startForegroundService(intent);
    }

    public static void stop(Context context) {
        context.startService(new Intent(context, RabiConversationService.class).setAction(ACTION_STOP));
    }

    public static void requestReview(Context context) {
        context.startForegroundService(new Intent(context, RabiConversationService.class).setAction(ACTION_REVIEW));
    }

    public static void enqueueMedia(Context context, Uri uri, String contentType, String routeProfileId) {
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
        context.startForegroundService(new Intent(context, RabiConversationService.class).setAction(ACTION_TEXT)
                .putExtra("text", text == null ? "" : text)
                .putExtra(EXTRA_ROUTE_PROFILE_ID, routeProfileId == null ? "" : routeProfileId)
                .putExtra(EXTRA_CLIENT_MESSAGE_ID, "phone-text-" + System.currentTimeMillis() + "-" + UUID.randomUUID()));
    }

    public static void sendText(Context context, String text) {
        sendText(context, text, RabiConversationTarget.load(context));
    }

    public static void sendConfigurationRequest(Context context, String text, String routeProfileId) {
        context.startForegroundService(new Intent(context, RabiConversationService.class).setAction(ACTION_CONFIG)
                .putExtra("text", text == null ? "" : text)
                .putExtra(EXTRA_ROUTE_PROFILE_ID, routeProfileId == null ? "" : routeProfileId)
                .putExtra(EXTRA_CLIENT_MESSAGE_ID, "phone-config-" + System.currentTimeMillis() + "-" + UUID.randomUUID()));
    }

    public static void sendConfigurationRequest(Context context, String text) {
        sendConfigurationRequest(context, text, RabiConversationTarget.load(context));
    }
    public static void retryFailed(Context context) {
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
        segmenter = new RabiPcmSegmenter(pcm -> {
            RabiGlassPcBackend target = backend;
            if (target != null) target.submitPcm(pcm);
        });
        phoneAudioCapture = new RabiPhoneAudioCapture(this, new RabiPhoneAudioCapture.Listener() {
            @Override public void onPcm(byte[] pcm) { segmenter.accept(pcm); }
            @Override public void onPlaybackSuppressed() { segmenter.reset(); }
            @Override public void onStatus(String status) { updateStatus(status); }
            @Override public void onDiagnostic(String event, String level, String state) {
                RabiGlassPcBackend target = backend;
                if (target != null) target.queueDiagnostic(event, level, state);
            }
        });
        speechArchive = RabiMobileSpeechArchive.tryCreate(this);
        backend = new RabiGlassPcBackend(this, new RabiGlassPcBackend.Listener() {
            @Override public void onStatus(String status) { updateStatus(status); if (glassBridge != null) glassBridge.sendGlassAudioStatus(status); }
            @Override public void onTranscript(String text, String routeProfileId) { chatStore.append(null, "user", "voice", text, "", "audio/pcm", routeProfileId); updateRuntime("transcript", text); if (glassBridge != null) glassBridge.sendGlassTranscript(text); updateStatus("识别 · " + shortText(text)); }
            @Override public void onDeliveryState(String clientMessageId, String routeProfileId, String state, String failure) {
                chatStore.updateDelivery(clientMessageId, state, failure);
                updateRuntime("delivery", state + (failure == null || failure.trim().isEmpty() ? "" : " · " + friendlyError(failure)));
            }
            @Override public boolean onReply(String messageId, String routeProfileId, String text, byte[] pcm, org.json.JSONArray attachments) {
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
                if (glassBridge != null) glassBridge.sendGlassReplyText(replySummary);
                if (settings.autoPlayAgentVoice && pcm != null && pcm.length > 0) {
                    if (settings.glassesEnabled) return glassBridge != null && glassBridge.sendAudioPcmToGlass(pcm);
                    playOnPhone(pcm);
                }
                return true;
            }
            @Override public void onError(String message) { updateStatus("错误 · " + friendlyError(message)); if (backend != null) backend.queueDiagnostic("conversation.error", "error", "conversation backend error"); }
        }, speechArchive);
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        String action = intent == null ? ACTION_START : intent.getAction();
        if (ACTION_STOP.equals(action)) {
            shutdown(true);
            return START_NOT_STICKY;
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
        if (!configureBackend()) {
            updateStatus("等待手机配置 RabiLink");
            return;
        }
        segmenter.configure(settings.vadThreshold, settings.silenceMs);
        promote(settings.continuousListening ? "Rabi 移动端持续服务" : "Rabi 移动端消息连接", settings.continuousListening);
        backend.start();
        applyInputMode(settings);
    }

    private void applyInputMode(RabiConversationSettings settings) {
        if (!settings.continuousListening) {
            pauseAllCaptureModes();
            updateStatus("持续聆听已暂停");
            return;
        }
        if (settings.glassesEnabled) {
            phoneAudioCapture.pause();
            startGlassesBackend();
            setInputMode(InputMode.GLASSES);
            return;
        }
        stopGlassesBackend();
        startPhoneCapture();
        setInputMode(InputMode.PHONE);
    }

    private void pauseAllCaptureModes() {
        phoneAudioCapture.pause();
        stopGlassesBackend();
        segmenter.reset();
        setInputMode(InputMode.PAUSED);
    }

    private void setInputMode(InputMode next) {
        if (inputMode == next) return;
        inputMode = next;
        backend.queueDiagnostic("conversation.input_mode", "info", next.name().toLowerCase(java.util.Locale.ROOT));
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
        if (token == null || token.trim().isEmpty()) { updateStatus("眼镜尚未授权 · 请从设置打开眼镜后端"); return; }
        glassBridge = new RokidNativeVoiceBridge(this, new RokidNativeVoiceBridge.Listener() {
            @Override public void onNativeVoiceLog(String line) { }
            @Override public void onNativeAsrText(String text, String channel, String clientId) { }
            @Override public void onNativeTtsAck(String text, String channel, String clientId) { }
            @Override public void onNativeCommandAck(String kind, String text, String channel, String clientId) { }
            @Override public void onNativeStatus(String text, String channel, String clientId) { updateStatus("眼镜 · " + shortText(text)); }
            @Override public void onNativeVoiceError(String kind, String text, String channel, String clientId) { backend.queueDiagnostic("glasses." + kind, "error", "glasses bridge error"); }
            @Override public void onGlassAudioCaptureComplete(byte[] pcm) { backend.submitPcmFromSource(pcm, RabiGlassPcBackend.SOURCE_GLASSES); }
            @Override public void onGlassReviewRequested() { backend.requestConversationReview(RabiGlassPcBackend.SOURCE_GLASSES); }
        }, values.getString("native_voice_access_key", ""), values.getString("native_voice_secret_key", ""));
        glassBridge.start();
        glassController = new RokidCxrController(this, new RokidCxrController.Listener() {
            @Override public void onLog(String line) { }
            @Override public void onCxrConnectionChanged(boolean connected) { updateStatus(connected ? "眼镜 CXR 已连接" : "等待眼镜 CXR 连接"); }
            @Override public void onGlassBtConnectionChanged(boolean connected) { updateStatus(connected ? "眼镜蓝牙已连接 · 持续聆听" : "等待眼镜蓝牙连接"); }
            @Override public void onGlassDeviceInfo(com.rokid.cxr.link.utils.GlassInfo info) { if (info != null && glassBridge != null) glassBridge.sendGlassDeviceState(info.batteryLevel, info.ischarging); }
            @Override public void onPhoto(byte[] data) { if (data != null && data.length > 0) backend.submitMediaFromSource(data, "image/jpeg", "rabi-glass-photo-" + System.currentTimeMillis() + ".jpg", "眼镜拍摄的照片", RabiGlassPcBackend.SOURCE_GLASSES); }
            @Override public void onGlassAppResult(String status, String summary, String error) { updateStatus("眼镜 App · " + shortText(status + " " + summary)); }
            @Override public void onNativeVoiceProtocol(String payload, String channel, String clientId) { if (glassBridge != null) glassBridge.handleIncomingProtocol(channel, payload, clientId); }
            @Override public void onAudioPcm(byte[] data, int offset, int length) { if (glassBridge != null) glassBridge.feedPhoneAsrAudio(data, offset, length); }
        });
        glassController.connectGlassAppSession(token.trim());
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

    private void playOnPhone(byte[] pcm) {
        if (pcm == null || pcm.length == 0) return;
        phoneAudioCapture.setPlaybackSuppressed(true);
        segmenter.flush();
        int minimum = AudioTrack.getMinBufferSize(16000, AudioFormat.CHANNEL_OUT_MONO, AudioFormat.ENCODING_PCM_16BIT);
        AudioTrack track = new AudioTrack.Builder()
                .setAudioAttributes(new AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_ASSISTANCE_ACCESSIBILITY)
                        .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH).build())
                .setAudioFormat(new AudioFormat.Builder().setSampleRate(16000).setChannelMask(AudioFormat.CHANNEL_OUT_MONO)
                        .setEncoding(AudioFormat.ENCODING_PCM_16BIT).build())
                .setBufferSizeInBytes(Math.max(minimum, pcm.length))
                .setTransferMode(AudioTrack.MODE_STATIC)
                .build();
        try {
            track.write(pcm, 0, pcm.length);
            track.play();
            long durationMs = Math.max(200, (pcm.length * 1000L) / 32000L);
            Thread.sleep(durationMs + 150);
        } catch (Throwable ignored) {
        } finally {
            try { track.stop(); } catch (Throwable ignored) { }
            track.release();
            phoneAudioCapture.setPlaybackSuppressed(false);
            segmenter.reset();
        }
    }

    private String persistTtsMessage(String text, String routeProfileId, byte[] pcm) {
        if (pcm == null || pcm.length == 0 || speechArchive == null) return "";
        try {
            RabiConversationSettings settings = RabiConversationSettings.load(this);
            RabiBoundedAudioCache.Entry retained = speechArchive.retainTts(
                    pcm, text, "rabi-phone", routeProfileId, settings.ttsModel, settings.ttsVoice);
            return retained.file.getAbsolutePath();
        } catch (Throwable ignored) { return ""; }
    }

    private void updateStatus(String text) {
        updateRuntime("status", text);
        NotificationManager manager = getSystemService(NotificationManager.class);
        if (manager != null) manager.notify(NOTIFICATION_ID, notification(text));
    }

    private void updateRuntime(String key, String value) {
        getSharedPreferences("rabi_conversation_runtime", MODE_PRIVATE).edit()
                .putString(key, value).putLong("updatedAt", System.currentTimeMillis()).apply();
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
        segmenter.flush();
        if (phoneAudioCapture != null) {
            phoneAudioCapture.close(explicitStop);
        }
        if (backend != null) backend.stop();
        stopGlassesBackend();
        inputMode = InputMode.PAUSED;
        stopForeground(STOP_FOREGROUND_REMOVE);
        NotificationManager manager = getSystemService(NotificationManager.class);
        if (manager != null) manager.cancel(REVIEW_NOTIFICATION_ID);
        if (explicitStop) stopSelf();
    }

    @Override public void onDestroy() { shutdown(false); super.onDestroy(); }
    @Override public IBinder onBind(Intent intent) { return null; }
}
