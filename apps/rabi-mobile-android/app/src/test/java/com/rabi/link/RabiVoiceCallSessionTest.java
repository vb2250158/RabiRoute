package com.rabi.link;
import org.junit.Test;
import static org.junit.Assert.*;
public class RabiVoiceCallSessionTest {
    @Test public void onlyCurrentFinalEventsBecomeAgentInputs() {
        RabiVoiceCallSession call = new RabiVoiceCallSession("pc-a", "route-a");
        long now = 1791300000000L;
        assertEquals("", call.admit("ordinary-recording", "a", now, now));
        String first = call.admit(call.captureId, "a", now, now);
        assertTrue(first.startsWith("rabi-call-v1."));
        assertTrue(call.acceptsInput(first, now));
        assertFalse(call.acceptsInput(first, now + 90000));
        assertEquals("", call.admit(call.captureId, "a", now, now));
        assertEquals("", call.admit(call.captureId, "stale", now - 90000, now));
        call.muted = true;
        assertEquals("", call.admit(call.captureId, "muted", now, now));
        call.ended = true;
        assertFalse(call.acceptsInput(first, now));
    }
    @Test public void lateAndCrossRouteRepliesCannotAutoplay() {
        RabiVoiceCallSession old = new RabiVoiceCallSession("pc-a", "route-a");
        RabiVoiceCallSession next = new RabiVoiceCallSession("pc-a", "route-a");
        assertTrue(old.acceptsReply(old.id, "route-a"));
        assertFalse(old.acceptsReply(old.id, "route-b"));
        old.ended = true;
        assertFalse(old.acceptsReply(old.id, "route-a"));
        assertFalse(next.acceptsReply(old.id, "route-a"));
    }
}
