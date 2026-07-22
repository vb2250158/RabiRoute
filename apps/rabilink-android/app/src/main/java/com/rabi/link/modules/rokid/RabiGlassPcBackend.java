package com.rabi.link.modules.rokid;

import com.rabi.link.RabiConversationSettings;
import com.rabi.link.RabiConversationTarget;
import com.rabi.link.modules.conversation.RabiMobileSpeechArchive;

import org.json.JSONArray;
import org.json.JSONObject;

import android.util.Base64;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.net.URLEncoder;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.nio.charset.StandardCharsets;
import java.util.UUID;
import java.util.Arrays;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Comparator;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;

/** Phone-owned backend for the thin glasses client. No Agent or model runs on Android. */
public final class RabiGlassPcBackend {
    public static final String SOURCE_PHONE = "phone";
    public static final String SOURCE_GLASSES = "glasses";

    public interface Listener {
        void onStatus(String status);
        void onTranscript(String text, String routeProfileId);
        void onDeliveryState(String clientMessageId, String routeProfileId, String state, String failure);
        boolean onReply(String messageId, String routeProfileId, String text, byte[] pcm, JSONArray attachments);
        void onError(String message);
    }

    private final ScheduledExecutorService uploadExecutor = Executors.newSingleThreadScheduledExecutor();
    private final ExecutorService pollExecutor = Executors.newSingleThreadExecutor();
    private final android.content.SharedPreferences preferences;
    private final android.content.Context context;
    private final File audioQueueDirectory;
    private final File replyQueueDirectory;
    private final File mediaQueueDirectory;
    private final File controlQueueDirectory;
    private final File diagnosticQueueDirectory;
    private final Listener listener;
    private final RabiMobileSpeechArchive speechArchive;
    private volatile boolean running;
    private String baseUrl = "";
    private String token = "";
    private String deviceId = "rabi-glass";
    private volatile RabiConversationSettings settings;
    private String lastTranscript = "";
    private long lastTranscriptAt;
    private String lastReplyText = "";
    private long lastReplyAt;
    private String lastDiagnosticKey = "";
    private long lastDiagnosticAt;

    public RabiGlassPcBackend(android.content.Context context, Listener listener) {
        this(context, listener, RabiMobileSpeechArchive.tryCreate(context));
    }

    public RabiGlassPcBackend(android.content.Context context, Listener listener, RabiMobileSpeechArchive speechArchive) {
        this.context = context.getApplicationContext();
        this.preferences = this.context.getSharedPreferences("rabi_glass_phone_backend", android.content.Context.MODE_PRIVATE);
        this.listener = listener;
        this.speechArchive = speechArchive;
        this.settings = RabiConversationSettings.load(this.context);
        this.audioQueueDirectory = new File(this.context.getFilesDir(), "rabi-conversation/audio-queue");
        this.audioQueueDirectory.mkdirs();
        this.replyQueueDirectory = new File(this.context.getFilesDir(), "rabi-conversation/reply-queue");
        this.replyQueueDirectory.mkdirs();
        this.mediaQueueDirectory = new File(this.context.getFilesDir(), "rabi-conversation/media-queue");
        this.mediaQueueDirectory.mkdirs();
        this.controlQueueDirectory = new File(this.context.getFilesDir(), "rabi-conversation/control-queue");
        this.controlQueueDirectory.mkdirs();
        this.diagnosticQueueDirectory = new File(this.context.getFilesDir(), "rabi-conversation/diagnostic-queue");
        this.diagnosticQueueDirectory.mkdirs();
    }

    public void configure(String baseUrl, String token, String deviceId) {
        this.baseUrl = trimSlash(baseUrl);
        this.token = clean(token);
        this.deviceId = clean(deviceId).isEmpty() ? "rabi-glass" : clean(deviceId);
    }

    public boolean configured() {
        return !baseUrl.isEmpty() && !token.isEmpty();
    }

    public void reloadSettings() {
        settings = RabiConversationSettings.load(context);
    }

    public void start() {
        if (running) return;
        running = true;
        uploadExecutor.scheduleWithFixedDelay(this::drainQueues, 0, 5, TimeUnit.SECONDS);
        pollExecutor.execute(this::pollLoop);
    }

    public void stop() {
        running = false;
        uploadExecutor.shutdownNow();
        pollExecutor.shutdownNow();
    }

    public void submitPcm(byte[] pcm) {
        submitPcm(pcm, routeProfileId());
    }

    public void submitPcm(byte[] pcm, String routeProfileId) {
        submitPcmFromSource(pcm, routeProfileId, SOURCE_PHONE);
    }

    public void submitPcmFromSource(byte[] pcm, String sourceDeviceKind) {
        submitPcmFromSource(pcm, routeProfileId(), sourceDeviceKind);
    }

    private void submitPcmFromSource(byte[] pcm, String routeProfileId, String sourceDeviceKind) {
        byte[] copy = pcm == null ? new byte[0] : pcm.clone();
        if (copy.length < 3200) { listener.onError("录音太短"); return; }
        try {
            persistAudio(copy, routeProfileId, normalizedSourceKind(sourceDeviceKind));
            listener.onStatus("语音已进入手机待传队列");
            uploadExecutor.execute(this::drainQueues);
        } catch (Throwable error) {
            listener.onError(shortError(error));
        }
    }

