package com.rabi.link.modules.rokid;

import java.io.IOException;
import java.io.OutputStream;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;

/** Streaming linear resampler. Carries fractional position across codec buffers. */
public final class VideoPcmResampler {
    private final int rate;
    private final int channels;
    private final boolean floatingPoint;
    private long inputFrames;
    private long outputFrames;
    private float previous;
    private final byte[] output = new byte[8192];
    private int outputSize;

    public VideoPcmResampler(int sampleRate, int channelCount, boolean floatPcm) {
        if (sampleRate < 8000 || sampleRate > 192000 || channelCount < 1 || channelCount > 8)
            throw new IllegalArgumentException("Unsupported PCM format");
        rate = sampleRate; channels = channelCount; floatingPoint = floatPcm;
    }

    public void accept(ByteBuffer buffer, OutputStream destination) throws IOException {
        buffer.order(ByteOrder.LITTLE_ENDIAN);
        int frameBytes = channels * (floatingPoint ? 4 : 2);
        if (buffer.remaining() % frameBytes != 0) throw new IOException("Unaligned decoded PCM");
        while (buffer.remaining() >= frameBytes) {
            float current = 0;
            for (int c = 0; c < channels; c++) {
                float sample = floatingPoint ? buffer.getFloat() : buffer.getShort() / 32768f;
                if (!Float.isFinite(sample)) sample = 0;
                current += sample / channels;
            }
            if (inputFrames == 0) {
                write(current, destination);
                outputFrames = 1;
            } else {
                // Rational clock avoids accumulation drift in 24h recordings.
                while (outputFrames * (long) rate <= inputFrames * 16000L) {
                    double fraction = (outputFrames * (double) rate / 16000.0) - (inputFrames - 1);
                    write((float) (previous + (current - previous) * fraction), destination);
                    outputFrames++;
                }
            }
            previous = current;
            inputFrames++;
        }
    }

    private void write(float sample, OutputStream destination) throws IOException {
        int value = Math.max(-32768, Math.min(32767, Math.round(sample * 32768f)));
        output[outputSize++] = (byte) value;
        output[outputSize++] = (byte) (value >> 8);
        if (outputSize == output.length) flush(destination);
    }

    public void finish(OutputStream destination) throws IOException {
        // Extend the final sample only when upsampling leaves a fractional tail.
        // Downsampling retains the sample at t=0; duration rounding is at most one output frame.
        long count = inputFrames * 16000L / rate;
        while (outputFrames < count) { write(previous, destination); outputFrames++; }
        flush(destination);
    }

    private void flush(OutputStream destination) throws IOException {
        if (outputSize > 0) { destination.write(output, 0, outputSize); outputSize = 0; }
    }
}
