package com.rabi.link.modules.rokid

import org.junit.Assert.*
import org.junit.Test

class VideoAudioDerivationTest {
    @Test fun stableTaskIdentity() {
        val first = VideoAudioDerivation.taskId("session", "segment.mp4", "hash")
        assertEquals(first, VideoAudioDerivation.taskId("session", "segment.mp4", "hash"))
        assertNotEquals(first, VideoAudioDerivation.taskId("session", "segment.mp4", "changed"))
        assertNotEquals(first, VideoAudioDerivation.taskId("other", "segment.mp4", "hash"))
    }
    @Test fun missingAndNonAudioTracksAreNotAudio() {
        assertFalse(VideoAudioDerivation.isAudioMime(null))
        assertFalse(VideoAudioDerivation.isAudioMime("video/avc"))
        assertTrue(VideoAudioDerivation.isAudioMime("audio/mp4a-latm"))
    }
}
