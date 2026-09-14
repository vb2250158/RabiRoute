package com.rabi.link.recording;

import org.junit.Test;
import static org.junit.Assert.*;

public class AllDayRecordingSettingsTest {
    private AllDayRecordingSettings settings(boolean running, long since) {
        return new AllDayRecordingSettings(running, "video", "glasses", "local_only", "fixed-route", true, false, false, since);
    }
    @Test public void pausePreservesModeSourceProcessingAndTarget() {
        AllDayRecordingSettings paused = settings(true, 100).withRunning(false, 200);
        assertFalse(paused.running);
        assertEquals("video", paused.mode);
        assertEquals("glasses", paused.source);
        assertEquals("local_only", paused.processingPolicy);
        assertEquals("fixed-route", paused.routeProfileId);
        assertFalse(paused.uploadEnabled);
    }
    @Test public void resumeCreatesANewPrivacyWindow() {
        assertEquals(300, settings(false, 100).withRunning(true, 300).windowStartedAt);
        assertEquals(100, settings(true, 100).withRunning(true, 300).windowStartedAt);
    }
    @Test public void unknownProcessingNeverEnablesAgent() {
        AllDayRecordingSettings value = new AllDayRecordingSettings(false, "bad", "bad", "bad", null, false, true, false, -4);
        assertEquals("transcribe", value.processingPolicy);
        assertEquals("audio", value.mode);
        assertEquals("mobile", value.source);
        assertFalse(value.running);
        assertFalse(value.autoResume);
        assertEquals(0, value.windowStartedAt);
    }
}