    private void persistAudio(byte[] pcm, String routeProfileId, String sourceDeviceKind) throws Exception {
        audioQueueDirectory.mkdirs();
        File target = new File(audioQueueDirectory, String.format(java.util.Locale.US, "%013d-%s.pcm",
                System.currentTimeMillis(), UUID.randomUUID()));
        try (FileOutputStream output = new FileOutputStream(target)) { output.write(pcm); }
        JSONObject metadata = new JSONObject()
                .put("routeProfileId", routeProfileId())
                .put("sourceDeviceKind", sourceDeviceKind);
        if (speechArchive != null) try {
            metadata.put("speechArchive", speechArchive.retainAsr(
                    pcm, sourceDeviceKind, deviceId, routeProfileId(), settings.asrModel, settings.asrLanguage));
        } catch (Throwable error) {
            queueDiagnostic("conversation.audio.archive_failed", "error", error.getClass().getSimpleName());
        }
        try (FileOutputStream output = new FileOutputStream(new File(target.getPath() + ".json"))) {
            output.write(metadata.toString().getBytes(StandardCharsets.UTF_8));
        }
        pruneAudioQueue();
    }

    private void drainAudioQueue() {
        if (!configured()) return;
        if (preferences.getBoolean("asrPaused:" + deviceId, false)) return;
        File[] pending = audioQueueDirectory.listFiles((directory, name) -> name.endsWith(".pcm"));
        if (pending == null || pending.length == 0) return;
        Arrays.sort(pending, Comparator.comparing(File::getName));
        for (File item : pending) {
            try {
                String queuedRoute = "";
                String sourceDeviceKind = SOURCE_PHONE;
                JSONObject archivedSpeech = null;
                File sidecar = new File(item.getPath() + ".json");
                if (sidecar.exists()) try (FileInputStream input = new FileInputStream(sidecar)) {
                    JSONObject metadata = new JSONObject(new String(readAll(input), StandardCharsets.UTF_8));
                    queuedRoute = metadata.optString("routeProfileId", "");
                    sourceDeviceKind = normalizedSourceKind(metadata.optString("sourceDeviceKind", SOURCE_PHONE));
                    archivedSpeech = metadata.optJSONObject("speechArchive");
                }
                byte[] pcm;
                try (FileInputStream input = new FileInputStream(item)) { pcm = readAll(input); }
                listener.onStatus("Rabi PC 正在识别待传语音 · 剩余 " + pending.length);
                String text = transcribe(wav(pcm));
                if (text.isEmpty()) {
                    completeArchivedAsr(archivedSpeech, "", "empty");
                    item.delete();
                    sidecar.delete();
                    listener.onStatus("已忽略没有识别文本的音频段");
                    continue;
                }
                if (!acceptTranscript(text)) {
                    completeArchivedAsr(archivedSpeech, text, "suppressed");
                    item.delete();
                    sidecar.delete();
                    listener.onStatus("已抑制重复或扬声器回声");
                    continue;
                }
                listener.onTranscript(text, queuedRoute);
                publishObservation(text, "queued-audio-" + item.getName(), queuedAt(item), queuedRoute, sourceDeviceKind);
                completeArchivedAsr(archivedSpeech, text, "transcribed");
                if (!item.delete()) throw new IllegalStateException("无法确认手机语音队列项");
                sidecar.delete();
                listener.onStatus("已写入会话账本 · 等待 Rabi 回复");
                preferences.edit().putInt("asrFailures:" + deviceId, 0).apply();
            } catch (Throwable error) {
                int failures = preferences.getInt("asrFailures:" + deviceId, 0) + 1;
                android.content.SharedPreferences.Editor editor = preferences.edit().putInt("asrFailures:" + deviceId, failures);
                if (failures >= 5) editor.putBoolean("asrPaused:" + deviceId, true);
                editor.apply();
                listener.onError(failures >= 5 ? "ASR 连续失败 5 次，已暂停待传语音；请点重试" : shortError(error));
                return;
            }
        }
    }

    public void retryFailedItems() {
        preferences.edit().putBoolean("asrPaused:" + deviceId, false).putInt("asrFailures:" + deviceId, 0).apply();
        File[] deferred = replyQueueDirectory.listFiles((directory, name) -> name.endsWith(".json"));
        if (deferred != null) for (File file : deferred) try {
            JSONObject item;
            try (FileInputStream input = new FileInputStream(file)) { item = new JSONObject(new String(readAll(input), StandardCharsets.UTF_8)); }
            persistDeferredReply(item, item.optInt("failures", 3), 0);
        } catch (Throwable ignored) { }
        listener.onStatus("已重新启用失败项重试"); uploadExecutor.execute(this::drainQueues);
    }

    private void drainQueues() {
        if (speechArchive != null) try { speechArchive.cleanup(); }
        catch (Throwable error) { queueDiagnostic("conversation.audio.cleanup_failed", "error", error.getClass().getSimpleName()); }
        drainControlQueue();
        drainAudioQueue();
        drainMediaQueue();
        drainDeferredReplies();
        drainDiagnostics();
    }

    public synchronized void queueDiagnostic(String event, String level, String state) {
        try {
            long now = System.currentTimeMillis();
            String safeEvent = clean(event).replaceAll("[^a-zA-Z0-9._:-]", "_");
            String safeState = clean(state).replaceAll("https?://\\S+|rbl_[0-9A-Za-z_-]+", "[redacted]");
            String diagnosticKey = safeEvent + "\n" + level + "\n" + safeState;
            if (diagnosticKey.equals(lastDiagnosticKey) && now - lastDiagnosticAt < 60_000L) return;
            lastDiagnosticKey = diagnosticKey;
            lastDiagnosticAt = now;
            JSONObject value = new JSONObject().put("id", "mobile-" + now + "-" + UUID.randomUUID())
                    .put("time", new java.util.Date(now).toInstant().toString())
                    .put("event", safeEvent.substring(0, Math.min(80, safeEvent.length())))
                    .put("level", "error".equals(level) ? "error" : "info")
                    .put("message", safeState.substring(0, Math.min(160, safeState.length())));
            File file = new File(diagnosticQueueDirectory, String.format(java.util.Locale.US, "%013d-%s.json", now, UUID.randomUUID()));
            try (FileOutputStream output = new FileOutputStream(file)) { output.write(value.toString().getBytes(StandardCharsets.UTF_8)); }
            pruneFiles(diagnosticQueueDirectory, ".json", 500, 7L * 24L * 60L * 60L * 1000L);
            uploadExecutor.execute(this::drainDiagnostics);
        } catch (Throwable ignored) { }
    }

