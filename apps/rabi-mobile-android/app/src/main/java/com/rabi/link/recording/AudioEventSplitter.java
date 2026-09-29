package com.rabi.link.recording;

import java.io.ByteArrayOutputStream;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
import java.util.Objects;
import java.util.UUID;
import java.util.function.Supplier;

/** PC-compatible acoustic segmentation of 16 kHz mono signed little-endian PCM. Single writer. */
public final class AudioEventSplitter {
    public static final double DEFAULT_SIGNAL_THRESHOLD = 0.015;
    private static final int BYTES_PER_MS = 32, FRAME_BYTES = 3200;
    public static final class Policy {
        public final int silenceMs, maxMs, preRollMs, minUtteranceMs;
        /** Legacy UI alias for transcribeThreshold, not the recording trigger. */
        public final double signalThreshold, recordThreshold, transcribeThreshold;
        public final double adaptiveMultiplier, adaptiveMargin, inputGain;
        public final boolean adaptiveThreshold;
        public Policy(int silenceMs, int maxMs) {
            this(silenceMs, maxMs, DEFAULT_SIGNAL_THRESHOLD);
        }
        public Policy(int silenceMs, int maxMs, double signalThreshold) {
            this(silenceMs, maxMs, 1500, 1000, 0.01, signalThreshold, true, 2.5, 0.004, 1.0);
        }
        public Policy(int silenceMs, int maxMs, int preRollMs, int minUtteranceMs,
                      double recordThreshold, double transcribeThreshold, boolean adaptiveThreshold,
                      double adaptiveMultiplier, double adaptiveMargin, double inputGain) {
            if (silenceMs < 200 || silenceMs > 3000 || maxMs < 3000 || maxMs > 120000
                    || preRollMs < 0 || preRollMs > 10000 || preRollMs >= maxMs
                    || minUtteranceMs < 100 || minUtteranceMs > maxMs)
                throw new IllegalArgumentException("invalid event splitting policy");
            check(recordThreshold, 0.001, 0.3); check(transcribeThreshold, 0.001, 0.3);
            check(adaptiveMultiplier, 1, 10); check(adaptiveMargin, 0, 0.3); check(inputGain, 0.1, 10);
            this.silenceMs = silenceMs; this.maxMs = maxMs;
            this.preRollMs = preRollMs; this.minUtteranceMs = minUtteranceMs;
            this.recordThreshold = recordThreshold; this.transcribeThreshold = Math.max(recordThreshold, transcribeThreshold);
            this.signalThreshold = this.transcribeThreshold; this.adaptiveThreshold = adaptiveThreshold;
            this.adaptiveMultiplier = adaptiveMultiplier; this.adaptiveMargin = adaptiveMargin; this.inputGain = inputGain;
        }
        @Override public boolean equals(Object other) {
            if (this == other) return true;
            if (!(other instanceof Policy)) return false;
            Policy p = (Policy) other;
            return silenceMs == p.silenceMs && maxMs == p.maxMs && preRollMs == p.preRollMs
                    && minUtteranceMs == p.minUtteranceMs && adaptiveThreshold == p.adaptiveThreshold
                    && Double.compare(recordThreshold, p.recordThreshold) == 0
                    && Double.compare(transcribeThreshold, p.transcribeThreshold) == 0
                    && Double.compare(adaptiveMultiplier, p.adaptiveMultiplier) == 0
                    && Double.compare(adaptiveMargin, p.adaptiveMargin) == 0
                    && Double.compare(inputGain, p.inputGain) == 0;
        }
        @Override public int hashCode() {
            return Objects.hash(silenceMs, maxMs, preRollMs, minUtteranceMs, recordThreshold,
                    transcribeThreshold, adaptiveThreshold, adaptiveMultiplier, adaptiveMargin, inputGain);
        }
        private static void check(double value, double min, double max) {
            if (!Double.isFinite(value) || value < min || value > max)
                throw new IllegalArgumentException("invalid acoustic setting");
        }
    }
    public static final class Part {
        public final String eventId;
        public final byte[] pcm;
        /** Start relative to this accept input, or to the last input end for finish(); may be negative. */
        public final int offset;
        public final boolean completed;
        Part(String id, byte[] pcm, int offset, boolean completed) {
            this.eventId = id; this.pcm = pcm; this.offset = offset; this.completed = completed;
        }
    }
    private final Supplier<Policy> policies;
    private Policy policy;
    private String owner;
    private final byte[] frame = new byte[FRAME_BYTES];
    private int frameSize, preSize;
    private final java.util.ArrayDeque<byte[]> pre = new java.util.ArrayDeque<>();
    private ByteArrayOutputStream utterance;
    private long position, start, voicedBytes, silenceBytes;
    private double noiseFloor, dynamicThreshold, peak;

    public AudioEventSplitter(Supplier<Policy> policies) { this.policies = Objects.requireNonNull(policies); }

    /** Only complete acoustically valid events escape memory. Call finish BEFORE changing owner. */
    public List<Part> accept(String owner, byte[] pcm) {
        Objects.requireNonNull(owner); Objects.requireNonNull(pcm);
        if ((pcm.length & 1) != 0) throw new IllegalArgumentException("unaligned PCM");
        if (!owner.equals(this.owner)) { clear(); this.owner = owner; }
        long origin = position;
        List<Part> parts = new ArrayList<>();
        int offset = 0;
        while (offset < pcm.length) {
            int count = Math.min(FRAME_BYTES - frameSize, pcm.length - offset);
            System.arraycopy(pcm, offset, frame, frameSize, count);
            frameSize += count; position += count; offset += count;
            if (frameSize == FRAME_BYTES) {
                refreshIdlePolicy();
                process(Arrays.copyOf(frame, frameSize), position - frameSize, origin, parts);
                frameSize = 0;
            }
        }
        return parts;
    }

