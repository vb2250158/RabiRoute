package com.rabi.link.recording;

import android.content.Context;
import android.content.SharedPreferences;

public final class EventSplitSettings {
    private EventSplitSettings() { }
    private static SharedPreferences prefs(Context context) {
        return context.getSharedPreferences("rabi_event_split", Context.MODE_PRIVATE);
    }
    public static boolean showTranscribeLine(Context context) {
        return prefs(context).getBoolean("showTranscribeLine", true);
    }
    public static void saveTranscribeLine(Context context, boolean visible) {
        prefs(context).edit().putBoolean("showTranscribeLine", visible).apply();
    }
    private static int bounded(SharedPreferences p, String key, int fallback, int min, int max) {
        return Math.max(min, Math.min(max, p.getInt(key, fallback)));
    }
    public static AudioEventSplitter.Policy load(Context context) {
        SharedPreferences p = prefs(context);
        int silence = bounded(p, "silenceMs", 500, 200, 3000);
        int maximum = bounded(p, "maxMs", 60000, 3000, 120000);
        maximum = 3000 + Math.round((maximum - 3000) / 1000f) * 1000;
        return new AudioEventSplitter.Policy(
                200 + Math.round((silence - 200) / 50f) * 50, maximum,
                bounded(p, "preRollMs", 1500, 0, Math.min(10000, maximum - 100)),
                bounded(p, "minUtteranceMs", 1000, 100, maximum),
                bounded(p, "recordThresholdMilli", 10, 1, 300) / 1000.0,
                bounded(p, "transcribeThresholdMilli", bounded(p, "thresholdMilli", 15, 1, 300), 1, 300) / 1000.0,
                p.getBoolean("adaptiveThreshold", true),
                bounded(p, "adaptiveMultiplierMilli", 2500, 1000, 10000) / 1000.0,
                bounded(p, "adaptiveMarginMilli", 4, 0, 300) / 1000.0,
                bounded(p, "inputGainMilli", 1000, 100, 10000) / 1000.0);
    }
    /** Legacy slider changes only the transcription threshold; retain the remaining acoustic settings. */
    public static void save(Context context, int silenceMs, int maxMs, int thresholdMilli) {
        AudioEventSplitter.Policy old = load(context);
        save(context, new AudioEventSplitter.Policy(silenceMs, maxMs,
                Math.min(old.preRollMs, maxMs - 100), Math.min(old.minUtteranceMs, maxMs),
                old.recordThreshold, thresholdMilli / 1000.0, old.adaptiveThreshold,
                old.adaptiveMultiplier, old.adaptiveMargin, old.inputGain));
    }
    public static void save(Context context, AudioEventSplitter.Policy policy) {
        prefs(context).edit()
                .putInt("silenceMs", policy.silenceMs).putInt("maxMs", policy.maxMs)
                .putInt("preRollMs", policy.preRollMs).putInt("minUtteranceMs", policy.minUtteranceMs)
                .putInt("thresholdMilli", (int)Math.round(policy.transcribeThreshold * 1000))
                .putInt("transcribeThresholdMilli", (int)Math.round(policy.transcribeThreshold * 1000))
                .putInt("recordThresholdMilli", (int)Math.round(policy.recordThreshold * 1000))
                .putBoolean("adaptiveThreshold", policy.adaptiveThreshold)
                .putInt("adaptiveMultiplierMilli", (int)Math.round(policy.adaptiveMultiplier * 1000))
                .putInt("adaptiveMarginMilli", (int)Math.round(policy.adaptiveMargin * 1000))
                .putInt("inputGainMilli", (int)Math.round(policy.inputGain * 1000)).apply();
    }
}
