package com.rabi.link.bridge;

public final class ProbeResult {
    private final String moduleId;
    private final String capabilityId;
    private final String status;
    private final long timestampMillis;
    private final String summary;
    private final String evidencePath;
    private final String error;

    public ProbeResult(
            String moduleId,
            String capabilityId,
            String status,
            long timestampMillis,
            String summary,
            String evidencePath,
            String error
    ) {
        this.moduleId = moduleId;
        this.capabilityId = capabilityId;
        this.status = status;
        this.timestampMillis = timestampMillis;
        this.summary = summary;
        this.evidencePath = evidencePath;
        this.error = error;
    }

    public String moduleId() {
        return moduleId;
    }

    public String capabilityId() {
        return capabilityId;
    }

    public String status() {
        return status;
    }

    public long timestampMillis() {
        return timestampMillis;
    }

    public String summary() {
        return summary;
    }

    public String evidencePath() {
        return evidencePath;
    }

    public String error() {
        return error;
    }
}
