package com.rabi.link.modules.wearable

import org.junit.Assert.*
import org.junit.Test

class WearableHealthWindowTest {
    @Test fun currentSampleAllowed() { assertTrue(WearableHealthWindow.contains(100, 200, 150)) }
    @Test fun missingPermitRejected() { assertFalse(WearableHealthWindow.contains(0, 200, 150)) }
    @Test fun pausedHistoryRejected() { assertFalse(WearableHealthWindow.contains(100, 200, 99)) }
    @Test fun crossPauseSleepRejectedWithoutClipping() { assertFalse(WearableHealthWindow.contains(100, 200, 150, 90, 150)) }
    @Test fun futureSampleRejected() { assertFalse(WearableHealthWindow.contains(100, 200, 201)) }
    @Test fun resumedWindowExcludesPriorRun() { assertFalse(WearableHealthWindow.contains(300, 400, 150)) }
    @Test fun wholeSleepWithinWindowAllowed() { assertTrue(WearableHealthWindow.contains(100, 200, 180, 120, 180)) }
}
