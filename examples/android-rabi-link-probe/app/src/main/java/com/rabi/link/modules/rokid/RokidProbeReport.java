package com.rabi.link.modules.rokid;

import android.util.Log;
import android.widget.TextView;

import com.rabi.link.bridge.ProbeResultLog;

final class RokidProbeReport {
    private static final String TAG = "RabiRokidProbe";

    private final StringBuilder report = new StringBuilder();
    private final ProbeResultLog resultLog = new ProbeResultLog();

    String text() {
        return report.toString();
    }

    void append(TextView logView, String line) {
        Log.i(TAG, line);
        report.append(line).append('\n');
        if (logView != null) {
            logView.append(line);
            logView.append("\n");
        }
    }

    void record(
            TextView logView,
            String capabilityId,
            String status,
            String summary,
            String evidencePath,
            String error
    ) {
        resultLog.record(RokidGlassModule.ID, capabilityId, status, summary, evidencePath, error);
        append(logView, resultLog.formatLastLine());
    }
}
