package com.rabi.link.recording;

import org.junit.Test;
import static org.junit.Assert.*;

public class RecordingFileChangesTest {
    @Test public void liveAudioAndRuntimeFilesDoNotReloadHistory() {
        RecordingFileChanges changes = new RecordingFileChanges();
        for(int i=0;i<1000;i++) {
            changes.mark("segment.pcm.partial",true);
            changes.mark("state.json",false);
            changes.mark("audit-index.json",false);
        }
        assertEquals(0,changes.revision());
        assertTrue(changes.takeMetadata().isEmpty());
    }
    @Test public void recordUpdatesAreCoalescedAndChangesAfterReadSurvive() {
        RecordingFileChanges changes = new RecordingFileChanges();
        changes.mark("segment.json",true); changes.mark("segment.json",true);
        assertEquals(1,changes.takeMetadata().size());
        changes.mark("segment.json",true); changes.mark("asr-event.json",false);
        assertEquals(1,changes.takeMetadata().size());
        assertEquals(4,changes.revision());
        assertTrue(changes.takeMetadata().isEmpty());
    }
}
