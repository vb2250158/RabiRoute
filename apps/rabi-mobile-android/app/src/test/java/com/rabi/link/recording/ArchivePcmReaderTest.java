package com.rabi.link.recording;

import org.json.*;
import org.junit.Test;
import java.io.IOException;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.security.MessageDigest;
import java.util.*;
import static org.junit.Assert.*;

public class ArchivePcmReaderTest {
    static String hash(byte[] b) throws Exception { StringBuilder s=new StringBuilder(); for(byte v:MessageDigest.getInstance("SHA-256").digest(b))s.append(String.format(Locale.ROOT,"%02x",v&255));return s.toString(); }
    static class Fixture {
        final byte[][] data; final JSONObject manifest; final List<String> calls=new ArrayList<>();
        Fixture(int size) throws Exception {
            data=new byte[3][size]; JSONArray objects=new JSONArray(),segments=new JSONArray();
            for(int i=0;i<3;i++) { Arrays.fill(data[i],(byte)(i+1)); String h=hash(data[i]); objects.put(new JSONObject().put("sha256",h).put("bytes",size).put("offset",(long)i*size)); segments.put(new JSONObject().put("sequence",i).put("bytes",size).put("sha256",h).put("startedAt",1000+(long)i*size/32)); }
            manifest=new JSONObject().put("schemaVersion",1).put("recordId","record").put("captureId","capture").put("eventId","event").put("deviceId","device").put("source","phone").put("startedAt",1000).put("endedAt",1000+(long)size*3/32+1).put("timeBasis","received").put("format",new JSONObject().put("codec","pcm_s16le").put("sampleRate",16000).put("channels",1)).put("segments",segments).put("objects",objects).put("gaps",new JSONArray()).put("processingPolicy","transcribe").put("totalBytes",size*3).put("sealed",true);
        }
        byte[] read(String h,int n) throws IOException { calls.add(h);try { for(byte[] b:data)if(hash(b).equals(h))return b; }catch(Exception e){throw new IOException(e);}throw new IOException("missing"); }
        ArchivePcmReader reader(){return new ArchivePcmReader(manifest,this::read);}
    }
    @Test public void headerEofAndBounds() throws Exception {
        Fixture f=new Fixture(320);ArchivePcmReader r=f.reader();byte[] b=new byte[44];
        assertEquals(1004,r.length());assertEquals(44,r.readAt(0,b,0,44));assertEquals(0,f.calls.size());
        ByteBuffer h=ByteBuffer.wrap(b).order(ByteOrder.LITTLE_ENDIAN);assertEquals("RIFF",new String(b,0,4,"US-ASCII"));assertEquals(996,h.getInt(4));assertEquals("WAVEfmt ",new String(b,8,8,"US-ASCII"));assertEquals(16,h.getInt(16));assertEquals(1,h.getShort(20));assertEquals(1,h.getShort(22));assertEquals(16000,h.getInt(24));assertEquals(32000,h.getInt(28));assertEquals(2,h.getShort(32));assertEquals(16,h.getShort(34));assertEquals("data",new String(b,36,4,"US-ASCII"));assertEquals(960,h.getInt(40));
        assertEquals(-1,r.readAt(r.length(),b,0,1));assertEquals(-1,r.readAt(Long.MAX_VALUE,b,0,1));assertEquals(0,r.readAt(r.length(),b,0,0));assertEquals(1,r.readAt(r.length()-1,b,0,44));
        assertThrows(IllegalArgumentException.class,()->r.readAt(-1,b,0,1));assertThrows(IndexOutOfBoundsException.class,()->r.readAt(0,b,-1,1));assertThrows(IndexOutOfBoundsException.class,()->r.readAt(0,b,1,Integer.MAX_VALUE));assertThrows(IndexOutOfBoundsException.class,()->r.readAt(0,b,45,0));
    }
    @Test public void seekOnlyHitAndCrossBoundary() throws Exception {
        Fixture f=new Fixture(320);ArchivePcmReader r=f.reader();byte[] b=new byte[8];
        assertEquals(8,r.readAt(44+640,b,0,8));assertEquals(Collections.singletonList(hash(f.data[2])),f.calls);assertArrayEquals(new byte[]{3,3,3,3,3,3,3,3},b);
        assertEquals(8,r.readAt(44+316,b,0,8));assertArrayEquals(new byte[]{1,1,1,1,2,2,2,2},b);
        assertEquals(8,r.readAt(40,b,0,8));assertEquals(1,b[4]);assertEquals(1,b[7]);
    }
    @Test public void badDataNeverCachedAndClose() throws Exception {
        Fixture f=new Fixture(320);byte[] b=new byte[4];
        ArchivePcmReader bad=new ArchivePcmReader(f.manifest,(h,n)->new byte[n]);assertThrows(IOException.class,()->bad.readAt(44,b,0,4));
        ArchivePcmReader shortData=new ArchivePcmReader(f.manifest,(h,n)->new byte[n-1]);assertThrows(IOException.class,()->shortData.readAt(44,b,0,4));
        ArchivePcmReader nullData=new ArchivePcmReader(f.manifest,(h,n)->null);assertThrows(IOException.class,()->nullData.readAt(44,b,0,4));
        ArchivePcmReader r=f.reader();r.close();r.close();assertThrows(IOException.class,()->r.readAt(0,b,0,0));
    }
    @Test public void twoMegabyteLruAndDetachedManifestAndBuffers() throws Exception {
        Fixture f=new Fixture(1024*1024);ArchivePcmReader r=f.reader();byte[] b=new byte[1];
        f.manifest.getJSONArray("objects").getJSONObject(0).put("offset",100);
        r.readAt(44,b,0,1);r.readAt(44+1024*1024,b,0,1);r.readAt(44,b,0,1);assertEquals(2,f.calls.size());
        r.readAt(44+2*1024*1024,b,0,1);r.readAt(44+1024*1024,b,0,1);assertEquals(4,f.calls.size());
        Fixture small=new Fixture(320);ArchivePcmReader safe=small.reader();safe.readAt(44,b,0,1);small.data[0][0]=99;safe.readAt(44,b,0,1);assertEquals(1,b[0]);
    }
}
