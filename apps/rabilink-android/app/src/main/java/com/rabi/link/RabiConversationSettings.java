package com.rabi.link;

import android.content.Context;
import android.content.SharedPreferences;

/** Phone-owned settings shared by standalone-phone and optional-glasses conversation modes. */
public final class RabiConversationSettings {
    private static final String PREFS = "rabi_conversation_settings";
    public final boolean continuousListening;
    public final boolean glassesEnabled;
    public final boolean autoPlayAgentVoice;
    public final String asrModel;
    public final String asrLanguage;
    public final String ttsModel;
    public final String ttsVoice;
    public final int vadThreshold;
    public final int silenceMs;

    public RabiConversationSettings(
            boolean continuousListening,
            boolean glassesEnabled,
            boolean autoPlayAgentVoice,
            String asrModel,
            String asrLanguage,
            String ttsModel,
            String ttsVoice,
            int vadThreshold,
            int silenceMs
    ) {
        this.continuousListening = continuousListening;
        this.glassesEnabled = glassesEnabled;
        this.autoPlayAgentVoice = autoPlayAgentVoice;
        this.asrModel = clean(asrModel, "faster-whisper/small");
        this.asrLanguage = clean(asrLanguage, "zh");
        this.ttsModel = clean(ttsModel, "local-tts/gpt-sovits");
        this.ttsVoice = clean(ttsVoice, "Rabi");
        this.vadThreshold = Math.max(100, Math.min(12000, vadThreshold));
        this.silenceMs = Math.max(250, Math.min(4000, silenceMs));
    }

    public static RabiConversationSettings load(Context context) {
        SharedPreferences values = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        return new RabiConversationSettings(
                values.getBoolean("continuousListening", true),
                values.getBoolean("glassesEnabled", false),
                values.getBoolean("autoPlayAgentVoice", true),
                values.getString("asrModel", "faster-whisper/small"),
                values.getString("asrLanguage", "zh"),
                values.getString("ttsModel", "local-tts/gpt-sovits"),
                values.getString("ttsVoice", "Rabi"),
                values.getInt("vadThreshold", 650),
                values.getInt("silenceMs", 900)
        );
    }

    public void save(Context context) {
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit()
                .putBoolean("continuousListening", continuousListening)
                .putBoolean("glassesEnabled", glassesEnabled)
                .putBoolean("autoPlayAgentVoice", autoPlayAgentVoice)
                .putString("asrModel", asrModel)
                .putString("asrLanguage", asrLanguage)
                .putString("ttsModel", ttsModel)
                .putString("ttsVoice", ttsVoice)
                .putInt("vadThreshold", vadThreshold)
                .putInt("silenceMs", silenceMs)
                .apply();
    }

    private static String clean(String value, String fallback) {
        String result = value == null ? "" : value.trim();
        return result.isEmpty() ? fallback : result;
    }
}
