package com.rabi.link.recording

import org.junit.Assert.*
import org.junit.Test

class RecordingResourceCacheOwnershipTest {
    @Test fun pcmRequiresAuthoritativeNegativeOwnership() {
        assertTrue(RecordingResourceCache.legacyOwnershipAllows("capture", "pcm", false))
        assertFalse(RecordingResourceCache.legacyOwnershipAllows("capture", "pcm", true))
        assertFalse(RecordingResourceCache.legacyOwnershipAllows("capture", "pcm", null))
        assertFalse(RecordingResourceCache.legacyOwnershipAllows(null, "pcm", false))
        assertFalse(RecordingResourceCache.legacyOwnershipAllows("", "pcm", false))
    }
    @Test fun onlyIndependentOriginalVideoRetainsLegacyException() {
        assertTrue(RecordingResourceCache.legacyOwnershipAllows(null, "mp4", null))
        assertFalse(RecordingResourceCache.legacyOwnershipAllows("capture", "mp4", true))
        assertFalse(RecordingResourceCache.legacyOwnershipAllows("capture", "mp4", null))
        assertFalse(RecordingResourceCache.legacyOwnershipAllows(null, "wav", false))
    }
}
