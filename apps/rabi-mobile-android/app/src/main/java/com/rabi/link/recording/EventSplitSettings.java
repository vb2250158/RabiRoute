package com.rabi.link.recording;

import android.content.Context;

public final class EventSplitSettings {
    private EventSplitSettings() { }
    public static boolean showTranscribeLine(Context context) {
        return context.getSharedPreferences("rabi_event_split",Context.MODE_PRIVATE)
            .getBoolean("showTranscribeLine",true);
    }
    public static void saveTranscribeLine(Context context, boolean visible) {
        context.getSharedPreferences("rabi_event_split",Context.MODE_PRIVATE).edit()
            .putBoolean("showTranscribeLine",visible).apply();
    }
    public static AudioEventSplitter.Policy load(Context context) {
        android.content.SharedPreferences prefs = context.getSharedPreferences("rabi_event_split",Context.MODE_PRIVATE);
        // Clamp legacy values individually to the current RabiPC slider ranges.
        int silence = Math.max(200, Math.min(3000, prefs.getInt("silenceMs",500)));
        int maximum = Math.max(3000, Math.min(120000, prefs.getInt("maxMs",60000)));
        return new AudioEventSplitter.Policy(200 + Math.round((silence-200)/50f)*50,
                3000 + Math.round((maximum-3000)/1000f)*1000,
                Math.max(1,Math.min(300,prefs.getInt("thresholdMilli",15)))/1000.0);
    }
    public static void save(Context context, int silenceMs, int maxMs, int thresholdMilli) {
        AudioEventSplitter.Policy policy = new AudioEventSplitter.Policy(silenceMs,maxMs,thresholdMilli/1000.0);
        context.getSharedPreferences("rabi_event_split",Context.MODE_PRIVATE).edit()
            .putInt("thresholdMilli",thresholdMilli).putInt("silenceMs",policy.silenceMs).putInt("maxMs",policy.maxMs).apply();
    }
}
