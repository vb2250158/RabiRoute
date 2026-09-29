package com.rabi.link.modules.rokid;

import org.junit.Test;
import static org.junit.Assert.*;

public class RabiRecordingEventSyncOwnershipTest {
    @Test public void onlyAuthoritativeUnownedCaptureMayUseLegacy() {
        assertTrue(RabiRecordingEventSync.legacyOwnershipAllows("capture", Boolean.FALSE));
        assertFalse(RabiRecordingEventSync.legacyOwnershipAllows("capture", Boolean.TRUE));
        assertFalse(RabiRecordingEventSync.legacyOwnershipAllows("capture", null));
        assertFalse(RabiRecordingEventSync.legacyOwnershipAllows("", Boolean.FALSE));
        assertFalse(RabiRecordingEventSync.legacyOwnershipAllows(null, Boolean.FALSE));
        assertFalse(RabiRecordingEventSync.legacyOwnershipAllows(" ", Boolean.FALSE));
    }
    @Test public void ownershipChangeOrUnavailableServiceStopsLaterCommit() {
        assertTrue(RabiRecordingEventSync.legacyOwnershipAllows("capture", Boolean.FALSE));
        assertFalse(RabiRecordingEventSync.legacyOwnershipAllows("capture", Boolean.TRUE));
        assertFalse(RabiRecordingEventSync.legacyOwnershipAllows("capture", null));
    }
}