    private void drainDiagnostics() {
        if (!configured()) return;
        File[] pending = diagnosticQueueDirectory.listFiles((directory, name) -> name.endsWith(".json"));
        if (pending == null || pending.length == 0) return;
        Arrays.sort(pending, Comparator.comparing(File::getName));
        JSONArray logs = new JSONArray(); List<File> batch = new ArrayList<>();
        for (int index = 0; index < Math.min(20, pending.length); index++) try {
            try (FileInputStream input = new FileInputStream(pending[index])) { logs.put(new JSONObject(new String(readAll(input), StandardCharsets.UTF_8))); }
            batch.add(pending[index]);
        } catch (Throwable ignored) { }
        if (logs.length() == 0) return;
        try {
            JSONObject body = new JSONObject().put("deviceId", deviceId).put("deviceKind", deviceId.contains("glass") ? "glasses" : "phone")
                    .put("deviceName", deviceId.contains("glass") ? "Rabi Glass" : "Rabi 移动端")
                    .put("source", "rabi-mobile-endpoint").put("logs", logs);
            jsonRequest("POST", "/api/rabilink/devices/logs", "application/json; charset=utf-8", body.toString().getBytes(StandardCharsets.UTF_8), 20000);
            for (File file : batch) file.delete();
        } catch (Throwable ignored) { }
    }

    private static void pruneFiles(File directory, String suffix, int maximum, long maxAgeMs) {
        File[] files = directory.listFiles((parent, name) -> name.endsWith(suffix)); if (files == null) return;
        Arrays.sort(files, Comparator.comparing(File::getName)); long cutoff = System.currentTimeMillis() - maxAgeMs;
        int excess = Math.max(0, files.length - maximum);
        for (int index = 0; index < files.length; index++) if (index < excess || files[index].lastModified() < cutoff) files[index].delete();
    }

    private void pruneAudioQueue() {
        File[] pending = audioQueueDirectory.listFiles((directory, name) -> name.endsWith(".pcm"));
        if (pending == null) return;
        Arrays.sort(pending, Comparator.comparing(File::getName));
        long cutoff = System.currentTimeMillis() - 48L * 60L * 60L * 1000L;
        int excess = Math.max(0, pending.length - 2000);
        for (int index = 0; index < pending.length; index++) {
            if (index < excess || pending[index].lastModified() < cutoff) {
                new File(pending[index].getPath() + ".json").delete(); pending[index].delete();
            }
        }
    }

    public void requestConversationReview() {
        requestConversationReview(SOURCE_PHONE);
    }

    private void completeArchivedAsr(JSONObject archivedSpeech, String text, String status) {
        if (speechArchive == null || archivedSpeech == null) return;
        try { speechArchive.completeAsr(archivedSpeech, text, status); }
        catch (Throwable error) { queueDiagnostic("conversation.audio.record_failed", "error", error.getClass().getSimpleName()); }
    }

    public void requestConversationReview(String sourceDeviceKind) {
        try {
            long now = System.currentTimeMillis();
            String origin = normalizedSourceKind(sourceDeviceKind);
            JSONObject body = new JSONObject()
                    .put("text", origin.equals("glasses")
                            ? "用户在眼镜连接会话模式单击触摸板，要求现在审阅会话记录。"
                            : "用户在手机持续会话中点击提示，要求现在审阅会话记录。")
                    .put("type", "rabilink.review_request")
                    .put("deliveryMode", "observe")
                    .put("reviewRequested", true)
                    .put("source", "rabilink-" + origin + "-review")
                    .put("sender", origin.equals("glasses") ? "Rokid Glass" : "RabiLink Phone")
                    .put("sourceDeviceId", deviceId)
                    .put("sourceDeviceName", origin.equals("glasses") ? "Rabi Glass" : "RabiLink Phone")
                    .put("sourceDeviceKind", origin)
                    .put("transport", "phone-control-backend")
                    .put("clientMessageId", origin + "-review-" + now + "-" + UUID.randomUUID())
                    .put("sessionId", deviceId)
                    .put("routeProfileId", routeProfileId())
                    .put("capturedAt", now);
            controlQueueDirectory.mkdirs();
            File target = new File(controlQueueDirectory, String.format(java.util.Locale.US, "%013d-%s.json", now, UUID.randomUUID()));
            try (FileOutputStream output = new FileOutputStream(target)) {
                output.write(body.toString().getBytes(StandardCharsets.UTF_8));
            }
            pruneControlQueue();
            listener.onStatus("审阅提示已进入手机待传队列");
            uploadExecutor.execute(this::drainQueues);
        } catch (Throwable error) {
            listener.onError(shortError(error));
        }
    }

    public void submitText(String text) {
        submitText(text, routeProfileId(), "", false);
    }

    public void submitText(String text, String routeProfileId, String clientMessageId) {
        submitText(text, routeProfileId, clientMessageId, false);
    }

