package com.rabi.link.modules.rokid;

import android.content.Context;
import com.rabi.link.RabiLinkRelayConfig;
import com.rabi.link.RabiLinkRelaySettings;
import com.rabi.link.transport.RabiSpeechTunnel;
import com.rabiroute.sdk.RabiLinkPc;
import com.rabiroute.sdk.RabiRouteSdk;
import org.json.JSONObject;
import java.io.ByteArrayOutputStream;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.nio.charset.StandardCharsets;
import java.util.List;
import java.util.UUID;

/** Transcription-only events use ASR priority; Agent audio keeps its existing explicit message owner. */
final class RabiEventAsrUploader implements AutoCloseable {
    private final Context context;
    private RabiSpeechTunnel tunnel;
    private String activeWorker = "", activeUrl = "", activeToken = "";
    RabiEventAsrUploader(Context context) { this.context = context.getApplicationContext(); }

    boolean process(RabiDurableAudioSpool spool, RabiDurableAudioSpool.Segment head, java.util.function.BooleanSupplier current) throws Exception {
        List<RabiDurableAudioSpool.Segment> event = spool.transcriptionEvent(head);
        if (event.isEmpty()) return false;
        try {
            return processEvent(spool, head, current, event);
        } catch (Exception error) {
            com.rabi.link.transport.AsrEventProgress.retry(head.eventId);
            throw error;
        }
    }
    private boolean processEvent(RabiDurableAudioSpool spool, RabiDurableAudioSpool.Segment head,
            java.util.function.BooleanSupplier current, List<RabiDurableAudioSpool.Segment> event) throws Exception {
        JSONObject receipt = spool.eventReceipt(head.eventId);
        if (receipt == null) {
            ByteArrayOutputStream pcm = new ByteArrayOutputStream();
            for (RabiDurableAudioSpool.Segment part : event) {
                // Fetch archived media before acquiring the microphone spool lock.
                com.rabi.link.recording.RecordingResourceCache.resolve(part.pcmFile);
                pcm.write(spool.readPcm(part));
            }
            byte[] audio = wav(pcm.toByteArray());
            RabiLinkRelayConfig relay = RabiLinkRelaySettings.INSTANCE.load(context);
            if (!relay.getConfigured()) throw new IllegalStateException("RabiLink 尚未配置");
            List<RabiLinkPc> workers = com.rabi.link.transport.AsrDirectory.INSTANCE.load(relay).getWorkers();
            for (RabiLinkPc worker : workers) {
                if (!current.getAsBoolean()) throw new IllegalStateException("ASR processing context changed");
                if (!worker.getOnline()) continue;
                try {
                    if (tunnel == null || !activeWorker.equals(worker.getId()) || !activeUrl.equals(relay.getBaseUrl()) || !activeToken.equals(relay.getToken())) {
                        close(); tunnel = new RabiSpeechTunnel(context, relay, worker);
                        activeWorker = worker.getId(); activeUrl = relay.getBaseUrl(); activeToken = relay.getToken();
                    }
                    String boundary = "rabi-" + UUID.randomUUID();
                    ByteArrayOutputStream body = new ByteArrayOutputStream();
                    body.write(("--" + boundary + "\r\nContent-Disposition: form-data; name=\"response_format\"\r\n\r\nverbose_json\r\n--" + boundary
                        + "\r\nContent-Disposition: form-data; name=\"file\"; filename=\"event.wav\"\r\nContent-Type: audio/wav\r\n\r\n").getBytes(StandardCharsets.UTF_8));
                    body.write(audio); body.write(("\r\n--" + boundary + "--\r\n").getBytes(StandardCharsets.UTF_8));
                    com.rabi.link.transport.AsrEventProgress.processing(head.eventId);
                    RabiSpeechTunnel.Response response = tunnel.request("POST", "/v1/audio/transcriptions", "multipart/form-data; boundary=" + boundary, body.toByteArray(), 190000L);
                    if (response.getStatus() != 200) { close(); continue; }
                    JSONObject result = new JSONObject(new String(response.getBody(), StandardCharsets.UTF_8));
                    if (!(result.opt("text") instanceof String)) { close(); continue; }
                    if (!current.getAsBoolean()) throw new IllegalStateException("ASR processing context changed");
                    receipt = new JSONObject().put("eventId", head.eventId).put("captureId", head.captureId)
                        .put("workerId", worker.getId()).put("transport", tunnel.getTransport()).put("text", result.getString("text"))
                        .put("segments", result.optJSONArray("segments")).put("processedAt", System.currentTimeMillis());
                    // Commit text before acknowledging any shard. A crash during ACK resumes from this receipt.
                    spool.saveEventReceipt(head.eventId, receipt);
                    break;
                } catch (Exception error) { close(); }
            }
            if (receipt == null) throw new IllegalStateException("没有可用的 ASR 电脑，录音已保留，稍后重试");
        }
        for (RabiDurableAudioSpool.Segment part : event) {
            if (!current.getAsBoolean()) throw new IllegalStateException("ASR processing context changed");
            if ("acked".equals(part.uploadState)) continue;
            RabiDurableAudioSpool.Segment assigned = spool.assignServerSequence(part, part.sequence);
            spool.acknowledge(assigned.id, assigned.serverSequence, assigned.bytes, assigned.sha256);
        }
        com.rabi.link.transport.AsrEventProgress.complete(head.eventId);
        return true;
    }
    private static byte[] wav(byte[] pcm) {
        ByteBuffer b = ByteBuffer.allocate(44 + pcm.length).order(ByteOrder.LITTLE_ENDIAN);
        b.put("RIFF".getBytes(StandardCharsets.US_ASCII)).putInt(36 + pcm.length).put("WAVEfmt ".getBytes(StandardCharsets.US_ASCII))
            .putInt(16).putShort((short)1).putShort((short)1).putInt(16000).putInt(32000).putShort((short)2).putShort((short)16)
            .put("data".getBytes(StandardCharsets.US_ASCII)).putInt(pcm.length).put(pcm);
        return b.array();
    }
    @Override public void close() { if (tunnel != null) tunnel.close(); tunnel = null; activeWorker = ""; activeUrl = ""; activeToken = ""; }
}
