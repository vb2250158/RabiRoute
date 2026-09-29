package com.rabi.link.recording;

import java.util.*;

/** Remote-authoritative pages and a separate, bounded first-page pending section.
 * Adapters own transport authentication, pre-indexing, persistence and threading. No metadata scan here.
 */
public final class RecordingArchiveRepository {
    public static final class Identity {
        public final String owner, worker, namespace;
        public Identity(String owner, String worker, String namespace) {
            this.owner = required(owner); this.worker = required(worker); this.namespace = required(namespace);
        }
        @Override public boolean equals(Object o) { if (!(o instanceof Identity)) return false; Identity i=(Identity)o; return owner.equals(i.owner)&&worker.equals(i.worker)&&namespace.equals(i.namespace); }
        @Override public int hashCode() { return Objects.hash(owner,worker,namespace); }
    }
    public static final class Query {
        public final int limit; public final Long from,to; public final String source;
        public Query(int limit, Long from, Long to, String source) {
            if(limit<1||limit>100||from!=null&&from<0||to!=null&&to<0||from!=null&&to!=null&&from>to) throw new IllegalArgumentException("invalid_query");
            if(source!=null&&!Arrays.asList("phone","glasses","video").contains(source)) throw new IllegalArgumentException("invalid_source");
            this.limit=limit; this.from=from; this.to=to; this.source=source;
        }
        @Override public boolean equals(Object o) { if(!(o instanceof Query))return false; Query q=(Query)o; return limit==q.limit&&Objects.equals(from,q.from)&&Objects.equals(to,q.to)&&Objects.equals(source,q.source); }
        @Override public int hashCode(){return Objects.hash(limit,from,to,source);}
    }
    public static final class Row {
        public final Identity identity;
        public final String recordId,captureId,eventId,source,manifestHash,manifestReference,processingPolicy,asrState,text,uploadState;
        public final long startedAt,endedAt,totalBytes;
        public final boolean archived;
        public Row(Identity identity,String recordId,String captureId,String eventId,String source,long startedAt,long endedAt,long totalBytes,String manifestHash,String manifestReference,String processingPolicy,String asrState,String text,String uploadState,boolean archived) {
            this.identity=Objects.requireNonNull(identity);this.recordId=required(recordId);this.captureId=captureId;this.eventId=eventId;this.source=required(source);
            if(startedAt<0||endedAt<startedAt||totalBytes<0)throw new IllegalArgumentException("invalid_row");
            this.startedAt=startedAt;this.endedAt=endedAt;this.totalBytes=totalBytes;this.manifestHash=manifestHash;this.manifestReference=manifestReference;this.processingPolicy=processingPolicy;
            this.asrState=required(asrState);this.text=text==null?"":text;this.uploadState=uploadState;this.archived=archived;
        }
    }
    public static final class RemotePage {
        public final Identity identity; public final List<Row> items; public final String nextCursor,snapshotRevision; public final boolean offline; public final long lastSyncedAt;
        public RemotePage(Identity identity,List<Row> items,String nextCursor,String snapshotRevision,boolean offline,long lastSyncedAt) {
            this.identity=Objects.requireNonNull(identity);this.items=immutable(items);this.nextCursor=nextCursor;this.snapshotRevision=required(snapshotRevision);this.offline=offline;this.lastSyncedAt=lastSyncedAt;
        }
    }
    /** Transport supplies a verified canonical manifest, not an arbitrary path or WAV export. */
    public static final class Manifest {
        public final Identity identity; public final String recordId,manifestHash,canonicalJson;
        public Manifest(Identity identity,String recordId,String manifestHash,String canonicalJson){this.identity=identity;this.recordId=required(recordId);this.manifestHash=required(manifestHash);this.canonicalJson=required(canonicalJson);}
    }
    public static final class Key {
        public final Identity identity; public final Query query; public final String cursor;
        public Key(Identity identity,Query query,String cursor){this.identity=identity;this.query=query;this.cursor=cursor;}
        @Override public boolean equals(Object o){if(!(o instanceof Key))return false;Key k=(Key)o;return identity.equals(k.identity)&&query.equals(k.query)&&Objects.equals(cursor,k.cursor);}
        @Override public int hashCode(){return Objects.hash(identity,query,cursor);}
    }
    public enum Status { READY, OFFLINE_CACHED, UNKNOWN_OFFLINE, STALE }
    public static final class Page {
        public final List<Row> remoteItems,localPendingOverlay;
        public final String remoteCursor,snapshotRevision; public final boolean offline,pendingTruncated;public final long lastSyncedAt; public final Status status;
        private Page(RemotePage remote,List<Row> pending,Status status,boolean truncated){remoteItems=remote==null?Collections.emptyList():remote.items;localPendingOverlay=immutable(pending);remoteCursor=remote==null?null:remote.nextCursor;snapshotRevision=remote==null?null:remote.snapshotRevision;offline=status==Status.OFFLINE_CACHED||status==Status.UNKNOWN_OFFLINE||remote!=null&&remote.offline;lastSyncedAt=remote==null?0:remote.lastSyncedAt;this.status=status;pendingTruncated=truncated;}
    }
    public static class Unavailable extends Exception { public Unavailable(){super("transport_unavailable");} }
    public static class Stale extends Exception { public Stale(){super("cursor_stale");} }
    public interface Remote { RemotePage page(Identity identity,Query query,String cursor) throws Exception; Manifest manifest(Identity identity,String recordId) throws Exception; }
    /** Must return at most limit matching pre-indexed rows; never scan old metadata. */
    public interface Local { List<Row> pending(Identity identity,Query query,int limit) throws Exception; }
    public interface Cache { RemotePage load(Key key) throws Exception; void save(Key key,RemotePage page) throws Exception; }
    private final Identity identity;private final Remote remote;private final Local local;private final Cache cache;
    public RecordingArchiveRepository(Identity identity,Remote remote,Local local,Cache cache){this.identity=Objects.requireNonNull(identity);this.remote=Objects.requireNonNull(remote);this.local=Objects.requireNonNull(local);this.cache=Objects.requireNonNull(cache);}
    public Page page(Query query,String cursor) throws Exception {
        Objects.requireNonNull(query); if(cursor!=null&&cursor.isEmpty())throw new IllegalArgumentException("empty_cursor");
        Key key=new Key(identity,query,cursor);RemotePage result;Status status;
        try { result=validate(remote.page(identity,query,cursor),query);status=result.offline?Status.OFFLINE_CACHED:Status.READY;
            try {cache.save(key,result);}catch(Exception ignored){/* Replaceable cache cannot revoke a valid remote page. */}
        } catch(Stale stale){return new Page(null,Collections.emptyList(),Status.STALE,false);
        } catch(Unavailable offline){result=cache.load(key);if(result!=null)result=validate(result,query);status=result==null?Status.UNKNOWN_OFFLINE:Status.OFFLINE_CACHED;}
        List<Row> overlay=new ArrayList<>();boolean truncated=false;
        if(cursor==null){List<Row> pending=local.pending(identity,query,query.limit+1);if(pending.size()>query.limit+1)throw new IllegalStateException("unbounded_pending_adapter");Set<String> seen=new HashSet<>();if(result!=null)for(Row row:result.items)seen.add(row.recordId);
            for(Row row:pending){if(!identity.equals(row.identity)||row.archived||!matches(row,query))continue;if(seen.add(row.recordId)){if(overlay.size()==query.limit){truncated=true;break;}overlay.add(row);}}
        }
        return new Page(result,overlay,status,truncated);
    }
    public Manifest manifest(String recordId) throws Exception {Manifest m=remote.manifest(identity,required(recordId));if(m==null||!identity.equals(m.identity)||!recordId.equals(m.recordId))throw new SecurityException("manifest_identity_mismatch");return m;}
    private RemotePage validate(RemotePage p,Query q){if(p==null||!identity.equals(p.identity))throw new SecurityException("page_identity_mismatch");if(p.items.size()>q.limit||p.lastSyncedAt<0)throw new IllegalArgumentException("invalid_page");Set<String> ids=new HashSet<>();List<Row> rows=new ArrayList<>();for(Row r:p.items){if(!identity.equals(r.identity)||!r.archived||!matches(r,q))throw new SecurityException("row_identity_or_filter_mismatch");if(ids.add(r.recordId))rows.add(r);}return new RemotePage(p.identity,rows,p.nextCursor,p.snapshotRevision,p.offline,p.lastSyncedAt);}
    private static boolean matches(Row r,Query q){return (q.from==null||r.startedAt>=q.from)&&(q.to==null||r.startedAt<=q.to)&&(q.source==null||q.source.equals(r.source));}
    private static String required(String value){if(value==null||value.isEmpty())throw new IllegalArgumentException("missing_identity");return value;}
    private static <T> List<T> immutable(List<T> values){return Collections.unmodifiableList(new ArrayList<>(Objects.requireNonNull(values)));}
}
