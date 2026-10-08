package com.rabi.link.recording;
import org.json.*;
import org.junit.Test;
import static org.junit.Assert.*;
import java.io.*;
import java.security.MessageDigest;

public class RecordingArchiveCoordinatorTest {
 static final String NS="12345678-1234-4234-8234-123456789abc";
 static class Harness implements RecordingArchiveCoordinator.Source, RecordingArchiveCoordinator.Transport, RecordingArchiveCoordinator.Persistence {
  JSONObject m,stored; int puts,commits,persists,evictions,closes,reads; boolean ready,failPersist,unknown,weak; Runnable onPut;
  final byte[] pcm=new byte[32000];
  final RecordingArchiveCoordinator.Target target=new RecordingArchiveCoordinator.Target("worker-1",NS,"device-1",1,true);
  Harness() throws Exception { m=RecordingArchiveContractTest.fixture(); StringBuilder s=new StringBuilder();for(byte b:MessageDigest.getInstance("SHA-256").digest(pcm))s.append(String.format("%02x",b&255));for(String a:new String[]{"segments","objects"})for(int i=0;i<2;i++)m.getJSONArray(a).getJSONObject(i).put("sha256",s.toString()); }
  public RecordingArchiveCoordinator.Snapshot acquireSnapshot(String id) { return new RecordingArchiveCoordinator.Snapshot(){public JSONObject manifest(){return m;}public RecordingArchiveCoordinator.Target target(){return target;}public boolean complete(){return true;}public InputStream openObject(String h){return new ByteArrayInputStream(pcm);}public void close(){closes++;}}; }
  JSONObject receipt() throws Exception {return new JSONObject().put("schemaVersion",1).put("workerId","worker-1").put("storageNamespaceId",NS).put("recordId","record-1").put("manifestHash",RecordingArchiveContract.recordingManifestHash(m)).put("totalBytes",64000).put("segmentCount",2).put("committedAt",4000).put("durability","archived").put("retention","indefinite");}
  public JSONObject readReceipt(RecordingArchiveCoordinator.Target t,String id,String hash){assertSame(target,t);reads++;return stored;}
  public void putObject(RecordingArchiveCoordinator.Target t,String hash,byte[] p){assertSame(target,t);puts++;if(onPut!=null)onPut.run();}
  public JSONObject commitManifest(RecordingArchiveCoordinator.Target t,String id,String hash,JSONObject manifest)throws Exception{assertSame(target,t);commits++;stored=weak?new JSONObject().put("durable",true):receipt();if(unknown)throw new RecordingArchiveCoordinator.UnknownWrite("timeout");return stored;}
  public void persistVerifiedReceipt(RecordingArchiveCoordinator.Target t,JSONObject m,JSONObject r)throws Exception{if(failPersist)throw new IOException();persists++;}
  public boolean requestEviction(RecordingArchiveCoordinator.Target t,JSONObject m,JSONObject r){assertTrue(closes>0);evictions++;return true;}
  public boolean remoteHistoryAndPlaybackReady(RecordingArchiveCoordinator.Target t,JSONObject m)throws Exception{return ready;}
  public void state(String id,String state,String reason){}
  RecordingArchiveCoordinator coordinator(){return new RecordingArchiveCoordinator(this,this,this);}
 }
 @Test public void readyGateAndDuplicateSkipCommit()throws Exception{Harness h=new Harness();RecordingArchiveCoordinator c=h.coordinator();assertFalse(c.runOne("record-1").evicted);assertEquals(0,h.evictions);h.ready=true;assertTrue(c.runOne("record-1").evicted);assertEquals(1,h.commits);assertEquals(2,h.closes);}
 @Test public void unknownCommitReadbackSameIdentity()throws Exception{Harness h=new Harness();h.ready=true;h.unknown=true;assertTrue(h.coordinator().runOne("record-1").evicted);assertEquals(2,h.reads);assertEquals(1,h.commits);}
 @Test public void weakAndMismatchedReceiptNeverPersist()throws Exception{Harness h=new Harness();h.weak=true;h.ready=true;assertEquals("blocked",h.coordinator().runOne("record-1").archiveState);assertEquals(0,h.persists);assertEquals(0,h.evictions);h.stored=h.receipt().put("workerId","other");assertEquals("blocked",h.coordinator().runOne("record-1").archiveState);assertEquals(0,h.evictions);}
 @Test public void persistFailureNeverEvictsAndPinReleased()throws Exception{Harness h=new Harness();h.ready=true;h.failPersist=true;assertEquals("retry_wait",h.coordinator().runOne("record-1").archiveState);assertEquals(0,h.evictions);assertEquals(1,h.closes);}
 @Test public void playbackReadbackFailureRetainsOriginalWithoutRepeatingCommit()throws Exception{Harness h=new Harness(){public boolean remoteHistoryAndPlaybackReady(RecordingArchiveCoordinator.Target t,JSONObject m)throws Exception{throw new IOException("remote audio unavailable");}};RecordingArchiveCoordinator c=h.coordinator();for(int i=0;i<2;i++){RecordingArchiveCoordinator.Result r=c.runOne("record-1");assertEquals("committed",r.archiveState);assertEquals("eviction_pending",r.reason);assertFalse(r.evicted);}assertEquals(1,h.commits);assertEquals(0,h.evictions);assertEquals(2,h.persists);}
 @Test public void localOnlyAndAgentNeverUpload()throws Exception{for(String p:new String[]{"local_only","agent"}){Harness h=new Harness();h.m.put("processingPolicy",p);assertEquals("blocked",h.coordinator().runOne("record-1").archiveState);assertEquals(0,h.reads);assertEquals(0,h.puts);assertEquals(1,h.closes);}}
 @Test public void singleOwnerRejectsReentry()throws Exception{Harness h=new Harness();RecordingArchiveCoordinator c=h.coordinator();h.onPut=()->{try{assertEquals("coordinator_busy",c.runOne("record-1").reason);}catch(Exception e){throw new RuntimeException(e);}};assertEquals("committed",c.runOne("record-1").archiveState);assertEquals(1,h.commits);}
 @Test public void unknownWriteWithoutReceiptNeverRetries()throws Exception{Harness h=new Harness(){public void putObject(RecordingArchiveCoordinator.Target t,String hash,byte[] p){throw new RuntimeException("unused");}public JSONObject commitManifest(RecordingArchiveCoordinator.Target t,String id,String hash,JSONObject m)throws Exception{commits++;throw new java.net.SocketTimeoutException();}};RecordingArchiveCoordinator.Transport transport=new RecordingArchiveCoordinator.Transport(){public JSONObject readReceipt(RecordingArchiveCoordinator.Target t,String i,String hash){h.reads++;return null;}public void putObject(RecordingArchiveCoordinator.Target t,String hash,byte[] p)throws Exception{h.puts++;throw new RecordingArchiveCoordinator.UnknownWrite("timeout");}public JSONObject commitManifest(RecordingArchiveCoordinator.Target t,String i,String hash,JSONObject m){throw new AssertionError();}};assertEquals("ambiguous",new RecordingArchiveCoordinator(h,transport,h).runOne("record-1").archiveState);assertEquals(1,h.puts);assertEquals(2,h.reads);assertEquals(0,h.persists);assertEquals(1,h.closes);}
 @Test public void corruptObjectNeverCommits()throws Exception{Harness h=new Harness();h.pcm[0]=1;assertEquals("blocked",h.coordinator().runOne("record-1").archiveState);assertEquals(0,h.commits);assertEquals(1,h.closes);}
}
