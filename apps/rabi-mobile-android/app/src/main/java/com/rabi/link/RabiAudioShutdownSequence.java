package com.rabi.link;

/** Fixed shutdown order: producers stop before the durable audio backend drains and closes. */
final class RabiAudioShutdownSequence {
    private RabiAudioShutdownSequence() { }

    static void run(Runnable stopPhoneCapture, Runnable stopGlassesCapture, Runnable stopBackend) {
        stopPhoneCapture.run();
        stopGlassesCapture.run();
        stopBackend.run();
    }
}
