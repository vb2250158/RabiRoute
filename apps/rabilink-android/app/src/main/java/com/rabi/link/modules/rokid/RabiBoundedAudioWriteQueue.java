package com.rabi.link.modules.rokid;

import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/** Byte-bounded single-consumer capture queue with exact source/route loss accounting. */
final class RabiBoundedAudioWriteQueue {
    static final class Entry {
        final byte[] pcm;
        final String source;
        final String route;

        Entry(byte[] pcm, String source, String route) {
            this.pcm = pcm;
            this.source = source;
            this.route = route;
        }
    }

    static final class Gap {
        final String source;
        final String route;
        final long bytes;

        Gap(String source, String route, long bytes) {
            this.source = source;
            this.route = route;
            this.bytes = bytes;
        }
    }

    private final int maxItems;
    private final long maxBytes;
    private final ArrayDeque<Entry> entries = new ArrayDeque<>();
    private final LinkedHashMap<String, Gap> rejected = new LinkedHashMap<>();
    private long queuedBytes;
    private boolean accepting = true;

    RabiBoundedAudioWriteQueue(int maxItems, long maxBytes) {
        if (maxItems < 1 || maxBytes < 2) throw new IllegalArgumentException("invalid audio queue bounds");
        this.maxItems = maxItems;
        this.maxBytes = maxBytes;
    }

    synchronized boolean offer(byte[] pcm, String source, String route) {
        int bytes = pcm == null ? 0 : pcm.length;
        if (bytes <= 0) return true;
        if (!accepting || entries.size() >= maxItems || queuedBytes + bytes > maxBytes) {
            recordRejectedLocked(source, route, bytes);
            return false;
        }
        entries.addLast(new Entry(pcm, source, route));
        queuedBytes += bytes;
        return true;
    }

    synchronized Entry poll() {
        Entry entry = entries.pollFirst();
        if (entry != null) queuedBytes = Math.max(0L, queuedBytes - entry.pcm.length);
        return entry;
    }

    synchronized void closeAdmission() { accepting = false; }

    synchronized boolean isAccepting() { return accepting; }

    synchronized boolean hasWork() { return !entries.isEmpty() || !rejected.isEmpty(); }

    synchronized long queuedBytes() { return queuedBytes; }

    synchronized int size() { return entries.size(); }

    synchronized List<Gap> takeRejected() {
        List<Gap> result = new ArrayList<>(rejected.values());
        rejected.clear();
        return result;
    }

    private void recordRejectedLocked(String source, String route, long bytes) {
        String normalizedSource = source == null ? "" : source;
        String normalizedRoute = route == null ? "" : route;
        String key = normalizedSource + "\u0000" + normalizedRoute;
        Gap previous = rejected.get(key);
        rejected.put(key, new Gap(normalizedSource, normalizedRoute,
                bytes + (previous == null ? 0L : previous.bytes)));
    }
}
