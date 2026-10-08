package com.rabi.link.recording;

import java.util.HashSet;
import java.util.Set;

/** Coalesces committed record changes. Live PCM and status ticks do not invalidate history. */
final class RecordingFileChanges {
    private long revision;
    private final Set<String> metadata = new HashSet<>();
    synchronized void mark(String path, boolean segmentMetadata) {
        if (path == null || !path.endsWith(".json")) return;
        if (!segmentMetadata && !path.startsWith("asr-") && !path.startsWith("capture-") && !path.startsWith("event-")) return;
        if (segmentMetadata) metadata.add(path);
        revision++;
    }
    synchronized long revision() { return revision; }
    synchronized Set<String> takeMetadata() {
        Set<String> result = new HashSet<>(metadata);
        metadata.clear();
        return result;
    }
}
