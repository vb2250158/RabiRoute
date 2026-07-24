package com.rabi.link.modules.rokid;

/**
 * Event-owned network availability gate.
 *
 * <p>Android connectivity callbacks update this gate. Transport workers wait here while the
 * device is known offline instead of waking on a fixed reconnect interval. Timed waiting is
 * reserved for a real server failure while the network itself remains available.</p>
 */
final class RabiNetworkWakeGate {
    private boolean available = true;
    private boolean closed;
    private long signalVersion;

    synchronized void setAvailable(boolean value) {
        available = value;
        signalVersion += 1;
        notifyAll();
    }

    synchronized boolean isAvailable() {
        return available && !closed;
    }

    synchronized boolean awaitAvailable() throws InterruptedException {
        while (!available && !closed) wait();
        return !closed;
    }

    synchronized boolean awaitRetry(long delayMs) throws InterruptedException {
        if (closed) return false;
        long observedVersion = signalVersion;
        long deadline = System.nanoTime() + Math.max(0L, delayMs) * 1_000_000L;
        while (available && !closed && observedVersion == signalVersion) {
            long remainingNanos = deadline - System.nanoTime();
            if (remainingNanos <= 0L) break;
            long millis = remainingNanos / 1_000_000L;
            int nanos = (int) (remainingNanos % 1_000_000L);
            wait(millis, nanos);
        }
        return !closed;
    }

    synchronized void wake() {
        signalVersion += 1;
        notifyAll();
    }

    synchronized void close() {
        closed = true;
        signalVersion += 1;
        notifyAll();
    }
}
