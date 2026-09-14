package com.rabi.link.modules.rokid;

import org.junit.Test;
import static org.junit.Assert.*;

public class RabiAudioCapabilityCacheTest {
    @Test public void missingCapabilityIsCachedAcrossThousandsOfPcmSegments() {
        RabiAudioCapabilityCache cache = new RabiAudioCapabilityCache();
        assertNull(cache.get("transcribe"));
        assertTrue(cache.store(cache.revision(), false, false));
        for (int i = 0; i < 20000; i++) assertEquals(Boolean.FALSE, cache.get("transcribe"));
        assertEquals(Boolean.FALSE, cache.get("agent"));
    }
    @Test public void retryConfigOrNetworkInvalidationRequiresNewRead() {
        RabiAudioCapabilityCache cache = new RabiAudioCapabilityCache();
        cache.store(cache.revision(), true, false);
        assertEquals(Boolean.TRUE, cache.get("agent"));
        assertEquals(Boolean.FALSE, cache.get("transcribe"));
        cache.invalidate();
        assertNull(cache.get("agent"));
        cache.store(cache.revision(), true, true);
        assertEquals(Boolean.TRUE, cache.get("transcribe"));
    }
    @Test public void lateResultCannotReplaceNewEndpointSnapshot() {
        RabiAudioCapabilityCache cache = new RabiAudioCapabilityCache();
        long old = cache.revision(); cache.invalidate();
        assertFalse(cache.store(old, true, true)); assertNull(cache.get("agent"));
        assertTrue(cache.store(cache.revision(), true, false));
        assertFalse(cache.store(old, false, false));
        assertEquals(Boolean.TRUE, cache.get("agent"));
    }
}
