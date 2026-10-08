package com.rabi.link.recording;

import org.json.JSONArray;
import org.json.JSONObject;
import java.io.InputStream;
import java.io.ByteArrayOutputStream;
import java.security.MessageDigest;
import java.util.concurrent.atomic.AtomicBoolean;

/** One synchronous drain owner. The caller schedules retries from its durable spool, not a second queue.
 * Transport MUST pin this target over the existing LAN -> P2P -> Relay resources tunnel.
 * Persistence MUST serialize receipt/eviction work on the existing spool writer.
 */
public final class RecordingArchiveCoordinator {
    public static final class Target {
        public final String workerId, namespace, owner;
        public final long bindingRevision;
        public final boolean uploadAllowed;
        public Target(String workerId, String namespace, String owner, long bindingRevision, boolean uploadAllowed) {
            this.workerId=workerId; this.namespace=namespace; this.owner=owner;
            this.bindingRevision=bindingRevision; this.uploadAllowed=uploadAllowed;
        }
    }
    public interface Snapshot extends AutoCloseable {
        JSONObject manifest() throws Exception;
        Target target();
        /** True only for a sealed, fully committed acoustic event, never active/partial/prepared data. */
        boolean complete();
        InputStream openObject(String sha256) throws Exception;
        void close() throws Exception;
    }
    public interface Source { Snapshot acquireSnapshot(String recordId) throws Exception; }
    public interface Transport {
        /** null means authoritative missing (404), not an exception, timeout or NAS unavailable. */
        JSONObject readReceipt(Target target, String recordId, String manifestHash) throws Exception;
        void putObject(Target target, String sha256, byte[] pcm) throws Exception;
        JSONObject commitManifest(Target target, String recordId, String hash, JSONObject manifest) throws Exception;
    }
    /** Any write whose response is unknown MUST use this exception (including timeout/connection loss). */
    public static final class UnknownWrite extends Exception {
        public UnknownWrite(String message) { super(message); }
    }
    public interface Persistence {
        void persistVerifiedReceipt(Target target, JSONObject manifest, JSONObject receipt) throws Exception;
        /** Must revalidate receipt and pins on writer; false means retained/eviction_pending, not deleted. */
        boolean requestEviction(Target target, JSONObject manifest, JSONObject receipt) throws Exception;
        boolean remoteHistoryAndPlaybackReady(Target target, JSONObject manifest) throws Exception;
        void state(String recordId, String archiveState, String reason) throws Exception;
    }
    public static class Result {
        public final String archiveState, reason;
        public final boolean evicted;
        Result(String state,String reason,boolean evicted) { this.archiveState=state;this.reason=reason;this.evicted=evicted; }
    }
    private final Source source;
    private final Transport transport;
    private final Persistence persistence;
    private final AtomicBoolean running=new AtomicBoolean();
    public RecordingArchiveCoordinator(Source source,Transport transport,Persistence persistence) {
        this.source=source;this.transport=transport;this.persistence=persistence;
    }
    public Result runOne(String recordId) throws Exception {
        if(!running.compareAndSet(false,true)) return new Result("retry_wait","coordinator_busy",false);
        try {
            Result result=upload(recordId);
            if(result instanceof CommittedResult) {
                CommittedResult committed=(CommittedResult)result;
                try {
                    boolean evicted=persistence.remoteHistoryAndPlaybackReady(committed.target,committed.manifest)
                            && persistence.requestEviction(committed.target,committed.manifest,committed.receipt);
                    return new Result("committed",evicted ? "evicted" : "local_retained",evicted);
                } catch(Exception failed) { return new Result("committed","eviction_pending",false); }
            }
            return result;
        } finally { running.set(false); }
    }
    private Result upload(String recordId) throws Exception {
        try (Snapshot snapshot=source.acquireSnapshot(recordId)) {
            Target target=snapshot.target();
            JSONObject manifest=RecordingArchiveContract.validateRecordingManifest(snapshot.manifest());
            if(target==null || !target.uploadAllowed || target.bindingRevision<1 || !snapshot.complete()
                    || !recordId.equals(manifest.getString("recordId"))
                    || !manifest.getString("deviceId").equals(target.owner)
                    || !"transcribe".equals(manifest.getString("processingPolicy")))
                return state(recordId,"blocked","archive_not_authorized",false);
            // Validate the expected identity before any network request, using a synthetic strict receipt.
            String hash=RecordingArchiveContract.recordingManifestHash(manifest);
            JSONObject identity=new JSONObject().put("schemaVersion",1).put("workerId",target.workerId)
                    .put("storageNamespaceId",target.namespace).put("recordId",recordId).put("manifestHash",hash)
                    .put("totalBytes",manifest.getLong("totalBytes")).put("segmentCount",manifest.getJSONArray("segments").length())
                    .put("committedAt",0).put("durability","archived").put("retention","indefinite");
            RecordingArchiveContract.validateArchiveReceipt(identity,target.workerId,target.namespace,manifest);
            JSONObject receipt=transport.readReceipt(target,recordId,hash);
            if(receipt==null) {
                persistence.state(recordId,"uploading","");
                try {
                    JSONArray objects=manifest.getJSONArray("objects");
                    for(int i=0;i<objects.length();i++) {
                        JSONObject object=objects.getJSONObject(i);
                        String sha=object.getString("sha256"); int bytes=object.getInt("bytes");
                        byte[] body;
                        try(InputStream in=snapshot.openObject(sha)) { body=readVerified(in,bytes,sha); }
                        transport.putObject(target,sha,body);
                    }
                    receipt=transport.commitManifest(target,recordId,hash,new JSONObject(manifest.toString()));
                } catch(UnknownWrite | java.io.IOException unknown) {
                    // No immediate write retry, no different target; only authoritative read-back.
                    persistence.state(recordId,"ambiguous","archive_write_unknown");
                    try { receipt=transport.readReceipt(target,recordId,hash); }
                    catch(Exception unavailable) { return state(recordId,"ambiguous","receipt_unavailable",false); }
                    if(receipt==null) return state(recordId,"ambiguous","receipt_not_committed",false);
                }
            }
            JSONObject verified=RecordingArchiveContract.validateArchiveReceipt(receipt,target.workerId,target.namespace,manifest);
            persistence.persistVerifiedReceipt(target,new JSONObject(manifest.toString()),new JSONObject(verified.toString()));
            persistence.state(recordId,"committed","");
            // Snapshot pin remains held here. Writer may defer eviction until it is released.
            // Eviction runs outside this scope below, never by this coordinator deleting files.
            return new CommittedResult(target,manifest,verified);
        } catch(IllegalArgumentException invalid) {
            return state(recordId,"blocked","archive_contract_rejected",false);
        } catch(Exception failure) {
            return state(recordId,"retry_wait","archive_io_failure",false);
        }
    }
    private static final class CommittedResult extends Result {
        final Target target; final JSONObject manifest,receipt;
        CommittedResult(Target target,JSONObject manifest,JSONObject receipt) {
            super("committed","local_retained",false); this.target=target;this.manifest=manifest;this.receipt=receipt;
        }
    }
    private Result state(String id,String state,String reason,boolean evicted) throws Exception {
        persistence.state(id,state,reason); return new Result(state,reason,evicted);
    }
    private static byte[] readVerified(InputStream input,int expected,String sha) throws Exception {
        ByteArrayOutputStream out=new ByteArrayOutputStream(expected); byte[] chunk=new byte[8192]; int n;
        while((n=input.read(chunk))!=-1) { if(out.size()+n>expected) throw new IllegalArgumentException("object size"); out.write(chunk,0,n); }
        byte[] body=out.toByteArray(); if(body.length!=expected) throw new IllegalArgumentException("object size");
        StringBuilder digest=new StringBuilder(); for(byte b:MessageDigest.getInstance("SHA-256").digest(body)) digest.append(String.format(java.util.Locale.ROOT,"%02x",b&255));
        if(!sha.equals(digest.toString())) throw new IllegalArgumentException("object hash"); return body;
    }
}
