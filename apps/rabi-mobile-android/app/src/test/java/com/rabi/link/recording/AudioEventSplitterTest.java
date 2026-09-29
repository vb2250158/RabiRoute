package com.rabi.link.recording;

import org.junit.Test;
import java.io.ByteArrayOutputStream;
import java.util.*;
import java.util.concurrent.atomic.AtomicReference;
import static org.junit.Assert.*;

public class AudioEventSplitterTest {
    private byte[] pcm(int ms, int amplitude) {
        byte[] result = new byte[ms * 32];
        for (int i = 0; i < result.length; i += 2) { result[i] = (byte)amplitude; result[i+1] = (byte)(amplitude >> 8); }
        return result;
    }
    private byte[] join(byte[]... arrays) {
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        for (byte[] bytes : arrays) out.write(bytes, 0, bytes.length);
        return out.toByteArray();
    }
    private AudioEventSplitter splitter() { return new AudioEventSplitter(() -> new AudioEventSplitter.Policy(500, 60000)); }
    @Test public void silenceAndShortNoiseNeverEscapeMemory() {
        AudioEventSplitter s = splitter();
        for (int i = 0; i < 20; i++) assertTrue(s.accept("a", pcm(60000, 0)).isEmpty());
        assertTrue(s.accept("a", join(pcm(900, 2000), pcm(500, 0))).isEmpty());
        assertTrue(s.finish().isEmpty());
    }
    @Test public void preRollIsBoundedAndOffsetReferencesCurrentInput() {
        AudioEventSplitter s = splitter();
        assertTrue(s.accept("a", pcm(5000, 0)).isEmpty());
        assertTrue(s.accept("a", pcm(1000, 2000)).isEmpty());
        List<AudioEventSplitter.Part> parts = s.accept("a", pcm(500, 0));
        assertEquals(1, parts.size());
        AudioEventSplitter.Part p = parts.get(0);
        // PC pre-roll includes the 100ms triggering frame: 1400ms of preceding silence.
        assertEquals(-2400 * 32, p.offset);
        assertArrayEquals(join(pcm(1400, 0), pcm(1000, 2000), pcm(500, 0)), p.pcm);
        assertTrue(p.completed);
    }
    @Test public void shortMidSentencePauseDoesNotSplit() {
        AudioEventSplitter s = splitter();
        byte[] input = join(pcm(1000, 2000), pcm(400, 0), pcm(1000, 2000), pcm(500, 0));
        List<AudioEventSplitter.Part> parts = s.accept("a", input);
        assertEquals(1, parts.size()); assertArrayEquals(input, parts.get(0).pcm);
    }
    @Test public void callbackPartitionDoesNotChangeAudioOrAbsoluteOffsets() {
        byte[] input = join(pcm(2200, 0), pcm(1300, 2000), pcm(500, 0), pcm(900, 0), pcm(1250, 2100));
        AudioEventSplitter reference = splitter();
        List<AudioEventSplitter.Part> expected = new ArrayList<>(reference.accept("a", input));
        List<AudioEventSplitter.Part> tail = reference.finish();
        List<Long> starts = new ArrayList<>();
        for (AudioEventSplitter.Part p : expected) starts.add((long)p.offset);
        for (AudioEventSplitter.Part p : tail) { starts.add(input.length + (long)p.offset); expected.add(p); }
        for (int size : new int[]{2, 74, 640, 4094, 32000}) {
            AudioEventSplitter s = splitter(); List<byte[]> audio = new ArrayList<>(); List<Long> actual = new ArrayList<>();
            for (int offset = 0; offset < input.length; offset += size) {
                for (AudioEventSplitter.Part p : s.accept("a", Arrays.copyOfRange(input, offset, Math.min(input.length, offset + size)))) {
                    audio.add(p.pcm); actual.add(offset + (long)p.offset);
                }
            }
            for (AudioEventSplitter.Part p : s.finish()) { audio.add(p.pcm); actual.add(input.length + (long)p.offset); }
            assertEquals(starts, actual); assertEquals(expected.size(), audio.size());
            for (int i = 0; i < audio.size(); i++) assertArrayEquals(expected.get(i).pcm, audio.get(i));
        }
    }
    @Test public void maximumIncludesPreRollAndContinuousSpeechRemainsBounded() {
        AudioEventSplitter s = new AudioEventSplitter(() -> new AudioEventSplitter.Policy(500, 3000));
        s.accept("a", pcm(2000, 0));
        List<AudioEventSplitter.Part> parts = s.accept("a", pcm(7000, 2000));
        assertEquals(2, parts.size());
        assertEquals(3000 * 32, parts.get(0).pcm.length); assertEquals(-1400 * 32, parts.get(0).offset);
        assertEquals(3000 * 32, parts.get(1).pcm.length);
        assertEquals(2400 * 32, s.finish().get(0).pcm.length);
    }
    @Test public void nonFrameAlignedMaximumPreservesEverySpeechSample() {
        AudioEventSplitter s = new AudioEventSplitter(() -> new AudioEventSplitter.Policy(500, 3050));
        byte[] input = pcm(7200, 2000);
        List<AudioEventSplitter.Part> parts = new ArrayList<>(s.accept("a", input));
        assertEquals(2, parts.size());
        assertEquals(3050 * 32, parts.get(0).pcm.length);
        assertEquals(3050 * 32, parts.get(1).pcm.length);
        parts.addAll(s.finish());
        ByteArrayOutputStream output = new ByteArrayOutputStream();
        for (AudioEventSplitter.Part part : parts) output.write(part.pcm, 0, part.pcm.length);
        assertArrayEquals(input, output.toByteArray());
    }
    @Test public void ownerChangeDropsOldUnfinishedAudioAndPreRoll() {
        AudioEventSplitter s = splitter(); s.accept("a", pcm(1500, 2000));
        assertTrue(s.accept("b", pcm(500, 0)).isEmpty());
        assertTrue(s.finish().isEmpty());
        s.accept("a", pcm(1000, 2000));
        assertEquals(1, s.finish().size());
        List<AudioEventSplitter.Part> b = s.accept("b", join(pcm(1000, 2200), pcm(500, 0)));
        assertEquals(0, b.get(0).offset); assertArrayEquals(join(pcm(1000, 2200), pcm(500, 0)), b.get(0).pcm);
    }
    @Test public void finishIncludesPartialFrameEnforcesMinimumAndClearsEverything() {
        AudioEventSplitter s = splitter(); byte[] audio = pcm(1050, 2000);
        s.accept("a", audio); AudioEventSplitter.Part p = s.finish().get(0);
        assertArrayEquals(audio, p.pcm); assertEquals(-audio.length, p.offset);
        assertTrue(s.finish().isEmpty());
        s.accept("a", pcm(950, 2000)); assertTrue(s.finish().isEmpty());
        s.accept("a", pcm(1000, 2000)); assertEquals(1000 * 32, s.finish().get(0).pcm.length);
    }
    @Test public void dualThresholdRejectsLowPeakEvenWithEnoughVoicedTime() {
        AudioEventSplitter.Policy p = new AudioEventSplitter.Policy(500, 60000, 1500, 1000, .01, .015, false, 2.5, .004, 1);
        AudioEventSplitter s = new AudioEventSplitter(() -> p);
        assertTrue(s.accept("a", pcm(2000, 400)).isEmpty()); assertTrue(s.finish().isEmpty());
        s = new AudioEventSplitter(() -> p);
        // Lower-energy speech counts toward voiced time but not toward clearing the silence timer.
        assertEquals(1, s.accept("a", join(pcm(600, 1000), pcm(500, 400))).size());
    }
    @Test public void gainAffectsDetectionAndRetainedSamples() {
        AudioEventSplitter s = new AudioEventSplitter(() -> new AudioEventSplitter.Policy(500, 60000, 0, 1000, .01, .015, false, 2.5, .004, 2));
        AudioEventSplitter.Part p = s.accept("a", join(pcm(1000, 300), pcm(500, 0))).get(0);
        assertArrayEquals(join(pcm(1000, 600), pcm(500, 0)), p.pcm);
    }
    @Test public void adaptiveFloorCanRejectSoundThatFixedThresholdAccepts() {
        for (boolean adaptive : new boolean[]{true, false}) {
            AudioEventSplitter s = new AudioEventSplitter(() -> new AudioEventSplitter.Policy(500, 60000, 0, 1000, .01, .015, adaptive, 2.5, .004, 1));
            s.accept("a", pcm(10000, 300));
            List<AudioEventSplitter.Part> result = s.accept("a", join(pcm(1200, 600), pcm(500, 0)));
            assertEquals(adaptive ? 0 : 1, result.size());
        }
    }
    @Test public void pcWholeFramePreRollAndThresholdClampFixtures() {
        // microphone.py _append_pre_roll drops whole oldest chunks; the trigger is already appended.
        for (int preMs : new int[]{0, 50, 1550}) {
            AudioEventSplitter.Policy policy = new AudioEventSplitter.Policy(500, 60000, preMs, 1000, .01, .005, false, 2.5, .004, 1);
            assertEquals(.01, policy.transcribeThreshold, 0);
            assertEquals(.01, policy.signalThreshold, 0);
            AudioEventSplitter s = new AudioEventSplitter(() -> policy);
            s.accept("a", pcm(2000, 0));
            AudioEventSplitter.Part p = s.accept("a", join(pcm(1000, 2000), pcm(500, 0))).get(0);
            int preceding = preMs == 1550 ? 1400 : 0;
            assertEquals(-preceding * 32, p.offset);
            assertArrayEquals(join(pcm(preceding, 0), pcm(1000, 2000), pcm(500, 0)), p.pcm);
        }
    }
    private AudioEventSplitter.Policy acoustic(double record, double transcribe, double gain, boolean adaptive) {
        return new AudioEventSplitter.Policy(500, 60000, 1500, 1000, record, transcribe, adaptive, 2.5, .004, gain);
    }
    @Test public void idleThresholdChangeTakesEffectWithoutPauseAndDiscardsOldPreRoll() {
        AtomicReference<AudioEventSplitter.Policy> p = new AtomicReference<>(acoustic(.1, .1, 1, false));
        AudioEventSplitter s = new AudioEventSplitter(p::get);
        assertTrue(s.accept("a", pcm(2000, 1000)).isEmpty());
        p.set(acoustic(.01, .015, 1, false));
        AudioEventSplitter.Part result = s.accept("a", join(pcm(1000, 1000), pcm(500, 0))).get(0);
        assertEquals(0, result.offset);
        assertArrayEquals(join(pcm(1000, 1000), pcm(500, 0)), result.pcm);
    }
    @Test public void idleGainChangeDoesNotMixOldGainPreRoll() {
        AtomicReference<AudioEventSplitter.Policy> p = new AtomicReference<>(acoustic(.01, .015, 1, false));
        AudioEventSplitter s = new AudioEventSplitter(p::get);
        assertTrue(s.accept("a", pcm(2000, 300)).isEmpty());
        p.set(acoustic(.01, .015, 2, false));
        AudioEventSplitter.Part result = s.accept("a", join(pcm(1000, 300), pcm(500, 0))).get(0);
        assertEquals(0, result.offset);
        assertArrayEquals(join(pcm(1000, 600), pcm(500, 0)), result.pcm);
    }
    @Test public void equalNewSnapshotsPreservePreRollAndLearnedNoise() {
        AudioEventSplitter s = new AudioEventSplitter(() -> acoustic(.01, .015, 1, false));
        s.accept("a", pcm(2000, 0));
        AudioEventSplitter.Part result = s.accept("a", join(pcm(1000, 2000), pcm(500, 0))).get(0);
        assertEquals(-1400 * 32, result.offset);
        assertArrayEquals(join(pcm(1400, 0), pcm(1000, 2000), pcm(500, 0)), result.pcm);
        // With learned background the 600-amplitude sound remains below the adaptive trigger.
        s = new AudioEventSplitter(() -> acoustic(.01, .015, 1, true));
        s.accept("a", pcm(10000, 300));
        assertTrue(s.accept("a", join(pcm(1200, 600), pcm(500, 0))).isEmpty());
        assertTrue(s.finish().isEmpty());
    }
    @Test public void settingsAreReadOnlyOncePerIdleFrameAndNeverForActiveSpeech() {
        java.util.concurrent.atomic.AtomicInteger reads = new java.util.concurrent.atomic.AtomicInteger();
        AudioEventSplitter s = new AudioEventSplitter(() -> { reads.incrementAndGet(); return acoustic(.01, .015, 1, false); });
        for (int i = 0; i < 1600; i++) s.accept("a", new byte[2]);
        assertEquals(1, reads.get());
        s.accept("a", pcm(1000, 2000));
        assertEquals(2, reads.get());
        s.accept("a", pcm(500, 0));
        assertEquals(2, reads.get());
        s.accept("a", pcm(100, 0));
        assertEquals(3, reads.get());
    }
    @Test public void activeGainAndThresholdRemainFrozenUntilNextFrameAfterSeal() {
        AtomicReference<AudioEventSplitter.Policy> p = new AtomicReference<>(acoustic(.01, .015, 1, false));
        AudioEventSplitter s = new AudioEventSplitter(p::get);
        s.accept("a", pcm(500, 2000));
        p.set(acoustic(.1, .1, 2, false));
        AudioEventSplitter.Part result = s.accept("a", join(pcm(500, 2000), pcm(500, 0))).get(0);
        assertArrayEquals(join(pcm(1000, 2000), pcm(500, 0)), result.pcm);
        assertTrue(s.accept("a", join(pcm(1200, 1000), pcm(500, 0))).isEmpty());
        assertTrue(s.finish().isEmpty());
    }
    @Test public void policyChangesWaitForUtteranceBoundary() {
        AtomicReference<AudioEventSplitter.Policy> policy = new AtomicReference<>(new AudioEventSplitter.Policy(500, 60000));
        AudioEventSplitter s = new AudioEventSplitter(policy::get); s.accept("a", pcm(1000, 2000));
        policy.set(new AudioEventSplitter.Policy(1000, 60000));
        assertEquals(1, s.accept("a", pcm(500, 0)).size());
        s.accept("a", pcm(1000, 2000)); assertTrue(s.accept("a", pcm(500, 0)).isEmpty());
        assertEquals(1, s.accept("a", pcm(500, 0)).size());
    }
}
