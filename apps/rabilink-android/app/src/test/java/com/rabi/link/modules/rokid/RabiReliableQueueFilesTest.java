package com.rabi.link.modules.rokid;

import org.junit.Test;

import java.io.File;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;

import static org.junit.Assert.assertArrayEquals;
import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

public final class RabiReliableQueueFilesTest {
    @Test
    public void atomicWriteReplacesTargetWithoutLeavingTemporaryFiles() throws Exception {
        File directory = Files.createTempDirectory("rabi-reliable-queue-write-").toFile();
        File target = new File(directory, "item.json");

        RabiReliableQueueFiles.writeAtomically(target, "old".getBytes(StandardCharsets.UTF_8));
        RabiReliableQueueFiles.writeAtomically(target, "new".getBytes(StandardCharsets.UTF_8));

        assertArrayEquals("new".getBytes(StandardCharsets.UTF_8), RabiReliableQueueFiles.read(target));
        File[] temporary = directory.listFiles((parent, name) -> name.endsWith(".tmp"));
        assertEquals(0, temporary == null ? 0 : temporary.length);
    }

    @Test
    public void quarantineRemovesPoisonItemFromPendingRootAndKeepsEvidence() throws Exception {
        File directory = Files.createTempDirectory("rabi-reliable-queue-quarantine-").toFile();
        File metadata = new File(directory, "0001.json");
        File binary = new File(directory, "0001.bin");
        RabiReliableQueueFiles.writeAtomically(metadata, "{".getBytes(StandardCharsets.UTF_8));
        RabiReliableQueueFiles.writeAtomically(binary, new byte[]{1, 2, 3});

        File evidence = RabiReliableQueueFiles.quarantine(directory, "invalid json", metadata, binary);

        assertFalse(metadata.exists());
        assertFalse(binary.exists());
        assertEquals(0, RabiReliableQueueFiles.list(directory, ".json").length);
        assertTrue(new File(evidence, "0001.json").isFile());
        assertTrue(new File(evidence, "0001.bin").isFile());
        assertTrue(new File(evidence, "reason.txt").isFile());
    }

    @Test
    public void startupCleanupRemovesOnlyIncompleteTemporaryFiles() throws Exception {
        File directory = Files.createTempDirectory("rabi-reliable-queue-cleanup-").toFile();
        File committed = new File(directory, "item.json");
        File temporary = new File(directory, ".item.json.dead.tmp");
        Files.write(committed.toPath(), "ok".getBytes(StandardCharsets.UTF_8));
        Files.write(temporary.toPath(), "partial".getBytes(StandardCharsets.UTF_8));

        RabiReliableQueueFiles.cleanupTemporaryFiles(directory);

        assertTrue(committed.isFile());
        assertFalse(temporary.exists());
    }
}