    public void submitConfigurationRequest(String text) {
        submitText(text, routeProfileId(), "", true);
    }

    public void submitConfigurationRequest(String text, String routeProfileId, String clientMessageId) {
        submitText(text, routeProfileId, clientMessageId, true);
    }

    private void submitText(String text, String routeProfileId, String clientMessageId, boolean configurationRequest) {
        String value = clean(text);
        if (value.isEmpty()) return;
        try {
            long now = System.currentTimeMillis();
            String stableClientMessageId = clean(clientMessageId).isEmpty() ? "phone-text-" + now + "-" + UUID.randomUUID() : clean(clientMessageId);
            JSONObject body = new JSONObject().put("text", value).put("type", configurationRequest ? "rabilink.configuration_request" : "rabilink.message")
                    .put("deliveryMode", "direct").put("source", "rabilink-phone-chat")
                    .put("configurationRequested", configurationRequest)
                    .put("sender", "RabiLink Phone").put("sourceDeviceId", deviceId)
                    .put("sourceDeviceName", "RabiLink Phone").put("sourceDeviceKind", "phone")
                    .put("transport", "phone-chat-backend").put("clientMessageId", stableClientMessageId)
                    .put("sessionId", deviceId).put("routeProfileId", clean(routeProfileId)).put("capturedAt", now);
            File target = new File(controlQueueDirectory, String.format(java.util.Locale.US, "%013d-%s.json", now, UUID.randomUUID()));
            try (FileOutputStream output = new FileOutputStream(target)) { output.write(body.toString().getBytes(StandardCharsets.UTF_8)); }
            pruneControlQueue(); listener.onStatus(configurationRequest ? "配置请求已进入 Rabi PC 安全队列" : "文本消息已进入手机待传队列"); uploadExecutor.execute(this::drainQueues);
        } catch (Throwable error) { listener.onError(shortError(error)); }
    }

    private void drainControlQueue() {
        if (!configured()) return;
        File[] pending = controlQueueDirectory.listFiles((directory, name) -> name.endsWith(".json"));
        if (pending == null || pending.length == 0) return;
        Arrays.sort(pending, Comparator.comparing(File::getName));
        for (File item : pending) {
            try {
                byte[] body;
                try (FileInputStream input = new FileInputStream(item)) { body = readAll(input); }
                JSONObject queued = new JSONObject(new String(body, StandardCharsets.UTF_8));
                String clientMessageId = queued.optString("clientMessageId", "");
                String routeProfileId = queued.optString("routeProfileId", "");
                listener.onDeliveryState(clientMessageId, routeProfileId, "sending", "");
                jsonRequest("POST", "/api/rabilink/devices/input", "application/json; charset=utf-8", body, 20000);
                if (!item.delete()) throw new IllegalStateException("无法确认审阅提示队列项");
                String type = queued.optString("type", "");
                listener.onStatus("rabilink.review_request".equals(type)
                        ? "已推送审阅请求 · 等待 Rabi"
                        : "rabilink.configuration_request".equals(type)
                                ? "配置请求已送达 Rabi PC"
                                 : "消息已送达 Rabi PC");
                listener.onDeliveryState(clientMessageId, routeProfileId, "sent", "");
            } catch (Throwable error) {
                try {
                    JSONObject queued;
                    try (FileInputStream input = new FileInputStream(item)) { queued = new JSONObject(new String(readAll(input), StandardCharsets.UTF_8)); }
                    listener.onDeliveryState(queued.optString("clientMessageId", ""), queued.optString("routeProfileId", ""), "failed", shortError(error));
                } catch (Throwable ignored) { }
                listener.onError(shortError(error));
                return;
            }
        }
    }

    private void pruneControlQueue() {
        File[] pending = controlQueueDirectory.listFiles((directory, name) -> name.endsWith(".json"));
        if (pending == null) return;
        Arrays.sort(pending, Comparator.comparing(File::getName));
        long cutoff = System.currentTimeMillis() - 48L * 60L * 60L * 1000L;
        int excess = Math.max(0, pending.length - 2000);
        for (int index = 0; index < pending.length; index++) {
            if (index < excess || pending[index].lastModified() < cutoff) pending[index].delete();
        }
    }

    public void submitMedia(byte[] data, String contentType, String fileName, String caption) {
        submitMedia(data, contentType, fileName, caption, routeProfileId(), "");
    }

    public void submitMedia(byte[] data, String contentType, String fileName, String caption,
                            String routeProfileId, String clientMessageId) {
        byte[] copy = data == null ? new byte[0] : data.clone();
        try {
            if (copy.length == 0) throw new IllegalArgumentException("媒体内容为空");
            persistMedia(copy, contentType, fileName, caption, routeProfileId, clientMessageId, SOURCE_PHONE);
            listener.onStatus("媒体已进入手机可靠待传队列");
            uploadExecutor.execute(this::drainQueues);
        } catch (Throwable error) {
            listener.onError(shortError(error));
        }
    }

    public void submitMediaFromSource(byte[] data, String contentType, String fileName, String caption, String sourceDeviceKind) {
        byte[] copy = data == null ? new byte[0] : data.clone();
        try {
            if (copy.length == 0) throw new IllegalArgumentException("媒体内容为空");
            persistMedia(copy, contentType, fileName, caption, routeProfileId(), "", normalizedSourceKind(sourceDeviceKind));
            listener.onStatus("媒体已进入手机可靠待传队列");
            uploadExecutor.execute(this::drainQueues);
        } catch (Throwable error) {
            listener.onError(shortError(error));
        }
    }

