package com.rabi.link.modules.rokid;

import org.junit.Test;
import org.junit.Rule;
import org.junit.rules.TemporaryFolder;
import org.json.JSONObject;
import java.io.File;
import java.nio.file.Files;
import static org.junit.Assert.*;

public class RabiUnifiedAudioCaptureTest {
    @Rule public TemporaryFolder temporary = new TemporaryFolder();
    private RabiDurableAudioSpool open(File root) throws Exception {
        return new RabiDurableAudioSpool(root, new RabiDurableAudioSpool.Policy(4, 5000, 1000000, 0, 0), () -> 1000L, file -> Long.MAX_VALUE);
    }
    @Test public void localOnlyAndUnboundDoNotUploadOrBlockLegacy() throws Exception {
        File root = temporary.newFolder(); RabiDurableAudioSpool spool = open(root);
        spool.append(new byte[]{1,2,3,4}, "phone", "r", "local", "local_only");
        spool.append(new byte[]{1,2,3,4}, "phone", "", "unbound", "transcribe");
        spool.append(new byte[]{5,6,7,8}, "phone", "old");
        assertEquals("old", spool.nextUpload().routeProfileId);
        spool.close(); spool = open(root);
        assertEquals("old", spool.nextUpload().routeProfileId);
        assertEquals("agent", spool.nextUpload().processingPolicy);
    }
    @Test public void queueFreezesContextAtAdmission() {
        RabiBoundedAudioWriteQueue queue = new RabiBoundedAudioWriteQueue(10, 100);
        queue.offer(new byte[]{1,2}, "phone", "a", "one", "local_only");
        queue.offer(new byte[]{3,4}, "glasses", "b", "two", "transcribe");
        RabiBoundedAudioWriteQueue.Entry first = queue.poll();
        assertEquals("one", first.captureId); assertEquals("local_only", first.processingPolicy);
        assertEquals("a", first.route); assertEquals("two", queue.poll().captureId);
    }
    @Test public void capturePolicySurvivesSealingAndAckDoesNotDeleteUserRecord() throws Exception {
        File root = temporary.newFolder(); RabiDurableAudioSpool spool = open(root);
        spool.bindCaptureEndpoint("one", "endpoint"); spool.setEndpointIdentity("endpoint");
        spool.append(new byte[]{1,2}, "phone", "a", "one", "transcribe"); spool.sealCapture();
        spool.close(); spool = open(root); spool.setEndpointIdentity("endpoint");
        RabiDurableAudioSpool.Segment segment = spool.nextUpload();
        assertEquals("one", segment.captureId); assertEquals("transcribe", segment.processingPolicy);
        segment = spool.assignServerSequence(segment, 1);
        assertTrue(spool.acknowledge(segment.id, 1, segment.bytes, segment.sha256));
        assertTrue(segment.pcmFile.exists()); assertNull(spool.nextUpload());
    }
    @Test public void partialRecoveryPreservesLocalOnly() throws Exception {
        File root = temporary.newFolder(); File segments = new File(root, "segments"); assertTrue(segments.mkdir());
        File pcm = new File(segments, "00000000000000000001-0000000001000.pcm.partial");
        Files.write(pcm.toPath(), new byte[]{1,2});
        Files.write(new File(pcm + ".meta").toPath(), new JSONObject().put("sequence",1).put("startedAt",1000)
            .put("source","phone").put("routeProfileId","a").put("captureId","one").put("processingPolicy","local_only").toString().getBytes());
        RabiDurableAudioSpool spool = open(root); assertNull(spool.nextUpload());
        File[] files = segments.listFiles((d,n) -> n.endsWith(".json")); assertEquals(1,files.length);
        JSONObject metadata = new JSONObject(new String(Files.readAllBytes(files[0].toPath())));
        assertEquals("one",metadata.getString("captureId")); assertEquals("local_only",metadata.getString("processingPolicy"));
    }
    @Test public void endpointSwitchNeverRebindsAnExistingRecord() throws Exception {
        RabiDurableAudioSpool spool = open(temporary.newFolder());
        spool.bindCaptureEndpoint("one", "pc-a"); spool.setEndpointIdentity("pc-a");
        spool.append(new byte[]{1,2,3,4}, "phone", "route", "one", "agent");
        assertNotNull(spool.nextUpload());
        spool.setEndpointIdentity("pc-b"); assertNull(spool.nextUpload());
        spool.bindCaptureEndpoint("one", "pc-b"); assertNull(spool.nextUpload());
        spool.setEndpointIdentity("pc-a"); assertNotNull(spool.nextUpload());
    }
    @Test public void staleEndpointResponsesCannotCommitEvenAfterSwitchingBack() {
        assertTrue(RabiGlassPcBackend.sameEndpointGeneration(7, 7));
        assertFalse(RabiGlassPcBackend.sameEndpointGeneration(7, 8));
        assertFalse(RabiGlassPcBackend.sameEndpointGeneration(7, 9));
    }
    @Test public void captureStreamIdentityIsStableAndNeverTruncatesDistinctCaptures() {
        String device = new String(new char[200]).replace('\0', 'd');
        String first = RabiGlassPcBackend.captureStreamId(device, "phone", "route-a", "agent", "capture-a");
        assertEquals(first, RabiGlassPcBackend.captureStreamId(device, "phone", "route-a", "agent", "capture-a"));
        assertTrue(first.length() <= 100);
        assertNotEquals(first, RabiGlassPcBackend.captureStreamId(device, "phone", "route-a", "agent", "capture-b"));
        assertNotEquals(first, RabiGlassPcBackend.captureStreamId(device, "phone", "route-b", "agent", "capture-a"));
        assertNotEquals(first, RabiGlassPcBackend.captureStreamId(device, "phone", "route-a", "transcribe", "capture-a"));
        assertNotEquals(first, RabiGlassPcBackend.captureStreamId(device, "glasses", "route-a", "agent", "capture-a"));
    }
    @Test public void mobileUiSourceMapsToExistingPhoneWireSource() {
        assertEquals("phone", RabiGlassPcBackend.normalizeCaptureSource("mobile"));
        assertEquals("phone", RabiGlassPcBackend.normalizeCaptureSource("phone"));
        assertEquals("glasses", RabiGlassPcBackend.normalizeCaptureSource("glasses"));
        try { RabiGlassPcBackend.normalizeCaptureSource("watch"); fail(); } catch (IllegalArgumentException expected) { }
    }
    @Test public void storageFailureHasExplicitLocalReasonAndPreservesPriorBytes() throws Exception {
        File root = temporary.newFolder();
        RabiDurableAudioSpool spool = new RabiDurableAudioSpool(root,
            new RabiDurableAudioSpool.Policy(4, 5000, 4, 0, 0), () -> 1000L, file -> Long.MAX_VALUE);
        assertTrue(spool.append(new byte[]{1,2,3,4}, "phone", "", "one", "local_only").accepted);
        RabiDurableAudioSpool.AppendResult result = spool.append(new byte[]{5,6}, "phone", "", "one", "local_only");
        assertFalse(result.accepted); assertEquals("storage_low", result.failure);
        assertEquals(4L, spool.health().getLong("totalCapturedBytes"));
        assertEquals(2L, spool.health().getLong("rejectedBytes"));
    }
    @Test public void callbackTimeIsNotReplacedByWriterClock() throws Exception {
        RabiDurableAudioSpool spool = open(temporary.newFolder());
        spool.bindCaptureEndpoint("one", "pc"); spool.setEndpointIdentity("pc");
        spool.append(new byte[]{1,2,3,4}, "phone", "route", "one", "agent", 500L, "received");
        assertEquals(500L, spool.nextUpload().startedAt);
    }
    @Test public void importedPcmIsIdempotentAndIdentityFrozen() throws Exception {
        File root = temporary.newFolder(); File pcm = temporary.newFile(); Files.write(pcm.toPath(),new byte[]{1,2,3,4,5,6});
        RabiDurableAudioSpool spool = open(root);
        assertTrue(spool.importCapture("glasses","route","transcribe","video-one",pcm));
        long bytes = spool.health().getLong("totalCapturedBytes");
        assertTrue(spool.importCapture("glasses","route","transcribe","video-one",pcm));
        assertEquals(bytes,spool.health().getLong("totalCapturedBytes"));
        try { spool.importCapture("glasses","other","agent","video-one",pcm); fail(); } catch (IllegalStateException expected) { }
    }
}
