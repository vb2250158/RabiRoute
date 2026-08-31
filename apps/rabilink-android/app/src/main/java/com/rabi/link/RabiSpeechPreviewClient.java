package com.rabi.link;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.net.HttpURLConnection;
import java.net.URL;
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;

/** Authenticated, read-only adapter for the mobile speech preview. */
public final class RabiSpeechPreviewClient {
    private static final long WINDOW_SECONDS = 24L * 60L * 60L;

    public RabiSpeechPreviewSnapshot load(RabiLinkRelayConfig config, String sourceDeviceId) throws Exception {
        if (config == null || !config.getConfigured()) throw new IllegalStateException("请先连接 RabiLink 服务器");
        String deviceId = sourceDeviceId == null ? "" : sourceDeviceId.trim();
        if (deviceId.isEmpty()) throw new IllegalArgumentException("手机设备 ID 不可用");

        long nowSeconds = System.currentTimeMillis() / 1000L;
        JSONObject streamsJson = get(config, "/api/rabilink/speech/v1/audio-streams");
        JSONObject microphoneJson = get(config, "/api/rabilink/speech/v1/microphone/status");
        String query = "?kind=asr&source_device_id=" + encode(deviceId)
                + "&since=" + (nowSeconds - WINDOW_SECONDS)
                + "&limit=" + RabiSpeechPreviewSnapshot.RECORD_LIMIT;
        JSONObject recordsJson = get(config, "/api/rabilink/speech/v1/records" + query);

        RabiSpeechPreviewSnapshot.Stream stream = parseStream(streamsJson, deviceId);
        RabiSpeechPreviewSnapshot.RuntimeStats stats = parseStats(microphoneJson, stream.selected);
        List<RabiSpeechPreviewSnapshot.Record> records = parseRecords(recordsJson, deviceId, nowSeconds);
        return new RabiSpeechPreviewSnapshot(deviceId, nowSeconds, stream, stats, records);
    }

    static RabiSpeechPreviewSnapshot.Stream parseStream(JSONObject root, String sourceDeviceId) {
        JSONArray clients = root.optJSONArray("clients");
        if (clients != null) {
            for (int index = 0; index < clients.length(); index++) {
                JSONObject client = clients.optJSONObject(index);
                if (client == null || !sourceDeviceId.equals(string(client, "source_device_id", "sourceDeviceId"))) continue;
                return new RabiSpeechPreviewSnapshot.Stream(
                        true,
                        bool(client, "online"),
                        bool(client, "selected"),
                        number(client, "received_bytes", "receivedBytes"),
                        number(client, "accepted_chunks", "acceptedChunks"),
                        number(client, "last_audio_at", "lastAudioAt")
                );
            }
        }
        return new RabiSpeechPreviewSnapshot.Stream(false, false, false, 0, 0, 0);
    }

    static RabiSpeechPreviewSnapshot.RuntimeStats parseStats(JSONObject root, boolean attributable) {
        JSONObject stats = root.optJSONObject("stats");
        if (stats == null) stats = new JSONObject();
        return new RabiSpeechPreviewSnapshot.RuntimeStats(
                attributable,
                number(stats, "captured"),
                number(stats, "recognized"),
                number(stats, "empty"),
                number(stats, "dropped")
        );
    }

    static List<RabiSpeechPreviewSnapshot.Record> parseRecords(JSONObject root, String sourceDeviceId, long nowSeconds) {
        JSONArray data = root.optJSONArray("data");
        if (data == null) data = root.optJSONArray("records");
        List<RabiSpeechPreviewSnapshot.Record> result = new ArrayList<>();
        if (data == null) return result;
        for (int index = 0; index < data.length(); index++) {
            JSONObject item = data.optJSONObject(index);
            if (item == null) continue;
            if (!"asr".equalsIgnoreCase(item.optString("kind"))) continue;
            if (!sourceDeviceId.equals(string(item, "source_device_id", "sourceDeviceId"))) continue;
            String text = item.optString("text", "").trim();
            if (text.isEmpty()) continue;
            String audioFile = string(item, "audio_file", "audioFile");
            long expiresAt = number(item, "audio_expires_at", "audioExpiresAt");
            result.add(new RabiSpeechPreviewSnapshot.Record(
                    item.optString("id", item.optString("record_id", "")),
                    number(item, "time"),
                    text,
                    item.optString("provider", ""),
                    item.optString("model", ""),
                    decimal(item, "duration"),
                    !audioFile.isEmpty() && expiresAt > nowSeconds,
                    expiresAt
            ));
        }
        return result;
    }

    private JSONObject get(RabiLinkRelayConfig config, String path) throws Exception {
        HttpURLConnection connection = (HttpURLConnection) new URL(config.getBaseUrl() + path).openConnection();
        try {
            connection.setRequestMethod("GET");
            connection.setConnectTimeout(12_000);
            connection.setReadTimeout(70_000);
            connection.setRequestProperty("X-RabiLink-Token", config.getToken());
            connection.setRequestProperty("Accept", "application/json");
            int status = connection.getResponseCode();
            InputStream input = status >= 200 && status < 300 ? connection.getInputStream() : connection.getErrorStream();
            StringBuilder body = new StringBuilder();
            if (input != null) {
                try (BufferedReader reader = new BufferedReader(new InputStreamReader(input, StandardCharsets.UTF_8))) {
                    String line;
                    while ((line = reader.readLine()) != null) body.append(line);
                }
            }
            if (status < 200 || status >= 300) {
                throw new IllegalStateException("RabiSpeech 请求失败（HTTP " + status + "）" + errorDetail(body.toString()));
            }
            return body.length() == 0 ? new JSONObject() : new JSONObject(body.toString());
        } finally {
            connection.disconnect();
        }
    }

    private static String errorDetail(String raw) {
        try {
            JSONObject value = new JSONObject(raw);
            String message = value.optString("message", "");
            if (message.isEmpty()) message = value.optJSONObject("error") == null ? "" : value.optJSONObject("error").optString("message", "");
            return message.isEmpty() ? "" : "：" + message;
        } catch (Throwable ignored) {
            return "";
        }
    }

    private static String encode(String value) throws Exception {
        return URLEncoder.encode(value, "UTF-8");
    }

    private static String string(JSONObject value, String snake, String camel) {
        String first = value.optString(snake, "").trim();
        return first.isEmpty() ? value.optString(camel, "").trim() : first;
    }

    private static long number(JSONObject value, String... keys) {
        for (String key : keys) {
            if (!value.has(key) || value.isNull(key)) continue;
            double parsed = value.optDouble(key, Double.NaN);
            if (!Double.isNaN(parsed) && !Double.isInfinite(parsed)) return Math.max(0L, (long) parsed);
        }
        return 0L;
    }

    private static double decimal(JSONObject value, String key) {
        double parsed = value.optDouble(key, 0d);
        return Double.isNaN(parsed) || Double.isInfinite(parsed) ? 0d : Math.max(0d, parsed);
    }

    private static boolean bool(JSONObject value, String key) {
        return value.optBoolean(key, false);
    }
}
