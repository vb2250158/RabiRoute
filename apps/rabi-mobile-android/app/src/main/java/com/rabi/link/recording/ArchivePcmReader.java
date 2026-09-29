package com.rabi.link.recording;

import org.json.JSONArray;
import org.json.JSONObject;
import java.io.Closeable;
import java.io.IOException;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.LinkedHashMap;
import java.util.Objects;

/** Seekable virtual WAV over immutable archive PCM objects. No storage or transport ownership.
 * The caller supplies an ObjectSource bound to a frozen owner/worker/namespace and owns its lifecycle.
 * This reader verifies every fetched object and retains at most two objects (2 MiB).
 */
public final class ArchivePcmReader implements Closeable {
    @FunctionalInterface public interface ObjectSource {
        byte[] read(String sha256, int expectedBytes) throws IOException;
    }
    private final ObjectSource source;
    private final String[] hashes;
    private final int[] sizes;
    private final long[] offsets;
    private final byte[] header;
    private final long length;
    private final LinkedHashMap<Integer, byte[]> cache = new LinkedHashMap<>(3, 0.75f, true);
    private boolean closed;

    public ArchivePcmReader(JSONObject manifest, ObjectSource source) {
        JSONObject valid = RecordingArchiveContract.validateRecordingManifest(manifest);
        this.source = Objects.requireNonNull(source, "source");
        try {
            JSONArray objects = valid.getJSONArray("objects");
            hashes = new String[objects.length()]; sizes = new int[objects.length()]; offsets = new long[objects.length()];
            for (int i = 0; i < objects.length(); i++) {
                JSONObject object = objects.getJSONObject(i);
                hashes[i] = object.getString("sha256"); sizes[i] = object.getInt("bytes"); offsets[i] = object.getLong("offset");
            }
            long pcmBytes = valid.getLong("totalBytes");
            length = 44 + pcmBytes;
            ByteBuffer b = ByteBuffer.allocate(44).order(ByteOrder.LITTLE_ENDIAN);
            b.put("RIFF".getBytes(StandardCharsets.US_ASCII)).putInt((int)pcmBytes + 36);
            b.put("WAVEfmt ".getBytes(StandardCharsets.US_ASCII)).putInt(16).putShort((short)1).putShort((short)1);
            b.putInt(16000).putInt(32000).putShort((short)2).putShort((short)16);
            b.put("data".getBytes(StandardCharsets.US_ASCII)).putInt((int)pcmBytes);
            header = b.array();
        } catch (org.json.JSONException e) { throw new IllegalArgumentException("Invalid archive manifest", e); }
    }
    public long length() { return length; }

    /** Returns bytes read, -1 at/beyond EOF, or 0 for a zero-length request.
     * Invalid offsets throw; a failed verification throws IOException (never returns unverified bytes).
     * As with InputStream, the destination may contain an earlier verified prefix if a later block fails.
     */
    public synchronized int readAt(long position, byte[] target, int off, int len) throws IOException {
        if (closed) throw new IOException("Archive reader is closed");
        Objects.requireNonNull(target, "target");
        if (position < 0) throw new IllegalArgumentException("Negative position");
        if (off < 0 || len < 0 || off > target.length || len > target.length - off) throw new IndexOutOfBoundsException();
        if (len == 0) return 0;
        if (position >= length) return -1;
        int wanted = (int)Math.min((long)len, length - position), copied = 0;
        if (position < 44) {
            int n = Math.min(wanted, 44 - (int)position);
            System.arraycopy(header, (int)position, target, off, n);
            copied += n; position += n;
        }
        while (copied < wanted) {
            long pcmPosition = position - 44;
            int index = find(pcmPosition);
            byte[] bytes = object(index);
            int within = (int)(pcmPosition - offsets[index]);
            int n = Math.min(wanted - copied, sizes[index] - within);
            System.arraycopy(bytes, within, target, off + copied, n);
            position += n; copied += n;
        }
        return copied;
    }
    private int find(long position) {
        int lo = 0, hi = offsets.length - 1;
        while (lo <= hi) {
            int mid = (lo + hi) >>> 1;
            if (offsets[mid] > position) hi = mid - 1;
            else if (position >= offsets[mid] + sizes[mid]) lo = mid + 1;
            else return mid;
        }
        throw new IllegalStateException("PCM position outside manifest");
    }
    private byte[] object(int index) throws IOException {
        byte[] found = cache.get(index);
        if (found != null) return found;
        // Evict before allocation so the retained cache never exceeds its two-object budget.
        if (cache.size() == 2) { Integer eldest = cache.keySet().iterator().next(); cache.remove(eldest); }
        byte[] supplied = source.read(hashes[index], sizes[index]);
        if (supplied == null || supplied.length != sizes[index]) throw new IOException("Archive object length mismatch");
        byte[] bytes = supplied.clone(); // A transport-owned mutable array must not mutate verified cached data.
        try {
            byte[] digest = MessageDigest.getInstance("SHA-256").digest(bytes);
            StringBuilder hex = new StringBuilder(64);
            for (byte b : digest) { hex.append(Character.forDigit((b >>> 4) & 15, 16)); hex.append(Character.forDigit(b & 15, 16)); }
            if (!hashes[index].equals(hex.toString())) throw new IOException("Archive object checksum mismatch");
        } catch (NoSuchAlgorithmException e) { throw new IOException("SHA-256 unavailable", e); }
        cache.put(index, bytes);
        return bytes;
    }
    /** Drops reader-owned memory; does not close a shared caller-owned source. */
    @Override public synchronized void close() { closed = true; cache.clear(); }
}
