package com.rabi.link.recording;

import android.content.Context;
import org.json.JSONArray;
import org.json.JSONObject;
import java.io.*;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.*;

/** Read-only projection of sealed durable PCM. Never constructs a backend or recovers/mutates its queue. */
public final class RabiAudioRecordRepository {
    private RabiAudioRecordRepository() { }
    private static File segments(Context context) {
        return new File(context.getFilesDir(), "rabi-conversation/audio-spool/segments");
    }
    private static List<JSONObject> metadata(Context context) {
        File[] files = segments(context).listFiles((dir, name) -> name.endsWith(".json"));
        List<JSONObject> rows = new ArrayList<>();
        if (files == null) return rows;
        for (File file : files) {
            if (file.length() > 65536) continue;
            try {
                JSONObject row = new JSONObject(new String(java.nio.file.Files.readAllBytes(file.toPath()), StandardCharsets.UTF_8));
                if (row.optString("captureId").isEmpty() || row.optString("sha256").isEmpty()) continue;
                rows.add(row);
            } catch (Exception ignored) { /* A concurrently replaced or invalid row is not a playable record. */ }
        }
        rows.sort(Comparator.comparingLong(row -> row.optLong("sequence")));
        return rows;
    }
    public static JSONArray listCaptureRecords(Context context, int limit) {
        Map<String, JSONObject> records = new LinkedHashMap<>();
        for (JSONObject segment : metadata(context)) {
            String id = segment.optString("captureId");
            try {
                JSONObject record = records.get(id);
                if (record == null) {
                    record = new JSONObject().put("id", id).put("captureId", id).put("kind", "audio")
                        .put("source", segment.optString("source"))
                        .put("routeProfileId", segment.optString("routeProfileId"))
                        .put("processingPolicy", segment.optString("processingPolicy", "agent"))
                        .put("timeBasis", segment.optString("timeBasis", "received"))
                        .put("startedAt", segment.optLong("startedAt")).put("endedAt", segment.optLong("endedAt"))
                        .put("bytes", 0L).put("segmentCount", 0).put("acknowledgedSegments", 0)
                        .put("state", "saved_segments");
                    File descriptor = new File(segments(context).getParentFile(), "capture-" + id + ".json");
                    if (id.matches("[A-Za-z0-9_-]{1,100}") && descriptor.isFile() && descriptor.length() < 65536) {
                        try {
                            JSONObject binding = new JSONObject(new String(java.nio.file.Files.readAllBytes(descriptor.toPath()), StandardCharsets.UTF_8));
                            record.put("parentCaptureId", binding.optString("parentCaptureId", ""));
                            record.put("targetBound", !binding.optString("endpointIdentity", "").isEmpty());
                        } catch (Exception ignored) { record.put("targetBound", false); }
                    }
                    records.put(id, record);
                }
                record.put("endedAt", Math.max(record.optLong("endedAt"), segment.optLong("endedAt")))
                    .put("bytes", record.optLong("bytes") + segment.optLong("bytes"))
                    .put("segmentCount", record.optInt("segmentCount") + 1)
                    .put("acknowledgedSegments", record.optInt("acknowledgedSegments") + ("acked".equals(segment.optString("uploadState")) ? 1 : 0));
                // Byte duration is actual saved coverage, not wall-clock service uptime.
                record.put("durationMs", record.optLong("bytes") * 1000L / 32000L);
            } catch (Exception ignored) { }
        }
        List<JSONObject> values = new ArrayList<>(records.values());
        values.sort((a, b) -> Long.compare(b.optLong("startedAt"), a.optLong("startedAt")));
        JSONArray result = new JSONArray();
        for (int i = 0; i < Math.min(Math.max(0, Math.min(limit, 500)), values.size()); i++) result.put(values.get(i));
        return result;
    }
    /** Explicit single-record export. Missing/corrupt shards fail rather than silently making a truncated WAV. */
    public static File exportCaptureWave(Context context, String captureId) throws Exception {
        if (captureId == null || !captureId.matches("[A-Za-z0-9_-]{1,100}")) throw new IllegalArgumentException("invalid capture id");
        List<JSONObject> rows = new ArrayList<>();
        long bytes = 0;
        for (JSONObject row : metadata(context)) if (captureId.equals(row.optString("captureId"))) {
            rows.add(row); bytes += row.getLong("bytes");
        }
        if (rows.isEmpty()) throw new IOException("record has no retained sealed audio");
        if (bytes > 0xffffffffL - 36L) throw new IOException("record exceeds WAV size limit; export shorter ranges");
        File directory = new File(context.getCacheDir(), "recording-exports");
        if (!directory.mkdirs() && !directory.isDirectory()) throw new IOException("export directory unavailable");
        if (directory.getUsableSpace() < bytes + 44L + 256L * 1024L * 1024L) throw new IOException("insufficient export space");
        String exportId = UUID.randomUUID().toString();
        File destination = new File(directory, captureId + "-" + exportId + ".wav");
        File temporary = new File(directory, captureId + "-" + exportId + ".partial");
        try {
            try (FileOutputStream output = new FileOutputStream(temporary)) {
                output.write("RIFF".getBytes(StandardCharsets.US_ASCII)); le(output, bytes + 36L, 4);
                output.write("WAVEfmt ".getBytes(StandardCharsets.US_ASCII)); le(output, 16, 4); le(output, 1, 2);
                le(output, 1, 2); le(output, 16000, 4); le(output, 32000, 4); le(output, 2, 2); le(output, 16, 2);
                output.write("data".getBytes(StandardCharsets.US_ASCII)); le(output, bytes, 4);
                for (JSONObject row : rows) {
                    File pcm = new File(segments(context), row.getString("pcmFileName")).getCanonicalFile();
                    if (!pcm.getParentFile().equals(segments(context).getCanonicalFile())) throw new IOException("invalid PCM path");
                    MessageDigest digest = MessageDigest.getInstance("SHA-256"); long count = 0;
                    try (InputStream input = new FileInputStream(pcm)) {
                        byte[] buffer = new byte[32768]; int read;
                        while ((read = input.read(buffer)) != -1) { count += read; digest.update(buffer, 0, read); output.write(buffer, 0, read); }
                    }
                    StringBuilder hash = new StringBuilder(); for (byte value : digest.digest()) hash.append(String.format(Locale.US, "%02x", value & 255));
                    if (count != row.getLong("bytes") || !hash.toString().equalsIgnoreCase(row.getString("sha256"))) throw new IOException("audio changed or checksum mismatch");
                }
                output.flush(); output.getFD().sync();
            }
            java.nio.file.Files.move(temporary.toPath(), destination.toPath());
            return destination;
        } finally { if (temporary.exists()) temporary.delete(); }
    }
    private static void le(OutputStream stream, long value, int bytes) throws IOException {
        for (int i = 0; i < bytes; i++) stream.write((int) (value >>> (8 * i)) & 255);
    }
}
