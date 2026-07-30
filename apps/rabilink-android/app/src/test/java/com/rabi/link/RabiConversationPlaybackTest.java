package com.rabi.link;

import org.junit.Test;

import java.io.IOException;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;

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

    @Test
    public void cachedAgentTtsWavReturnsOriginalPcm() throws Exception {
        byte[] pcm = new byte[]{1, 0, 2, 0, 3, 0, 4, 0};
        assertEquals(pcm.length, RabiConversationService.pcmFromWav(wav(pcm)).length);
        org.junit.Assert.assertArrayEquals(pcm, RabiConversationService.pcmFromWav(wav(pcm)));
    }

    @Test(expected = IOException.class)
    public void replayRejectsUnsupportedWavFormat() throws Exception {
        byte[] wav = wav(new byte[]{1, 0, 2, 0});
        ByteBuffer.wrap(wav).order(ByteOrder.LITTLE_ENDIAN).putInt(24, 22050);
        RabiConversationService.pcmFromWav(wav);
    }

    private static byte[] wav(byte[] pcm) {
        ByteBuffer value = ByteBuffer.allocate(44 + pcm.length).order(ByteOrder.LITTLE_ENDIAN);
        value.put(new byte[]{'R','I','F','F'}).putInt(36 + pcm.length).put(new byte[]{'W','A','V','E','f','m','t',' '})
                .putInt(16).putShort((short) 1).putShort((short) 1).putInt(16000).putInt(32000)
                .putShort((short) 2).putShort((short) 16).put(new byte[]{'d','a','t','a'}).putInt(pcm.length).put(pcm);
        return value.array();
    }
}
