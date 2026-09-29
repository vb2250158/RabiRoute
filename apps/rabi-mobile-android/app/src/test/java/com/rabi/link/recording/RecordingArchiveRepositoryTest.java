package com.rabi.link.recording;
import org.junit.Test;
import static org.junit.Assert.*;
import java.util.*;
import static com.rabi.link.recording.RecordingArchiveRepository.*;

public class RecordingArchiveRepositoryTest {
 final Identity id=new Identity("phone","worker","namespace");final Query q=new Query(10,null,null,null);
 Row row(Identity i,String key,boolean archived){return new Row(i,key,"capture","event","phone",1,2,32,"hash","ref","transcribe","queued","","pending",archived);}
 class Harness implements Remote,Local,Cache {
  Map<Key,RemotePage> cache=new HashMap<>();List<Row> rows=new ArrayList<>(),pending=new ArrayList<>();int localCalls;boolean down,stale;Identity remoteId=id;
  public RemotePage page(Identity i,Query q,String cursor)throws Exception{if(stale)throw new Stale();if(down)throw new Unavailable();return new RemotePage(remoteId,rows,"next","rev",false,12);}
  public Manifest manifest(Identity i,String r){return new Manifest(remoteId,r,"hash","{}");}
  public List<Row> pending(Identity i,Query q,int limit){localCalls++;return pending;}
  public RemotePage load(Key k){return cache.get(k);}public void save(Key k,RemotePage p){cache.put(k,p);}
  RecordingArchiveRepository repo(){return new RecordingArchiveRepository(id,this,this,this);}
 }
 @Test public void remoteDedupRetainsEmptyTextAndHidesMatchingPending()throws Exception{Harness h=new Harness();h.rows=Arrays.asList(row(id,"one",true),row(id,"one",true));h.pending=Arrays.asList(row(id,"one",false),row(id,"two",false));Page p=h.repo().page(q,null);assertEquals(1,p.remoteItems.size());assertEquals("",p.remoteItems.get(0).text);assertEquals("queued",p.remoteItems.get(0).asrState);assertEquals("two",p.localPendingOverlay.get(0).recordId);}
 @Test public void overlayIsFirstPageOnlyAndOtherBindingExcluded()throws Exception{Harness h=new Harness();h.pending=Arrays.asList(row(new Identity("other","worker","namespace"),"x",false),row(id,"two",false));RecordingArchiveRepository r=h.repo();assertEquals(1,r.page(q,null).localPendingOverlay.size());assertTrue(r.page(q,"next").localPendingOverlay.isEmpty());assertEquals(1,h.localCalls);}
 @Test public void cacheIsExactIdentityFilterAndCursorScoped()throws Exception{Harness h=new Harness();h.rows=Arrays.asList(row(id,"one",true));RecordingArchiveRepository r=h.repo();r.page(q,null);h.down=true;Page cached=r.page(q,null);assertEquals(Status.OFFLINE_CACHED,cached.status);assertEquals(12,cached.lastSyncedAt);assertEquals(1,cached.remoteItems.size());assertEquals(Status.UNKNOWN_OFFLINE,r.page(q,"other").status);assertEquals(Status.UNKNOWN_OFFLINE,r.page(new Query(9,null,null,null),null).status);}
 @Test public void staleNeverMixesCachedPagesOrOverlay()throws Exception{Harness h=new Harness();RecordingArchiveRepository r=h.repo();r.page(q,null);h.stale=true;Page p=r.page(q,"next");assertEquals(Status.STALE,p.status);assertTrue(p.remoteItems.isEmpty());assertEquals(1,h.localCalls);}
 @Test public void wrongRemoteOwnerFailsClosedNotOfflineFallback()throws Exception{Harness h=new Harness();h.remoteId=new Identity("evil","worker","namespace");try{h.repo().page(q,null);fail();}catch(SecurityException expected){}try{h.repo().manifest("one");fail();}catch(SecurityException expected){}}
 @Test public void boundsAndPendingTruncationAreExplicit()throws Exception{Harness h=new Harness();h.pending=Arrays.asList(row(id,"one",false),row(id,"two",false));Page p=h.repo().page(new Query(1,null,null,null),null);assertTrue(p.pendingTruncated);assertEquals(1,p.localPendingOverlay.size());try{new Query(101,null,null,null);fail();}catch(IllegalArgumentException expected){}}
}
