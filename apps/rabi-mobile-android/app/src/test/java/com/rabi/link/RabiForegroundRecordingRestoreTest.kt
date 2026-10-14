package com.rabi.link

import com.rabi.link.recording.AllDayRecordingSettings
import org.junit.Assert.*
import org.junit.Test

class RabiForegroundRecordingRestoreTest {
    private fun settings(enabled: Boolean) = AllDayRecordingSettings(
        false, "audio", "auto", "local_only", "saved-target", false, false, enabled, 123)

    @Test fun foregroundWithoutSavedIntentNeverStartsOrEnablesRecording() {
        val saved = settings(false)
        var starts = 0
        repeat(3) { restoreSavedRecording(saved) { starts++ } }
        assertEquals(0, starts)
        assertFalse(saved.autoResume)
        assertFalse(saved.running)
        assertEquals(123L, saved.windowStartedAt)
    }

    @Test fun savedIntentResumesWithoutChangingTargetPolicyOrPrivacyWindow() {
        val saved = settings(true)
        var starts = 0
        restoreSavedRecording(saved) { starts++ }
        assertEquals(1, starts)
        assertTrue(saved.autoResume)
        assertFalse(saved.running)
        assertEquals("saved-target", saved.routeProfileId)
        assertEquals("local_only", saved.processingPolicy)
        assertFalse(saved.uploadEnabled)
        assertEquals(123L, saved.windowStartedAt)
        val explicitlyDisabled = saved.withEnabled(false, 500)
        restoreSavedRecording(explicitlyDisabled) { starts++ }
        assertEquals(1, starts)
    }
}
