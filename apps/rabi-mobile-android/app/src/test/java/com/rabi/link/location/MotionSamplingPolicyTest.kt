package com.rabi.link.location

import org.junit.Assert.*
import org.junit.Test

class MotionSamplingPolicyTest {
    private val config = SamplingConfig()
    private fun point(ms: Long, latitude: Double = 39.9, accuracy: Float = 5f) =
        LocationPoint(ms, ms * 1_000_000, latitude, 116.4, accuracy, "gps")
    @Test fun unknownStartsAtOneMinuteAndSingleMotionExpires() {
        val policy = MotionSamplingPolicy()
        assertEquals(60_000, policy.decision(1_000, config).intervalMs)
        policy.motion(1_000)
        assertEquals(15_000, policy.decision(1_000, config).intervalMs)
        assertEquals(60_000, policy.decision(92_000, config).intervalMs)
    }
    @Test fun constantSpeedTravelStaysFastWithoutSensorEvents() {
        val policy = MotionSamplingPolicy()
        for (time in 1_000L..601_000L step 5_000) {
            policy.observe(point(time), 15f, 0.2f, config)
            assertEquals(5_000, policy.decision(time, config).intervalMs)
        }
        assertEquals(60_000, policy.decision(700_000, config).intervalMs)
    }
    @Test fun stationaryBackoffNeedsGoodFixesAndMotionWakesIt() {
        val policy = MotionSamplingPolicy()
        for (time in 1_000L..601_000L step 60_000) policy.observe(point(time), 0f, 0.1f, config)
        assertEquals(300_000, policy.decision(601_000, config).intervalMs)
        policy.motion(602_000)
        assertEquals(15_000, policy.decision(602_000, config).intervalMs)
        assertEquals(60_000, policy.decision(700_000, config).intervalMs)
    }
    @Test fun threeMinutesQuietUsesIntermediateBackoffAndLostFixesReturnToBaseline() {
        val policy = MotionSamplingPolicy()
        for (time in 1_000L..181_000L step 60_000) policy.observe(point(time), null, null, config)
        assertEquals(120_000, policy.decision(181_000, config).intervalMs)
        assertEquals(60_000, policy.decision(800_000, config).intervalMs)
    }
    @Test fun oneQuietFixDoesNotProveSeveralMinutesOfRest() {
        val policy = MotionSamplingPolicy()
        policy.observe(point(1_000), 0f, 0.1f, config)
        assertEquals(60_000, policy.decision(601_000, config).intervalMs)
    }
    @Test fun poorAccuracyAndUncertainSpeedDoNotConfirmRestOrFastMotion() {
        for (accuracy in listOf(5f, 3000f)) {
            val policy = MotionSamplingPolicy()
            for (time in 1_000L..601_000L step 60_000) policy.observe(point(time, accuracy=accuracy), 3f, 5f, config)
            assertEquals(60_000, policy.decision(601_000, config).intervalMs)
        }
    }
    @Test fun displacementAccumulatesAgainstAnchorAndCanConfirmFastTravel() {
        val policy = MotionSamplingPolicy()
        policy.observe(point(1_000), null, null, config)
        policy.observe(point(61_000, 39.90005), null, null, config)
        assertEquals(60_000, policy.decision(61_000, config).intervalMs)
        policy.observe(point(121_000, 39.90010), null, null, config)
        assertEquals(15_000, policy.decision(121_000, config).intervalMs)
        policy.observe(point(126_000, 39.901), null, null, config)
        assertEquals(5_000, policy.decision(126_000, config).intervalMs)
    }
    @Test fun duplicateAndOutOfOrderFixesCannotOverwriteMovingState() {
        val policy = MotionSamplingPolicy()
        policy.observe(point(61_000), 8f, 0.1f, config)
        policy.observe(point(61_000), 0f, 0.1f, config)
        policy.observe(point(1_000), 0f, 0.1f, config)
        assertEquals(5_000, policy.decision(61_000, config).intervalMs)
    }
    @Test fun respectsConfiguredBoundsAndRejectsInvalidSettings() {
        val policy = MotionSamplingPolicy()
        val slower = SamplingConfig(90_000, 30_000, 25.0)
        policy.motion(1_000)
        assertEquals(30_000, policy.decision(1_000, slower).intervalMs)
        policy.observe(point(1_000), 10f, 0.1f, slower)
        assertEquals(30_000, policy.decision(1_000, slower).intervalMs)
        assertThrows(IllegalArgumentException::class.java) { SamplingConfig(fastIntervalMs=1_000) }
        assertThrows(IllegalArgumentException::class.java) { SamplingConfig(5_000, 10_000) }
        assertThrows(IllegalArgumentException::class.java) { SamplingConfig(distanceMeters=Double.NaN) }
    }
}
