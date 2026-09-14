package com.rabi.link;

import org.junit.Test;

import static org.junit.Assert.assertEquals;

public final class RabiConversationStartupPolicyTest {
    private static RabiConversationSettings settings(
            RabiConversationSettings.InputMode inputMode,
            boolean autoStartVoiceService
    ) {
        return new RabiConversationSettings(
                inputMode,
                RabiConversationSettings.ProactivityPreference.AGENT_DECIDES,
                autoStartVoiceService,
                true,
                "local-tts/gpt-sovits",
                "Rabi"
        );
    }

    @Test
    public void startsPhoneVoiceAfterAppLaunchWhenSwitchAndPermissionAreReady() {
        assertEquals(
                RabiConversationStartupPolicy.Action.START_VOICE,
                RabiConversationStartupPolicy.decide(true, false, settings(
                        RabiConversationSettings.InputMode.PHONE,
                        true
                ), true)
        );
    }

    @Test
    public void switchOffRestoresOnlyExistingMessageTransport() {
        assertEquals(
                RabiConversationStartupPolicy.Action.RESTORE_TRANSPORT,
                RabiConversationStartupPolicy.decide(true, true, settings(
                        RabiConversationSettings.InputMode.PHONE,
                        false
                ), true)
        );
    }

    @Test
    public void switchOffDoesNothingWhenNoTransportWasPreviouslyEnabled() {
        assertEquals(
                RabiConversationStartupPolicy.Action.NONE,
                RabiConversationStartupPolicy.decide(true, false, settings(
                        RabiConversationSettings.InputMode.PHONE,
                        false
                ), true)
        );
    }

    @Test
    public void missingPhoneMicrophonePermissionKeepsTransportWithoutStartingCapture() {
        assertEquals(
                RabiConversationStartupPolicy.Action.RESTORE_TRANSPORT,
                RabiConversationStartupPolicy.decide(true, false, settings(
                        RabiConversationSettings.InputMode.PHONE,
                        true
                ), false)
        );
    }

    @Test
    public void glassesInputDoesNotDependOnPhoneMicrophonePermission() {
        assertEquals(
                RabiConversationStartupPolicy.Action.START_VOICE,
                RabiConversationStartupPolicy.decide(true, false, settings(
                        RabiConversationSettings.InputMode.GLASSES,
                        true
                ), false)
        );
    }

    @Test
    public void pausedInputNeverStartsVoiceEvenWhenSwitchIsOn() {
        assertEquals(
                RabiConversationStartupPolicy.Action.RESTORE_TRANSPORT,
                RabiConversationStartupPolicy.decide(true, true, settings(
                        RabiConversationSettings.InputMode.PAUSED,
                        true
                ), true)
        );
    }
}
