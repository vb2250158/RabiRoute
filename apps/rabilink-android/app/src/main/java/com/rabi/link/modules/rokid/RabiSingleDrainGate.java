package com.rabi.link.modules.rokid;

import java.util.concurrent.Executor;
import java.util.concurrent.RejectedExecutionException;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicLong;

/**
 * Coalesces producer wakeups into one scheduled drain. Requests that arrive while the drain is
 * running are consumed by the same task, so a 100 ms PCM producer cannot build an executor queue.
 */
final class RabiSingleDrainGate {
    private final AtomicBoolean scheduled = new AtomicBoolean();
    private final AtomicLong requestedGeneration = new AtomicLong();

    void request(Executor executor, Runnable drain) {
        requestedGeneration.incrementAndGet();
        scheduleIfNeeded(executor, drain);
    }

    private void scheduleIfNeeded(Executor executor, Runnable drain) {
        if (!scheduled.compareAndSet(false, true)) return;
        try {
            executor.execute(() -> runDrain(executor, drain));
        } catch (RejectedExecutionException ignored) {
            scheduled.set(false);
        }
    }

    private void runDrain(Executor executor, Runnable drain) {
        long handledGeneration = 0;
        try {
            do {
                handledGeneration = requestedGeneration.get();
                drain.run();
            } while (requestedGeneration.get() != handledGeneration);
        } finally {
            scheduled.set(false);
            if (requestedGeneration.get() != handledGeneration) {
                scheduleIfNeeded(executor, drain);
            }
        }
    }
}
