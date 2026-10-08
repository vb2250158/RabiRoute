package com.rabi.link.modules.rokid;

import com.rabi.link.RabiConversationSettings;
import org.junit.Test;
import static org.junit.Assert.*;

public class RabiGlassStoragePolicyTest {
    @Test public void applicationDoesNotLimitRetainedAudioBytes() {
        RabiConversationSettings settings = new RabiConversationSettings(
            RabiConversationSettings.InputMode.PHONE,RabiConversationSettings.ProactivityPreference.AGENT_DECIDES,
            true,true,"model","voice");
        RabiDurableAudioSpool.Policy policy = RabiGlassPcBackend.audioPolicy(settings);
        assertEquals(Long.MAX_VALUE,policy.maxStorageBytes);
        assertEquals(1024L*1024L*1024L,policy.reserveFreeBytes);
    }
}
