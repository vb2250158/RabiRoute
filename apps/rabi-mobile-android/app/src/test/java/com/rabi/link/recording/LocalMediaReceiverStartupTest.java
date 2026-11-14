package com.rabi.link.recording;

import org.junit.Test;
import java.io.BufferedReader;
import java.io.File;
import java.io.InputStreamReader;
import java.net.BindException;
import java.net.InetSocketAddress;
import java.net.ServerSocket;
import java.util.concurrent.TimeUnit;
import static org.junit.Assert.*;

public class LocalMediaReceiverStartupTest {
    private static String rtmp(LocalMediaReceiverStartup.Attempt attempt) {
        return "INF [RTMP] started with listener on 0.0.0.0:" + attempt.rtmpPort + " (TCP/RTMP)";
    }
    private static String rtsp(LocalMediaReceiverStartup.Attempt attempt) {
        return "INF [RTSP] started with listeners on 127.0.0.1:" + attempt.previewPort + " (TCP/RTSP)";
    }
    private static String conflict(LocalMediaReceiverStartup.Attempt attempt) {
        return "ERR listen tcp 0.0.0.0:" + attempt.rtmpPort + ": bind: address already in use";
    }
    private static Process child(String... args) throws Exception {
        String[] command = new String[5 + args.length];
        command[0] = new File(System.getProperty("java.home"), "bin/java").getAbsolutePath();
        command[1] = "-cp"; command[2] = System.getProperty("java.class.path");
        command[3] = LocalMediaReceiverStartupTest.class.getName(); command[4] = "fixture";
        System.arraycopy(args, 0, command, 5, args.length);
        return new ProcessBuilder(command).redirectErrorStream(true).start();
    }
    private static void stopped(Process child) throws Exception {
        child.getOutputStream().close();
        if (!child.waitFor(3, TimeUnit.SECONDS)) { child.destroyForcibly(); assertTrue(child.waitFor(3, TimeUnit.SECONDS)); }
    }
    private static ServerSocket listener(int port) throws Exception {
        ServerSocket server = new ServerSocket();
        try { server.bind(new InetSocketAddress("127.0.0.1", port)); return server; }
        catch (Exception error) { server.close(); throw error; }
    }

    @Test public void zeroPreferencesStayAutomaticAndExplicitPreferencesStayStrict() {
        LocalMediaSettings automatic = new LocalMediaSettings(0, 0);
        assertEquals(0, automatic.rtmpPort); assertEquals(0, automatic.previewPort);
        assertEquals(0, LocalMediaSettings.DEFAULT_RTMP_PORT); assertEquals(0, LocalMediaSettings.DEFAULT_PREVIEW_PORT);
        assertFalse(LocalMediaSettings.validPort(-1)); assertFalse(LocalMediaSettings.validPort(65536));
        LocalMediaReceiverStartup.Attempt explicit = new LocalMediaReceiverStartup(1936, 8554).first();
        assertEquals(1936, explicit.rtmpPort); assertEquals(8554, explicit.previewPort);
        try { new LocalMediaSettings(1936, 1936); fail("Equal explicit ports must fail"); } catch (IllegalArgumentException expected) { }
    }

    @Test(timeout=10000) public void occupiedLegacyPortsDoNotBlockActualDynamicListeners() throws Exception {
        ServerSocket legacyRtmp = null, legacyPreview = null;
        try {
            try { legacyRtmp = listener(1936); } catch (BindException alreadyOccupied) { }
            try { legacyPreview = listener(8554); } catch (BindException alreadyOccupied) { }
            LocalMediaReceiverStartup.Attempt attempt = new LocalMediaReceiverStartup(0, 0).first();
            assertNotEquals(1936, attempt.rtmpPort); assertNotEquals(8554, attempt.previewPort);
            assertNotEquals(attempt.rtmpPort, attempt.previewPort);
            Process child = child("receiver", String.valueOf(attempt.rtmpPort), String.valueOf(attempt.previewPort));
            try {
                attempt.attach(child);
                BufferedReader reader = new BufferedReader(new InputStreamReader(child.getInputStream()));
                assertFalse(attempt.observe(reader.readLine()));
                assertTrue(attempt.observe(reader.readLine()));
                assertTrue(attempt.ready());
                attempt.retire(); assertFalse(attempt.ready());
            } finally { stopped(child); }
            if (legacyRtmp != null) assertFalse(legacyRtmp.isClosed());
            if (legacyPreview != null) assertFalse(legacyPreview.isClosed());
        } finally { if (legacyRtmp != null) legacyRtmp.close(); if (legacyPreview != null) legacyPreview.close(); }
    }

