package com.rabi.link.recording;

import org.junit.Test;
import static org.junit.Assert.*;

public class AutomaticAudioSourceTest {
    @Test public void connectionWithoutPcmKeepsPhoneAndStallFallsBack() {
        AutomaticAudioSource source = new AutomaticAudioSource();
        assertEquals("mobile", source.preferred(100));
        source.receivedGlassesPcm(100);
        assertEquals("glasses", source.preferred(5099));
        assertEquals("mobile", source.preferred(5100));
        source.receivedGlassesPcm(5200);
        assertEquals("glasses", source.preferred(5200));
        source.disconnected();
        assertEquals("mobile", source.preferred(5201));
    }
    @Test public void oldManualSourceCannotDisableAutomaticSelection() {
        for (String old : new String[]{"mobile", "glasses", "auto", "invalid"}) {
            AllDayRecordingSettings value = new AllDayRecordingSettings(false,"audio",old,"local_only","",false,false,false,0);
            assertEquals("auto",value.source);
            assertFalse(value.running);
        }
    }
}
