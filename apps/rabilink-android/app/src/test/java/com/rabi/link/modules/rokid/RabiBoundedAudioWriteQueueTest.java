package com.rabi.link.modules.rokid;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

import java.util.List;

public final class RabiBoundedAudioWriteQueueTest {
    @Test
    public void queueUsesByteLimitAndAttributesLossPerSourceAndRoute() {
        RabiBoundedAudioWriteQueue queue = new RabiBoundedAudioWriteQueue(10, 6);
        assertTrue(queue.offer(new byte[4], "phone", "route-a"));
        assertFalse(queue.offer(new byte[4], "glasses", "route-b"));
        assertFalse(queue.offer(new byte[4], "phone", "route-a"));
        assertEquals(4L, queue.queuedBytes());

        List<RabiBoundedAudioWriteQueue.Gap> gaps = queue.takeRejected();
        assertEquals(2, gaps.size());
        assertEquals("glasses", gaps.get(0).source);
        assertEquals("route-b", gaps.get(0).route);
        assertEquals(4L, gaps.get(0).bytes);
        assertEquals("phone", gaps.get(1).source);
        assertEquals(4L, gaps.get(1).bytes);
    }

    @Test
    public void shutdownRejectsEveryLateByteAndAcceptedBytesRemainDrainable() {
        RabiBoundedAudioWriteQueue queue = new RabiBoundedAudioWriteQueue(4, 16);
        assertTrue(queue.offer(new byte[6], "phone", "before"));
        queue.closeAdmission();
        assertFalse(queue.offer(new byte[8], "glasses", "after"));
        assertEquals(6, queue.poll().pcm.length);
        assertEquals(0L, queue.queuedBytes());
        assertEquals(8L, queue.takeRejected().get(0).bytes);
        assertFalse(queue.isAccepting());
    }
}
