package com.rabi.link.modules.rokid;

import java.util.LinkedHashMap;
import java.util.Map;

final class RokidNativeVoiceStatus {
    private final String raw;
    private final Map<String, String> values;

    private RokidNativeVoiceStatus(String raw, Map<String, String> values) {
        this.raw = raw == null ? "" : raw;
        this.values = values;
    }

    static RokidNativeVoiceStatus empty() {
        return new RokidNativeVoiceStatus("", new LinkedHashMap<>());
    }

    static RokidNativeVoiceStatus parse(String raw) {
        Map<String, String> parsed = new LinkedHashMap<>();
        if (raw == null || raw.trim().isEmpty()) {
            return new RokidNativeVoiceStatus("", parsed);
        }
        String[] parts = raw.split(";");
        for (String part : parts) {
            int index = part.indexOf('=');
            if (index <= 0) {
                continue;
            }
            String key = part.substring(0, index).trim();
            String value = part.substring(index + 1).trim();
            if (!key.isEmpty()) {
                parsed.put(key, value);
            }
        }
        return new RokidNativeVoiceStatus(raw.trim(), parsed);
    }

    boolean hasRawStatus() {
        return !raw.isEmpty();
    }

    boolean isReady() {
        return bool("ready");
    }

    boolean isAsrReady() {
        return isReady() && bool("asr");
    }

    boolean isTtsReady() {
        return isReady() && bool("tts");
    }

    boolean isMessageReady() {
        return bool("message");
    }

    String shortSummary() {
        if (!hasRawStatus()) {
            return "未查询";
        }
        return "ready=" + yesNo(isReady())
                + " ASR=" + yesNo(isAsrReady())
                + " TTS=" + yesNo(isTtsReady())
                + " message=" + yesNo(isMessageReady())
                + " service=" + yesNo(bool("serviceConnected"))
                + " serverPackage=" + yesNo(bool("serverPackage"));
    }

    String diagnosticSummary() {
        if (!hasRawStatus()) {
            return "尚未收到 RABI_STATUS。请先启动眼镜 APK，再点“查询原生状态”。";
        }
        if (isAsrReady() && isTtsReady()) {
            return "Glass SDK ASR/TTS 已 ready，可以继续测试 ASR 文本和 TTS 播报。";
        }
        StringBuilder builder = new StringBuilder();
        builder.append("Glass SDK 未 ready：").append(shortSummary());
        appendValue(builder, "event");
        appendValue(builder, "error");
        appendValue(builder, "securityCandidates");
        appendValue(builder, "rokidPackages");
        appendValue(builder, "device");
        if (!bool("serverPackage")) {
            builder.append("\n原因线索：眼镜环境里看不到 Glass SDK Security Service 包。");
            String packages = values.get("rokidPackages");
            String candidates = values.get("securityCandidates");
            if ((packages != null && packages.contains("com.rokid.cxrservice"))
                    || (candidates != null && candidates.contains("com.rokid.cxrservice:yes"))) {
                builder.append("\n补充判断：CXR/CustomApp 服务存在，但它不是 Glass SDK Security Service，不能直接证明 GlassSdk ASR/TTS 可用。");
            }
        } else if (!bool("serviceConnected")) {
            builder.append("\n原因线索：已尝试绑定 Security Service，但 serviceConnected=false。");
        } else if (!bool("asr") || !bool("tts")) {
            builder.append("\n原因线索：服务已连接，但 ASR/TTS 子服务未同时可用。");
        }
        return builder.toString();
    }

    String raw() {
        return raw;
    }

    private void appendValue(StringBuilder builder, String key) {
        String value = values.get(key);
        if (value != null && !value.isEmpty() && !"none".equalsIgnoreCase(value)) {
            builder.append("\n").append(key).append(": ").append(value);
        }
    }

    private boolean bool(String key) {
        String value = values.get(key);
        return "true".equalsIgnoreCase(value) || "1".equals(value) || "yes".equalsIgnoreCase(value);
    }

    private static String yesNo(boolean value) {
        return value ? "是" : "否";
    }
}
