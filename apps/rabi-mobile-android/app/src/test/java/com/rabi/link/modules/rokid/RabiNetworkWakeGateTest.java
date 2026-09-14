package com.rabi.link.modules.rokid;

import org.junit.Test;

import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

public final class RabiNetworkWakeGateTest {
    @Test
    public void knownOfflineWaitsUntilConnectivityEvent() throws Exception {
        RabiNetworkWakeGate gate = new RabiNetworkWakeGate();
        gate.setAvailable(false);
        CountDownLatch started = new CountDownLatch(1);
        CountDownLatch finished = new CountDownLatch(1);
        AtomicBoolean result = new AtomicBoolean();
        Thread waiter = new Thread(() -> {
            started.countDown();
            try {
                result.set(gate.awaitAvailable());
            } catch (InterruptedException error) {
                Thread.currentThread().interrupt();
            } finally {
                finished.countDown();
            }
        });
        waiter.start();

        assertTrue(started.await(1, TimeUnit.SECONDS));
        assertFalse(finished.await(80, TimeUnit.MILLISECONDS));
        gate.setAvailable(true);
        assertTrue(finished.await(1, TimeUnit.SECONDS));
        assertTrue(result.get());
    }

    @Test
    public void closeReleasesOfflineWaitWithoutPretendingNetworkRecovered() throws Exception {
        RabiNetworkWakeGate gate = new RabiNetworkWakeGate();
        gate.setAvailable(false);
        CountDownLatch finished = new CountDownLatch(1);
        AtomicBoolean result = new AtomicBoolean(true);
        Thread waiter = new Thread(() -> {
            try {
                result.set(gate.awaitAvailable());
            } catch (InterruptedException error) {
                Thread.currentThread().interrupt();
            } finally {
                finished.countDown();
            }
        });
        waiter.start();

        gate.close();
        assertTrue(finished.await(1, TimeUnit.SECONDS));
        assertFalse(result.get());
        assertFalse(gate.isAvailable());
    }

    @Test
    public void connectivityChangeInterruptsServerRetryAndThenWaitsForRecovery() throws Exception {
        RabiNetworkWakeGate gate = new RabiNetworkWakeGate();
        CountDownLatch retryFinished = new CountDownLatch(1);
        Thread retry = new Thread(() -> {
            try {
                gate.awaitRetry(30_000L);
            } catch (InterruptedException error) {
                Thread.currentThread().interrupt();
            } finally {
                retryFinished.countDown();
            }
        });
        retry.start();

        gate.setAvailable(false);
        assertTrue(retryFinished.await(1, TimeUnit.SECONDS));

        CountDownLatch recoveryFinished = new CountDownLatch(1);
        Thread recovery = new Thread(() -> {
            try {
                gate.awaitAvailable();
            } catch (InterruptedException error) {
                Thread.currentThread().interrupt();
            } finally {
                recoveryFinished.countDown();
            }
        });
        recovery.start();

        assertFalse(recoveryFinished.await(80, TimeUnit.MILLISECONDS));
        gate.setAvailable(true);
        assertTrue(recoveryFinished.await(1, TimeUnit.SECONDS));
    }

}
