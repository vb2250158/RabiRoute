package com.rabi.link.modules.rokid;

import java.io.ByteArrayOutputStream;
import java.util.ArrayDeque;

/**
 * Lightweight phone-side utterance segmentation for 16 kHz mono PCM16.
 * It is transport/VAD glue only: transcription remains on the selected Rabi PC.
 */
public final class RabiPcmSegmenter {
    public interface Listener {
        void onSegment(byte[] pcm);
    }

    private static final int BYTES_PER_SECOND = 16000 * 2;
    private final Listener listener;
    private final ArrayDeque<byte[]> preRoll = new ArrayDeque<>();
    private ByteArrayOutputStream active = new ByteArrayOutputStream();
    private int preRollBytes;
    private int speechBytes;
    private int silenceBytes;
    private boolean speechActive;
    private int threshold = 650;
    private int silenceMs = 900;
    private int minimumSpeechMs = 420;
    private int maximumSegmentMs = 20000;
    private int preRollMs = 320;

    public RabiPcmSegmenter(Listener listener) {
        this.listener = listener;
    }

    public synchronized void configure(int threshold, int silenceMs) {
        this.threshold = Math.max(100, Math.min(12000, threshold));
        this.silenceMs = Math.max(250, Math.min(4000, silenceMs));
    }

    public synchronized void accept(byte[] pcm) {
        if (pcm == null || pcm.length < 2) return;
        byte[] chunk = pcm.clone();
        boolean voiced = rms(chunk) >= threshold;
        if (!speechActive) {
            addPreRoll(chunk);
            if (!voiced) return;
            active = new ByteArrayOutputStream();
            for (byte[] buffered : preRoll) active.write(buffered, 0, buffered.length);
            speechActive = true;
            speechBytes = chunk.length;
            silenceBytes = 0;
            return;
        }

        active.write(chunk, 0, chunk.length);
        if (voiced) {
            speechBytes += chunk.length;
            silenceBytes = 0;
        } else {
            silenceBytes += chunk.length;
        }
        if (silenceBytes >= bytesForMs(silenceMs) || active.size() >= bytesForMs(maximumSegmentMs)) {
            emitIfLongEnough();
        }
    }

    public synchronized void flush() {
        emitIfLongEnough();
        reset();
    }

    public synchronized void reset() {
        active = new ByteArrayOutputStream();
        preRoll.clear();
        preRollBytes = 0;
        speechBytes = 0;
        silenceBytes = 0;
        speechActive = false;
    }

    private void emitIfLongEnough() {
        byte[] result = speechActive && speechBytes >= bytesForMs(minimumSpeechMs)
                ? active.toByteArray()
                : null;
        reset();
        if (result != null && result.length > 0) listener.onSegment(result);
    }

    private void addPreRoll(byte[] chunk) {
        preRoll.addLast(chunk);
        preRollBytes += chunk.length;
        int limit = bytesForMs(preRollMs);
        while (preRollBytes > limit && preRoll.size() > 1) {
            byte[] removed = preRoll.removeFirst();
            preRollBytes -= removed.length;
        }
    }

    private static int bytesForMs(int milliseconds) {
        return Math.max(2, (BYTES_PER_SECOND * milliseconds) / 1000);
    }

    private static int rms(byte[] pcm) {
        long sum = 0;
        int samples = pcm.length / 2;
        for (int index = 0; index + 1 < pcm.length; index += 2) {
            int sample = (short) ((pcm[index] & 0xff) | (pcm[index + 1] << 8));
            sum += (long) sample * sample;
        }
        return samples == 0 ? 0 : (int) Math.sqrt((double) sum / samples);
    }
}
