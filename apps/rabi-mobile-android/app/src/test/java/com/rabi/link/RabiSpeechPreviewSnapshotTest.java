package com.rabi.link;

import org.junit.Test;

import java.util.Arrays;
import java.util.Collections;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

public final class RabiSpeechPreviewSnapshotTest {
    @Test public void reportsSuccessfulRecordsWithoutConfusingPcmChunksWithUtterances() {
        RabiSpeechPreviewSnapshot snapshot = new RabiSpeechPreviewSnapshot(
                "rabi-phone-one", 1000,
                new RabiSpeechPreviewSnapshot.Stream(true, true, true, 65536, 42, 999),
                new RabiSpeechPreviewSnapshot.RuntimeStats(true, 7, 5, 1, 1),
                Arrays.asList(
                        new RabiSpeechPreviewSnapshot.Record("a", 900, "第一条", "faster-whisper", "small", 1.2, true, 2000),
                        new RabiSpeechPreviewSnapshot.Record("b", 950, "第二条", "faster-whisper", "small", 2.1, false, 0)
                )
        );
        assertEquals(42, snapshot.stream.acceptedChunks);
        assertEquals(7, snapshot.runtimeStats.captured);
        assertEquals(5, snapshot.runtimeStats.recognized);
        assertEquals(2, snapshot.successfulCount());
        assertEquals("2", snapshot.successfulCountLabel());
        assertFalse(snapshot.recordCountTruncated);
    }

    @Test public void marksRuntimeCountersUnavailableWhenAnotherInputIsSelected() {
        RabiSpeechPreviewSnapshot snapshot = new RabiSpeechPreviewSnapshot(
                "rabi-phone-one", 1000,
                new RabiSpeechPreviewSnapshot.Stream(true, true, false, 1024, 2, 999),
                new RabiSpeechPreviewSnapshot.RuntimeStats(false, 50, 40, 5, 5),
                Collections.emptyList()
        );
        assertFalse(snapshot.runtimeStats.attributableToDevice);
        assertTrue(snapshot.successfulRecords.isEmpty());
    }
}
