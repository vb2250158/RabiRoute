package com.rabi.link.recording;

import org.json.JSONArray;
import org.json.JSONObject;
import java.math.BigDecimal;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.*;

/** Pure record-archive-v1 contract. No storage, network, model selection or eviction. */
public final class RecordingArchiveContract {
    public static final long MAX_BYTES = 128L * 1024 * 1024;
    public static final int MAX_ITEMS = 4096;
    private static final long MAX_SAFE = 9007199254740991L, MAX_TIME = 8640000000000000L;
    private RecordingArchiveContract() { }
    private static IllegalArgumentException invalid(String field) { return new IllegalArgumentException("Invalid recording archive " + field); }
    private static JSONObject object(Object value, String... keys) {
        if (!(value instanceof JSONObject)) throw invalid("object");
        JSONObject o = (JSONObject)value;
        Set<String> expected = new HashSet<>(Arrays.asList(keys));
        if (o.length() != expected.size()) throw invalid("fields");
        Iterator<String> names = o.keys();
        while (names.hasNext()) if (!expected.contains(names.next())) throw invalid("unknown field");
        for (String key : keys) if (!o.has(key) || o.isNull(key)) throw invalid(key);
        return o;
    }
    private static long integer(Object value, long min, long max) {
        if (!(value instanceof Number)) throw invalid("number");
        double d = ((Number)value).doubleValue();
        if (!Double.isFinite(d) || (d == 0 && Double.doubleToRawLongBits(d) < 0)) throw invalid("number");
        try {
            long n = new BigDecimal(value.toString()).longValueExact();
            if (n < min || n > max || n > MAX_SAFE) throw invalid("integer range");
            return n;
        } catch (ArithmeticException | NumberFormatException e) { throw invalid("integer"); }
    }
    private static String string(Object value, String pattern) {
        if (!(value instanceof String) || !((String)value).matches(pattern)) throw invalid("string");
        return (String)value;
    }
    private static String id(Object value) { return string(value,"[A-Za-z0-9_-]{1,128}"); }
    private static String hash(Object value) { return string(value,"[a-f0-9]{64}"); }
    private static String namespace(Object value) {
        String s = string(value,"[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}");
        if (s.equals("00000000-0000-0000-0000-000000000000")) throw invalid("namespace");
        return s;
    }
    private static String choice(Object value, String... values) {
        if (!(value instanceof String) || !Arrays.asList(values).contains(value)) throw invalid("enum");
        return (String)value;
    }
    private static long bytes(Object value, long max) {
        long n = integer(value,2,max); if ((n & 1) != 0) throw invalid("PCM alignment"); return n;
    }
    private static long time(Object value) { return integer(value,0,MAX_TIME); }
    private static JSONArray list(Object value, int min) {
        if (!(value instanceof JSONArray)) throw invalid("array");
        JSONArray a=(JSONArray)value;
        if(a.length()<min || a.length()>MAX_ITEMS) throw invalid("array size"); return a;
    }
    private static JSONObject put(JSONObject o,String key,Object value) {
        try { o.put(key,value); return o; } catch(Exception e) { throw invalid(key); }
    }
    /** Detached normalized JSON, matching the PC validator (including ASCII reason codes). */
    public static JSONObject validateRecordingManifest(JSONObject input) {
        JSONObject v=object(input,"schemaVersion","recordId","captureId","eventId","deviceId","source","startedAt","endedAt","timeBasis","format","segments","objects","gaps","processingPolicy","totalBytes","sealed");
        if(integer(v.opt("schemaVersion"),1,1)!=1 || !Boolean.TRUE.equals(v.opt("sealed"))) throw invalid("version/seal");
        long start=time(v.opt("startedAt")), end=time(v.opt("endedAt")), total=bytes(v.opt("totalBytes"),MAX_BYTES);
        if(end<=start || total/32.0>end-start+1) throw invalid("time range");
        JSONObject f=object(v.opt("format"),"codec","sampleRate","channels");
        choice(f.opt("codec"),"pcm_s16le"); integer(f.opt("sampleRate"),16000,16000); integer(f.opt("channels"),1,1);
        JSONArray segments=new JSONArray(), source=list(v.opt("segments"),1);
        long previous=-1, sum=0, previousStart=start;
        for(int i=0;i<source.length();i++) {
            JSONObject s=object(source.opt(i),"sequence","bytes","sha256","startedAt");
            long seq=integer(s.opt("sequence"),0,MAX_SAFE), size=bytes(s.opt("bytes"),MAX_BYTES), at=time(s.opt("startedAt"));
            if(seq<=previous || at<previousStart || at<start || at>=end || size/32.0>end-at+1) throw invalid("segment order/time");
            previous=seq;previousStart=at;sum+=size;if(sum>total)throw invalid("segment total");
            segments.put(put(put(put(put(new JSONObject(),"sequence",seq),"bytes",size),"sha256",hash(s.opt("sha256"))),"startedAt",at));
        }
        JSONArray objects=new JSONArray();source=list(v.opt("objects"),1);long objectBytes=0;
        for(int i=0;i<source.length();i++) {
            JSONObject o=object(source.opt(i),"sha256","bytes","offset");
            long size=bytes(o.opt("bytes"),1024*1024), offset=integer(o.opt("offset"),0,MAX_BYTES);
            if(offset!=objectBytes)throw invalid("object offset");objectBytes+=size;if(objectBytes>total)throw invalid("object total");
            objects.put(put(put(put(new JSONObject(),"sha256",hash(o.opt("sha256"))),"bytes",size),"offset",offset));
        }
        if(sum!=total || objectBytes!=total)throw invalid("total bytes");
        JSONArray gaps=new JSONArray();source=list(v.opt("gaps"),0);long gapEnd=start;
        for(int i=0;i<source.length();i++) {
            JSONObject g=object(source.opt(i),"startedAt","endedAt","reason");long at=time(g.opt("startedAt")), until=time(g.opt("endedAt"));
            if(at<gapEnd || until<=at || until>end)throw invalid("gap time");gapEnd=until;
            gaps.put(put(put(put(new JSONObject(),"startedAt",at),"endedAt",until),"reason",id(g.opt("reason"))));
        }
        JSONObject out=new JSONObject();put(out,"schemaVersion",1);
        for(String key:new String[]{"recordId","captureId","eventId","deviceId"})put(out,key,id(v.opt(key)));
        put(out,"source",choice(v.opt("source"),"phone","glasses","video"));put(out,"startedAt",start);put(out,"endedAt",end);
        put(out,"timeBasis",choice(v.opt("timeBasis"),"received","media","imported"));
        put(out,"format",put(put(put(new JSONObject(),"codec","pcm_s16le"),"sampleRate",16000),"channels",1));
        put(out,"segments",segments);put(out,"objects",objects);put(out,"gaps",gaps);
        put(out,"processingPolicy",choice(v.opt("processingPolicy"),"transcribe","agent","local_only"));put(out,"totalBytes",total);put(out,"sealed",true);return out;
    }
    public static String recordingManifestCanonicalJson(JSONObject value) { return canonical(validateRecordingManifest(value)); }
    public static String recordingManifestHash(JSONObject value) {
        try {
            byte[] digest=MessageDigest.getInstance("SHA-256").digest(recordingManifestCanonicalJson(value).getBytes(StandardCharsets.UTF_8));
            StringBuilder s=new StringBuilder();for(byte b:digest)s.append(String.format(Locale.ROOT,"%02x",b&255));return s.toString();
        } catch(java.security.NoSuchAlgorithmException e) { throw new IllegalStateException(e); }
    }
    public static JSONObject validateArchiveReceipt(JSONObject value,String workerId,String storageNamespaceId,JSONObject manifest) {
        JSONObject m=validateRecordingManifest(manifest);
        String worker=id(workerId), ns=namespace(storageNamespaceId);
        JSONObject v=object(value,"schemaVersion","workerId","storageNamespaceId","recordId","manifestHash","totalBytes","segmentCount","committedAt","durability","retention");
        integer(v.opt("schemaVersion"),1,1);choice(v.opt("durability"),"archived");choice(v.opt("retention"),"indefinite");
        String actualWorker=id(v.opt("workerId")), actualNs=namespace(v.opt("storageNamespaceId")), record=id(v.opt("recordId")), digest=hash(v.opt("manifestHash"));
        long total=bytes(v.opt("totalBytes"),MAX_BYTES), count=integer(v.opt("segmentCount"),1,MAX_ITEMS), committed=time(v.opt("committedAt"));
        if(!worker.equals(actualWorker)||!ns.equals(actualNs)||!record.equals(m.opt("recordId"))||!digest.equals(recordingManifestHash(m))||total!=((Number)m.opt("totalBytes")).longValue()||count!=((JSONArray)m.opt("segments")).length())throw invalid("receipt identity");
        JSONObject out=new JSONObject();put(out,"schemaVersion",1);put(out,"workerId",actualWorker);put(out,"storageNamespaceId",actualNs);put(out,"recordId",record);put(out,"manifestHash",digest);put(out,"totalBytes",total);put(out,"segmentCount",count);put(out,"committedAt",committed);put(out,"durability","archived");put(out,"retention","indefinite");return out;
    }
    private static String canonical(Object v) {
        if(v instanceof JSONObject) {
            JSONObject o=(JSONObject)v;List<String> keys=new ArrayList<>();o.keys().forEachRemaining(keys::add);Collections.sort(keys);
            StringJoiner j=new StringJoiner(",","{","}");for(String k:keys)j.add(quote(k)+":"+canonical(o.opt(k)));return j.toString();
        }
        if(v instanceof JSONArray) {JSONArray a=(JSONArray)v;StringJoiner j=new StringJoiner(",","[","]");for(int i=0;i<a.length();i++)j.add(canonical(a.opt(i)));return j.toString();}
        if(v instanceof String)return quote((String)v);
        if(v instanceof Number)return Long.toString(((Number)v).longValue());
        if(v instanceof Boolean)return v.toString();throw invalid("canonical value");
    }
    // JSON.stringify-compatible escaping: no slash/Unicode escaping, except lone UTF16 surrogates.
    static String quote(String value) {
        StringBuilder s=new StringBuilder("\"");
        for(int i=0;i<value.length();i++) {
            char c=value.charAt(i);
            switch(c) {
                case '"':s.append("\\\"");break;case '\\':s.append("\\\\");break;
                case '\b':s.append("\\b");break;case '\f':s.append("\\f");break;case '\n':s.append("\\n");break;case '\r':s.append("\\r");break;case '\t':s.append("\\t");break;
                default:
                    boolean lone=Character.isHighSurrogate(c)? i+1>=value.length()||!Character.isLowSurrogate(value.charAt(i+1)) : Character.isLowSurrogate(c)&&(i==0||!Character.isHighSurrogate(value.charAt(i-1)));
                    if(c<32||lone)s.append(String.format(Locale.ROOT,"\\u%04x",(int)c));else s.append(c);
            }
        }
        return s.append('"').toString();
    }
}
