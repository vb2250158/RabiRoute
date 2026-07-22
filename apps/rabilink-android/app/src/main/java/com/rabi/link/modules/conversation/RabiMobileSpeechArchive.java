package com.rabi.link.modules.conversation;

import android.content.Context;

import org.json.JSONObject;
import org.json.JSONException;

import java.io.File;
import java.io.IOException;
import java.util.UUID;

/** Shared mobile facade for bounded audio files and append-only speech metadata. */
public final class RabiMobileSpeechArchive {
    private final RabiBoundedAudioCache asrAudioCache;
    private final RabiBoundedAudioCache ttsAudioCache;
    private final RabiMobileSpeechRecordStore records;

    public RabiMobileSpeechArchive(Context context) throws IOException {
        File owner = new File(context.getApplicationContext().getFilesDir(), "rabi-conversation");
        this.asrAudioCache = new RabiBoundedAudioCache(owner, "audio-cache/asr-audio");
        this.ttsAudioCache = new RabiBoundedAudioCache(owner, "audio-cache/tts-audio");
        this.records = new RabiMobileSpeechRecordStore(new File(owner, "speech-records"));
    }

    public static RabiMobileSpeechArchive tryCreate(Context context) {
        try { return new RabiMobileSpeechArchive(context); }
        catch (IOException error) { return null; }
    }

    public JSONObject retainAsr(byte[] pcm, String sourceDeviceKind, String sessionId, String routeId,
                                String model, String language) throws IOException {
        long now = System.currentTimeMillis();
        RabiBoundedAudioCache.Entry audio = asrAudioCache.retainPcm(pcm, sourceDeviceKind);
        try {
            return new JSONObject()
                    .put("id", "speech-" + UUID.randomUUID())
                    .put("kind", "asr")
                    .put("source", "rabilink-" + sourceDeviceKind)
                    .put("time", now / 1000.0)
                    .put("session_id", sessionId)
                    .put("route_id", routeId)
                    .put("provider", "rabispeech-proxy")
                    .put("model", model)
                    .put("language", language)
                    .put("duration", pcm.length / 32000.0)
                    .put("source_device_kind", sourceDeviceKind)
                    .put("audio_file", audio.relativePath)
                    .put("audio_expires_at", audio.expiresAt / 1000.0);
        } catch (JSONException error) {
            throw new IOException("Unable to create ASR archive metadata.", error);
        }
    }

    public void completeAsr(JSONObject retained, String text, String status) throws IOException {
        if (retained == null) return;
        try {
            records.append(new JSONObject(retained.toString())
                    .put("text", text == null ? "" : text.trim())
                    .put("status", status));
        } catch (JSONException error) {
            throw new IOException("Unable to complete ASR archive metadata.", error);
        }
    }

    public RabiBoundedAudioCache.Entry retainTts(byte[] pcm, String text, String sessionId, String routeId,
                                                  String model, String voice) throws IOException {
        long now = System.currentTimeMillis();
        RabiBoundedAudioCache.Entry audio = ttsAudioCache.retainPcm(pcm, "tts");
        try {
            records.append(new JSONObject()
                    .put("id", "speech-" + UUID.randomUUID())
                    .put("kind", "tts")
                    .put("source", "rabilink-downlink")
                    .put("time", now / 1000.0)
                    .put("session_id", sessionId)
                    .put("route_id", routeId)
                    .put("provider", "rabispeech-proxy")
                    .put("model", model)
                    .put("voice", voice)
                    .put("text", text == null ? "" : text.trim())
                    .put("audio_file", audio.relativePath)
                    .put("audio_expires_at", audio.expiresAt / 1000.0));
        } catch (JSONException error) {
            throw new IOException("Unable to create TTS archive metadata.", error);
        }
        return audio;
    }

    public void cleanup() throws IOException {
        asrAudioCache.cleanup();
        ttsAudioCache.cleanup();
    }
}
