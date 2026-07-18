package com.rabi.link.modules.rokid;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.net.URLEncoder;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.nio.charset.StandardCharsets;
import java.util.UUID;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/** Phone-owned backend for the thin glasses client. No Agent or model runs on Android. */
final class RabiGlassPcBackend {
    interface Listener {
        void onStatus(String status);
        void onReplyPcm(byte[] pcm);
        void onError(String message);
    }

    private final ExecutorService uploadExecutor = Executors.newSingleThreadExecutor();
    private final ExecutorService pollExecutor = Executors.newSingleThreadExecutor();
    private final android.content.SharedPreferences preferences;
    private final Listener listener;
    private volatile boolean running;
    private String baseUrl = "";
    private String token = "";
    private String deviceId = "rabi-glass";

    RabiGlassPcBackend(android.content.Context context, Listener listener) {
        this.preferences = context.getSharedPreferences("rabi_glass_phone_backend", android.content.Context.MODE_PRIVATE);
        this.listener = listener;
    }

    void configure(String baseUrl, String token, String deviceId) {
        this.baseUrl = trimSlash(baseUrl);
        this.token = clean(token);
        this.deviceId = clean(deviceId).isEmpty() ? "rabi-glass" : clean(deviceId);
    }

    boolean configured() {
        return !baseUrl.isEmpty() && !token.isEmpty();
    }

    void start() {
        if (running) return;
        running = true;
        pollExecutor.execute(this::pollLoop);
    }

    void stop() {
        running = false;
        uploadExecutor.shutdownNow();
        pollExecutor.shutdownNow();
    }

    void submitPcm(byte[] pcm) {
        if (!configured()) {
            listener.onError("手机尚未连接 RabiLink 服务器");
            return;
        }
        byte[] copy = pcm == null ? new byte[0] : pcm.clone();
        uploadExecutor.execute(() -> {
            try {
                if (copy.length < 3200) throw new IllegalStateException("眼镜录音太短");
                listener.onStatus("Rabi PC 正在识别眼镜音频");
                String text = transcribe(wav(copy));
                if (text.isEmpty()) throw new IllegalStateException("Rabi PC 未识别到文字");
                publishObservation(text);
                listener.onStatus("已写入眼镜消息端 · 等待 Rabi 回复");
            } catch (Throwable error) {
                listener.onError(shortError(error));
            }
        });
    }

    void submitMedia(byte[] data, String contentType, String fileName, String caption) {
        if (!configured()) { listener.onError("手机尚未连接 RabiLink 服务器"); return; }
        byte[] copy = data == null ? new byte[0] : data.clone();
        uploadExecutor.execute(() -> {
            try {
                if (copy.length == 0) throw new IllegalArgumentException("媒体内容为空");
                listener.onStatus("手机正在慢传眼镜媒体");
                String path = "/api/rabilink/devices/media?fileName=" + encode(fileName);
                JSONObject receipt = new JSONObject(new String(request("POST", path, contentType, copy, 10 * 60 * 1000), StandardCharsets.UTF_8));
                JSONObject attachment = receipt.getJSONObject("attachment");
                publishMediaObservation(caption, attachment);
                listener.onStatus("眼镜媒体已进入 Rabi PC 消息端");
            } catch (Throwable error) {
                listener.onError(shortError(error));
            }
        });
    }

