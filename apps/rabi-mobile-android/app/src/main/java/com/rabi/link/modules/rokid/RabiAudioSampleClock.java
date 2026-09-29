package com.rabi.link.modules.rokid;

/** Writer-owned timeline: wall time is sampled only at an explicit continuity boundary. */
final class RabiAudioSampleClock {
    private boolean anchored;
    private long startedAt, bytes;

    long accept(long capturedAt, int length) {
        if (length < 0 || (length & 1) != 0) throw new IllegalArgumentException("unaligned PCM");
        if (!anchored) { anchored = true; startedAt = capturedAt; }
        long reference = endTime();
        bytes = Math.addExact(bytes, length);
        return reference;
    }

    long endTime() { return startedAt + bytes * 1000L / 32000L; }
    void reset() { anchored = false; startedAt = bytes = 0L; }
}
