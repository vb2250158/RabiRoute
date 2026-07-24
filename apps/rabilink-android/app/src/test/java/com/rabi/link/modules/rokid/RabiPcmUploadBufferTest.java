package com.rabi.link.modules.rokid;

import org.junit.Test;

import java.util.concurrent.atomic.AtomicInteger;

import static org.junit.Assert.assertArrayEquals;
import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertSame;
import static org.junit.Assert.assertTrue;

public final class RabiPcmUploadBufferTest {
    @Test
    public void pendingChunkKeepsStableIdentityUntilAcknowledged() {
        AtomicInteger ids = new AtomicInteger();
        RabiPcmUploadBuffer buffer = new RabiPcmUploadBuffer(4, 8, () -> "chunk-" + ids.incrementAndGet());
        buffer.append(new byte[]{1, 2, 3, 4});

        RabiPcmUploadBuffer.PendingChunk first = buffer.preparePending();
        RabiPcmUploadBuffer.PendingChunk retry = buffer.preparePending();

        assertSame(first, retry);
        assertEquals("chunk-1", retry.id);
        assertArrayEquals(new byte[]{1, 2, 3, 4}, retry.pcm);
        buffer.acknowledgePending();
        assertFalse(buffer.hasPending());
    }

    @Test
    public void offlineBufferKeepsOnlyBoundedNewestPcmBehindPendingChunk() {
        RabiPcmUploadBuffer buffer = new RabiPcmUploadBuffer(4, 8, () -> "chunk");
        buffer.append(new byte[]{1, 2, 3, 4});
        buffer.preparePending();

        assertEquals(4, buffer.append(new byte[]{5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16}));
        assertTrue(buffer.hasPending());
        assertEquals(8, buffer.bufferedBytes());

        buffer.acknowledgePending();
        assertArrayEquals(new byte[]{9, 10, 11, 12, 13, 14, 15, 16}, buffer.preparePending().pcm);
    }

    @Test
    public void clearDropsBothPendingAndBufferedAudio() {
        RabiPcmUploadBuffer buffer = new RabiPcmUploadBuffer(4, 8, () -> "chunk");
        buffer.append(new byte[]{1, 2, 3, 4});
        buffer.preparePending();
        buffer.append(new byte[]{5, 6});

        buffer.clear();

        assertFalse(buffer.hasData());
        assertFalse(buffer.ready());
        assertEquals(0, buffer.bufferedBytes());
    }
}
