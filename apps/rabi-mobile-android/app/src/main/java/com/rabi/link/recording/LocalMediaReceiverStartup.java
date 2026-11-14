package com.rabi.link.recording;

import java.security.SecureRandom;
import java.util.HashSet;
import java.util.Set;
import java.util.function.IntSupplier;

/** Startup facts held by the existing recording controller, not a second process owner. */
public final class LocalMediaReceiverStartup {
    private final int preferredRtmp;
    private final int preferredPreview;
    private final IntSupplier candidatePort;
    private final Set<Integer> candidates = new HashSet<>();
    private Attempt current;
    private int attempts;

    public LocalMediaReceiverStartup(int preferredRtmp, int preferredPreview) {
        this(preferredRtmp, preferredPreview, new SecureRandom());
    }

    private LocalMediaReceiverStartup(int rtmp, int preview, SecureRandom random) {
        this(rtmp, preview, () -> 49152 + random.nextInt(16384));
    }

    // Package-private deterministic source for real-process conflict tests.
    LocalMediaReceiverStartup(int rtmp, int preview, IntSupplier candidatePort) {
        if (!validPreference(rtmp) || !validPreference(preview) || (rtmp != 0 && rtmp == preview))
            throw new IllegalArgumentException("Invalid local media port preference");
        preferredRtmp = rtmp;
        preferredPreview = preview;
        this.candidatePort = candidatePort;
        if (rtmp != 0) candidates.add(rtmp);
        if (preview != 0) candidates.add(preview);
    }

    private static boolean validPreference(int port) { return port == 0 || (port >= 1024 && port <= 65535); }

    public Attempt first() {
        if (current != null) throw new IllegalStateException("Receiver startup already began");
        return next();
    }

    private int automaticPort() {
        for (int count = 0; count < 64; count++) {
            int port = candidatePort.getAsInt();
            if (port < 1024 || port > 65535) throw new IllegalArgumentException("Invalid receiver port candidate");
            if (candidates.add(port)) return port;
        }
        throw new IllegalStateException("No distinct receiver port candidate");
    }

    private Attempt next() {
        int rtmp = preferredRtmp == 0 ? automaticPort() : preferredRtmp;
        int preview = preferredPreview == 0 ? automaticPort() : preferredPreview;
        current = new Attempt(++attempts, rtmp, preview);
        return current;
    }

    /** Only the same original child after actual exit may release the next startup attempt. */
    public Attempt retryAfterExit(Attempt failed, Process exited) {
        if (failed != current || failed.original != exited || exited == null || exited.isAlive()) return null;
        try { exited.exitValue(); } catch (IllegalThreadStateException notExited) { return null; }
        if (preferredRtmp != 0 && failed.rtmpConflict || preferredPreview != 0 && failed.previewConflict) return null;
        if (failed.retired || failed.wasReady || attempts >= 3
                || !(preferredRtmp == 0 && failed.rtmpConflict || preferredPreview == 0 && failed.previewConflict)) return null;
        return next();
    }

    public static final class Attempt {
        public final int number;
        public final int rtmpPort;
        public final int previewPort;
        private volatile Process original;
        private volatile boolean retired;
        private boolean rtmpReady;
        private boolean previewReady;
        private volatile boolean wasReady;
        private volatile boolean rtmpConflict;
        private volatile boolean previewConflict;

        private Attempt(int number, int rtmpPort, int previewPort) {
            this.number = number; this.rtmpPort = rtmpPort; this.previewPort = previewPort;
        }

        public void attach(Process original) {
            if (this.original != null || original == null) throw new IllegalStateException("Receiver child already attached");
            this.original = original;
        }

        /** The pinned MediaMTX 1.21.0 emits these only after its real bind succeeds. */
        public synchronized boolean observe(String line) {
            if (retired) return false;
            if (line.endsWith("[RTMP] started with listener on 0.0.0.0:" + rtmpPort + " (TCP/RTMP)")) rtmpReady = true;
            if (line.endsWith("[RTSP] started with listeners on 127.0.0.1:" + previewPort + " (TCP/RTSP)")) previewReady = true;
            if (line.endsWith("[RTMP] closing")) rtmpReady = false;
            if (line.endsWith("[RTSP] closing")) previewReady = false;
            if (line.contains("ERR") && line.contains("listen tcp") && line.contains("bind: address already in use")) {
                if (line.contains("0.0.0.0:" + rtmpPort + ":")) rtmpConflict = true;
                if (line.contains("127.0.0.1:" + previewPort + ":")) previewConflict = true;
            }
            if (ready()) wasReady = true;
            return ready();
        }

        public synchronized boolean ready() {
            return !retired && rtmpReady && previewReady && original != null && original.isAlive();
        }

        public boolean portConflict() { return rtmpConflict || previewConflict; }

        public void retire() { retired = true; }
    }
}
