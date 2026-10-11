package com.rabi.link.protocol;

/** Diagnostic transport receipts only; none of these states confirms an AIUI launch. */
public final class RabiAiuiWakeProbeProtocol {
    public static final String COMMAND = "aiui_wake_probe";
    public static final String TWO_FINGER_ACTION = "com.android.action.ACTION_TWO_FINGER_SINGLE_TAP";
    public static final String RECEIPT_PREFIX = "RABI_VIDEO_STATUS:aiui_wake_probe:";
    private RabiAiuiWakeProbeProtocol() { }

    public static boolean validRequestId(String id) {
        return id != null && id.matches("[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}");
    }

    public static String command(String id) {
        if (!validRequestId(id)) throw new IllegalArgumentException("Invalid wake probe id");
        return RabiGlassVideoProtocol.PREFIX + "{\"action\":\"" + COMMAND + "\",\"session\":\"" + id + "\"}";
    }

    public static String receiptState(String raw, String id) {
        if (!validRequestId(id) || raw == null) return "";
        String prefix = RECEIPT_PREFIX + id + ":";
        if (!raw.startsWith(prefix)) return "";
        String state = raw.substring(prefix.length());
        switch (state) {
            case "broadcast_submitted": case "broadcast_finished": case "duplicate_suppressed":
            case "capture_busy": case "ledger_full": case "ledger_failed": case "dispatch_failed":
            case "dispatch_security_rejected": case "dispatch_invalid_argument":
                return state;
            default: return "";
        }
    }
}