    private void persistMedia(byte[] data, String contentType, String fileName, String caption,
                              String routeProfileId, String clientMessageId, String sourceDeviceKind) throws Exception {
        mediaQueueDirectory.mkdirs();
        String id = String.format(java.util.Locale.US, "%013d-%s", System.currentTimeMillis(), UUID.randomUUID());
        File binary = new File(mediaQueueDirectory, id + ".bin");
        File metadata = new File(mediaQueueDirectory, id + ".json");
        try (FileOutputStream output = new FileOutputStream(binary)) { output.write(data); }
        JSONObject value = new JSONObject().put("contentType", clean(contentType)).put("fileName", clean(fileName))
                .put("caption", clean(caption)).put("clientMessageId", clean(clientMessageId).isEmpty() ? "queued-media-" + id : clean(clientMessageId))
                .put("routeProfileId", clean(routeProfileId))
                .put("sourceDeviceKind", sourceDeviceKind)
                .put("capturedAt", System.currentTimeMillis());
        try (FileOutputStream output = new FileOutputStream(metadata)) {
            output.write(value.toString().getBytes(StandardCharsets.UTF_8));
        }
        pruneMediaQueue();
    }

    private void drainMediaQueue() {
        if (!configured()) return;
        File[] pending = mediaQueueDirectory.listFiles((directory, name) -> name.endsWith(".json"));
        if (pending == null || pending.length == 0) return;
        Arrays.sort(pending, Comparator.comparing(File::getName));
        for (File metadata : pending) {
            File binary = new File(mediaQueueDirectory, metadata.getName().replace(".json", ".bin"));
            try {
                if (!binary.exists()) { metadata.delete(); continue; }
                JSONObject value;
                try (FileInputStream input = new FileInputStream(metadata)) {
                    value = new JSONObject(new String(readAll(input), StandardCharsets.UTF_8));
                }
                listener.onDeliveryState(value.optString("clientMessageId", ""), value.optString("routeProfileId", ""), "sending", "");
                byte[] data;
                try (FileInputStream input = new FileInputStream(binary)) { data = readAll(input); }
                listener.onStatus("手机正在慢传媒体 · 剩余 " + pending.length);
                String path = "/api/rabilink/devices/media?fileName=" + encode(value.optString("fileName", "media.bin"));
                JSONObject receipt = new JSONObject(new String(request("POST", path,
                        value.optString("contentType", "application/octet-stream"), data, 10 * 60 * 1000), StandardCharsets.UTF_8));
                publishMediaObservation(value.optString("caption", ""), receipt.getJSONObject("attachment"),
                        value.optString("clientMessageId"), value.optLong("capturedAt", metadata.lastModified()),
                        value.optString("routeProfileId", ""),
                        normalizedSourceKind(value.optString("sourceDeviceKind", SOURCE_PHONE)));
                if (!binary.delete() || !metadata.delete()) throw new IllegalStateException("无法确认媒体队列项");
                listener.onDeliveryState(value.optString("clientMessageId", ""), value.optString("routeProfileId", ""), "sent", "");
                listener.onStatus("媒体已进入 Rabi PC 消息端");
            } catch (Throwable error) {
                try {
                    JSONObject value;
                    try (FileInputStream input = new FileInputStream(metadata)) { value = new JSONObject(new String(readAll(input), StandardCharsets.UTF_8)); }
                    listener.onDeliveryState(value.optString("clientMessageId", ""), value.optString("routeProfileId", ""), "failed", shortError(error));
                } catch (Throwable ignored) { }
                listener.onError(shortError(error));
                return;
            }
        }
    }

    private void pruneMediaQueue() {
        File[] pending = mediaQueueDirectory.listFiles((directory, name) -> name.endsWith(".json"));
        if (pending == null) return;
        Arrays.sort(pending, Comparator.comparing(File::getName));
        long cutoff = System.currentTimeMillis() - 7L * 24L * 60L * 60L * 1000L;
        int excess = Math.max(0, pending.length - 500);
        for (int index = 0; index < pending.length; index++) {
            if (index < excess || pending[index].lastModified() < cutoff) {
                new File(mediaQueueDirectory, pending[index].getName().replace(".json", ".bin")).delete();
                pending[index].delete();
            }
        }
    }

    private void pollLoop() {
        while (running) {
            try {
                if (!configured()) {
                    Thread.sleep(1500);
                    continue;
                }
                String cursor = preferences.getString("cursor:" + deviceId, "");
                String deviceKind = deviceId.contains("glass") ? "glasses" : "phone";
                JSONObject page = jsonRequest("GET", "/api/rabilink/devices/messages?deviceId=" + encode(deviceId)
                        + "&deviceKind=" + deviceKind + "&after=" + encode(cursor) + "&waitMs=25000&stream=1", null, null, 35000);
                String next = page.optString("nextCursor", page.optString("cursor", cursor));
                JSONArray messages = page.optJSONArray("messages");
                for (int index = 0; messages != null && index < messages.length(); index++) {
                    JSONObject item = messages.optJSONObject(index);
                    String text = item == null ? "" : item.optString("text", "").trim();
                    JSONArray attachments = item == null ? null : item.optJSONArray("attachments");
                    if (text.isEmpty() && (attachments == null || attachments.length() == 0)) continue;
                    String messageId = item.optString("deliveryId", item.optString("id", "message-" + index));
                    if (wasDelivered(messageId)) continue;
                    try {
                        deliverReply(item);
                    } catch (Throwable error) {
                        int failures = preferences.getInt("replyFailures:" + deviceId + ":" + messageId, 0) + 1;
                        preferences.edit().putInt("replyFailures:" + deviceId + ":" + messageId, failures).apply();
                        if (failures < 3) throw error;
                        persistDeferredReply(item, failures, System.currentTimeMillis() + 30000);
                        listener.onError("该回复连续失败 3 次，已让出队首并保留重试");
                    }
                }
                if (!next.isEmpty()) preferences.edit().putString("cursor:" + deviceId, next).apply();
            } catch (InterruptedException error) {
                Thread.currentThread().interrupt();
                return;
            } catch (Throwable error) {
                listener.onError(shortError(error));
                try { Thread.sleep(2500); } catch (InterruptedException interrupted) { Thread.currentThread().interrupt(); return; }
            }
        }
    }

