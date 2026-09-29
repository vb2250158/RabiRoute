package com.rabi.link.recording

import org.junit.Assert.*
import org.junit.Test
import java.util.concurrent.CountDownLatch

class ArchiveWakeupTest {
    @Test fun kickDuringBatchSurvivesUntilFinalDrain() {
        val wakeup = ArchiveWakeup()
        wakeup.signal()
        assertTrue(wakeup.consume())
        val started = CountDownLatch(1)
        val finished = CountDownLatch(1)
        val producer = Thread { started.await(); wakeup.signal(); finished.countDown() }
        producer.start()
        started.countDown(); finished.await(); producer.join()
        assertTrue(wakeup.consume())
        assertFalse(wakeup.consume())
    }
    @Test fun coalescesSignalsWithoutPollingOrDroppingNextEdge() {
        val wakeup = ArchiveWakeup()
        repeat(100) { wakeup.signal() }
        assertTrue(wakeup.consume())
        assertFalse(wakeup.consume())
        wakeup.signal()
        assertTrue(wakeup.consume())
    }
}
