package com.rabi.link.bridge;

public final class BridgeEvent {
    private final String moduleId;
    private final String type;
    private final long timestampMillis;
    private final String payloadSummary;

    public BridgeEvent(String moduleId, String type, long timestampMillis, String payloadSummary) {
        this.moduleId = moduleId;
        this.type = type;
        this.timestampMillis = timestampMillis;
        this.payloadSummary = payloadSummary;
    }

    public String moduleId() {
        return moduleId;
    }

    public String type() {
        return type;
    }

    public long timestampMillis() {
        return timestampMillis;
    }

    public String payloadSummary() {
        return payloadSummary;
    }
}