    private synchronized void deliverReply(JSONObject item) throws Exception {
        String text = item.optString("text", "").trim();
        String messageId = item.optString("deliveryId", item.optString("id", "message"));
        String routeProfileId = item.optString("routeProfileId", "");
        JSONArray sourceAttachments = item.optJSONArray("attachments");
        if ((text.isEmpty() && (sourceAttachments == null || sourceAttachments.length() == 0)) || wasDelivered(messageId)) return;
        if (!text.isEmpty()) { lastReplyText = normalizedSpeechText(text); lastReplyAt = System.currentTimeMillis(); }
        JSONArray presentation = item.optJSONArray("presentation");
        boolean wantsTts = !text.isEmpty() && (presentation == null || presentation.length() == 0);
        for (int index = 0; !text.isEmpty() && presentation != null && index < presentation.length(); index++) if ("tts".equals(presentation.optString(index))) wantsTts = true;
        if (wantsTts) listener.onStatus("Rabi PC 正在合成移动端回复");
        byte[] pcm = wantsTts ? cachedReply(messageId) : new byte[0];
        if (wantsTts && pcm == null) {
            byte[] wav = request("POST", "/api/rabilink/speech/v1/audio/speech", "application/json; charset=utf-8",
                    new JSONObject().put("model", settings.ttsModel).put("input", text).put("voice", settings.ttsVoice)
                            .put("response_format", "wav").put("play", false).put("session_id", deviceId)
                            .toString().getBytes(StandardCharsets.UTF_8), 240000);
            pcm = wavPcm(wav); persistReply(messageId, pcm);
        }
        JSONArray attachments = materializeIncomingAttachments(sourceAttachments, messageId);
        if (!listener.onReply(messageId, routeProfileId, text, pcm, attachments)) throw new IllegalStateException("回复尚未被当前输出设备确认");
        markDelivered(messageId); replyFile(messageId).delete(); deferredReplyFile(messageId).delete();
        preferences.edit().remove("replyFailures:" + deviceId + ":" + messageId).apply();
        listener.onStatus("Rabi 回复已投递到移动设备消息端");
    }

    private File deferredReplyFile(String messageId) { return new File(replyQueueDirectory, replyFile(messageId).getName().replace(".pcm", ".json")); }

    private void persistDeferredReply(JSONObject item, int failures, long nextRetryAt) throws Exception {
        String messageId = item.optString("deliveryId", item.optString("id", "message"));
        JSONObject saved = new JSONObject(item.toString()).put("failures", failures).put("nextRetryAt", nextRetryAt);
        try (FileOutputStream output = new FileOutputStream(deferredReplyFile(messageId))) {
            output.write(saved.toString().getBytes(StandardCharsets.UTF_8));
        }
    }

    private JSONArray materializeIncomingAttachments(JSONArray input, String messageId) throws Exception {
        JSONArray result = new JSONArray();
        if (input == null) return result;
        File directory = new File(context.getFilesDir(), "rabi-conversation/incoming/" + Integer.toHexString(messageId.hashCode()));
        directory.mkdirs();
        for (int index = 0; index < Math.min(8, input.length()); index++) {
            JSONObject item = input.optJSONObject(index); if (item == null) continue;
            String downloadPath = item.optString("downloadPath", "");
            if (!downloadPath.startsWith("/api/rabilink/devices/media/")) continue;
            String fileName = new File(item.optString("fileName", "attachment.bin")).getName();
            byte[] data = request("GET", downloadPath, null, null, 10 * 60 * 1000);
            File target = new File(directory, fileName);
            try (FileOutputStream output = new FileOutputStream(target)) { output.write(data); }
            result.put(new JSONObject(item.toString()).put("localPath", target.getAbsolutePath()));
        }
        return result;
    }

    private void drainDeferredReplies() {
        File[] pending = replyQueueDirectory.listFiles((directory, name) -> name.endsWith(".json"));
        if (!configured() || pending == null) return;
        Arrays.sort(pending, Comparator.comparing(File::getName));
        for (File file : pending) try {
            JSONObject item;
            try (FileInputStream input = new FileInputStream(file)) { item = new JSONObject(new String(readAll(input), StandardCharsets.UTF_8)); }
            if (item.optLong("nextRetryAt", 0) > System.currentTimeMillis()) continue;
            try { deliverReply(item); }
            catch (Throwable error) {
                int failures = item.optInt("failures", 3) + 1;
                persistDeferredReply(item, failures, System.currentTimeMillis() + Math.min(10 * 60 * 1000L, 30000L * failures));
            }
        } catch (Throwable error) { listener.onError(shortError(error)); }
    }

