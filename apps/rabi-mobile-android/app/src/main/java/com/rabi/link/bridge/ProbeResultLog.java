package com.rabi.link.bridge;

import java.util.ArrayList;
import java.util.Collections;
import java.util.List;

public final class ProbeResultLog {
    private final List<ProbeResult> results = new ArrayList<>();

    public ProbeResult record(
            String moduleId,
            String capabilityId,
            String status,
            String summary,
            String evidencePath,
            String error
    ) {
        ProbeResult result = new ProbeResult(
                moduleId,
                capabilityId,
                status,
                System.currentTimeMillis(),
                summary,
                evidencePath,
                error
        );
        results.add(result);
        return result;
    }

    public List<ProbeResult> results() {
        return Collections.unmodifiableList(results);
    }

    public String formatLastLine() {
        if (results.isEmpty()) {
            return "ProbeResult: <empty>";
        }
        return formatLine(results.get(results.size() - 1));
    }

    public String formatLine(ProbeResult result) {
        StringBuilder builder = new StringBuilder();
        builder.append("ProbeResult[")
                .append(result.moduleId())
                .append("/")
                .append(result.capabilityId())
                .append("] ")
                .append(result.status())
                .append(" - ")
                .append(result.summary());
        if (result.evidencePath() != null && !result.evidencePath().isEmpty()) {
            builder.append(" evidence=").append(result.evidencePath());
        }
        if (result.error() != null && !result.error().isEmpty()) {
            builder.append(" error=").append(result.error());
        }
        return builder.toString();
    }
}
