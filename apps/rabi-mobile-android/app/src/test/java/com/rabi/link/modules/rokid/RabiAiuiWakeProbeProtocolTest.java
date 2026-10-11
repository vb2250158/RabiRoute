package com.rabi.link.modules.rokid;

import com.rabi.link.protocol.RabiAiuiWakeProbeProtocol;
import org.junit.Test;
import static org.junit.Assert.*;

public class RabiAiuiWakeProbeProtocolTest {
    private static final String ID = "01234567-89ab-cdef-0123-456789abcdef";
    @Test public void rejectsInjectedCommandsAndInvalidIdentity() {
        for (String invalid : new String[]{"", "\"}", ID + ":broadcast_finished", ID.toUpperCase()}) {
            assertFalse(RabiAiuiWakeProbeProtocol.validRequestId(invalid));
            try { RabiAiuiWakeProbeProtocol.command(invalid); fail("accepted invalid id"); }
            catch (IllegalArgumentException expected) { }
        }
        assertFalse(RabiAiuiWakeProbeProtocol.validRequestId(null));
    }
    @Test public void unrelatedAndFabricatedLaunchReceiptsCannotSettleProbe() {
        String prefix = RabiAiuiWakeProbeProtocol.RECEIPT_PREFIX;
        assertEquals("", RabiAiuiWakeProbeProtocol.receiptState(prefix + ID + ":awake", ID));
        assertEquals("", RabiAiuiWakeProbeProtocol.receiptState(prefix + ID + ":broadcast_finished", "new-id"));
        assertEquals("", RabiAiuiWakeProbeProtocol.receiptState("RABI_VIDEO_STATUS:pong:" + ID, ID));
        assertEquals("broadcast_finished", RabiAiuiWakeProbeProtocol.receiptState(prefix + ID + ":broadcast_finished", ID));
        assertEquals("dispatch_failed", RabiAiuiWakeProbeProtocol.receiptState(prefix + ID + ":dispatch_failed", ID));
    }
    @Test public void classifiedFailuresOnlySettleTheirOriginalProbe() {
        String prefix = RabiAiuiWakeProbeProtocol.RECEIPT_PREFIX;
        String other = "fedcba98-7654-3210-fedc-ba9876543210";
        for (String state : new String[]{"dispatch_security_rejected", "dispatch_invalid_argument"}) {
            assertEquals(state, RabiAiuiWakeProbeProtocol.receiptState(prefix + ID + ":" + state, ID));
            assertEquals("", RabiAiuiWakeProbeProtocol.receiptState(prefix + ID + ":" + state, other));
            assertEquals("", RabiAiuiWakeProbeProtocol.receiptState(prefix + ID + ":" + state + ":awake", ID));
        }
    }
}
