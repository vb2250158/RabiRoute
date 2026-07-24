package com.rabi.link.protocol;

/**
 * Pure playback protocol state shared by the phone and glasses builds.
 * AudioTrack remains an Android presentation concern; this object only owns
 * message identity, byte accounting, END validation, and marker completion.
 */
public final class RabiGlassPlaybackSession {
    public enum State {
        IDLE,
        RECEIVING,
        WAITING_FOR_MARKER,
        PLAYED,
        PLAYBACK_FAILED
    }

    private String messageId = "";
    private int expectedBytes;
    private int receivedBytes;
    private boolean markerReached;
    private State state = State.IDLE;

    /**
     * Starts a new message. Returns false for an idempotent duplicate BEGIN.
     * A different message may replace only an idle or terminal session.
     */
    public synchronized boolean begin(String value, int bytes) {
        String normalizedId = value == null ? "" : value.trim();
        if (normalizedId.isEmpty()) throw new IllegalArgumentException("messageId is required");
        if (bytes <= 0 || (bytes & 1) != 0) {
            throw new IllegalArgumentException("PCM byte length must be a positive even number");
        }
        if (!messageId.isEmpty() && messageId.equals(normalizedId)) {
            if (expectedBytes != bytes) throw new IllegalStateException("duplicate message length changed");
            return false;
        }
        if (isActive()) throw new IllegalStateException("another playback is active");
        messageId = normalizedId;
        expectedBytes = bytes;
        receivedBytes = 0;
        markerReached = false;
        state = State.RECEIVING;
        return true;
    }

    /** Returns false when the bytes belong to the legacy no-BEGIN path. */
    public synchronized boolean acceptPcm(int bytes) {
        if (messageId.isEmpty()) return false;
        if (state != State.RECEIVING) return true;
        if (bytes <= 0 || receivedBytes > expectedBytes - bytes) {
            state = State.PLAYBACK_FAILED;
            return true;
        }
        receivedBytes += bytes;
        return true;
    }

    public synchronized State end(String value, int bytes) {
        String normalizedId = value == null ? "" : value.trim();
        if (messageId.isEmpty()) return State.IDLE;
        if (state == State.PLAYED || state == State.PLAYBACK_FAILED) return state;
        if (!messageId.equals(normalizedId)
                || bytes != expectedBytes
                || receivedBytes != expectedBytes) {
            state = State.PLAYBACK_FAILED;
            return state;
        }
        state = markerReached ? State.PLAYED : State.WAITING_FOR_MARKER;
        return state;
    }

    public synchronized State markerReached() {
        if (messageId.isEmpty() || state == State.PLAYBACK_FAILED) return state;
        markerReached = true;
        if (state == State.WAITING_FOR_MARKER) state = State.PLAYED;
        return state;
    }

    public synchronized State fail() {
        if (!messageId.isEmpty() && state != State.PLAYED) state = State.PLAYBACK_FAILED;
        return state;
    }

    public synchronized boolean isActive() {
        return state == State.RECEIVING || state == State.WAITING_FOR_MARKER;
    }

    public synchronized boolean knowsMessage() {
        return !messageId.isEmpty();
    }

    public synchronized String messageId() {
        return messageId;
    }

    public synchronized int expectedBytes() {
        return expectedBytes;
    }

    public synchronized int receivedBytes() {
        return receivedBytes;
    }

    public synchronized State state() {
        return state;
    }
}
