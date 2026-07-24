package com.rabi.link.modules.rokid;

import java.util.Arrays;
import java.util.UUID;
import java.util.function.Supplier;

/**
 * In-memory PCM upload state. It retains one acknowledgement-sensitive chunk and a bounded
 * newest-audio buffer; it never owns ASR segmentation or durable recordings.
 */
final class RabiPcmUploadBuffer {
    static final int DEFAULT_CHUNK_BYTES = 16_000;
    static final int DEFAULT_MAX_BUFFERED_BYTES = 32_000;

    static final class PendingChunk {
        final String id;
        final byte[] pcm;

        PendingChunk(String id, byte[] pcm) {
            this.id = id;
            this.pcm = pcm;
        }
    }

    private final int chunkBytes;
    private final int maxBufferedBytes;
    private final Supplier<String> idSupplier;
    private byte[] buffered = new byte[0];
    private PendingChunk pending;

    RabiPcmUploadBuffer() {
        this(DEFAULT_CHUNK_BYTES, DEFAULT_MAX_BUFFERED_BYTES, () -> UUID.randomUUID().toString());
    }

    RabiPcmUploadBuffer(int chunkBytes, int maxBufferedBytes, Supplier<String> idSupplier) {
        if (chunkBytes <= 0 || maxBufferedBytes < chunkBytes) {
            throw new IllegalArgumentException("PCM buffer limits are invalid");
        }
        this.chunkBytes = chunkBytes;
        this.maxBufferedBytes = maxBufferedBytes;
        this.idSupplier = idSupplier;
    }

    int append(byte[] pcm) {
        if (pcm == null || pcm.length == 0) return 0;
        int combinedLength = buffered.length + pcm.length;
        byte[] combined = new byte[combinedLength];
        System.arraycopy(buffered, 0, combined, 0, buffered.length);
        System.arraycopy(pcm, 0, combined, buffered.length, pcm.length);
        int dropped = Math.max(0, combinedLength - maxBufferedBytes);
        buffered = dropped == 0 ? combined : Arrays.copyOfRange(combined, dropped, combined.length);
        return dropped;
    }

    boolean ready() {
        return pending != null || buffered.length >= chunkBytes;
    }

    boolean hasData() {
        return pending != null || buffered.length > 0;
    }

    boolean hasPending() {
        return pending != null;
    }

    int bufferedBytes() {
        return buffered.length;
    }

    PendingChunk preparePending() {
        if (pending != null) return pending;
        if (buffered.length == 0) return null;
        String id = idSupplier.get();
        if (id == null || id.trim().isEmpty()) throw new IllegalStateException("PCM chunk id is empty");
        pending = new PendingChunk(id.trim(), buffered);
        buffered = new byte[0];
        return pending;
    }

    void acknowledgePending() {
        pending = null;
    }

    void clear() {
        pending = null;
        buffered = new byte[0];
    }
}
