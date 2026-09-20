package com.rabi.link.modules.rokid;

import android.content.Context;
import android.util.AtomicFile;
import com.rabi.link.RabiLinkRelayConfig;
import com.rabi.link.RabiLinkRelaySettings;
import com.rabi.link.recording.RecordingResourceCache;
import com.rabi.link.transport.AsrDirectory;
import com.rabi.link.transport.RabiSpeechTunnel;
import com.rabiroute.sdk.RabiLinkPc;
import org.json.JSONArray;
import org.json.JSONObject;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.security.MessageDigest;
import java.util.Arrays;
import java.util.List;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;

/** Durable event export is separate from ASR ACK: an older PC must not block transcription. */
public final class RabiRecordingEventSync {
    private static final ScheduledExecutorService executor = Executors.newSingleThreadScheduledExecutor();
    private static final AtomicBoolean queued = new AtomicBoolean();
    private static final Object diskLock = new Object();
    private static File root(Context context) { return new File(context.getFilesDir(), "recording-event-sync"); }

    static void enqueue(Context context, JSONObject receipt, List<RabiDurableAudioSpool.Segment> parts) throws Exception {
        if (parts.isEmpty() || receipt.optJSONObject("timelineWorker") == null || receipt.optString("timelineScope").isEmpty()) return;
        String id = receipt.getString("eventId");
        if (!id.matches("[A-Za-z0-9_-]{1,120}")) throw new IllegalArgumentException("Invalid recording event");
        File target = new File(root(context), id + ".json");
        synchronized (diskLock) {
            if (!target.isFile()) {
                JSONArray files = new JSONArray();
                long started = Long.MAX_VALUE, ended = 0;
                for (RabiDurableAudioSpool.Segment part : parts) {
                    String file = part.pcmFile.getCanonicalPath();
                    if (!file.startsWith(context.getFilesDir().getCanonicalPath() + File.separator)) throw new IllegalArgumentException("Invalid recording file");
                    files.put(file); started = Math.min(started, part.startedAt); ended = Math.max(ended, part.endedAt);
                }
                write(target, new JSONObject().put("id", id).put("startedAt", started).put("endedAt", ended)
                    .put("text", receipt.optString("text")).put("files", files)
                    .put("worker", receipt.getJSONObject("timelineWorker")).put("scope", receipt.getString("timelineScope")));
            }
        }
        wake(context);
    }
    private static void write(File file, JSONObject value) throws Exception {
        if (!file.getParentFile().isDirectory() && !file.getParentFile().mkdirs()) throw new IllegalStateException("Cannot create recording sync queue");
        AtomicFile atomic = new AtomicFile(file); FileOutputStream stream = atomic.startWrite();
        try { stream.write(value.toString().getBytes(StandardCharsets.UTF_8)); atomic.finishWrite(stream); }
        catch (Exception error) { atomic.failWrite(stream); throw error; }
    }
    public static void wake(Context source) {
        Context context = source.getApplicationContext();
        if (!queued.compareAndSet(false, true)) return;
        executor.execute(() -> {
            boolean retry = false;
            try {
                File[] files = root(context).listFiles((dir, name) -> name.endsWith(".json"));
                if (files == null) return;
                Arrays.sort(files);
                for (File file : files) {
                    JSONObject item = new JSONObject(new String(Files.readAllBytes(file.toPath()), StandardCharsets.UTF_8));
                    if (item.optBoolean("synced")) continue;
                    try { send(context, file, item); }
                    catch (Exception error) { retry = true; context.getSharedPreferences("recording_event_sync", Context.MODE_PRIVATE).edit().putString("status", "事件同步待重试：" + error.getMessage()).apply(); break; }
                }
            } catch (Exception error) { retry = true; }
            finally {
                queued.set(false);
                if (retry) executor.schedule(() -> wake(context), 60, TimeUnit.SECONDS);
            }
        });
    }
    private static void send(Context context, File file, JSONObject item) throws Exception {
        RabiLinkRelayConfig relay = RabiLinkRelaySettings.INSTANCE.load(context);
        if (!relay.getConfigured() || !item.getString("scope").equals(AsrDirectory.accountIdentity(relay.getBaseUrl(), relay.getToken()))) return;
        JSONObject worker = item.getJSONObject("worker");
        RabiLinkPc target = new RabiLinkPc(worker.getString("id"), "", worker.optString("name"), "", "", true, "", worker);
        ByteArrayOutputStream pcm = new ByteArrayOutputStream();
        JSONArray files = item.getJSONArray("files");
        for (int index = 0; index < files.length(); index++) {
            File original = new File(files.getString(index)).getCanonicalFile();
            if (!original.getPath().startsWith(context.getFilesDir().getCanonicalPath() + File.separator)) throw new IllegalStateException("Invalid recording path");
            File resolved = RecordingResourceCache.resolve(original);
            if (pcm.size() + resolved.length() > 4 * 1024 * 1024) throw new IllegalStateException("Recording event too large");
            pcm.write(Files.readAllBytes(resolved.toPath()));
        }
        byte[] audio = RabiEventAsrUploader.wav(pcm.toByteArray());
        try (RabiSpeechTunnel tunnel = new RabiSpeechTunnel(context, relay, target, "resources")) {
            JSONArray chunks = new JSONArray();
            for (int offset = 0; offset < audio.length; offset += 1024 * 1024) {
                byte[] bytes = Arrays.copyOfRange(audio, offset, Math.min(audio.length, offset + 1024 * 1024));
                StringBuilder digest = new StringBuilder();
                for (byte part : MessageDigest.getInstance("SHA-256").digest(bytes)) digest.append(String.format(java.util.Locale.ROOT, "%02x", part & 255));
                String id = digest.toString();
                RabiSpeechTunnel.Response reply = tunnel.request("PUT", "/objects/" + id, "application/octet-stream", bytes, 30000L);
                if (reply.getStatus() != 200) throw new IllegalStateException("电脑保存录音失败 " + reply.getStatus());
                JSONObject ack = new JSONObject(new String(reply.getBody(), StandardCharsets.UTF_8));
                if (!ack.optBoolean("durable") || !id.equals(ack.optString("sha256")) || ack.optLong("bytes") != bytes.length) throw new IllegalStateException("Invalid recording receipt");
                chunks.put(id);
            }
            JSONObject event = new JSONObject().put("id", item.getString("id")).put("startedAt", item.getLong("startedAt"))
                .put("endedAt", item.getLong("endedAt")).put("text", item.getString("text")).put("chunks", chunks);
            RabiSpeechTunnel.Response reply = tunnel.request("PUT", "/recording-events", "application/json", event.toString().getBytes(StandardCharsets.UTF_8), 30000L);
            if (reply.getStatus() != 200 || !new JSONObject(new String(reply.getBody(), StandardCharsets.UTF_8)).optBoolean("durable")) throw new IllegalStateException("电脑尚未接收时间轴事件 " + reply.getStatus());
            synchronized (diskLock) { item.put("synced", true); write(file, item); }
            context.getSharedPreferences("recording_event_sync", Context.MODE_PRIVATE).edit().putString("status", "时间轴事件已同步到电脑").apply();
        }
    }
}
