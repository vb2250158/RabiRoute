package com.rabi.link.recording;

/** Pure terminal decision shared by the foreground coordinator and regression tests. */
public final class CaptureCompletionPolicy {
    private CaptureCompletionPolicy() { }
    public static boolean mayRestart(boolean hasNext, boolean runningIntent, boolean saveFailed, boolean shutdown) {
        return hasNext && runningIntent && !saveFailed && !shutdown;
    }
    public static boolean acceptsCallback(long eventGeneration, long currentGeneration, long ownerGeneration,
            boolean shutdown, boolean transitioning, boolean voiceActive, boolean glassesSource, boolean runningIntent) {
        return !shutdown && !transitioning && voiceActive && glassesSource && runningIntent
                && eventGeneration == currentGeneration && eventGeneration == ownerGeneration;
    }
}
