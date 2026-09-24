package com.rabi.link.protocol;

import org.json.JSONObject;

/** Text delivery is acknowledged only after a focused glasses window draws it. */
public final class RabiGlassTextProtocol {
    public static final String CHANNEL = "rabi_text_delivery";
    public static final String REPLY = "rabi_text_receipt";
    public static final String PREFIX = "RABI_TEXT:";
    public static final String RECEIPT_PREFIX = "RABI_TEXT_RECEIPT:";
    public static final String PACKAGE = "com.rabi.link.glass.video";
    public static final String ENTRY = PACKAGE + ".GlassTextActivity";
    private RabiGlassTextProtocol() { }

    public static String message(String messageId, String attempt, String text) throws Exception {
        JSONObject value = new JSONObject().put("messageId", messageId).put("attempt", attempt).put("text", text);
        if (!valid(value)) throw new IllegalArgumentException("Invalid glasses text delivery");
        return PREFIX + value;
    }
    public static boolean valid(JSONObject value) {
        if (value == null) return false;
        String id = value.optString("messageId", "");
        String text = value.optString("text", "");
        return !id.isEmpty() && id.length() <= 240 && !text.trim().isEmpty() && text.length() <= 8000
                && value.optString("attempt", "").matches("[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}");
    }
    public static boolean matchesReceipt(String raw, String messageId, String attempt) {
        if (raw == null || !raw.startsWith(RECEIPT_PREFIX)) return false;
        try {
            JSONObject value = new JSONObject(raw.substring(RECEIPT_PREFIX.length()));
            return messageId.equals(value.optString("messageId")) && attempt.equals(value.optString("attempt"))
                    && "displayed".equals(value.optString("state"));
        } catch (Exception invalid) { return false; }
    }
}