    private String transcribe(byte[] wav) throws Exception {
        String boundary = "----RabiPhone" + System.currentTimeMillis();
        ByteArrayOutputStream body = new ByteArrayOutputStream();
        part(body, boundary, "model", settings.asrModel);
        part(body, boundary, "language", settings.asrLanguage);
        part(body, boundary, "response_format", "json");
        body.write(("--" + boundary + "\r\nContent-Disposition: form-data; name=\"file\"; filename=\"glasses.wav\"\r\nContent-Type: audio/wav\r\n\r\n").getBytes(StandardCharsets.UTF_8));
        body.write(wav);
        body.write(("\r\n--" + boundary + "--\r\n").getBytes(StandardCharsets.UTF_8));
        JSONObject result = new JSONObject(new String(request("POST", "/api/rabilink/speech/v1/audio/transcriptions",
                "multipart/form-data; boundary=" + boundary, body.toByteArray(), 240000), StandardCharsets.UTF_8));
        return result.optString("text", result.optString("transcript", "")).trim();
    }

    private void publishObservation(String text, String clientMessageId, long capturedAt, String routeProfileId,
                                    String sourceDeviceKind) throws Exception {
        long now = System.currentTimeMillis();
        boolean glasses = SOURCE_GLASSES.equals(normalizedSourceKind(sourceDeviceKind));
        JSONObject body = new JSONObject().put("text", text).put("type", "rabilink.observation")
                .put("deliveryMode", "observe").put("source", "rabilink-glasses-phone-backend")
                .put("sourceDeviceId", glasses ? "rabi-glass" : deviceId).put("sourceDeviceName", glasses ? "Rabi Glass" : "Rabi 移动端")
                .put("sourceDeviceKind", glasses ? "glasses" : "phone").put("transport", "phone-audio-backend")
                .put("clientMessageId", clientMessageId).put("routeProfileId", routeProfileId)
                .put("sessionId", deviceId)
                .put("capturedAt", capturedAt > 0 ? capturedAt : now);
        jsonRequest("POST", "/api/rabilink/devices/input", "application/json; charset=utf-8", body.toString().getBytes(StandardCharsets.UTF_8), 20000);
    }

    private static long queuedAt(File file) {
        String name = file.getName();
        int dash = name.indexOf('-');
        if (dash > 0) {
            try { return Long.parseLong(name.substring(0, dash)); } catch (NumberFormatException ignored) { }
        }
        return file.lastModified();
    }

    private synchronized boolean acceptTranscript(String text) {
        long now = System.currentTimeMillis();
        String normalized = normalizedSpeechText(text);
        if (normalized.isEmpty()) return false;
        if (now - lastTranscriptAt <= 2500 && normalized.equals(lastTranscript)) return false;
        if (now - lastReplyAt <= 12000 && similarSpeech(normalized, lastReplyText)) return false;
        lastTranscript = normalized;
        lastTranscriptAt = now;
        return true;
    }

    private static String normalizedSpeechText(String text) {
        return clean(text).toLowerCase(java.util.Locale.ROOT)
                .replaceAll("[\\s\\p{Punct}，。！？、；：‘’“”（）【】]+", "");
    }

    private static boolean similarSpeech(String left, String right) {
        if (left.isEmpty() || right.isEmpty()) return false;
        if (left.equals(right)) return true;
        int shorter = Math.min(left.length(), right.length());
        int longer = Math.max(left.length(), right.length());
        return shorter >= 4 && shorter * 10 >= longer * 7 && (left.contains(right) || right.contains(left));
    }

    private File replyFile(String messageId) {
        String key = Base64.encodeToString(messageId.getBytes(StandardCharsets.UTF_8),
                Base64.URL_SAFE | Base64.NO_WRAP | Base64.NO_PADDING);
        if (key.length() > 180) key = key.substring(0, 180) + "-" + Integer.toHexString(messageId.hashCode());
        return new File(replyQueueDirectory, key + ".pcm");
    }

    private byte[] cachedReply(String messageId) throws Exception {
        File file = replyFile(messageId);
        if (!file.exists()) return null;
        try (FileInputStream input = new FileInputStream(file)) { return readAll(input); }
    }

    private void persistReply(String messageId, byte[] pcm) throws Exception {
        replyQueueDirectory.mkdirs();
        File target = replyFile(messageId);
        File temporary = new File(target.getParentFile(), target.getName() + ".tmp");
        try (FileOutputStream output = new FileOutputStream(temporary)) { output.write(pcm); }
        if (!temporary.renameTo(target)) {
            target.delete();
            if (!temporary.renameTo(target)) throw new IllegalStateException("无法保存待播放回复");
        }
    }

    private boolean wasDelivered(String messageId) {
        return preferences.getString("delivered:" + deviceId + ":" + messageId, null) != null;
    }

    private void markDelivered(String messageId) {
        long now = System.currentTimeMillis();
        String prefix = "delivered:" + deviceId + ":";
        android.content.SharedPreferences.Editor editor = preferences.edit()
                .putString(prefix + messageId, Long.toString(now));
        List<Map.Entry<String, ?>> delivered = new ArrayList<>();
        for (Map.Entry<String, ?> entry : preferences.getAll().entrySet()) {
            if (!entry.getKey().startsWith(prefix)) continue;
            long savedAt;
            try { savedAt = Long.parseLong(String.valueOf(entry.getValue())); }
            catch (NumberFormatException error) { savedAt = 0; }
            if (savedAt < now - 48L * 60L * 60L * 1000L) editor.remove(entry.getKey());
            else delivered.add(entry);
        }
        delivered.sort(Comparator.comparingLong(entry -> {
            try { return Long.parseLong(String.valueOf(entry.getValue())); }
            catch (NumberFormatException error) { return 0L; }
        }));
        for (int index = 0; index < Math.max(0, delivered.size() - 1999); index++) {
            editor.remove(delivered.get(index).getKey());
        }
        editor.apply();
    }

