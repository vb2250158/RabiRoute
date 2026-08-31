package com.rabi.link;

import org.junit.Test;

import static org.junit.Assert.assertEquals;

public final class RabiConversationSettingsTest {
    @Test
    public void inputModeRejectsUnknownPersistedValuesWithoutInventingAnotherState() {
        assertEquals(RabiConversationSettings.InputMode.GLASSES,
                RabiConversationSettings.InputMode.fromPersisted("glasses", RabiConversationSettings.InputMode.PHONE));
        assertEquals(RabiConversationSettings.InputMode.PAUSED,
                RabiConversationSettings.InputMode.fromPersisted("unknown", RabiConversationSettings.InputMode.PAUSED));
    }

    @Test
    public void proactivityPreferenceUsesAgentDecisionAsSafeContractDefault() {
        assertEquals(RabiConversationSettings.ProactivityPreference.PROACTIVE,
                RabiConversationSettings.ProactivityPreference.fromPersisted("proactive"));
        assertEquals(RabiConversationSettings.ProactivityPreference.AGENT_DECIDES,
                RabiConversationSettings.ProactivityPreference.fromPersisted("always_interrupt"));
    }

    @Test
    public void durableAudioStorageSettingsAreBoundedToOperationalRanges() {
        RabiConversationSettings value = new RabiConversationSettings(
                RabiConversationSettings.InputMode.PHONE,
                RabiConversationSettings.ProactivityPreference.BALANCED,
                true, true, "model", "voice", -1, 100, 99999);
        assertEquals(0, value.audioRetentionHours);
        assertEquals(1024, value.audioMaxStorageMb);
        assertEquals(16384, value.audioReserveFreeMb);
    }
}
