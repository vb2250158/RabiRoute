package com.rabi.link.modules.rokid;

import org.json.JSONObject;
import org.junit.Test;
import static org.junit.Assert.*;

public class RabiMessageRetryTargetTest {
    @Test public void retryRequiresBothOriginalMessageAndDestination() throws Exception {
        JSONObject item = new JSONObject().put("clientMessageId", "original-message").put("routeProfileId", "route-a");
        assertTrue(RabiGlassPcBackend.matchesRetryTarget(item,"original-message","route-a"));
        assertFalse(RabiGlassPcBackend.matchesRetryTarget(item,"other-message","route-a"));
        assertFalse(RabiGlassPcBackend.matchesRetryTarget(item,"original-message","route-b"));
        assertFalse(RabiGlassPcBackend.matchesRetryTarget(item,"original-message",""));
        assertTrue(RabiGlassPcBackend.matchesRetryTarget(item,"",""));
        assertEquals("original-message",item.getString("clientMessageId"));
        assertEquals("route-a",item.getString("routeProfileId"));
    }
}
