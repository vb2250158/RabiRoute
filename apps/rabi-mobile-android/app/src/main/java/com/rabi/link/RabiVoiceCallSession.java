package com.rabi.link;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.Base64;
import java.util.HashSet;
import java.util.Set;
import java.util.UUID;

/** Live state owned by RabiConversationService; never a second capture owner. */
public final class RabiVoiceCallSession {
    public static final long INPUT_TTL_MS = 90_000L;
    public final String id = UUID.randomUUID().toString();
    public final String captureId = "call_" + id;
    public final String workerId;
    public final String routeId;
    public volatile boolean muted;
    public volatile boolean ended;
    private final Set<String> admittedEvents = new HashSet<>();
    public RabiVoiceCallSession(String workerId, String routeId) {
        if (workerId == null || workerId.trim().isEmpty() || routeId == null || routeId.trim().isEmpty())
            throw new IllegalArgumentException("通话需要明确的电脑和消息路线");
        this.workerId = workerId; this.routeId = routeId;
    }
    public synchronized String admit(String capture, String eventId, long endedAt, long now) {
        if (ended || muted || !captureId.equals(capture) || endedAt > now || now - endedAt >= INPUT_TTL_MS
                || eventId == null || eventId.isEmpty() || !admittedEvents.add(eventId)) return "";
        return "rabi-call-v1." + id + "." + (endedAt + INPUT_TTL_MS) + "." + encode(workerId) + "." + encode(routeId) + "." + hash(eventId);
    }
    public boolean acceptsInput(String clientId, long now) {
        if (ended || clientId == null) return false;
        String[] parts = clientId.split("\\.");
        if (parts.length != 6 || !id.equals(parts[1])) return false;
        try { return Long.parseLong(parts[2]) > now; } catch (NumberFormatException error) { return false; }
    }
    public boolean acceptsReply(String replyCallId, String route) { return !ended && id.equals(replyCallId) && routeId.equals(route); }
    private static String encode(String value) { return Base64.getUrlEncoder().withoutPadding().encodeToString(value.getBytes(StandardCharsets.UTF_8)); }
    private static String hash(String value) {
        try {
            StringBuilder output = new StringBuilder();
            for (byte b : MessageDigest.getInstance("SHA-256").digest(value.getBytes(StandardCharsets.UTF_8))) output.append(String.format(java.util.Locale.ROOT, "%02x", b & 255));
            return output.toString();
        } catch (java.security.NoSuchAlgorithmException error) { throw new IllegalStateException(error); }
    }
}
