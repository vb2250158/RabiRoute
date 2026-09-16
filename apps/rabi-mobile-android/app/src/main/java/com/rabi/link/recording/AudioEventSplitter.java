package com.rabi.link.recording;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
import java.util.UUID;
import java.util.function.Supplier;

/** Event boundaries only: every PCM sample is retained, including silence. Single writer owner. */
public final class AudioEventSplitter {
    public static final double DEFAULT_SIGNAL_THRESHOLD = 0.015;
    public static final class Policy {
        public final int silenceMs, maxMs;
        public final double signalThreshold;
        public Policy(int silenceMs, int maxMs) {
            this(silenceMs,maxMs,DEFAULT_SIGNAL_THRESHOLD);
        }
        public Policy(int silenceMs, int maxMs, double signalThreshold) {
            if (!Double.isFinite(signalThreshold) || signalThreshold < 0.001 || signalThreshold > 0.3)
                throw new IllegalArgumentException("invalid sound threshold");
            if (silenceMs < 200 || silenceMs > 3000 || maxMs < 3000 || maxMs > 120000)
                throw new IllegalArgumentException("invalid event splitting policy");
            this.signalThreshold = signalThreshold;
            this.silenceMs = silenceMs; this.maxMs = maxMs;
        }
    }
    public static final class Part {
        public final String eventId;
        public final byte[] pcm;
        public final int offset;
        public final boolean completed;
        Part(String id, byte[] pcm, int offset, boolean completed) {
            this.eventId = id; this.pcm = pcm; this.offset = offset; this.completed = completed;
        }
    }
    private final Supplier<Policy> policies;
    private Policy policy;
    private String owner = "", id = "";
    private long samples, voiced, silence;
    private double energy;
    private int frameSamples;
    public AudioEventSplitter(Supplier<Policy> policies) { this.policies = policies; }
    public List<Part> accept(String owner, byte[] pcm) {
        if ((pcm.length & 1) != 0) throw new IllegalArgumentException("unaligned PCM");
        if (!this.owner.equals(owner)) { this.owner = owner; reset(); }
        List<Part> parts = new ArrayList<>();
        int start = 0;
        for (int offset = 0; offset < pcm.length; offset += 2) {
            if (id.isEmpty()) { id = UUID.randomUUID().toString(); policy = policies.get(); }
            short value = (short)((pcm[offset] & 255) | (pcm[offset + 1] << 8));
            energy += (double)value * value; frameSamples++; samples++;
            if (frameSamples == 320) {
                boolean signal = Math.sqrt(energy / frameSamples) / 32768.0 >= policy.signalThreshold;
                if (signal) { voiced += frameSamples; silence = 0; } else silence += frameSamples;
                frameSamples = 0; energy = 0;
            }
            if (samples >= policy.maxMs * 16L || (voiced >= 16000 && silence >= policy.silenceMs * 16L)) {
                parts.add(new Part(id, Arrays.copyOfRange(pcm,start,offset+2),start,true));
                start = offset + 2; reset();
            }
        }
        if (start < pcm.length) parts.add(new Part(id,Arrays.copyOfRange(pcm,start,pcm.length),start,false));
        return parts;
    }
    private void reset() { id = ""; samples = voiced = silence = 0; energy = 0; frameSamples = 0; }
}
