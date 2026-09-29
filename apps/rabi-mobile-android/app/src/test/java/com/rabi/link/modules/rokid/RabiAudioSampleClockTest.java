package com.rabi.link.modules.rokid;

import com.rabi.link.recording.AudioEventSplitter;
import org.junit.Test;
import java.util.List;
import static org.junit.Assert.*;

public class RabiAudioSampleClockTest {
    private byte[] voice(int bytes) {
        byte[] pcm = new byte[bytes];
        for (int i=0;i<bytes;i+=2) { pcm[i]=(byte)2000; pcm[i+1]=(byte)(2000>>8); }
        return pcm;
    }
    @Test public void wallClockJumpDoesNotMoveUtterance() {
        RabiAudioSampleClock clock = new RabiAudioSampleClock();
        AudioEventSplitter splitter = new AudioEventSplitter(() -> new AudioEventSplitter.Policy(500,60000));
        assertEquals(10000, clock.accept(10000,32000));
        assertTrue(splitter.accept("a",voice(32000)).isEmpty());
        long reference = clock.accept(41000,16000);
        List<AudioEventSplitter.Part> parts = splitter.accept("a",new byte[16000]);
        assertEquals(1,parts.size());
        assertEquals(10000, reference + parts.get(0).offset * 1000L / 32000L);
        assertEquals(11500,clock.endTime());
    }
    @Test public void arbitraryCallbacksUseCumulativeBytesWithoutRoundingDrift() {
        RabiAudioSampleClock clock = new RabiAudioSampleClock();
        long bytes = 0;
        for(int i=0;i<10000;i++) {
            int length=(i%31+1)*2;
            assertEquals(5000+bytes*1000/32000,clock.accept(i==0?5000:999999,length));
            bytes+=length;
        }
        assertEquals(5000+bytes*1000/32000,clock.endTime());
    }
    @Test public void finishUsesSampleEndAndNextOwnerGetsFreshAnchor() {
        RabiAudioSampleClock clock = new RabiAudioSampleClock();
        AudioEventSplitter splitter = new AudioEventSplitter(() -> new AudioEventSplitter.Policy(500,60000));
        clock.accept(7000,16000); splitter.accept("a",voice(16000));
        clock.accept(-10000,17600); splitter.accept("a",voice(17600));
        List<AudioEventSplitter.Part> parts=splitter.finish();
        assertEquals(1,parts.size());
        assertEquals(7000,clock.endTime()+parts.get(0).offset*1000L/32000L);
        clock.reset();
        assertEquals(90000,clock.accept(90000,32000));
        splitter.accept("b",voice(32000));
        parts=splitter.finish();
        assertEquals(90000,clock.endTime()+parts.get(0).offset*1000L/32000L);
    }
    @Test public void shutdownFinishesValidBufferedSpeechBeforeClose() {
        AudioEventSplitter splitter = new AudioEventSplitter(() -> new AudioEventSplitter.Policy(500,60000));
        java.util.List<AudioEventSplitter.Part> saved=new java.util.ArrayList<>();
        RabiGlassPcBackend.closeAudioWriter(
            () -> saved.addAll(splitter.accept("a",voice(32000))),
            () -> saved.addAll(splitter.finish()), () -> {},
            () -> { assertEquals(1,saved.size()); assertTrue(saved.get(0).completed); });
        assertEquals(32000,saved.get(0).pcm.length);
    }
}
