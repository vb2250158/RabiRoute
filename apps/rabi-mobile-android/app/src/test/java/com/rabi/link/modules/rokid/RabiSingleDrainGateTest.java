package com.rabi.link.modules.rokid;

import org.junit.Test;

import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.atomic.AtomicInteger;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

public final class RabiSingleDrainGateTest {
    @Test
    public void hundredProducerRequestsScheduleOnlyOneDrainTask() {
        List<Runnable> scheduled = new ArrayList<>();
        AtomicInteger drains = new AtomicInteger();
        RabiSingleDrainGate gate = new RabiSingleDrainGate();

        for (int index = 0; index < 100; index += 1) {
            gate.request(scheduled::add, drains::incrementAndGet);
        }

        assertEquals(1, scheduled.size());
        scheduled.get(0).run();
        assertEquals(1, drains.get());
    }

    @Test
    public void producerRequestDuringDrainIsHandledByTheSameScheduledTask() {
        List<Runnable> scheduled = new ArrayList<>();
        AtomicInteger drains = new AtomicInteger();
        RabiSingleDrainGate gate = new RabiSingleDrainGate();
        Runnable[] drain = new Runnable[1];
        drain[0] = () -> {
            if (drains.incrementAndGet() == 1) {
                gate.request(scheduled::add, drain[0]);
            }
        };

        gate.request(scheduled::add, drain[0]);
        scheduled.get(0).run();

        assertEquals(1, scheduled.size());
        assertEquals(2, drains.get());
    }

    @Test
    public void keepaliveRunsBeforeThePcStaleDeadlineWithoutProducerPolling() {
        assertEquals(5_000L, RabiGlassPcBackend.audioStreamKeepaliveDelayMs());
    }

    @Test
    public void anOlderRelayDisablesKeepaliveWithoutTurningItIntoAStreamFailure() {
        assertTrue(RabiGlassPcBackend.shouldDisableAudioStreamKeepalive(
                new IllegalStateException("Relay HTTP 404: not found")));
        assertFalse(RabiGlassPcBackend.shouldDisableAudioStreamKeepalive(
                new IllegalStateException("Relay HTTP 500: unavailable")));
    }
}
