package com.rabi.link.modules.conversation;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.nio.file.Files;
import java.util.UUID;

/** Per-file rolling audio cache with the same 24-hour semantics as RabiSpeech TTS caches. */
public final class RabiBoundedAudioCache {
    public static final long RETENTION_MILLIS = 24L * 60L * 60L * 1000L;

    public static final class Entry {
        public final File file;
        public final String relativePath;
        public final long expiresAt;

        private Entry(File file, String relativePath, long expiresAt) {
            this.file = file;
            this.relativePath = relativePath;
            this.expiresAt = expiresAt;
        }
    }

    private final File ownerRoot;
    private final File cacheRoot;
    private final String logicalPrefix;
    private final String canonicalOwnerRoot;
    private final String canonicalCacheRoot;

    public RabiBoundedAudioCache(File ownerRoot, String relativeDirectory) throws IOException {
        this.ownerRoot = ownerRoot.getCanonicalFile();
        this.cacheRoot = new File(this.ownerRoot, relativeDirectory).getCanonicalFile();
        this.logicalPrefix = relativeDirectory.replace('\\', '/');
        this.ownerRoot.mkdirs();
        this.cacheRoot.mkdirs();
        this.canonicalOwnerRoot = this.ownerRoot.getCanonicalPath();
        this.canonicalCacheRoot = this.cacheRoot.getCanonicalPath();
        validateRoot();
        cleanup();
    }

    public synchronized Entry retainPcm(byte[] pcm, String prefix) throws IOException {
        if (pcm == null || pcm.length == 0) throw new IllegalArgumentException("Audio cache input is empty.");
        return retainWav(wav(pcm), prefix);
    }

    public synchronized Entry retainWav(byte[] wav, String prefix) throws IOException {
        if (wav == null || wav.length < 44) throw new IllegalArgumentException("Audio cache input is not WAV.");
        File root = validateRoot();
        String safePrefix = String.valueOf(prefix == null ? "audio" : prefix).replaceAll("[^a-zA-Z0-9_-]", "_");
        String name = String.format(java.util.Locale.US, "%013d-%s-%s.wav",
                System.currentTimeMillis(), safePrefix, UUID.randomUUID().toString().substring(0, 8));
        File target = ownedChild(root, name);
        File temporary = ownedChild(root, name + ".tmp");
        try (FileOutputStream output = new FileOutputStream(temporary)) {
            output.write(wav);
            output.flush();
            output.getFD().sync();
        }
        if (!temporary.renameTo(target)) {
            target.delete();
            if (!temporary.renameTo(target)) throw new IOException("Unable to finalize cached audio.");
        }
        cleanupLocked(System.currentTimeMillis());
        return new Entry(target, logicalPrefix + "/" + target.getName(), target.lastModified() + RETENTION_MILLIS);
    }

    public synchronized int cleanup() throws IOException {
        return cleanupLocked(System.currentTimeMillis());
    }

    private int cleanupLocked(long now) throws IOException {
        File root = validateRoot();
        File[] files = root.listFiles();
        if (files == null) throw new IOException("Audio cache root cannot be listed.");
        int removed = 0;
        long cutoff = now - RETENTION_MILLIS;
        for (File file : files) {
            validateRoot();
            if (Files.isSymbolicLink(file.toPath()) || !file.isFile()) continue;
            File candidate;
            try { candidate = file.getCanonicalFile(); } catch (IOException ignored) { continue; }
            if (!candidate.getParentFile().equals(root) || candidate.lastModified() > cutoff) continue;
            if (candidate.delete()) removed += 1;
        }
        return removed;
    }

    private File validateRoot() throws IOException {
        if (!ownerRoot.isDirectory() || !cacheRoot.isDirectory()
                || !ownerRoot.getCanonicalPath().equals(canonicalOwnerRoot)
                || !cacheRoot.getCanonicalPath().equals(canonicalCacheRoot)
                || !canonicalCacheRoot.startsWith(canonicalOwnerRoot + File.separator)) {
            throw new IOException("Audio cache root identity changed or escaped its owner.");
        }
        return cacheRoot;
    }

    private File ownedChild(File root, String name) throws IOException {
        File candidate = new File(root, name).getCanonicalFile();
        if (!candidate.getParentFile().equals(root)) throw new IOException("Audio cache path escaped its root.");
        return candidate;
    }

    private static byte[] wav(byte[] pcm) {
        ByteBuffer header = ByteBuffer.allocate(44).order(ByteOrder.LITTLE_ENDIAN);
        header.put(new byte[]{'R','I','F','F'}).putInt(36 + pcm.length).put(new byte[]{'W','A','V','E','f','m','t',' '})
                .putInt(16).putShort((short)1).putShort((short)1).putInt(16000).putInt(32000)
                .putShort((short)2).putShort((short)16).put(new byte[]{'d','a','t','a'}).putInt(pcm.length);
        ByteArrayOutputStream output = new ByteArrayOutputStream(44 + pcm.length);
        output.write(header.array(), 0, 44);
        output.write(pcm, 0, pcm.length);
        return output.toByteArray();
    }
}
