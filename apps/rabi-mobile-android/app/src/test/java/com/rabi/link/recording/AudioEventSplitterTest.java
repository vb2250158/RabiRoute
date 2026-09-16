package com.rabi.link.recording;

import org.junit.Test;
import java.io.ByteArrayOutputStream;
import java.util.*;
import java.util.concurrent.atomic.AtomicReference;
import static org.junit.Assert.*;

public class AudioEventSplitterTest {
    private byte[] pcm(int ms, int amplitude) {
        byte[] result = new byte[ms * 32];
        for (int i=0;i<result.length;i+=2) { result[i]=(byte)amplitude; result[i+1]=(byte)(amplitude>>8); }
        return result;
    }
    @Test public void pauseClosesEventWithoutDroppingSilenceOrSamples() throws Exception {
        AudioEventSplitter splitter = new AudioEventSplitter(() -> new AudioEventSplitter.Policy(500,60000));
        byte[] voice=pcm(1400,2000), silence=pcm(800,0);
        List<AudioEventSplitter.Part> first=splitter.accept("capture",voice);
        List<AudioEventSplitter.Part> next=splitter.accept("capture",silence);
        assertEquals(first.get(0).eventId,next.get(0).eventId);
        assertTrue(next.get(0).completed);
        assertEquals(16000,next.get(0).pcm.length);
        assertNotEquals(next.get(0).eventId,next.get(1).eventId);
        ByteArrayOutputStream result=new ByteArrayOutputStream();
        for(AudioEventSplitter.Part p:next) result.write(p.pcm);
        assertArrayEquals(silence,result.toByteArray());
    }
    @Test public void continuousVoiceAndSilenceBothHaveBoundedEvents() {
        for(int amplitude:new int[]{0,2000}) {
            AudioEventSplitter splitter=new AudioEventSplitter(() -> new AudioEventSplitter.Policy(500,10000));
            List<AudioEventSplitter.Part> parts=splitter.accept("capture",pcm(25000,amplitude));
            assertEquals(3,parts.size());
            assertEquals(320000,parts.get(0).pcm.length);
            assertEquals(320000,parts.get(1).pcm.length);
            assertEquals(160000,parts.get(2).pcm.length);
        }
    }
    @Test public void settingChangesApplyOnlyAfterBoundary() {
        AtomicReference<AudioEventSplitter.Policy> policy=new AtomicReference<>(new AudioEventSplitter.Policy(500,10000));
        AudioEventSplitter splitter=new AudioEventSplitter(policy::get);
        String id=splitter.accept("a",pcm(5000,0)).get(0).eventId;
        policy.set(new AudioEventSplitter.Policy(1000,20000));
        List<AudioEventSplitter.Part> next=splitter.accept("a",pcm(26000,0));
        assertEquals(id,next.get(0).eventId);
        assertEquals(5000*32,next.get(0).pcm.length);
        assertEquals(20000*32,next.get(1).pcm.length);
        assertNotEquals(next.get(2).eventId,splitter.accept("b",pcm(20,0)).get(0).eventId);
    }
    @Test public void configuredThresholdChangesSoundDetection() {
        for (double threshold : new double[]{0.01,0.1}) {
            AudioEventSplitter splitter = new AudioEventSplitter(() -> new AudioEventSplitter.Policy(500,60000,threshold));
            splitter.accept("capture",pcm(1400,2000));
            assertEquals(threshold < 0.06,splitter.accept("capture",pcm(500,0)).get(0).completed);
        }
    }
    @Test public void callbackSizeDoesNotChangeBoundaries() {
        AudioEventSplitter splitter=new AudioEventSplitter(() -> new AudioEventSplitter.Policy(500,10000));
        int total=0,ended=0;
        for(int i=0;i<16000;i++) for(AudioEventSplitter.Part p:splitter.accept("a",new byte[20])) {
            total+=p.pcm.length;if(p.completed) { ended++;assertEquals(320000,total); }
        }
        assertEquals(1,ended);
    }
}
