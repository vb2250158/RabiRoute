package com.rabi.link.recording;

/** Session-local readiness; Bluetooth alone is not evidence that glasses supply PCM. */
public final class AutomaticAudioSource {
    public static final long STALE_MS = 5000;
    private long lastGlassesPcm = -1;
    public void receivedGlassesPcm(long elapsedMs) { lastGlassesPcm = elapsedMs; }
    public void disconnected() { lastGlassesPcm = -1; }
    public String preferred(long elapsedMs) {
        return lastGlassesPcm >= 0 && elapsedMs - lastGlassesPcm < STALE_MS ? "glasses" : "mobile";
    }
}
