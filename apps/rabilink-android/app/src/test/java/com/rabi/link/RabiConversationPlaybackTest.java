package com.rabi.link;

import org.junit.Test;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

public final class RabiConversationPlaybackTest {
    @Test
    public void markerStaysInsideStaticPcmBuffer() {
        int pcmByteCount = 32000;
        int frameCount = pcmByteCount / 2;
        int markerFrames = RabiConversationService.phonePlaybackMarkerFrames(pcmByteCount);

        assertEquals(frameCount - 1, markerFrames);
        assertTrue(markerFrames < frameCount);
    }

    @Test
    public void staticTrackWithoutDataIsReadyForFirstWrite() {
        assertTrue(RabiConversationService.phonePlaybackStateReadyForWrite(1));
        assertTrue(RabiConversationService.phonePlaybackStateReadyForWrite(2));
        assertFalse(RabiConversationService.phonePlaybackStateReadyForWrite(0));
    }
}
