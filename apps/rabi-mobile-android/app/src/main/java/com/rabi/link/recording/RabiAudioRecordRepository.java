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
    private static String cachedRoot = "";
    private static final Map<String, CachedMetadata> cachedMetadata = new HashMap<>();
    private static final Map<String, CachedMetadata> transcriptCache = new LinkedHashMap<String, CachedMetadata>(128,0.75f,true) {
        protected boolean removeEldestEntry(Map.Entry<String,CachedMetadata> entry) { return size() > 2048; }
    };
    private static synchronized JSONObject transcript(Context context, String id, String captureId) {
        if (!id.matches("[A-Za-z0-9_-]{1,120}")) return null;
        File file = new File(segments(context).getParentFile(), "asr-" + id + ".json");
        if (!file.isFile() || file.length() >= 2_000_000) return null;
        try {
            CachedMetadata cached = transcriptCache.get(file.getAbsolutePath());
            JSONObject receipt = cached != null && cached.matches(file) ? cached.row
                : new JSONObject(new String(java.nio.file.Files.readAllBytes(file.toPath()), StandardCharsets.UTF_8));
            transcriptCache.put(file.getAbsolutePath(),new CachedMetadata(file,receipt));
            return id.equals(receipt.optString("eventId")) && captureId.equals(receipt.optString("captureId")) ? receipt : null;
        } catch (Exception ignored) { return null; }
    }
    public static JSONArray listAsrRecords(Context context, long from, long to) {
        JSONArray records = listCaptureRecords(context, from, to), result = new JSONArray();
        for (int i = 0; i < records.length(); i++) {
            JSONObject row = records.optJSONObject(i), receipt = row.optJSONObject("transcript");
            if (receipt != null && !receipt.optString("text").trim().isEmpty()) result.put(row);
        }
        return result;
    }
    private static final class CachedMetadata {
        final long modified, length;
        final JSONObject row;
        CachedMetadata(File file, JSONObject row) { modified = file.lastModified(); length = file.length(); this.row = row; }
        boolean matches(File file) { return modified == file.lastModified() && length == file.length(); }
    }
    private static File segments(Context context) {
        return new File(context.getFilesDir(), "rabi-conversation/audio-spool/segments");
    }
    private static synchronized List<JSONObject> metadata(Context context) {
        String root = segments(context).getAbsolutePath();
        if (!root.equals(cachedRoot)) { cachedMetadata.clear(); cachedRoot = root; }
        File[] files = segments(context).listFiles((dir, name) -> name.endsWith(".json"));
        List<JSONObject> rows = new ArrayList<>();
        if (files == null) return rows;
        Set<String> retained = new HashSet<>();
        for (File file : files) {
            retained.add(file.getName());
            CachedMetadata cached = cachedMetadata.get(file.getName());
            if (cached != null && cached.matches(file)) {
                if (cached.row != null) rows.add(cached.row);
                continue;
            }
            if (file.length() > 65536) continue;
            try {
                JSONObject row = new JSONObject(new String(java.nio.file.Files.readAllBytes(file.toPath()), StandardCharsets.UTF_8));
                boolean valid = !row.optString("captureId").isEmpty() && !row.optString("sha256").isEmpty();
                cachedMetadata.put(file.getName(), new CachedMetadata(file, valid ? row : null));
                if (valid) rows.add(row);
            } catch (Exception ignored) { /* A concurrently replaced or invalid row is not a playable record. */ }
        }
        cachedMetadata.keySet().retainAll(retained);
        rows.sort(Comparator.comparingLong(row -> row.optLong("sequence")));
        return rows;
    }
    public static JSONArray listCaptureRecords(Context context, int limit) {
        return listCaptureRecords(context, Math.max(0, Math.min(limit, 500)), 0, Long.MAX_VALUE);
    }
    /** Window queries retain complete captures/offsets and are not truncated by the latest-record cap. */
    public static JSONArray listCaptureRecords(Context context, long from, long to) {
        return listCaptureRecords(context, Integer.MAX_VALUE, from, to);
    }
    public static JSONArray page(Context context, long time, String cursorId, boolean older, int sourceFilter) {
        return page(context,time,cursorId,older,sourceFilter,false);
    }
    public static JSONArray page(Context context, long time, String cursorId, boolean older, int sourceFilter, boolean asrOnly) {
        Map<String, Long> starts = new HashMap<>();
        for (JSONObject row : metadata(context)) {
            if (row.optLong("bytes") < 32) continue;
            if (sourceFilter != 0 && (sourceFilter == 2) != "glasses".equals(row.optString("source"))) continue;
            String id = row.optString("eventId");
            if (id.isEmpty()) id = row.optString("captureId");
            if (asrOnly) {
                JSONObject receipt = transcript(context,id,row.optString("captureId"));
                if (receipt == null || receipt.optString("text").trim().isEmpty()) continue;
            }
            starts.merge(id, row.optLong("startedAt"), Math::min);
        }
        List<String> ids = new ArrayList<>(starts.keySet());
        ids.removeIf(id -> { int order = Long.compare(starts.get(id), time); if (order == 0) order = id.compareTo(cursorId); return older ? order >= 0 : order <= 0; });
        ids.sort((a,b) -> { int order = Long.compare(starts.get(a),starts.get(b)); if(order == 0) order = a.compareTo(b); return older ? -order : order; });
        Set<String> selected = new HashSet<>(ids.subList(0, Math.min(101,ids.size())));
        return listCaptureRecords(context, Integer.MAX_VALUE, 0, Long.MAX_VALUE, selected);
    }
    private static JSONArray listCaptureRecords(Context context, int limit, long from, long to) {
        return listCaptureRecords(context, limit, from, to, null);
    }
    private static JSONArray listCaptureRecords(Context context, int limit, long from, long to, Set<String> eventIds) {
        android.content.SharedPreferences enrollment = context.getSharedPreferences("rabi_asr_enrollment", Context.MODE_PRIVATE);
        com.rabi.link.RabiLinkRelayConfig relay = com.rabi.link.RabiLinkRelaySettings.INSTANCE.load(context);
        long pendingBefore = relay.getConfigured() && com.rabi.link.transport.AsrDirectory.accountIdentity(relay.getBaseUrl(), relay.getToken()).equals(enrollment.getString("scope", ""))
                && enrollment.getLong("requestedAt", 0) > enrollment.getLong("completedAt", 0) ? enrollment.getLong("requestedAt", 0) : 0;
        List<JSONObject> segments = metadata(context);
        Set<String> selected = new HashSet<>();
        for (JSONObject row : segments) {
            long start = row.optLong("startedAt"), duration = row.optLong("bytes") * 1000L / 32000L;
            if (start <= to && duration > 0 && start + duration > from) selected.add(row.optString("captureId"));
        }
        Map<String, JSONObject> records = new LinkedHashMap<>();
        for (JSONObject segment : segments) {
            if (!selected.contains(segment.optString("captureId"))) continue;
            String captureId = segment.optString("captureId");
            String id = segment.optString("eventId", "");
            if (id.isEmpty()) id = captureId;
            if (eventIds != null && !eventIds.contains(id)) continue;
            try {
                JSONObject record = records.get(id);
                if (record == null) {
                    record = new JSONObject().put("id", id).put("captureId", captureId).put("kind", "audio")
                        .put("source", segment.optString("source"))
                        .put("routeProfileId", segment.optString("routeProfileId"))
                        .put("processingPolicy", segment.optString("processingPolicy", "agent"))
                        .put("timeBasis", segment.optString("timeBasis", "received"))
                        .put("startedAt", segment.optLong("startedAt")).put("endedAt", segment.optLong("endedAt"))
                        .put("playbackSpans", new JSONArray()).put("bytes", 0L).put("segmentCount", 0).put("acknowledgedSegments", 0)
                        .put("state", "saved_segments");
                    File descriptor = new File(segments(context).getParentFile(), "capture-" + captureId + ".json");
                    if (captureId.matches("[A-Za-z0-9_-]{1,100}") && descriptor.isFile() && descriptor.length() < 65536) {
                        try {
                            JSONObject binding = new JSONObject(new String(java.nio.file.Files.readAllBytes(descriptor.toPath()), StandardCharsets.UTF_8));
                            record.put("parentCaptureId", binding.optString("parentCaptureId", ""));
                            record.put("targetBound", !binding.optString("endpointIdentity", "").isEmpty());
                        } catch (Exception ignored) { record.put("targetBound", false); }
                    }
                    if ("transcribe".equals(record.optString("processingPolicy")))
                        record.put("asrState", com.rabi.link.transport.AsrEventProgress.get(id));
                    else if ("local_only".equals(record.optString("processingPolicy"))) record.put("asrState", pendingBefore > 0 && segment.optLong("startedAt") <= pendingBefore ? "pending" : "local_only");
                    records.put(id, record);
                    JSONObject receipt = transcript(context,id,captureId);
                    if (receipt != null) record.put("transcript",receipt);
                }
                record.getJSONArray("playbackSpans").put(new JSONObject()
                    .put("startedAt", segment.optLong("startedAt"))
                    .put("durationMs", segment.optLong("bytes") * 1000L / 32000L)
                    .put("offsetMs", record.optLong("bytes") * 1000L / 32000L));
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
        for (int i = 0; i < Math.min(limit, values.size()); i++) result.put(values.get(i));
        return result;
    }
    /** Explicit single-record export. Missing/corrupt shards fail rather than silently making a truncated WAV. */
    public static File exportCaptureWave(Context context, String captureId) throws Exception {
        if (captureId == null || !captureId.matches("[A-Za-z0-9_-]{1,100}")) throw new IllegalArgumentException("invalid capture id");
        List<JSONObject> rows = new ArrayList<>();
        long bytes = 0;
        for (JSONObject row : metadata(context)) if (captureId.equals(row.optString("eventId")) || captureId.equals(row.optString("captureId"))) {
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
                    try (InputStream input = new FileInputStream(RecordingResourceCache.materialize(context, pcm))) {
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
