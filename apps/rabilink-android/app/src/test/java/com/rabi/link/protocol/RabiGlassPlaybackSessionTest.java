package com.rabi.link.protocol;

import org.junit.Test;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

public final class RabiGlassPlaybackSessionTest {
    @Test
    public void beginChunksEndAndMarkerProducePlayed() {
        RabiGlassPlaybackSession session = new RabiGlassPlaybackSession();

        assertTrue(session.begin("message-one", 8));
        assertTrue(session.acceptPcm(4));
        assertTrue(session.acceptPcm(4));
        assertEquals(RabiGlassPlaybackSession.State.WAITING_FOR_MARKER,
                session.end("message-one", 8));
        assertEquals(RabiGlassPlaybackSession.State.PLAYED, session.markerReached());
    }

    @Test
    public void markerMayArriveBeforeEndButCannotConfirmEarly() {
        RabiGlassPlaybackSession session = new RabiGlassPlaybackSession();
        session.begin("message-one", 4);
        session.acceptPcm(4);

        assertEquals(RabiGlassPlaybackSession.State.RECEIVING, session.markerReached());
        assertEquals(RabiGlassPlaybackSession.State.PLAYED, session.end("message-one", 4));
    }

    @Test
    public void lengthMismatchFailsPlayback() {
        RabiGlassPlaybackSession session = new RabiGlassPlaybackSession();
        session.begin("message-one", 8);
        session.acceptPcm(4);

        assertEquals(RabiGlassPlaybackSession.State.PLAYBACK_FAILED,
                session.end("message-one", 8));
    }

    @Test
    public void messageMismatchFailsPlayback() {
        RabiGlassPlaybackSession session = new RabiGlassPlaybackSession();
        session.begin("message-one", 4);
        session.acceptPcm(4);

        assertEquals(RabiGlassPlaybackSession.State.PLAYBACK_FAILED,
                session.end("message-two", 4));
    }

    @Test
    public void duplicateBeginAndEndAreIdempotent() {
        RabiGlassPlaybackSession session = new RabiGlassPlaybackSession();
        assertTrue(session.begin("message-one", 4));
        assertFalse(session.begin("message-one", 4));
        session.acceptPcm(4);
        session.markerReached();

        assertEquals(RabiGlassPlaybackSession.State.PLAYED, session.end("message-one", 4));
        assertEquals(RabiGlassPlaybackSession.State.PLAYED, session.end("message-one", 4));
        assertFalse(session.begin("message-one", 4));
    }

    @Test
    public void noBeginPcmStaysOnLegacyUnconfirmedPath() {
        RabiGlassPlaybackSession session = new RabiGlassPlaybackSession();

        assertFalse(session.acceptPcm(4));
        assertEquals(RabiGlassPlaybackSession.State.IDLE, session.state());
    }

    @Test
    public void invalidNewBeginDoesNotRewritePreviousTerminalMessage() {
        RabiGlassPlaybackSession session = new RabiGlassPlaybackSession();
        session.begin("message-one", 4);
        session.acceptPcm(4);
        session.markerReached();
        assertEquals(RabiGlassPlaybackSession.State.PLAYED, session.end("message-one", 4));

        try {
            session.begin("message-two", 3);
        } catch (IllegalArgumentException expected) {
            assertEquals("message-one", session.messageId());
            assertEquals(RabiGlassPlaybackSession.State.PLAYED, session.state());
            return;
        }
        throw new AssertionError("Expected invalid odd PCM byte length to fail");
    }
}