    private void publishMediaObservation(String caption, JSONObject attachment, String clientMessageId, long capturedAt,
                                         String routeProfileId, String sourceDeviceKind) throws Exception {
        long now = System.currentTimeMillis();
        boolean glasses = SOURCE_GLASSES.equals(normalizedSourceKind(sourceDeviceKind));
        String kind = attachment.optString("kind", "file");
        String text = clean(caption);
        if (text.isEmpty()) text = "眼镜发送了一条" + ("image".equals(kind) ? "照片" : "video".equals(kind) ? "视频" : "媒体") + "消息。";
        JSONObject body = new JSONObject().put("text", text).put("type", "rabilink.observation")
                .put("deliveryMode", "observe").put("source", "rabilink-glasses-phone-backend")
                .put("sourceDeviceId", glasses ? "rabi-glass" : deviceId).put("sourceDeviceName", glasses ? "Rabi Glass" : "Rabi 移动端")
                .put("sourceDeviceKind", glasses ? "glasses" : "phone").put("transport", "phone-media-backend")
                .put("clientMessageId", clean(clientMessageId).isEmpty() ? "glass-media-" + now + "-" + UUID.randomUUID() : clientMessageId)
                .put("routeProfileId", routeProfileId)
                .put("sessionId", deviceId)
                .put("capturedAt", capturedAt > 0 ? capturedAt : now)
                .put("attachments", new JSONArray().put(attachment));
        jsonRequest("POST", "/api/rabilink/devices/input", "application/json; charset=utf-8", body.toString().getBytes(StandardCharsets.UTF_8), 20000);
    }

    private JSONObject jsonRequest(String method, String path, String contentType, byte[] body, int timeout) throws Exception {
        return new JSONObject(new String(request(method, path, contentType, body, timeout), StandardCharsets.UTF_8));
    }

    private byte[] request(String method, String path, String contentType, byte[] body, int timeout) throws Exception {
        HttpURLConnection connection = (HttpURLConnection) new URL(baseUrl + path).openConnection();
        connection.setRequestMethod(method); connection.setConnectTimeout(15000); connection.setReadTimeout(timeout);
        connection.setRequestProperty("X-RabiLink-Token", token); connection.setRequestProperty("Accept", "application/json, audio/wav");
        if (body != null) { connection.setDoOutput(true); connection.setRequestProperty("Content-Type", contentType); connection.setFixedLengthStreamingMode(body.length); try (OutputStream out = connection.getOutputStream()) { out.write(body); } }
        int status = connection.getResponseCode();
        byte[] response = readAll(status >= 200 && status < 300 ? connection.getInputStream() : connection.getErrorStream());
        connection.disconnect();
        if (status < 200 || status >= 300) throw new IllegalStateException("Relay HTTP " + status + ": " + new String(response, StandardCharsets.UTF_8));
        return response;
    }

    private static byte[] wav(byte[] pcm) { ByteBuffer header = ByteBuffer.allocate(44).order(ByteOrder.LITTLE_ENDIAN); header.put(new byte[]{'R','I','F','F'}).putInt(36 + pcm.length).put(new byte[]{'W','A','V','E','f','m','t',' '}).putInt(16).putShort((short)1).putShort((short)1).putInt(16000).putInt(32000).putShort((short)2).putShort((short)16).put(new byte[]{'d','a','t','a'}).putInt(pcm.length); ByteArrayOutputStream out = new ByteArrayOutputStream(44 + pcm.length); out.write(header.array(), 0, 44); out.write(pcm, 0, pcm.length); return out.toByteArray(); }
    private static byte[] wavPcm(byte[] wav) { if (wav == null || wav.length < 44) throw new IllegalArgumentException("TTS response is not WAV"); ByteBuffer b = ByteBuffer.wrap(wav).order(ByteOrder.LITTLE_ENDIAN); int offset = 12; while (offset + 8 <= wav.length) { int id = b.getInt(offset), size = b.getInt(offset + 4), start = offset + 8; if (id == 0x61746164 && size >= 0 && start + size <= wav.length) { byte[] pcm = new byte[size]; System.arraycopy(wav, start, pcm, 0, size); return pcm; } offset = start + size + (size & 1); } throw new IllegalArgumentException("TTS WAV has no data chunk"); }
    private static void part(ByteArrayOutputStream out, String boundary, String name, String value) throws Exception { out.write(("--" + boundary + "\r\nContent-Disposition: form-data; name=\"" + name + "\"\r\n\r\n" + value + "\r\n").getBytes(StandardCharsets.UTF_8)); }
    private static byte[] readAll(InputStream input) throws Exception { if (input == null) return new byte[0]; try (InputStream in = input; ByteArrayOutputStream out = new ByteArrayOutputStream()) { byte[] buffer = new byte[8192]; int read; while ((read = in.read(buffer)) >= 0) out.write(buffer, 0, read); return out.toByteArray(); } }
    private static String encode(String value) throws Exception { return URLEncoder.encode(value == null ? "" : value, "UTF-8"); }
    private static String clean(String value) { return value == null ? "" : value.trim(); }
    private static String normalizedSourceKind(String value) {
        return SOURCE_GLASSES.equalsIgnoreCase(clean(value)) ? SOURCE_GLASSES : SOURCE_PHONE;
    }
    private static String trimSlash(String value) { String result = clean(value); while (result.endsWith("/")) result = result.substring(0, result.length() - 1); return result; }
    private static String shortError(Throwable error) { String text = error.getMessage(); if (text == null || text.trim().isEmpty()) text = error.getClass().getSimpleName(); text = text.replace('\n', ' '); return text.length() > 160 ? text.substring(0, 160) : text; }
    private String routeProfileId() { return RabiConversationTarget.load(context); }
}