    @Test(timeout=10000) public void onlyTheSameExitedChildMayAdvanceAClassifiedAutomaticConflict() throws Exception {
        try (ServerSocket foreign = listener(0)) {
            final int busy = foreign.getLocalPort();
            LocalMediaReceiverStartup startup = new LocalMediaReceiverStartup(0, 8554, () -> busy);
            LocalMediaReceiverStartup.Attempt attempt = startup.first();
            Process child = child("wait"); Process other = child("wait");
            try {
                attempt.attach(child); attempt.observe(conflict(attempt));
                assertNull(startup.retryAfterExit(attempt, child));
                stopped(other); assertNull(startup.retryAfterExit(attempt, other));
                // The first child must actually exit; a termination request is insufficient.
                stopped(child);
                try { startup.retryAfterExit(attempt, child); fail("A repeated candidate cannot be reused"); }
                catch (IllegalStateException exhausted) { }
                assertFalse(foreign.isClosed());
            } finally { stopped(child); stopped(other); }
        }
    }

    @Test(timeout=10000) public void bindRetriesAreBoundedAndNeverReplaceExplicitPorts() throws Exception {
        final int[] candidate = { 50000 };
        LocalMediaReceiverStartup startup = new LocalMediaReceiverStartup(0, 8554, () -> candidate[0]++);
        LocalMediaReceiverStartup.Attempt attempt = startup.first();
        for (int index=1; index<=3; index++) {
            assertEquals(index, attempt.number); assertEquals(8554, attempt.previewPort);
            Process child = child("wait");
            try {
                attempt.attach(child); attempt.observe(conflict(attempt)); stopped(child);
                LocalMediaReceiverStartup.Attempt next = startup.retryAfterExit(attempt, child);
                if (index == 3) assertNull(next); else { assertNotNull(next); assertNotEquals(attempt.rtmpPort, next.rtmpPort); attempt = next; }
            } finally { stopped(child); }
        }
        LocalMediaReceiverStartup strict = new LocalMediaReceiverStartup(1936, 0);
        LocalMediaReceiverStartup.Attempt fixed = strict.first(); Process child = child("wait");
        try { fixed.attach(child); fixed.observe(conflict(fixed)); stopped(child); assertNull(strict.retryAfterExit(fixed, child)); }
        finally { stopped(child); }
    }

    @Test(timeout=10000) public void readinessRequiresBothMatchingProtocolsAndCannotSurviveRetirementOrExit() throws Exception {
        LocalMediaReceiverStartup startup = new LocalMediaReceiverStartup(0, 0);
        LocalMediaReceiverStartup.Attempt attempt = startup.first(); Process child = child("wait");
        try {
            attempt.attach(child);
            assertFalse(attempt.observe("INF [RTMP] listener opened on 0.0.0.0:1936"));
            assertFalse(attempt.observe("INF [RTSP] started with listeners on 127.0.0.1:1 (TCP/RTSP)"));
            assertFalse(attempt.observe(rtmp(attempt))); assertTrue(attempt.observe(rtsp(attempt)));
            attempt.observe("INF [RTMP] closing"); assertFalse(attempt.ready());
            attempt.observe(rtmp(attempt)); assertTrue(attempt.ready());
            stopped(child); assertFalse(attempt.ready());
            attempt.observe(conflict(attempt)); assertNull(startup.retryAfterExit(attempt, child));
            attempt.retire(); assertFalse(attempt.observe(rtmp(attempt)));
        } finally { stopped(child); }
    }

    @Test(timeout=10000) public void actualBindFailureIsNotReadinessAndPreservesTheForeignListener() throws Exception {
        try (ServerSocket foreign = listener(0)) {
            final int[] port = { foreign.getLocalPort(), 57000 };
            final int[] index = { 0 };
            LocalMediaReceiverStartup startup = new LocalMediaReceiverStartup(0, 0, () -> port[index[0]++]);
            LocalMediaReceiverStartup.Attempt attempt = startup.first();
            Process child = child("receiver", String.valueOf(attempt.rtmpPort), String.valueOf(attempt.previewPort));
            try {
                attempt.attach(child); BufferedReader reader = new BufferedReader(new InputStreamReader(child.getInputStream()));
                String line; while ((line=reader.readLine()) != null) attempt.observe(line);
                assertTrue(child.waitFor(3, TimeUnit.SECONDS)); assertNotEquals(0, child.exitValue());
                assertFalse(attempt.ready()); assertFalse(foreign.isClosed());
            } finally { stopped(child); }
        }
    }

    /** Real child bind/wait fixture, not an Android or MediaMTX execution claim. */
    public static void main(String[] args) throws Exception {
        if (args.length < 2 || !"fixture".equals(args[0])) throw new IllegalArgumentException("fixture");
        if ("wait".equals(args[1])) { System.in.read(); return; }
        int rtmp = Integer.parseInt(args[2]), preview = Integer.parseInt(args[3]);
        String address = "127.0.0.1:" + preview;
        try (ServerSocket previewListener = listener(preview)) {
            System.out.println("INF [RTSP] started with listeners on " + address + " (TCP/RTSP)");
            address = "0.0.0.0:" + rtmp;
            try (ServerSocket rtmpListener = listener(rtmp)) {
                System.out.println("INF [RTMP] started with listener on " + address + " (TCP/RTMP)");
                System.in.read();
            }
        } catch (BindException occupied) {
            System.out.println("ERR listen tcp " + address + ": bind: address already in use"); System.exit(7);
        }
    }
}
