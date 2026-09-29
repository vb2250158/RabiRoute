package com.rabi.link.recording;

import org.json.*;
import org.junit.Test;
import java.math.BigInteger;
import static org.junit.Assert.*;

public class RecordingArchiveContractTest {
    private static final String NS="12345678-1234-4234-8234-123456789abc";
    private static String repeated(char c) { return new String(new char[64]).replace('\0',c); }
    // Same fixed fixture as src/manager/recordingArchiveContract.test.ts.
    static JSONObject fixture() throws Exception {
        return new JSONObject("{\"schemaVersion\":1,\"recordId\":\"record-1\",\"captureId\":\"capture-1\",\"eventId\":\"event-1\",\"deviceId\":\"device-1\",\"source\":\"phone\",\"startedAt\":1000,\"endedAt\":3000,\"timeBasis\":\"received\",\"format\":{\"codec\":\"pcm_s16le\",\"sampleRate\":16000,\"channels\":1},\"segments\":[{\"sequence\":2,\"bytes\":32000,\"sha256\":\""+repeated('a')+"\",\"startedAt\":1000},{\"sequence\":4,\"bytes\":32000,\"sha256\":\""+repeated('b')+"\",\"startedAt\":2000}],\"objects\":[{\"sha256\":\""+repeated('a')+"\",\"bytes\":32000,\"offset\":0},{\"sha256\":\""+repeated('b')+"\",\"bytes\":32000,\"offset\":32000}],\"gaps\":[],\"processingPolicy\":\"transcribe\",\"totalBytes\":64000,\"sealed\":true}");
    }
    private static JSONObject receipt(JSONObject m) throws Exception {
        return new JSONObject().put("schemaVersion",1).put("workerId","worker-1").put("storageNamespaceId",NS)
            .put("recordId","record-1").put("manifestHash",RecordingArchiveContract.recordingManifestHash(m))
            .put("totalBytes",64000).put("segmentCount",2).put("committedAt",4000).put("durability","archived").put("retention","indefinite");
    }
    private static void reject(JSONObject m) { assertThrows(IllegalArgumentException.class,()->RecordingArchiveContract.validateRecordingManifest(m)); }
    @Test public void normalizedDetachedCanonicalFixture() throws Exception {
        JSONObject m=fixture(), valid=RecordingArchiveContract.validateRecordingManifest(m);
        String canonical=RecordingArchiveContract.recordingManifestCanonicalJson(m);
        // Computed by executing the current PC TypeScript contract against its identical fixture.
        assertEquals("c272627f1bec72e289cdd190fdf3534229e8b8a1062d11c28631b7339abc7a7b",RecordingArchiveContract.recordingManifestHash(m));
        assertTrue(canonical.startsWith("{\"captureId\":\"capture-1\",\"deviceId\":\"device-1\",\"endedAt\":3000,"));
        assertEquals(canonical,RecordingArchiveContract.recordingManifestCanonicalJson(new JSONObject(canonical)));
        assertEquals(RecordingArchiveContract.recordingManifestHash(m),RecordingArchiveContract.recordingManifestHash(new JSONObject(canonical)));
        m.getJSONArray("segments").getJSONObject(0).put("bytes",2);
        assertEquals(32000,valid.getJSONArray("segments").getJSONObject(0).getLong("bytes"));
    }
    @Test public void unknownFieldsAndPathsAndUnicodeCodesRejected() throws Exception {
        for(String k:new String[]{"owner","roleId","model","path"})reject(fixture().put(k,"injected"));
        for(String s:new String[]{"../id","a/b","中文",""})reject(fixture().put("recordId",s));
        reject(fixture().put("gaps",new JSONArray().put(new JSONObject().put("startedAt",1000).put("endedAt",1001).put("reason","断开"))));
        reject(fixture().put("format",fixture().getJSONObject("format").put("owner","x")));
    }
    @Test public void unsafeFractionalNegativeZeroAndAlignmentRejected() throws Exception {
        for(Object n:new Object[]{-1,-0.0,1.5,new BigInteger("9007199254740992"),"1000",JSONObject.NULL})reject(fixture().put("startedAt",n));
        for(long n:new long[]{0,3,64002,RecordingArchiveContract.MAX_BYTES+2})reject(fixture().put("totalBytes",n));
        JSONObject m=fixture();m.getJSONArray("segments").getJSONObject(0).put("sequence",9007199254740992L);reject(m);
        reject(fixture().put("endedAt",1001));
    }
    @Test public void orderingOffsetsAndBoundsRejected() throws Exception {
        JSONObject m=fixture();m.getJSONArray("objects").getJSONObject(1).put("offset",0);reject(m);
        m=fixture();m.getJSONArray("objects").getJSONObject(0).put("offset",-1);reject(m);
        m=fixture();m.getJSONArray("objects").getJSONObject(0).put("bytes",1048578);reject(m);
        m=fixture();m.getJSONArray("segments").getJSONObject(1).put("sequence",2);reject(m);
        m=fixture();m.getJSONArray("segments").getJSONObject(0).put("sha256",repeated('A'));reject(m);
        reject(fixture().put("segments",new JSONArray()));
        JSONArray many=new JSONArray();for(int i=0;i<4097;i++)many.put(fixture().getJSONArray("objects").getJSONObject(0));reject(fixture().put("objects",many));
    }
    @Test public void exactMaximumAndSafeSequenceAccepted() throws Exception {
        JSONObject m=fixture();long total=RecordingArchiveContract.MAX_BYTES;
        m.put("totalBytes",total).put("endedAt",1000+total/32);
        JSONArray segments=new JSONArray(),objects=new JSONArray();
        for(int i=0;i<4096;i++)segments.put(new JSONObject().put("sequence",9007199254740991L-4095+i).put("bytes",32768).put("sha256",repeated('a')).put("startedAt",1000L+i*1024));
        for(int i=0;i<128;i++)objects.put(new JSONObject().put("bytes",1048576).put("offset",i*1048576L).put("sha256",repeated('b')));
        m.put("segments",segments).put("objects",objects);
        assertEquals(total,RecordingArchiveContract.validateRecordingManifest(m).getLong("totalBytes"));
        segments.put(segments.getJSONObject(0));reject(m);
    }
    @Test public void strongReceiptMatchesAllDimensions() throws Exception {
        JSONObject m=fixture(), r=receipt(m);
        assertEquals("record-1",RecordingArchiveContract.validateArchiveReceipt(r,"worker-1",NS,m).getString("recordId"));
        for(Object[] change:new Object[][]{{"workerId","other"},{"storageNamespaceId","12345678-1234-4234-8234-123456789abd"},{"recordId","other"},{"manifestHash",repeated('c')},{"totalBytes",32000},{"segmentCount",1},{"durability","durable"},{"retention","24h"},{"model","x"}}) {
            JSONObject bad=receipt(m).put((String)change[0],change[1]);
            assertThrows(IllegalArgumentException.class,()->RecordingArchiveContract.validateArchiveReceipt(bad,"worker-1",NS,m));
        }
        JSONObject weak=new JSONObject().put("durable",true);
        assertThrows(IllegalArgumentException.class,()->RecordingArchiveContract.validateArchiveReceipt(weak,"worker-1",NS,m));
    }
    @Test public void jsonStringEscapingMatchesJavascript() {
        assertEquals("\"中文/\\\"\\\\\\n\\t\\b\\f\\r\\u0001\"",RecordingArchiveContract.quote("中文/\"\\\n\t\b\f\r\u0001"));
        assertEquals("\"😀\"",RecordingArchiveContract.quote("😀"));
        assertEquals("\"\\ud800\"",RecordingArchiveContract.quote("\ud800"));
        assertEquals("\"\\udc00\"",RecordingArchiveContract.quote("\udc00"));
    }
}
