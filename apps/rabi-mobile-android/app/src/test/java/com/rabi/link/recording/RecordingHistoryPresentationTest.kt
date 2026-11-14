package com.rabi.link.recording

import org.junit.Assert.*
import org.junit.Test
import java.time.Instant
import java.util.TimeZone

class RecordingHistoryPresentationTest {
    @Test fun dayIncludesStartAndExcludesNextMidnight() {
        val time = Instant.parse("2026-11-14T04:20:00Z").toEpochMilli()
        val day = RecordingDay.at(time,TimeZone.getTimeZone("Asia/Hong_Kong"))
        assertEquals(Instant.parse("2026-11-13T16:00:00Z").toEpochMilli(),day.start)
        assertTrue(day.contains(day.start)); assertTrue(day.contains(day.until-1))
        assertFalse(day.contains(day.start-1)); assertFalse(day.contains(day.until))
    }
    @Test fun calendarDayIsNotAlwaysTwentyFourHours() {
        val time = Instant.parse("2026-03-08T12:00:00Z").toEpochMilli()
        val day = RecordingDay.at(time,TimeZone.getTimeZone("America/New_York"))
        assertEquals(23*60*60*1000L,day.until-day.start)
    }
    @Test fun missingTextDoesNotEraseProcessingFacts() {
        assertEquals("正在转写",recordingTranscriptStatus("transcribe","processing",false,""))
        assertEquals("识别完成，无文字",recordingTranscriptStatus("transcribe","pending",true,""))
        assertEquals("仅本地保存 · 未请求转写",recordingTranscriptStatus("local_only","local_only",false,""))
        assertEquals("转写待核对",recordingTranscriptStatus("transcribe","failed",false,""))
        assertEquals("",recordingTranscriptStatus("transcribe","pending",true,"真实原文"))
    }
}
