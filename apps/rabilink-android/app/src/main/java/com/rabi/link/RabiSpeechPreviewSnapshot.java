package com.rabi.link;

import java.util.ArrayList;
import java.util.Collections;
import java.util.List;

/** Read-only projection of one phone's live speech stream and retained ASR records. */
public final class RabiSpeechPreviewSnapshot {
    public static final int RECORD_LIMIT = 1000;

    public static final class Stream {
        public final boolean found;
        public final boolean online;
        public final boolean selected;
        public final long receivedBytes;
        public final long acceptedChunks;
        public final long lastAudioAt;

        public Stream(boolean found, boolean online, boolean selected, long receivedBytes,
                      long acceptedChunks, long lastAudioAt) {
            this.found = found;
            this.online = online;
            this.selected = selected;
            this.receivedBytes = Math.max(0L, receivedBytes);
            this.acceptedChunks = Math.max(0L, acceptedChunks);
            this.lastAudioAt = Math.max(0L, lastAudioAt);
        }
    }

    public static final class RuntimeStats {
        public final boolean attributableToDevice;
        public final long captured;
        public final long recognized;
        public final long empty;
        public final long dropped;

        public RuntimeStats(boolean attributableToDevice, long captured, long recognized,
                            long empty, long dropped) {
            this.attributableToDevice = attributableToDevice;
            this.captured = Math.max(0L, captured);
            this.recognized = Math.max(0L, recognized);
            this.empty = Math.max(0L, empty);
            this.dropped = Math.max(0L, dropped);
        }
    }

    public static final class Record {
        public final String id;
        public final long time;
        public final String text;
        public final String provider;
        public final String model;
        public final double durationSeconds;
        public final boolean audioAvailable;
        public final long audioExpiresAt;

        public Record(String id, long time, String text, String provider, String model,
                      double durationSeconds, boolean audioAvailable, long audioExpiresAt) {
            this.id = safe(id);
            this.time = Math.max(0L, time);
            this.text = safe(text);
            this.provider = safe(provider);
            this.model = safe(model);
            this.durationSeconds = Math.max(0d, durationSeconds);
            this.audioAvailable = audioAvailable;
            this.audioExpiresAt = Math.max(0L, audioExpiresAt);
        }
    }

    public final String sourceDeviceId;
    public final long checkedAt;
    public final Stream stream;
    public final RuntimeStats runtimeStats;
    public final List<Record> successfulRecords;
    public final boolean recordCountTruncated;

    public RabiSpeechPreviewSnapshot(String sourceDeviceId, long checkedAt, Stream stream,
                                     RuntimeStats runtimeStats, List<Record> successfulRecords) {
        this.sourceDeviceId = safe(sourceDeviceId);
        this.checkedAt = Math.max(0L, checkedAt);
        this.stream = stream;
        this.runtimeStats = runtimeStats;
        this.successfulRecords = Collections.unmodifiableList(new ArrayList<>(successfulRecords));
        this.recordCountTruncated = successfulRecords.size() >= RECORD_LIMIT;
    }

    public int successfulCount() {
        return successfulRecords.size();
    }

    public String successfulCountLabel() {
        return recordCountTruncated ? RECORD_LIMIT + "+" : String.valueOf(successfulCount());
    }

    private static String safe(String value) {
        return value == null ? "" : value.trim();
    }
}
