package com.rabi.link.recording;

import android.content.Context;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;

/** Verified Relay selection, isolated by endpoint and credential digest. Never stores a token. */
public final class TargetWorkerIdentity {
    private static final String PREFS = "rabi_verified_recording_workers";
    private TargetWorkerIdentity() { }
    private static String key(String baseUrl, String token) {
        if (baseUrl == null || token == null || baseUrl.trim().isEmpty() || token.trim().isEmpty()) return "";
        try {
            String endpoint = baseUrl.trim().replaceAll("/+$", "");
            byte[] digest = MessageDigest.getInstance("SHA-256").digest((endpoint + "\n" + token.trim()).getBytes(StandardCharsets.UTF_8));
            StringBuilder hex = new StringBuilder();
            for (byte value : digest) hex.append(String.format(java.util.Locale.ROOT, "%02x", value & 255));
            return hex.toString();
        } catch (java.security.NoSuchAlgorithmException error) { throw new IllegalStateException(error); }
    }
    public static void save(Context context, String baseUrl, String token, String workerId) {
        String key = key(baseUrl, token);
        if (key.isEmpty()) throw new IllegalArgumentException("Cannot persist worker without verified endpoint identity");
        String id = workerId == null ? "" : workerId.trim();
        android.content.SharedPreferences.Editor edit = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit();
        if (id.isEmpty()) edit.remove(key); else edit.putString(key, id);
        if (!edit.commit()) throw new IllegalStateException("无法保存已验证的电脑身份");
    }
    public static String load(Context context, String baseUrl, String token) {
        String key = key(baseUrl, token);
        return key.isEmpty() ? "" : context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getString(key, "");
    }
}
