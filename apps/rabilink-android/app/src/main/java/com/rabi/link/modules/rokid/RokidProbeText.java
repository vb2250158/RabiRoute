package com.rabi.link.modules.rokid;

import com.rokid.cxr.link.utils.GlassInfo;

final class RokidProbeText {
    private RokidProbeText() {
    }

    static String summarizeToken(String value) {
        if (value == null || value.isEmpty()) {
            return "<empty>";
        }
        if (value.length() <= 12) {
            return "len=" + value.length();
        }
        return value.substring(0, 4) + "..." + value.substring(value.length() - 4) + " len=" + value.length();
    }

    static String customViewPayload(String title, String body) {
        return "{"
                + "\"type\":\"LinearLayout\","
                + "\"props\":{\"orientation\":\"vertical\",\"padding\":24,\"backgroundColor\":\"#202124\"},"
                + "\"children\":["
                + "{\"type\":\"TextView\",\"props\":{\"text\":\"" + escapeJson(title) + "\",\"textSize\":32,\"textColor\":\"#FFFFFF\"}},"
                + "{\"type\":\"TextView\",\"props\":{\"text\":\"" + escapeJson(body) + "\",\"textSize\":24,\"textColor\":\"#DDEBFF\"}}"
                + "]"
                + "}";
    }

    static String customViewBoxPayload(String text) {
        return "{"
                + "\"id\":\"root_layout\","
                + "\"type\":\"LinearLayout\","
                + "\"props\":{"
                + "\"width\":\"match_parent\","
                + "\"height\":\"match_parent\","
                + "\"orientation\":\"vertical\","
                + "\"gravity\":\"center\","
                + "\"backgroundColor\":\"#000000\""
                + "},"
                + "\"children\":["
                + "{"
                + "\"id\":\"hello_text\","
                + "\"type\":\"TextView\","
                + "\"props\":{"
                + "\"width\":\"match_parent\","
                + "\"height\":\"wrap_content\","
                + "\"text\":\"" + escapeJson(text) + "\","
                + "\"textSize\":50,"
                + "\"textColor\":\"#00FF00\","
                + "\"gravity\":\"center\""
                + "}"
                + "}"
                + "]"
                + "}";
    }

    static String formatGlassInfo(GlassInfo info) {
        if (info == null) {
            return "null";
        }
        return "name=" + info.deviceName
                + " battery=" + info.batteryLevel
                + " sound=" + info.sound
                + " brightness=" + info.brightness
                + " wearing=" + info.wearingStatus
                + " charging=" + info.ischarging
                + " screenOn=" + info.screenOn
                + " version=" + info.systemVersion;
    }

    private static String escapeJson(String text) {
        return text.replace("\\", "\\\\").replace("\"", "\\\"");
    }
}
