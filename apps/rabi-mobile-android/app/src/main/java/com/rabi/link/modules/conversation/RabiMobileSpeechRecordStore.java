package com.rabi.link.modules.conversation;

import org.json.JSONObject;
import org.json.JSONException;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.text.SimpleDateFormat;
import java.util.Date;
import java.util.Locale;

/** Append-only mobile TTS metadata ledger mirroring the RabiSpeech speech-record contract. */
public final class RabiMobileSpeechRecordStore {
    private final File root;

    public RabiMobileSpeechRecordStore(File root) throws IOException {
        this.root = root.getCanonicalFile();
        this.root.mkdirs();
        if (!this.root.isDirectory()) throw new IOException("Speech record root is unavailable.");
    }

    public synchronized void append(JSONObject record) throws IOException {
        JSONObject safe;
        try { safe = new JSONObject(record.toString()); }
        catch (JSONException error) { throw new IOException("Speech record metadata is invalid.", error); }
        String audioFile = safe.optString("audio_file", "");
        if (!audioFile.isEmpty() && !safeRelativePath(audioFile)) {
            throw new IllegalArgumentException("Speech record audio_file must be a safe relative path.");
        }
        long millis = Math.round(safe.optDouble("time", System.currentTimeMillis() / 1000.0) * 1000.0);
        File target = new File(root, new SimpleDateFormat("yyyy-MM-dd", Locale.US).format(new Date(millis)) + ".jsonl");
        File canonical = target.getCanonicalFile();
        if (!canonical.getParentFile().equals(root)) throw new IOException("Speech record path escaped its root.");
        byte[] encoded = (safe.toString() + "\n").getBytes(StandardCharsets.UTF_8);
        try (FileOutputStream output = new FileOutputStream(canonical, true)) {
            output.write(encoded);
            output.flush();
        }
    }

    private static boolean safeRelativePath(String value) {
        String text = value.replace('\\', '/').trim();
        if (text.isEmpty() || text.startsWith("/") || text.contains(":") || text.contains("%")) return false;
        for (String part : text.split("/")) if (part.isEmpty() || ".".equals(part) || "..".equals(part)) return false;
        for (int index = 0; index < text.length(); index++) {
            char valueAt = text.charAt(index);
            if (valueAt < 32 || valueAt == 127) return false;
        }
        return true;
    }
}
