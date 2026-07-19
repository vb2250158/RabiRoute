package com.rabi.link;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.media.AudioAttributes;
import android.media.AudioFormat;
import android.media.AudioRecord;
import android.media.AudioTrack;
import android.media.MediaRecorder;
import android.net.Uri;
import android.os.IBinder;
import android.provider.OpenableColumns;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;

import androidx.core.app.NotificationCompat;

import com.rabi.link.modules.rokid.RabiGlassPcBackend;
import com.rabi.link.modules.rokid.RabiPcmSegmenter;
import com.rabi.link.modules.rokid.RokidCxrController;
import com.rabi.link.modules.rokid.RokidNativeVoiceBridge;

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

    private volatile boolean running;
    private volatile boolean playing;
    private Thread captureThread;
    private AudioRecord recorder;
    private RabiGlassPcBackend backend;
    private RabiPcmSegmenter segmenter;
    private RabiChatStore chatStore;
    private RokidCxrController glassController;
    private RokidNativeVoiceBridge glassBridge;
    private final android.os.Handler notificationHandler = new android.os.Handler(android.os.Looper.getMainLooper());
    private final Runnable reviewNotificationRefresh = new Runnable() {
        @Override public void run() {
            postReviewShortcut();
            notificationHandler.postDelayed(this, REVIEW_NOTIFICATION_REFRESH_MS);
        }
    };

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

    public static void enqueueMedia(Context context, Uri uri, String contentType) {
        Intent intent = new Intent(context, RabiConversationService.class).setAction(ACTION_MEDIA)
                .setData(uri).putExtra("contentType", contentType == null ? "application/octet-stream" : contentType)
                .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
        context.startForegroundService(intent);
    }

    public static void sendText(Context context, String text) {
        context.startForegroundService(new Intent(context, RabiConversationService.class).setAction(ACTION_TEXT)
                .putExtra("text", text == null ? "" : text));
    }
    public static void sendConfigurationRequest(Context context, String text) {
        context.startForegroundService(new Intent(context, RabiConversationService.class).setAction(ACTION_CONFIG)
                .putExtra("text", text == null ? "" : text));
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
        backend = new RabiGlassPcBackend(this, new RabiGlassPcBackend.Listener() {
            @Override public void onStatus(String status) { updateStatus(status); if (glassBridge != null) glassBridge.sendGlassAudioStatus(status); }
            @Override public void onTranscript(String text) { chatStore.append(null, "user", "voice", text, "", "audio/pcm", RabiConversationTarget.load(RabiConversationService.this)); updateRuntime("transcript", text); if (glassBridge != null) glassBridge.sendGlassTranscript(text); updateStatus("识别 · " + shortText(text)); }
            @Override public boolean onReply(String messageId, String routeProfileId, String text, byte[] pcm, org.json.JSONArray attachments) {
                String ttsPath = persistTtsMessage(messageId, pcm);
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
        });
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        String action = intent == null ? ACTION_START : intent.getAction();
        if (ACTION_STOP.equals(action)) {
            shutdown();
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
            new Thread(() -> enqueueMedia(uri, contentType), "rabi-phone-media-import").start();
            return START_STICKY;
        }
        if (ACTION_TEXT.equals(action) || ACTION_CONFIG.equals(action)) {
            promote("正在发送文本消息", false); showReviewShortcut(); if (configureBackend()) backend.start();
            String text = intent.getStringExtra("text");
            if (text != null && !text.trim().isEmpty()) {
                chatStore.append(null, "user", ACTION_CONFIG.equals(action) ? "configuration" : "text", text.trim(), "", "text/plain", RabiConversationTarget.load(this));
                if (ACTION_CONFIG.equals(action)) backend.submitConfigurationRequest(text); else backend.submitText(text);
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
        promote("Rabi 移动端持续服务", true);
        if (settings.glassesEnabled) {
            backend.start();
            startGlassesBackend();
            return;
        }
        backend.start();
        backend.queueDiagnostic("conversation.started", "info", settings.glassesEnabled ? "glasses" : "phone");
        if (!settings.continuousListening) {
            updateStatus("持续聆听已暂停");
            return;
        }
        startPhoneCapture();
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
            @Override public void onGlassAudioCaptureComplete(byte[] pcm) { backend.submitPcm(pcm); }
            @Override public void onGlassReviewRequested() { backend.requestConversationReview(); }
        }, values.getString("native_voice_access_key", ""), values.getString("native_voice_secret_key", ""));
        glassBridge.start();
        glassController = new RokidCxrController(this, new RokidCxrController.Listener() {
            @Override public void onLog(String line) { }
            @Override public void onCxrConnectionChanged(boolean connected) { updateStatus(connected ? "眼镜 CXR 已连接" : "等待眼镜 CXR 连接"); }
            @Override public void onGlassBtConnectionChanged(boolean connected) { updateStatus(connected ? "眼镜蓝牙已连接 · 持续聆听" : "等待眼镜蓝牙连接"); }
            @Override public void onGlassDeviceInfo(com.rokid.cxr.link.utils.GlassInfo info) { if (info != null && glassBridge != null) glassBridge.sendGlassDeviceState(info.batteryLevel, info.ischarging); }
            @Override public void onPhoto(byte[] data) { if (data != null && data.length > 0) backend.submitMedia(data, "image/jpeg", "rabi-glass-photo-" + System.currentTimeMillis() + ".jpg", "眼镜拍摄的照片"); }
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

    private boolean configureBackend() {
        RabiLinkRelayConfig relay = RabiLinkRelaySettings.load(this);
        if (!relay.getConfigured()) return false;
        backend.configure(relay.getBaseUrl(), relay.getToken(), "rabi-phone");
        backend.reloadSettings();
        return true;
    }

    private void enqueueMedia(Uri uri, String contentType) {
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
            backend.submitMedia(data, contentType, fileName, "手机发送的媒体消息");
            String kind = contentType != null && contentType.startsWith("image/") ? "image"
                    : contentType != null && contentType.startsWith("video/") ? "video"
                    : contentType != null && contentType.startsWith("audio/") ? "audio-file" : "file";
            chatStore.append(null, "user", kind, "", fileName, contentType, RabiConversationTarget.load(this), uri.toString());
        } catch (Throwable error) {
            updateStatus("媒体导入失败 · " + error.getMessage());
        }
    }

    private void startPhoneCapture() {
        if (running) return;
        if (checkSelfPermission(android.Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
            updateStatus("需要麦克风权限");
            return;
        }
        int minimum = AudioRecord.getMinBufferSize(16000, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT);
        recorder = new AudioRecord(MediaRecorder.AudioSource.VOICE_RECOGNITION, 16000,
                AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT, Math.max(minimum * 2, 8192));
        if (recorder.getState() != AudioRecord.STATE_INITIALIZED) {
            updateStatus("手机麦克风初始化失败");
            recorder.release();
            recorder = null;
            return;
        }
        running = true;
        recorder.startRecording();
        captureThread = new Thread(this::captureLoop, "rabi-phone-continuous-audio");
        captureThread.start();
        updateStatus("手机持续聆听中 · 点通知可返回");
    }

    private void captureLoop() {
        byte[] buffer = new byte[3200];
        while (running) {
            AudioRecord source = recorder;
            if (source == null) break;
            int read = source.read(buffer, 0, buffer.length);
            if (read <= 0) continue;
            if (playing) {
                segmenter.reset();
                continue;
            }
            byte[] chunk = new byte[read];
            System.arraycopy(buffer, 0, chunk, 0, read);
            segmenter.accept(chunk);
        }
    }

    private void playOnPhone(byte[] pcm) {
        if (pcm == null || pcm.length == 0) return;
        playing = true;
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
            playing = false;
            segmenter.reset();
        }
    }

    private String persistTtsMessage(String messageId, byte[] pcm) {
        if (pcm == null || pcm.length == 0) return "";
        try {
            File directory = new File(getFilesDir(), "rabi-conversation/incoming/tts"); directory.mkdirs();
            File target = new File(directory, Integer.toHexString((messageId == null ? "tts" : messageId).hashCode()) + ".wav");
            ByteBuffer header = ByteBuffer.allocate(44).order(ByteOrder.LITTLE_ENDIAN);
            header.put(new byte[]{'R','I','F','F'}).putInt(36 + pcm.length).put(new byte[]{'W','A','V','E','f','m','t',' '})
                    .putInt(16).putShort((short)1).putShort((short)1).putInt(16000).putInt(32000)
                    .putShort((short)2).putShort((short)16).put(new byte[]{'d','a','t','a'}).putInt(pcm.length);
            try (FileOutputStream output = new FileOutputStream(target)) { output.write(header.array()); output.write(pcm); }
            return target.getAbsolutePath();
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
                .putExtra("route_profile_id", routeProfileId == null ? "" : routeProfileId);
        int requestCode = 7430 + Math.abs((messageId == null ? text : messageId).hashCode() % 20000);
        PendingIntent content = PendingIntent.getActivity(this, requestCode, destination,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        Notification value = new NotificationCompat.Builder(this, MESSAGE_CHANNEL)
                .setSmallIcon(com.rabi.link.R.drawable.rabiroute_icon).setContentTitle("Rabi")
                .setContentText(shortText(text)).setStyle(new NotificationCompat.BigTextStyle().bigText(text))
                .setContentIntent(content).setAutoCancel(true).build();
        NotificationManager manager = getSystemService(NotificationManager.class);
        if (manager != null) manager.notify(7500 + Math.abs((messageId == null ? text : messageId).hashCode() % 20000), value);
    }

    private void createChannel() {
        NotificationManager manager = getSystemService(NotificationManager.class);
        if (manager != null) {
            manager.createNotificationChannel(new NotificationChannel(CHANNEL, "Rabi 持续会话", NotificationManager.IMPORTANCE_LOW));
            manager.createNotificationChannel(new NotificationChannel(MESSAGE_CHANNEL, "Rabi 消息", NotificationManager.IMPORTANCE_DEFAULT));
        }
    }

    private void shutdown() {
        running = false;
        notificationHandler.removeCallbacks(reviewNotificationRefresh);
        segmenter.flush();
        AudioRecord source = recorder;
        recorder = null;
        if (source != null) {
            try { source.stop(); } catch (Throwable ignored) { }
            source.release();
        }
        if (backend != null) backend.stop();
        if (glassController != null) { glassController.disconnect(); glassController = null; }
        if (glassBridge != null) { glassBridge.stop(); glassBridge = null; }
        stopForeground(STOP_FOREGROUND_REMOVE);
        NotificationManager manager = getSystemService(NotificationManager.class);
        if (manager != null) manager.cancel(REVIEW_NOTIFICATION_ID);
        stopSelf();
    }

    @Override public void onDestroy() { shutdown(); super.onDestroy(); }
    @Override public IBinder onBind(Intent intent) { return null; }
}
