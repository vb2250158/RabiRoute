package com.rabi.link.modules.rokid;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.json.JSONObject;
import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;

import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicLong;

public final class RabiGlassPcBackendDeviceLabelTest {
    @Rule public final TemporaryFolder temporary = new TemporaryFolder();
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

    @Test
    public void durableChunkProtocolMustBeNegotiatedBeforePcmUpload() throws Exception {
        assertFalse(RabiGlassPcBackend.supportsDurableChunkProtocol(new JSONObject()));
        assertFalse(RabiGlassPcBackend.supportsDurableChunkProtocol(new JSONObject()
                .put("rabilink_chunk_protocol", new JSONObject()
                        .put("version", 1)
                        .put("durable_ack_tuple", true))));
        assertTrue(RabiGlassPcBackend.supportsDurableChunkProtocol(new JSONObject()
                .put("rabilink_chunk_protocol", new JSONObject()
                        .put("version", 2)
                        .put("durable_ack_tuple", true)
                        .put("cross_process_claim", true)
                        .put("ambiguous_replay_policy", "retain_without_ack"))));
    }

    @Test
    public void shutdownTimeoutSynchronouslyAccountsEveryAcceptedQueueByte() {
        RabiBoundedAudioWriteQueue queue = new RabiBoundedAudioWriteQueue(256, 2L * 1024L * 1024L);
        byte[] pcm = new byte[8 * 1024];
        for (int index = 0; index < 256; index++) assertTrue(queue.offer(pcm, "phone", "route-a"));
        queue.closeAdmission();
        AtomicLong drained = new AtomicLong();
        boolean asyncCompleted = RabiGlassPcBackend.awaitDrainOrTakeOver(
                new CountDownLatch(1), 0L, TimeUnit.MILLISECONDS, () -> {
                    RabiBoundedAudioWriteQueue.Entry entry;
                    while ((entry = queue.poll()) != null) drained.addAndGet(entry.pcm.length);
                });
        assertFalse(asyncCompleted);
        assertEquals(2L * 1024L * 1024L, drained.get());
        assertEquals(0L, queue.queuedBytes());
    }

    @Test
    public void completedShutdownDoesNotRunSynchronousTakeoverTwice() {
        CountDownLatch completed = new CountDownLatch(0);
        AtomicBoolean takeover = new AtomicBoolean();
        assertTrue(RabiGlassPcBackend.awaitDrainOrTakeOver(
                completed, 0L, TimeUnit.MILLISECONDS, () -> takeover.set(true)));
        assertFalse(takeover.get());
    }

    @Test
    public void realShutdownDrainPersistsEveryAcceptedByteAndRecordsEveryRejectedByte() throws Exception {
        RabiBoundedAudioWriteQueue queue = new RabiBoundedAudioWriteQueue(256, 2L * 1024L * 1024L);
        byte[] pcm = new byte[8 * 1024];
        for (int index = 0; index < 256; index++) assertTrue(queue.offer(pcm, "phone", "route-a"));
        queue.closeAdmission();
        assertFalse(queue.offer(new byte[]{1, 2}, "glasses", "route-b"));
        RabiDurableAudioSpool spool = new RabiDurableAudioSpool(
                temporary.newFolder(),
                new RabiDurableAudioSpool.Policy(2L * 1024L * 1024L, 60_000L,
                        4L * 1024L * 1024L, 0L, 60_000L),
                () -> 10_000L, file -> Long.MAX_VALUE);

        RabiGlassPcBackend.drainAndCloseAudioQueue(queue, spool);

        JSONObject health = spool.health();
        assertEquals(2L * 1024L * 1024L, health.getLong("totalCapturedBytes"));
        assertEquals(2L * 1024L * 1024L, health.getLong("pendingBytes"));
        assertEquals(2L, health.getLong("uncapturedGapBytes"));
        assertTrue(health.getBoolean("accountingBalanced"));
        assertEquals(0L, queue.queuedBytes());
    }
}
