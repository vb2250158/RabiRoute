package com.rabi.link.recording;

import android.content.Context;
import android.content.SharedPreferences;

/** Device-side capture intent. Processing and transport never imply microphone consent. */
public final class AllDayRecordingSettings {
    public static final String PREFS = "rabi_all_day_recording";
    public final boolean running;
    public final String mode;
    public final String source;
    public final String processingPolicy;
    public final String routeProfileId;
    public final boolean healthEnabled;
    public final boolean uploadEnabled;
    public final boolean autoResume;
    public final long windowStartedAt;

    public AllDayRecordingSettings(boolean running, String mode, String source, String processingPolicy,
            String routeProfileId, boolean healthEnabled, boolean uploadEnabled, boolean autoResume, long windowStartedAt) {
        this.running = running;
        this.mode = "video".equals(mode) ? "video" : "health".equals(mode) ? "health" : "audio";
        // Manual preferences migrate to auto. Each capture still freezes its physical source.
        this.source = "video".equals(this.mode) ? "glasses" : "auto";
        this.processingPolicy = "agent".equals(processingPolicy) ? "agent" : "local_only".equals(processingPolicy) ? "local_only" : "transcribe";
        this.routeProfileId = routeProfileId == null ? "" : routeProfileId.trim();
        this.healthEnabled = healthEnabled;
        this.uploadEnabled = uploadEnabled;
        this.autoResume = autoResume;
        this.windowStartedAt = Math.max(0, windowStartedAt);
    }

    public static AllDayRecordingSettings load(Context context) {
        SharedPreferences p = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        // No legacy auto-start flag is imported: an upgrade must not grant capture consent.
        return new AllDayRecordingSettings(p.getBoolean("running", false), p.getString("mode", "audio"),
                p.getString("source", "mobile"), p.getString("processingPolicy", "transcribe"),
                p.getString("routeProfileId", ""), p.getBoolean("healthEnabled", false),
                p.getBoolean("uploadEnabled", true), p.getBoolean("autoResume", false), p.getLong("windowStartedAt", 0));
    }

    public void save(Context context) {
        SharedPreferences existing = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        long effectiveWindow = windowStartedAt;
        if (running && ((!existing.getBoolean("healthEnabled", false) && healthEnabled)
                || (!"health".equals(existing.getString("mode", "audio")) && "health".equals(mode)))) {
            effectiveWindow = Math.max(effectiveWindow, System.currentTimeMillis());
        }
        if (!existing.edit()
                .putBoolean("running", running).putString("mode", mode).remove("source")
                .putString("processingPolicy", processingPolicy).putString("routeProfileId", routeProfileId)
                .putBoolean("healthEnabled", healthEnabled).putBoolean("uploadEnabled", uploadEnabled)
                .putBoolean("autoResume", autoResume).putLong("windowStartedAt", effectiveWindow).commit()) {
            throw new IllegalStateException("无法保存全天记录设置，未启动采集");
        }
    }

    public AllDayRecordingSettings withRunning(boolean value, long now) {
        return new AllDayRecordingSettings(value, mode, source, processingPolicy, routeProfileId,
                healthEnabled, uploadEnabled, autoResume, value && !running ? now : windowStartedAt);
    }
}
