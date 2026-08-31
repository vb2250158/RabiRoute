package com.rabi.link;

/** Pure app-launch policy; Android components only execute the selected action. */
public final class RabiConversationStartupPolicy {
    public enum Action {
        NONE,
        RESTORE_TRANSPORT,
        START_VOICE
    }

    private RabiConversationStartupPolicy() { }

    public static Action decide(
            boolean relayConfigured,
            boolean transportRestoreRequested,
            RabiConversationSettings settings,
            boolean microphonePermissionGranted
    ) {
        if (!relayConfigured || settings == null) return Action.NONE;
        if (!settings.autoStartVoiceService || settings.inputMode == RabiConversationSettings.InputMode.PAUSED) {
            return transportRestoreRequested ? Action.RESTORE_TRANSPORT : Action.NONE;
        }
        if (settings.inputMode == RabiConversationSettings.InputMode.PHONE && !microphonePermissionGranted) {
            return Action.RESTORE_TRANSPORT;
        }
        return Action.START_VOICE;
    }
}
