package com.rabi.link;

import org.junit.Test;

import static org.junit.Assert.assertEquals;

public final class RabiAudioShutdownSequenceTest {
    @Test
    public void captureProducersStopBeforeDurableBackendDrain() {
        StringBuilder order = new StringBuilder();
        RabiAudioShutdownSequence.run(
                () -> order.append("phone>"),
                () -> order.append("glasses>"),
                () -> order.append("backend"));
        assertEquals("phone>glasses>backend", order.toString());
    }
}
