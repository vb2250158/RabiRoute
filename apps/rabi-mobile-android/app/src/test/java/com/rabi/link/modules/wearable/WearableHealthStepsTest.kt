package com.rabi.link.modules.wearable

import org.junit.Assert.*
import org.junit.Test
import java.time.Instant
import java.time.ZoneId

class WearableHealthStepsTest {
    private val zone = ZoneId.of("Asia/Shanghai")
    private fun at(hour: Int, minute: Int = 0) =
        java.time.ZonedDateTime.of(2026, 9, 17, hour, minute, 0, 0, zone).toInstant()

    private fun atDay(day: Int, hour: Int, minute: Int = 0) =
        java.time.ZonedDateTime.of(2026, 9, day, hour, minute, 0, 0, zone).toInstant()

    @Test fun emptySegmentsProduceNoSamples() {
        assertEquals(0, aggregateDailySteps(emptyList(), zone).size)
    }

    @Test fun sameDaySegmentsSumIntoSingleSample() {
        val samples = aggregateDailySteps(listOf(
            StepSegment(at(8), at(9), 300),
            StepSegment(at(12), at(13), 1200),
            StepSegment(at(18), at(19), 500)
        ), zone)
        assertEquals(1, samples.size)
        assertEquals(2000, samples[0].value)
        assertEquals("steps", samples[0].metric)
        assertEquals("count", samples[0].unit)
    }

    @Test fun idDependsOnlyOnDaySoRereadDeduplicates() {
        val first = aggregateDailySteps(listOf(
            StepSegment(at(8), at(9), 300),
            StepSegment(at(12), at(13), 1200)
        ), zone)
        // 同一天重读会得到不同的分段边界：两段变三段，但累计值相同。
        val second = aggregateDailySteps(listOf(
            StepSegment(at(8), at(9), 300),
            StepSegment(at(10), at(11), 700),
            StepSegment(at(12), at(13), 500)
        ), zone)
        assertEquals(first[0].id, second[0].id)
        assertEquals(first[0].value, second[0].value)
    }

    @Test fun dayBoundarySplitsByLocalCalendarDay() {
        val samples = aggregateDailySteps(listOf(
            StepSegment(atDay(16, 23, 30), atDay(16, 23, 59), 100),
            StepSegment(atDay(17, 0, 1), atDay(17, 0, 30), 40)
        ), zone)
        assertEquals(2, samples.size)
        assertEquals(100, samples[0].value)
        assertEquals(40, samples[1].value)
        assertNotEquals(samples[0].id, samples[1].id)
    }

    @Test fun startAtIsLocalDayStartAndRecordedAtIsLastSegmentEnd() {
        val samples = aggregateDailySteps(listOf(
            StepSegment(at(8), at(9), 300),
            StepSegment(at(18), at(19), 500)
        ), zone)
        assertEquals(at(0).toString(), samples[0].startAt)
        assertEquals(at(19), Instant.parse(samples[0].recordedAt))
        assertEquals(at(19), Instant.parse(samples[0].endAt))
    }

    @Test fun samplesAreOrderedByDay() {
        val samples = aggregateDailySteps(listOf(
            StepSegment(atDay(17, 9), atDay(17, 10), 1),
            StepSegment(atDay(16, 0, 30), atDay(16, 0, 45), 2)
        ), zone)
        assertEquals(2, samples.size)
        assertTrue(samples[0].id < samples[1].id)
    }
}