    /** Seals valid speech, including a final sub-100ms frame; clears pre-roll, noise state and owner. */
    public List<Part> finish() {
        List<Part> parts = new ArrayList<>();
        long origin = position;
        if (frameSize > 0) {
            refreshIdlePolicy();
            process(Arrays.copyOf(frame, frameSize), position - frameSize, origin, parts);
        }
        seal(origin, parts);
        clear();
        return parts;
    }

    /** Check once per idle analysis frame, never per sample or active utterance. */
    private void refreshIdlePolicy() {
        if (utterance != null) return;
        Policy next = Objects.requireNonNull(policies.get());
        // A supplier may allocate an equal snapshot on every read. Preserve learned state in that case.
        // Real changes reset pre-roll and noise together, so old-gain PCM cannot enter the new event.
        if (!next.equals(policy)) loadPolicy(next);
    }

    private void loadPolicy(Policy next) {
        policy = next;
        noiseFloor = Math.max(0.0005, policy.recordThreshold / 3.0);
        pre.clear(); preSize = 0;
    }

    private void process(byte[] pcm, long frameStart, long origin, List<Part> parts) {
        if (pcm.length == 0) return;
        if (policy == null) refreshIdlePolicy();
        if (utterance != null && utterance.size() >= policy.maxMs * BYTES_PER_MS) seal(origin, parts);
        if (utterance != null) {
            int remaining = policy.maxMs * BYTES_PER_MS - utterance.size();
            if (remaining < pcm.length) {
                process(Arrays.copyOfRange(pcm, 0, remaining), frameStart, origin, parts);
                process(Arrays.copyOfRange(pcm, remaining, pcm.length), frameStart + remaining, origin, parts);
                return;
            }
        }
        // Gain precedes both acoustic decisions and retained PCM, as on PC.
        double sum = 0;
        for (int i = 0; i < pcm.length; i += 2) {
            short raw = (short)((pcm[i] & 255) | (pcm[i + 1] << 8));
            double scaled = Math.max(-1.0, Math.min(1.0, raw / 32768.0 * policy.inputGain));
            sum += scaled * scaled;
            int value = Math.max(-32768, Math.min(32767, (int)Math.round(scaled * 32768.0)));
            pcm[i] = (byte)value; pcm[i + 1] = (byte)(value >> 8);
        }
        double level = Math.sqrt(sum / (pcm.length / 2));
        if (utterance == null) {
            appendPre(pcm);
            dynamicThreshold = policy.adaptiveThreshold
                    ? Math.max(policy.recordThreshold, noiseFloor * policy.adaptiveMultiplier + policy.adaptiveMargin)
                    : policy.recordThreshold;
            if (level < dynamicThreshold) {
                if (policy.adaptiveThreshold) noiseFloor = noiseFloor * 0.95 + level * 0.05;
                return;
            }
            utterance = new ByteArrayOutputStream(policy.maxMs * BYTES_PER_MS);
            if (preSize == 0) utterance.write(pcm, 0, pcm.length);
            else for (byte[] chunk : pre) utterance.write(chunk, 0, chunk.length);
            start = frameStart + pcm.length - utterance.size();
            pre.clear(); preSize = 0;
            peak = level; voicedBytes = pcm.length; silenceBytes = 0;
            return;
        }
        int count = Math.min(pcm.length, policy.maxMs * BYTES_PER_MS - utterance.size());
        utterance.write(pcm, 0, count);
        peak = Math.max(peak, level);
        if (level >= dynamicThreshold) voicedBytes += count;
        if (level >= policy.transcribeThreshold) silenceBytes = 0; else silenceBytes += count;
        if (silenceBytes >= policy.silenceMs * BYTES_PER_MS || utterance.size() >= policy.maxMs * BYTES_PER_MS) {
            seal(origin, parts);
        }
    }

    private void appendPre(byte[] pcm) {
        int limit = policy.preRollMs * BYTES_PER_MS;
        if (limit <= 0) return;
        pre.addLast(pcm); preSize += pcm.length;
        // PC retains whole frames and at least the newest frame, even if it exceeds the limit.
        while (preSize > limit && pre.size() > 1) preSize -= pre.removeFirst().length;
    }

    private void seal(long origin, List<Part> parts) {
        if (utterance == null) return;
        if (peak >= policy.transcribeThreshold && voicedBytes >= policy.minUtteranceMs * BYTES_PER_MS)
            parts.add(new Part(UUID.randomUUID().toString(), utterance.toByteArray(), Math.toIntExact(start - origin), true));
        utterance = null; voicedBytes = silenceBytes = 0; peak = 0;
        // Adopt pending settings before the next idle analysis frame; this event kept its frozen policy.
        pre.clear(); preSize = 0;
    }

    private void clear() {
        utterance = null; policy = null; owner = null; pre.clear();
        frameSize = preSize = 0; position = start = voicedBytes = silenceBytes = 0;
        noiseFloor = dynamicThreshold = peak = 0;
        Arrays.fill(frame, (byte)0);
    }
}
