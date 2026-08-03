package com.rabi.link.modules.rokid;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

import java.util.concurrent.ScheduledExecutorService;

public final class RabiGlassPcBackendDeviceLabelTest {
    @Test
    public void phoneLabelIncludesModelAndStableSuffix() {
        assertEquals(
                "Rabi Android · HBP-AL00 · f743e5",
                RabiGlassPcBackend.deviceLabel("rabi-phone-3850263387f743e5", false, "HBP-AL00")
        );
    }

    @Test
    public void glassesLabelDoesNotClaimThePhoneModel() {
        assertEquals(
                "Rabi Glass · f743e5",
                RabiGlassPcBackend.deviceLabel("rabi-phone-3850263387f743e5", true, "")
        );
    }

    @Test
    public void audioStreamSchedulingIsIsolatedFromOrdinaryReliableQueueUploads() throws Exception {
        assertTrue(ScheduledExecutorService.class.isAssignableFrom(
                RabiGlassPcBackend.class.getDeclaredField("audioStreamExecutor").getType()
        ));
    }

    @Test
    public void resumedServerSequenceOwnsTheNextPendingChunkNumber() {
        assertEquals(42L, RabiGlassPcBackend.resumeAudioStreamSequence(42L));
        assertEquals(43L, RabiGlassPcBackend.nextPendingAudioSequence(42L, true));
        assertEquals(0L, RabiGlassPcBackend.nextPendingAudioSequence(42L, false));
    }
}
