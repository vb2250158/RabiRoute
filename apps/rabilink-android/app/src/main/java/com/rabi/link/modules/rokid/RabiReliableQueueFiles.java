package com.rabi.link.modules.rokid;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.nio.file.AtomicMoveNotSupportedException;
import java.nio.file.Files;
import java.nio.file.StandardCopyOption;
import java.util.Arrays;
import java.util.Comparator;
import java.util.Locale;
import java.util.UUID;

/** Crash-safe file primitives shared by the phone-owned reliable queues. */
final class RabiReliableQueueFiles {
    private static final String QUARANTINE_DIRECTORY = "quarantine";

    private RabiReliableQueueFiles() { }

    static void writeAtomically(File target, byte[] body) throws Exception {
        File parent = target.getParentFile();
        if (parent == null || (!parent.exists() && !parent.mkdirs())) {
            throw new IllegalStateException("无法创建可靠队列目录");
        }
        File temporary = new File(parent, "." + target.getName() + "." + UUID.randomUUID() + ".tmp");
        try {
            try (FileOutputStream output = new FileOutputStream(temporary)) {
                output.write(body == null ? new byte[0] : body);
                output.getFD().sync();
            }
            moveReplacing(temporary, target);
        } finally {
            if (temporary.exists()) temporary.delete();
        }
    }

    static byte[] read(File source) throws Exception {
        try (InputStream input = new FileInputStream(source);
             ByteArrayOutputStream output = new ByteArrayOutputStream()) {
            byte[] buffer = new byte[8192];
            int count;
            while ((count = input.read(buffer)) >= 0) output.write(buffer, 0, count);
            return output.toByteArray();
        }
    }

    static File[] list(File directory, String suffix) {
        File[] files = directory.listFiles((parent, name) -> name.endsWith(suffix));
        if (files == null) return new File[0];
        Arrays.sort(files, Comparator.comparing(File::getName));
        return files;
    }

    static void cleanupTemporaryFiles(File directory) {
        File[] temporary = directory.listFiles((parent, name) -> name.endsWith(".tmp"));
        if (temporary == null) return;
        for (File file : temporary) file.delete();
    }

    static File quarantine(File queueDirectory, String reason, File... relatedFiles) throws Exception {
        File root = new File(queueDirectory, QUARANTINE_DIRECTORY);
        if (!root.exists() && !root.mkdirs()) throw new IllegalStateException("无法创建可靠队列隔离目录");
        File destination = new File(root, String.format(Locale.US, "%013d-%s",
                System.currentTimeMillis(), UUID.randomUUID()));
        if (!destination.mkdirs()) throw new IllegalStateException("无法创建可靠队列隔离项目");

        int moved = 0;
        for (File source : relatedFiles) {
            if (source == null || !source.exists()) continue;
            moveReplacing(source, new File(destination, source.getName()));
            moved += 1;
        }
        String safeReason = reason == null ? "invalid_queue_item" : reason
                .replaceAll("[\\r\\n]+", " ")
                .replaceAll("https?://\\S+|rbl_[0-9A-Za-z_-]+", "[redacted]");
        writeAtomically(new File(destination, "reason.txt"),
                (safeReason.substring(0, Math.min(240, safeReason.length()))
                        + "\nmoved=" + moved + "\n").getBytes(java.nio.charset.StandardCharsets.UTF_8));
        return destination;
    }

    private static void moveReplacing(File source, File destination) throws Exception {
        try {
            Files.move(source.toPath(), destination.toPath(),
                    StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING);
        } catch (AtomicMoveNotSupportedException error) {
            Files.move(source.toPath(), destination.toPath(), StandardCopyOption.REPLACE_EXISTING);
        }
    }
}
