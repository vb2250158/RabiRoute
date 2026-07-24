package com.rabi.link;

import android.content.Context;
import android.content.SharedPreferences;

/** Phone-owned settings shared by standalone-phone and optional-glasses conversation modes. */
public final class RabiConversationSettings {
    private static final String PREFS = "rabi_conversation_settings";
    private static final String KEY_INPUT_MODE = "inputMode";
    private static final String KEY_PROACTIVITY_PREFERENCE = "proactivityPreference";

    public enum InputMode {
        PAUSED,
        PHONE,
        GLASSES;

        public static InputMode fromPersisted(String value, InputMode fallback) {
            try {
                return InputMode.valueOf(value == null ? "" : value.trim().toUpperCase(java.util.Locale.ROOT));
            } catch (IllegalArgumentException error) {
                return fallback;
            }
        }
    }

    public enum ProactivityPreference {
        AGENT_DECIDES("agent_decides"),
        QUIET("quiet"),
        BALANCED("balanced"),
        PROACTIVE("proactive");

        public final String wireValue;

        ProactivityPreference(String wireValue) {
            this.wireValue = wireValue;
        }

        public static ProactivityPreference fromPersisted(String value) {
            String normalized = value == null ? "" : value.trim().toLowerCase(java.util.Locale.ROOT);
            for (ProactivityPreference candidate : values()) {
                if (candidate.wireValue.equals(normalized)) return candidate;
            }
            return AGENT_DECIDES;
        }
    }

    public final InputMode inputMode;
    public final ProactivityPreference proactivityPreference;
    public final boolean continuousListening;
    public final boolean glassesEnabled;
    public final boolean autoPlayAgentVoice;
    public final String ttsModel;
    public final String ttsVoice;

    public RabiConversationSettings(
            InputMode inputMode,
            ProactivityPreference proactivityPreference,
            boolean autoPlayAgentVoice,
            String ttsModel,
            String ttsVoice
    ) {
        this.inputMode = inputMode == null ? InputMode.PHONE : inputMode;
        this.proactivityPreference = proactivityPreference == null
                ? ProactivityPreference.AGENT_DECIDES : proactivityPreference;
        this.continuousListening = this.inputMode != InputMode.PAUSED;
        this.glassesEnabled = this.inputMode == InputMode.GLASSES;
        this.autoPlayAgentVoice = autoPlayAgentVoice;
        this.ttsModel = clean(ttsModel, "local-tts/gpt-sovits");
        this.ttsVoice = clean(ttsVoice, "Rabi");
    }

    public static RabiConversationSettings load(Context context) {
        SharedPreferences values = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        InputMode legacyMode = !values.getBoolean("continuousListening", true)
                ? InputMode.PAUSED
                : values.getBoolean("glassesEnabled", false) ? InputMode.GLASSES : InputMode.PHONE;
        return new RabiConversationSettings(
                InputMode.fromPersisted(values.getString(KEY_INPUT_MODE, ""), legacyMode),
                ProactivityPreference.fromPersisted(values.getString(KEY_PROACTIVITY_PREFERENCE, "agent_decides")),
                values.getBoolean("autoPlayAgentVoice", true),
                values.getString("ttsModel", "local-tts/gpt-sovits"),
                values.getString("ttsVoice", "Rabi")
        );
    }

    public void save(Context context) {
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit()
                .putString(KEY_INPUT_MODE, inputMode.name())
                .putString(KEY_PROACTIVITY_PREFERENCE, proactivityPreference.wireValue)
                .putBoolean("autoPlayAgentVoice", autoPlayAgentVoice)
                .putString("ttsModel", ttsModel)
                .putString("ttsVoice", ttsVoice)
                .remove("asrModel")
                .remove("asrLanguage")
                .remove("vadThreshold")
                .remove("silenceMs")
                .remove("continuousListening")
                .remove("glassesEnabled")
                .apply();
    }

    private static String clean(String value, String fallback) {
        String result = value == null ? "" : value.trim();
        return result.isEmpty() ? fallback : result;
    }
}
