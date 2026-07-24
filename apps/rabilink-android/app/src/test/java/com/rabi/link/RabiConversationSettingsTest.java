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
}
