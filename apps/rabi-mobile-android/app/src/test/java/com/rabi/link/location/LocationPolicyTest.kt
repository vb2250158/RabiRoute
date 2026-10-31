package com.rabi.link.location

import org.junit.Assert.*
import org.junit.Test

class LocationPolicyTest {
    private val first = LocationPoint(1000, 1_000_000_000L, 39.9,116.4, 5f,"gps")
    @Test fun rejectsStaleInvalidAndDuplicateSamples() {
        assertTrue(LocationPolicy.accept(first,null,first.elapsedNanos))
        assertFalse(LocationPolicy.accept(first,null,first.elapsedNanos+121_000_000_000L))
        assertFalse(LocationPolicy.accept(first.copy(latitude=Double.NaN),null,first.elapsedNanos))
        assertFalse(LocationPolicy.accept(first.copy(accuracy=0f),null,first.elapsedNanos))
        assertFalse(LocationPolicy.accept(first,first,first.elapsedNanos))
        val tooSoon=first.copy(elapsedNanos=first.elapsedNanos+4_000_000_000L,latitude=40.0)
        assertFalse(LocationPolicy.accept(tooSoon,first,tooSoon.elapsedNanos))
    }
    @Test fun recordsMovementAndStationaryHeartbeatWithoutInventingPrecision() {
        val moved=first.copy(elapsedNanos=first.elapsedNanos+60_000_000_000L,latitude=39.901)
        assertTrue(LocationPolicy.accept(moved,first,moved.elapsedNanos))
        val still=first.copy(elapsedNanos=first.elapsedNanos+60_000_000_000L)
        assertFalse(LocationPolicy.accept(still,first,still.elapsedNanos))
        val heartbeat=first.copy(elapsedNanos=first.elapsedNanos+300_000_000_000L)
        assertTrue(LocationPolicy.accept(heartbeat,first,heartbeat.elapsedNanos))
        assertTrue(LocationPolicy.accept(first.copy(accuracy=3000f),null,first.elapsedNanos))
        assertFalse(LocationPolicy.accept(moved.copy(accuracy=3000f),first,moved.elapsedNanos))
    }
    @Test fun limitsAddressQueriesAcrossRestartsAndClockChanges() {
        assertFalse(LocationPolicy.addressDue(599_999,0))
        assertTrue(LocationPolicy.addressDue(600_000,0))
        assertFalse(LocationPolicy.addressDue(50,100))
        assertTrue(LocationPolicy.distance(first,first.copy(latitude=39.901)) in 110.0..112.0)
    }
    @Test fun configuredDistanceFiltersNoiseAndKeepsFastMovingSamples() {
        val next = first.copy(elapsedNanos=first.elapsedNanos+5_000_000_000L,latitude=39.9002)
        assertTrue(LocationPolicy.accept(next, first, next.elapsedNanos))
        assertFalse(LocationPolicy.accept(next, first, next.elapsedNanos, SamplingConfig(distanceMeters=50.0)))
        assertFalse(LocationPolicy.accept(next.copy(accuracy=30f), first.copy(accuracy=30f), next.elapsedNanos))
        assertFalse(LocationPolicy.accept(next, first, next.elapsedNanos, SamplingConfig(fastIntervalMs=10_000)))
    }
}
