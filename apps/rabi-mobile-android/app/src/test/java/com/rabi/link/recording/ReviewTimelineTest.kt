package com.rabi.link.recording

import org.junit.Assert.*
import org.junit.Test

class ReviewTimelineTest {
    @Test fun rulerCrossesDaysAndClampsOnlyAtNow() {
        val now = 10*86_400_000L
        assertEquals(now-2*86_400_000L,TimelineRulerMath.pan(now,800.0,400,86_400_000L,now))
        assertEquals(now,TimelineRulerMath.pan(now,-400.0,400,86_400_000L,now))
        assertEquals(0L,TimelineRulerMath.pan(now,100000.0,400,86_400_000L,now))
    }
    @Test fun rulerZoomIsBoundedAndViewportIncludesOverlappingRecords() {
        assertEquals(30_000L,TimelineRulerMath.zoom(30_000,10.0))
        assertEquals(TimelineRulerMath.MAX_WINDOW,TimelineRulerMath.zoom(TimelineRulerMath.MAX_WINDOW,0.1))
        assertEquals(60_000L,TimelineRulerMath.zoom(120_000,2.0))
        val range = TimelineRulerMath.range(100_000,60_000)
        assertTrue(TimelineRulerMath.overlaps(60_000,20_000,range))
        assertFalse(TimelineRulerMath.overlaps(50_000,20_000,range))
        assertFalse(TimelineRulerMath.overlaps(100_000,0,range))
        assertEquals(300_000L,TimelineRulerMath.majorStep(1_200_000,400f))
    }
    @Test fun gapsNeverMapToAudioAndReplayOffsetsSkipGaps() {
        val spans = listOf(ReviewTimeline.Span(1000,2000),ReviewTimeline.Span(5000,1000,2000))
        assertEquals(1500L,ReviewTimeline.mediaAt(spans,2500))
        assertNull(ReviewTimeline.mediaAt(spans,3000))
        assertNull(ReviewTimeline.mediaAt(spans,4999))
        assertEquals(2000L,ReviewTimeline.mediaAt(spans,5000))
        assertEquals(5000L,ReviewTimeline.timeFor(spans,2000))
        assertNull(ReviewTimeline.timeFor(spans,3000))
    }
    @Test fun scrubbingAcrossOriginalVideoPartsUsesCorrectPartAndOffset() {
        assertEquals(PlaybackPosition.Position(0,0),PlaybackPosition.locate(listOf(2000L,3000L),-100))
        assertEquals(PlaybackPosition.Position(1,0),PlaybackPosition.locate(listOf(2000L,3000L),2000))
        assertEquals(PlaybackPosition.Position(1,1500),PlaybackPosition.locate(listOf(2000L,3000L),3500))
        assertEquals(PlaybackPosition.Position(1,3000),PlaybackPosition.locate(listOf(2000L,3000L),6000))
    }
}