    private void pollLoop() {
        while (running) {
            try {
                if (!configured()) {
                    Thread.sleep(1500);
                    continue;
                }
                String cursor = preferences.getString("cursor:" + deviceId, "");
                JSONObject page = jsonRequest("GET", "/api/rabilink/devices/messages?deviceId=" + encode(deviceId)
                        + "&deviceKind=glasses&after=" + encode(cursor) + "&waitMs=25000&stream=1", null, null, 35000);
                String next = page.optString("nextCursor", page.optString("cursor", cursor));
                JSONArray messages = page.optJSONArray("messages");
                for (int index = 0; messages != null && index < messages.length(); index++) {
                    JSONObject item = messages.optJSONObject(index);
                    String text = item == null ? "" : item.optString("text", "").trim();
                    if (text.isEmpty()) continue;
                    listener.onStatus("Rabi PC 正在合成眼镜回复");
                    byte[] wav = request("POST", "/api/rabilink/speech/v1/audio/speech", "application/json; charset=utf-8",
                            new JSONObject().put("model", "local-tts/gpt-sovits").put("input", text).put("voice", "Rabi")
                                    .put("response_format", "wav").put("play", false).put("session_id", deviceId)
                                    .toString().getBytes(StandardCharsets.UTF_8), 240000);
                    listener.onReplyPcm(wavPcm(wav));
                    listener.onStatus("Rabi 回复已发送到眼镜");
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

    private String transcribe(byte[] wav) throws Exception {
        String boundary = "----RabiPhone" + System.currentTimeMillis();
        ByteArrayOutputStream body = new ByteArrayOutputStream();
        part(body, boundary, "model", "faster-whisper/small");
        part(body, boundary, "language", "zh");
        part(body, boundary, "response_format", "json");
        body.write(("--" + boundary + "\r\nContent-Disposition: form-data; name=\"file\"; filename=\"glasses.wav\"\r\nContent-Type: audio/wav\r\n\r\n").getBytes(StandardCharsets.UTF_8));
        body.write(wav);
        body.write(("\r\n--" + boundary + "--\r\n").getBytes(StandardCharsets.UTF_8));
        JSONObject result = new JSONObject(new String(request("POST", "/api/rabilink/speech/v1/audio/transcriptions",
                "multipart/form-data; boundary=" + boundary, body.toByteArray(), 240000), StandardCharsets.UTF_8));
        return result.optString("text", result.optString("transcript", "")).trim();
    }

    private void publishObservation(String text) throws Exception {
        long now = System.currentTimeMillis();
        JSONObject body = new JSONObject().put("text", text).put("type", "rabilink.observation")
                .put("deliveryMode", "observe").put("source", "rabilink-glasses-phone-backend")
                .put("sourceDeviceId", deviceId).put("sourceDeviceName", "Rabi Glass")
                .put("sourceDeviceKind", "glasses").put("transport", "phone-audio-backend")
                .put("clientMessageId", "glass-audio-" + now + "-" + UUID.randomUUID()).put("capturedAt", now);
        jsonRequest("POST", "/api/rabilink/devices/input", "application/json; charset=utf-8", body.toString().getBytes(StandardCharsets.UTF_8), 20000);
    }

    private void publishMediaObservation(String caption, JSONObject attachment) throws Exception {
        long now = System.currentTimeMillis();
        String kind = attachment.optString("kind", "file");
        String text = clean(caption);
        if (text.isEmpty()) text = "眼镜发送了一条" + ("image".equals(kind) ? "照片" : "video".equals(kind) ? "视频" : "媒体") + "消息。";
        JSONObject body = new JSONObject().put("text", text).put("type", "rabilink.observation")
                .put("deliveryMode", "observe").put("source", "rabilink-glasses-phone-backend")
                .put("sourceDeviceId", deviceId).put("sourceDeviceName", "Rabi Glass")
                .put("sourceDeviceKind", "glasses").put("transport", "phone-media-backend")
                .put("clientMessageId", "glass-media-" + now + "-" + UUID.randomUUID()).put("capturedAt", now)
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
    private static String trimSlash(String value) { String result = clean(value); while (result.endsWith("/")) result = result.substring(0, result.length() - 1); return result; }
    private static String shortError(Throwable error) { String text = error.getMessage(); if (text == null || text.trim().isEmpty()) text = error.getClass().getSimpleName(); text = text.replace('\n', ' '); return text.length() > 160 ? text.substring(0, 160) : text; }
}
