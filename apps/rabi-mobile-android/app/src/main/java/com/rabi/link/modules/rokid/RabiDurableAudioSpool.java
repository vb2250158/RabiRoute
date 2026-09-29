package com.rabi.link.modules.rokid;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.OutputStreamWriter;
import java.nio.charset.StandardCharsets;
import java.nio.file.AtomicMoveNotSupportedException;
import java.nio.file.Files;
import java.nio.file.StandardCopyOption;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Comparator;
import java.util.List;
import java.util.Locale;
import java.util.HashSet;
import java.util.Set;
import java.util.TreeSet;
import java.util.UUID;

/**
 * Phone-local source of truth for continuous PCM.
 *
 * Capture writes a durable .partial shard without consulting the network. Upload reads only
 * sealed shards and records its own acknowledgement state, so transport retries never block or
 * mutate the live capture file.
 */
final class RabiDurableAudioSpool {
    interface Clock { long now(); }
    interface SpaceProbe { long usableBytes(File directory); }
    interface FileMover { void move(File source, File destination) throws Exception; }
    interface Cutpoint { void reached(String stage) throws Exception; }

    static final class Policy {
        final long maxSegmentBytes;
        final long maxSegmentDurationMs;
        final long maxStorageBytes;
        final long reserveFreeBytes;
        final long acknowledgedRetentionMs;

        Policy(long maxSegmentBytes, long maxSegmentDurationMs, long maxStorageBytes,
               long reserveFreeBytes, long acknowledgedRetentionMs) {
            if (maxSegmentBytes < 2 || maxSegmentDurationMs < 1 || maxStorageBytes < maxSegmentBytes) {
                throw new IllegalArgumentException("invalid durable audio policy");
            }
            this.maxSegmentBytes = maxSegmentBytes & ~1L;
            this.maxSegmentDurationMs = maxSegmentDurationMs;
            this.maxStorageBytes = maxStorageBytes;
            this.reserveFreeBytes = Math.max(0L, reserveFreeBytes);
            this.acknowledgedRetentionMs = Math.max(0L, acknowledgedRetentionMs);
        }
    }

    static final class AppendResult {
        final boolean accepted;
        final long segmentSequence;
        final String failure;

        AppendResult(boolean accepted, long segmentSequence, String failure) {
            this.accepted = accepted;
            this.segmentSequence = segmentSequence;
            this.failure = failure == null ? "" : failure;
        }
    }

    static final class Segment {
        final long sequence;
        final String id;
        final File pcmFile;
        final File metadataFile;
        final long startedAt;
        final long endedAt;
        final long bytes;
        final String sha256;
        final String source;
        final String routeProfileId;
        final String captureId;
        final String processingPolicy;
        final String uploadState;
        final long serverSequence;
        final long acknowledgedAt;
        final String eventId;

        Segment(JSONObject value, File pcmFile, File metadataFile) {
            sequence = value.optLong("sequence", 0L);
            id = value.optString("id", idFor(sequence));
            this.pcmFile = pcmFile;
            this.metadataFile = metadataFile;
            startedAt = value.optLong("startedAt", 0L);
            endedAt = value.optLong("endedAt", 0L);
            bytes = value.optLong("bytes", pcmFile.length());
            sha256 = value.optString("sha256", "");
            source = value.optString("source", "phone");
            routeProfileId = value.optString("routeProfileId", "");
            captureId = value.optString("captureId", "");
            processingPolicy = value.optString("processingPolicy", "agent");
            uploadState = value.optString("uploadState", "sealed");
            serverSequence = value.optLong("serverSequence", 0L);
            acknowledgedAt = value.optLong("acknowledgedAt", 0L);
            eventId = value.optString("eventId", "");
        }
    }

    static final class PoisonedSegmentException extends Exception {
        final boolean isolated;
        PoisonedSegmentException(String reason, boolean isolated) {
            super(reason);
            this.isolated = isolated;
        }
    }

    private static final class CleanupInterruptedException extends RuntimeException {
        CleanupInterruptedException(String stage, Throwable cause) {
            super("injected durable cleanup interruption at " + stage, cause);
        }
    }

    private static final String STATE_FILE = "state.json";
    private static final String AUDIT_FILE = "audit.jsonl";
    private static final String AUDIT_INDEX_FILE = "audit-index.json";
    private static final String ACK_JOURNAL_DIRECTORY = "ack-journal";
    private static final String CLEANUP_TOMBSTONE_DIRECTORY = "cleanup-tombstones";
    private static final String QUARANTINE_TXN_PREFIX = ".quarantine-txn-";
    private static final long AUDIT_MAX_BYTES = 4L * 1024L * 1024L;
    private static final long ACK_JOURNAL_RETENTION_MS = 96L * 60L * 60L * 1000L;
    private static final long ACK_JOURNAL_MAX_BYTES = 128L * 1024L * 1024L;
    private static final int ACK_JOURNAL_MAX_RECORDS = 100_000;
    private static final long SYNC_INTERVAL_MS = 1_000L;

    private final File root;
    private final File segmentsDirectory;
    private final File ackJournalDirectory;
    private final File cleanupTombstoneDirectory;
    private final File stateFile;
    private final File auditFile;
    private Policy policy;
    private final Clock clock;
    private final SpaceProbe spaceProbe;
    private final FileMover fileMover;
    private final Cutpoint cutpoint;
    private final int ackJournalMaxRecords;
    private final long ackJournalMaxBytes;
    private long nextAuditEventSequence = 1L;
    private long nextAuditSegmentSequence = 1L;
    private long auditFailures;
    private final Set<String> auditEventIds = new HashSet<>();
    private long nextSequence;
    private File activePartial;
    private File activePartialMetadata;
    private FileOutputStream activeOutput;
    private long activeSequence;
    private long activeStartedAt;
    private long activeBytes;
    private long lastSyncAt;
    private String activeSource = "";
    private String activeRoute = "";
    private String activeCaptureId = "";
    private String activeEventId = "";
    private String activeProcessingPolicy = "agent";
    private String activeTimeBasis = "received";
    private long lastCapturedAt;
    private long lastWrittenAt;
    private long lastUploadedAt;
    private long rejectedBytes;
    private long uncapturedGapBytes;
    private long totalCapturedBytes;
    private long totalAcknowledgedBytes;
    private long totalAcknowledgedSegments;
    private long acknowledgedAccountingSequence;
    private boolean inferAcknowledgedAccountingSequence;
    private long quarantinedAudioBytes;
    private long capturedGapBytes;
    private long accountedQuarantineManifestAudioBytes;
    private long accountedQuarantineManifestGapBytes;
    private long quarantineBytes;
    private long quarantineItems;
    private String lastFailure = "";
    private long totalStoredBytes;
    private long lastCleanupAt;
    private long ackJournalBytes;
    private long ackJournalRecords;
    private long ackJournalMaxSourceSequence;
    private final List<File> recoveredCleanupTombstones = new ArrayList<>();
    private final TreeSet<Long> pendingSequences = new TreeSet<>();
    private final TreeSet<Long> transcriptionSequences = new TreeSet<>();
    private final TreeSet<Long> localSequences = new TreeSet<>();
    private final TreeSet<Long> unscopedSequences = new TreeSet<>();
    private boolean allDayOnly;
    private long lastJournalPruneAt;
    // Rebuilt during recovery and updated by the same owner as pendingSequences.
    // Health and fsync must never reread the entire retained queue under the writer lock.
    private final java.util.Map<Long, Long> pendingByteIndex = new java.util.HashMap<>();
    private long indexedPendingBytes;
    private final TreeSet<Long> acknowledgedSequences = new TreeSet<>();

    RabiDurableAudioSpool(File root, Policy policy) throws Exception {
        this(root, policy, System::currentTimeMillis, File::getUsableSpace,
                RabiDurableAudioSpool::moveReplacing, stage -> { });
    }

    RabiDurableAudioSpool(File root, Policy policy, Clock clock, SpaceProbe spaceProbe) throws Exception {
        this(root, policy, clock, spaceProbe, RabiDurableAudioSpool::moveReplacing, stage -> { });
    }

    RabiDurableAudioSpool(File root, Policy policy, Clock clock, SpaceProbe spaceProbe,
                          FileMover fileMover) throws Exception {
        this(root, policy, clock, spaceProbe, fileMover, stage -> { });
    }

    RabiDurableAudioSpool(File root, Policy policy, Clock clock, SpaceProbe spaceProbe,
                          FileMover fileMover, Cutpoint cutpoint) throws Exception {
        this(root, policy, clock, spaceProbe, fileMover, cutpoint,
                ACK_JOURNAL_MAX_RECORDS, ACK_JOURNAL_MAX_BYTES);
    }

    RabiDurableAudioSpool(File root, Policy policy, Clock clock, SpaceProbe spaceProbe,
                          FileMover fileMover, Cutpoint cutpoint,
                          int ackJournalMaxRecords, long ackJournalMaxBytes) throws Exception {
        if (ackJournalMaxRecords < 1 || ackJournalMaxBytes < 1L) {
            throw new IllegalArgumentException("invalid durable acknowledgement journal capacity");
        }
        this.root = root;
        this.policy = policy;
        this.clock = clock;
        this.spaceProbe = spaceProbe;
        this.fileMover = fileMover;
        this.cutpoint = cutpoint;
        this.ackJournalMaxRecords = ackJournalMaxRecords;
        this.ackJournalMaxBytes = ackJournalMaxBytes;
        this.segmentsDirectory = new File(root, "segments");
        this.ackJournalDirectory = new File(root, ACK_JOURNAL_DIRECTORY);
        this.cleanupTombstoneDirectory = new File(root, CLEANUP_TOMBSTONE_DIRECTORY);
        this.stateFile = new File(root, STATE_FILE);
        this.auditFile = new File(root, AUDIT_FILE);
        ensureDirectory(root);
        ensureDirectory(segmentsDirectory);
        ensureDirectory(ackJournalDirectory);
        ensureDirectory(cleanupTombstoneDirectory);
        recover();
        // Recovered events have no live writer. Seal their ASR boundary after recovering partial PCM.
        for (long sequence : new ArrayList<>(pendingSequences)) {
            Segment item = readSegment(metadataForSequence(sequence));
            if (item != null && "transcribe".equals(item.processingPolicy) && !item.eventId.isEmpty()) completeEvent(item.eventId);
        }
    }

    synchronized AppendResult append(byte[] pcm, String source, String routeProfileId) {
        return append(pcm, source, routeProfileId, "", "agent");
    }

    synchronized AppendResult append(byte[] pcm, String source, String routeProfileId, String captureId, String processingPolicy) {
        return append(pcm, source, routeProfileId, captureId, processingPolicy, 0L, "received");
    }
    synchronized AppendResult append(byte[] pcm, String source, String routeProfileId, String captureId, String processingPolicy, long capturedAt, String timeBasis) {
        return append(pcm, source, routeProfileId, captureId, processingPolicy, capturedAt, timeBasis, "");
    }
    synchronized AppendResult append(byte[] pcm, String source, String routeProfileId, String captureId, String processingPolicy, long capturedAt, String timeBasis, String eventId) {
        if (!java.util.Arrays.asList("local_only", "transcribe", "agent").contains(processingPolicy))
            throw new IllegalArgumentException("unknown audio processing policy");
        captureId = clean(captureId, "");
        if (pcm == null || pcm.length == 0) return new AppendResult(true, activeSequence, "");
        if ((pcm.length & 1) != 0) {
            recordGap("invalid_pcm_alignment", pcm.length, source, routeProfileId);
            return new AppendResult(false, 0L, "invalid_pcm_alignment");
        }
        long now = clock.now();
        lastCapturedAt = now;
        int offset = 0;
        String normalizedSource = clean(source, "phone");
        String normalizedRoute = clean(routeProfileId, "");
        try {
            if (!activeEventId.isEmpty() && (!activeEventId.equals(eventId) || !activeCaptureId.equals(captureId))) {
                sealActive("event_boundary");
                completeEvent(activeEventId);
            }
            if (activeOutput != null && (!activeSource.equals(normalizedSource) || !activeRoute.equals(normalizedRoute)
                    || !activeCaptureId.equals(captureId) || !activeEventId.equals(eventId) || !activeProcessingPolicy.equals(processingPolicy))) {
                sealActive("state_boundary");
            }
            if (now - lastCleanupAt >= 60_000L) cleanupAcknowledged(false);
            long writtenSequence = activeSequence;
            while (offset < pcm.length) {
                if (activeOutput != null && now - activeStartedAt >= policy.maxSegmentDurationMs) {
                    sealActive("duration_boundary");
                }
                long room = activeOutput == null ? policy.maxSegmentBytes : policy.maxSegmentBytes - activeBytes;
                if (room < 2L) {
                    sealActive("size_boundary");
                    continue;
                }
                int count = (int) Math.min((long) pcm.length - offset, room);
                count &= ~1;
                if (count <= 0) throw new IllegalStateException("invalid even PCM shard boundary");
                if (!hasStorageFor(count)) {
                    if (activeOutput != null) sealActive("storage_boundary");
                    cleanupAcknowledged(true);
                    if (!hasStorageFor(count)) {
                        long rejected = pcm.length - offset;
                        recordGap("storage_low", rejected, normalizedSource, normalizedRoute);
                        return new AppendResult(false, writtenSequence, "storage_low");
                    }
                }
                if (activeOutput == null) {
                    activeCaptureId = captureId;
                    activeEventId = eventId;
                    activeProcessingPolicy = processingPolicy;
                    activeTimeBasis = timeBasis;
                    openActive(normalizedSource, normalizedRoute, capturedAt > 0L ? capturedAt + offset * 1000L / 32000L : now);
                }
                activeOutput.write(pcm, offset, count);
                offset += count;
                activeBytes += count;
                totalStoredBytes += count;
                totalCapturedBytes += count;
                writtenSequence = activeSequence;
                lastWrittenAt = now;
                if (now - lastSyncAt >= SYNC_INTERVAL_MS) syncActive(now);
                if (activeBytes >= policy.maxSegmentBytes) sealActive("size_boundary");
            }
            return new AppendResult(true, writtenSequence, "");
        } catch (Throwable error) {
            String reason = "write_" + error.getClass().getSimpleName();
            recordGap(reason, Math.max(0L, pcm.length - offset), normalizedSource, normalizedRoute);
            return new AppendResult(false, 0L, reason);
        }
    }

    /** New whole-event writes are fail-closed: only a durable commit may publish their ASR boundary. */
    synchronized AppendResult appendCompleteEvent(byte[] pcm, String source, String route, String captureId,
                                                  String processingPolicy, long capturedAt, String timeBasis, String eventId) {
        if (eventId == null || !eventId.matches("[A-Za-z0-9_-]{1,120}"))
            throw new IllegalArgumentException("invalid event id");
        if (pcm == null || pcm.length == 0 || (pcm.length & 1) != 0)
            return new AppendResult(false, 0L, "invalid_event_pcm");
        File intentFile = new File(root, "event-intent-" + eventId + ".json");
        try {
            String digest = sha256(pcm);
            if (intentFile.exists()) {
                JSONObject prior = readJson(intentFile);
                if (prior.getLong("expectedBytes") != pcm.length || !digest.equals(prior.getString("sha256"))
                        || !captureId.equals(prior.getString("captureId")) || !source.equals(prior.getString("source"))
                        || !route.equals(prior.getString("route")) || !processingPolicy.equals(prior.getString("processingPolicy")))
                    return new AppendResult(false, 0L, "event_identity_conflict");
                if (!"committed".equals(prior.optString("state")))
                    return new AppendResult(false, 0L, "event_incomplete");
                completeEvent(eventId);
                return new AppendResult(true, prior.optLong("sequence"), "");
            }
            if (new File(root, "event-" + eventId + ".json").exists())
                return new AppendResult(false, 0L, "legacy_event_identity_conflict");
            JSONObject intent = new JSONObject().put("version", 1).put("state", "prepared")
                    .put("eventId", eventId).put("captureId", captureId).put("source", source).put("route", route)
                    .put("processingPolicy", processingPolicy).put("expectedBytes", pcm.length).put("sha256", digest);
            writeJson(intentFile, intent);
            long firstSequence = nextSequence;
            AppendResult result = append(pcm, source, route, captureId, processingPolicy, capturedAt, timeBasis, eventId);
            // Keep partial PCM for diagnosis; endCapture/recovery must not promote it to a complete event.
            if (!result.accepted) return result;
            sealActive("event_commit");
            long bytes = 0;
            java.io.ByteArrayOutputStream retained = new java.io.ByteArrayOutputStream(pcm.length);
            java.util.List<Segment> eventSegments = new ArrayList<>();
            for (long sequence = firstSequence; sequence < nextSequence; sequence++) {
                Segment segment = readSegment(metadataForSequence(sequence));
                if (segment != null && eventId.equals(segment.eventId) && captureId.equals(segment.captureId)) eventSegments.add(segment);
            }
            eventSegments.sort(Comparator.comparingLong(item -> item.sequence));
            for (Segment segment : eventSegments) {
                if (segment != null && eventId.equals(segment.eventId) && captureId.equals(segment.captureId)) {
                    byte[] body = Files.readAllBytes(segment.pcmFile.toPath());
                    if (body.length != segment.bytes || !sha256(body).equals(segment.sha256))
                        return new AppendResult(false, result.segmentSequence, "event_integrity_failed");
                    retained.write(body); bytes += body.length;
                }
            }
            if (bytes != pcm.length || !digest.equals(sha256(retained.toByteArray())))
                return new AppendResult(false, result.segmentSequence, "event_integrity_failed");
            writeJson(intentFile, intent.put("state", "committed").put("sequence", result.segmentSequence));
            completeEvent(eventId);
            if ("transcribe".equals(processingPolicy)) {
                archiveCandidates.put(eventId,captureId);
                for(Segment item:eventSegments)indexArchiveSummary(readJson(item.metadataFile));
            }
            return result;
        } catch (Exception error) {
            return new AppendResult(false, 0L, "event_commit_" + error.getClass().getSimpleName());
        }
    }

    synchronized void updatePolicy(Policy policy) {
        if (policy == null) return;
        this.policy = policy;
        cleanupAcknowledged(false);
    }

    synchronized void sealCapture() throws Exception { sealActive("capture_end"); completeEvent(activeEventId); }

    synchronized void completeEvent(String eventId) throws Exception {
        if (eventId == null || eventId.isEmpty()) return;
        if (!eventId.matches("[A-Za-z0-9_-]{1,120}")) throw new IllegalArgumentException("invalid event id");
        if (!eventCommitted(eventId)) return;
        writeJson(new File(root, "event-" + eventId + ".json"), new JSONObject().put("complete", true));
    }

    private boolean eventCommitted(String eventId) {
        if (eventId == null || eventId.isEmpty()) return true;
        File intent = new File(root, "event-intent-" + eventId + ".json");
        if (!intent.exists()) return true; // Historical events retain their existing contract.
        try { return "committed".equals(readJson(intent).getString("state")); }
        catch (Exception error) { return false; }
    }

    /** A complete VAD event may span several storage shards. Never transcribe a partial event. */
    synchronized List<Segment> transcriptionEvent(Segment head) throws Exception {
        List<Segment> result = new ArrayList<>();
        if (head.eventId.isEmpty() || !eventCommitted(head.eventId) || !new File(root, "event-" + head.eventId + ".json").isFile()) return result;
        long bytes = 0;
        for (long sequence : new ArrayList<>(pendingSequences)) {
            Segment item = readSegment(metadataForSequence(sequence));
            if (item == null) continue;
            if (!item.eventId.equals(head.eventId) || !item.captureId.equals(head.captureId)) {
                if (!result.isEmpty()) break;
                continue;
            }
            bytes += item.bytes;
            if (bytes > 4 * 1024 * 1024) throw new IllegalStateException("ASR event exceeds size bound");
            result.add(item);
        }
        result.sort(Comparator.comparingLong(item -> item.sequence));
        File intentFile = new File(root, "event-intent-" + head.eventId + ".json");
        if (intentFile.exists()) {
            JSONObject intent = readJson(intentFile);
            if (bytes != intent.getLong("expectedBytes")) return new ArrayList<>();
            java.io.ByteArrayOutputStream body = new java.io.ByteArrayOutputStream((int) bytes);
            for (Segment item : result) body.write(Files.readAllBytes(item.pcmFile.toPath()));
            if (!sha256(body.toByteArray()).equals(intent.getString("sha256"))) return new ArrayList<>();
        }
        return result;
    }

    /** Explicit ASR enrollment of retained local events; never reassign Agent or already-bound ASR work. */
    synchronized boolean enrollLocalEventsForAsr(long before, String identity, String activeCapture) throws Exception {
        if (!identity.startsWith("asr:")) throw new IllegalArgumentException("ASR account required");
        boolean complete = true;
        int enrolled = 0;
        String lastEvent = "";
        String legacyCapture = "", legacyEvent = "";
        long legacyBytes = 0;
        for (long sequence : new ArrayList<>(localSequences)) {
            File file = metadataForSequence(sequence);
            Segment item = readSegment(file);
            if (item == null || !"local_only".equals(item.processingPolicy)) continue;
            JSONObject value = readJson(file);
            if (value.optLong("startedAt") > before) continue;
            if (item.captureId.equals(activeCapture)) { complete = false; continue; }
            if (enrolled >= 32 && (item.eventId.isEmpty() || !item.eventId.equals(lastEvent))) return false; // Bound disk work while capture remains active.
            File descriptorFile = new File(root, "capture-" + item.captureId + ".json");
            JSONObject descriptor = descriptorFile.exists() ? readJson(descriptorFile) : new JSONObject().put("captureId", item.captureId);
            String prior = descriptor.optString("endpointIdentity");
            if (prior.startsWith("asr:") && !prior.equals(identity)) continue;
            descriptor.put("endpointIdentity", identity);
            writeJson(descriptorFile, descriptor);
            String eventId = item.eventId;
            if (eventId.isEmpty()) {
                if (!legacyCapture.equals(item.captureId) || legacyBytes + item.bytes > 1_920_000L) {
                    legacyCapture = item.captureId; legacyEvent = "backfill-" + item.id; legacyBytes = 0;
                }
                eventId = legacyEvent; legacyBytes += item.bytes;
                value.put("eventId", eventId);
            }
            completeEvent(eventId);
            value.put("processingPolicy", "transcribe");
            writeJson(file, value);
            transcriptionSequences.add(sequence);
            localSequences.remove(sequence);
            lastEvent = eventId;
            enrolled++;
        }
        return complete;
    }

    synchronized JSONObject eventReceipt(String eventId) throws Exception {
        File file = new File(root, "asr-" + eventId + ".json");
        return file.isFile() ? readJson(file) : null;
    }

    synchronized void saveEventReceipt(String eventId, JSONObject receipt) throws Exception {
        if (!eventId.matches("[A-Za-z0-9_-]{1,120}")) throw new IllegalArgumentException("invalid event id");
        writeJson(new File(root, "asr-" + eventId + ".json"), receipt);
    }

    /** Single-record resumable import. The descriptor gates uploads until the complete PCM is durable. */
    synchronized boolean importCapture(String source, String route, String processingPolicy, String captureId, File pcm) throws Exception {
        return importCapture(source, route, processingPolicy, captureId, pcm, 0L);
    }
    synchronized boolean importCapture(String source, String route, String processingPolicy, String captureId, File pcm, long capturedAt) throws Exception {
        return importCapture(source, route, processingPolicy, captureId, pcm, capturedAt,
                new com.rabi.link.recording.AudioEventSplitter.Policy(500, 60000));
    }
    synchronized boolean importCapture(String source, String route, String processingPolicy, String captureId, File pcm,
                                       long capturedAt, com.rabi.link.recording.AudioEventSplitter.Policy requestedPolicy) throws Exception {
        if (captureId == null || !captureId.matches("[A-Za-z0-9_-]{1,100}")) throw new IllegalArgumentException("invalid capture id");
        if (!java.util.Arrays.asList("local_only", "transcribe", "agent").contains(processingPolicy)) throw new IllegalArgumentException("invalid policy");
        long length = pcm.length();
        if (!pcm.isFile() || length == 0 || (length & 1) != 0) throw new IllegalArgumentException("invalid PCM input");
        MessageDigest digest = MessageDigest.getInstance("SHA-256");
        try (FileInputStream input = new FileInputStream(pcm)) { byte[] buffer = new byte[32768]; int n;
            while ((n = input.read(buffer)) != -1) digest.update(buffer, 0, n); }
        StringBuilder hash = new StringBuilder(); for (byte b : digest.digest()) hash.append(String.format(Locale.US, "%02x", b & 255));
        File descriptor = new File(root, "import-" + captureId + ".json");
        JSONObject state;
        if (descriptor.exists()) {
            state = readJson(descriptor);
            if (!hash.toString().equals(state.getString("sha256")) || length != state.getLong("bytes")
                    || !source.equals(state.getString("source")) || !route.equals(state.getString("routeProfileId"))
                    || !processingPolicy.equals(state.getString("processingPolicy"))) throw new IllegalStateException("import identity changed");
            if (state.optBoolean("complete")) return true;
            if (state.optInt("version") != 2) throw new IllegalStateException("legacy incomplete import requires explicit recovery");
            if (state.getLong("capturedAt") != capturedAt) throw new IllegalStateException("import timestamp changed");
        } else {
            state = new JSONObject().put("version", 2).put("sha256", hash.toString()).put("bytes", length).put("source", source)
                    .put("routeProfileId", route).put("processingPolicy", processingPolicy).put("complete", false)
                    .put("capturedAt", capturedAt).put("inputProcessedBytes", 0L).put("acousticPolicy", acousticPolicyJson(requestedPolicy));
            writeJson(descriptor, state);
        }
        final com.rabi.link.recording.AudioEventSplitter.Policy frozen = acousticPolicyFromJson(state.getJSONObject("acousticPolicy"));
        com.rabi.link.recording.AudioEventSplitter splitter = new com.rabi.link.recording.AudioEventSplitter(() -> frozen);
        sealActive("import_boundary");
        // Replay source from zero to reconstruct adaptive/pre-roll state. Committed event IDs make this idempotent.
        // inputProcessedBytes is source progress only; retained output bytes may omit arbitrary silent intervals.
        long offset = 0;
        MessageDigest processedDigest = MessageDigest.getInstance("SHA-256");
        try (FileInputStream input = new FileInputStream(pcm)) {
            byte[] buffer = new byte[32000]; int count;
            while ((count = input.read(buffer)) != -1) {
                processedDigest.update(buffer, 0, count);
                if (!persistImportedEvents(splitter.accept(captureId, Arrays.copyOf(buffer, count)), offset,
                        hash.toString(), source, route, captureId, processingPolicy, capturedAt)) return false;
                offset += count;
                state.put("inputProcessedBytes", offset); writeJson(descriptor, state);
            }
        }
        StringBuilder processedHash = new StringBuilder();
        for (byte b : processedDigest.digest()) processedHash.append(String.format(Locale.US, "%02x", b & 255));
        if (offset != length || !hash.toString().equals(processedHash.toString()))
            throw new IllegalStateException("import source changed during processing");
        if (!persistImportedEvents(splitter.finish(), offset, hash.toString(), source, route, captureId, processingPolicy, capturedAt)) return false;
        state.put("complete", true); writeJson(descriptor, state);
        return true;
    }

    private boolean persistImportedEvents(java.util.List<com.rabi.link.recording.AudioEventSplitter.Part> parts,
                                          long origin, String inputHash, String source, String route, String captureId,
                                          String processingPolicy, long capturedAt) throws Exception {
        for (com.rabi.link.recording.AudioEventSplitter.Part part : parts) {
            long start = origin + part.offset, end = start + part.pcm.length;
            String eventId = "import-" + sha256((captureId + ":" + inputHash + ":" + start + ":" + end).getBytes(StandardCharsets.UTF_8));
            AppendResult result = appendCompleteEvent(part.pcm, source, route, captureId, processingPolicy,
                    capturedAt > 0 ? capturedAt + start * 1000L / 32000L : 0L,
                    capturedAt > 0 ? "media" : "imported", eventId);
            if (!result.accepted) return false;
        }
        return true;
    }

    private static JSONObject acousticPolicyJson(com.rabi.link.recording.AudioEventSplitter.Policy p) throws Exception {
        return new JSONObject().put("silenceMs", p.silenceMs).put("maxMs", p.maxMs).put("preRollMs", p.preRollMs)
                .put("minUtteranceMs", p.minUtteranceMs).put("recordThreshold", p.recordThreshold)
                .put("transcribeThreshold", p.transcribeThreshold).put("adaptiveThreshold", p.adaptiveThreshold)
                .put("adaptiveMultiplier", p.adaptiveMultiplier).put("adaptiveMargin", p.adaptiveMargin).put("inputGain", p.inputGain);
    }
    private static com.rabi.link.recording.AudioEventSplitter.Policy acousticPolicyFromJson(JSONObject p) throws Exception {
        return new com.rabi.link.recording.AudioEventSplitter.Policy(p.getInt("silenceMs"), p.getInt("maxMs"),
                p.getInt("preRollMs"), p.getInt("minUtteranceMs"), p.getDouble("recordThreshold"), p.getDouble("transcribeThreshold"),
                p.getBoolean("adaptiveThreshold"), p.getDouble("adaptiveMultiplier"), p.getDouble("adaptiveMargin"), p.getDouble("inputGain"));
    }

    private String currentEndpointIdentity = "";
    private String currentAsrIdentity = "";
    synchronized void setAsrEndpointIdentity(String identity) { currentAsrIdentity = identity == null ? "" : identity; }
    synchronized void setEndpointIdentity(String identity) { currentEndpointIdentity = identity == null ? "" : identity; }
    synchronized void bindCaptureEndpoint(String captureId, String identity) throws Exception {
        if (captureId == null || !captureId.matches("[A-Za-z0-9_-]{1,100}")) throw new IllegalArgumentException("invalid capture id");
        File file = new File(root, "capture-" + captureId + ".json");
        if (file.exists()) return; // Never rebind a previously unbound/offline record implicitly.
        writeJson(file, new JSONObject().put("captureId", captureId).put("endpointIdentity", identity == null ? "" : identity));
    }
    synchronized void bindDerivedEndpoint(String derivedId, String parentId) throws Exception {
        File parent = new File(root, "capture-" + parentId + ".json");
        String identity = parent.exists() ? readJson(parent).optString("endpointIdentity", "") : "";
        bindCaptureEndpoint(derivedId, identity);
        File child = new File(root, "capture-" + derivedId + ".json");
        JSONObject descriptor = readJson(child);
        descriptor.put("parentCaptureId", parentId); writeJson(child, descriptor);
    }

    synchronized String captureEndpointIdentity(String captureId) throws Exception {
        if (captureId.isEmpty()) return "";
        File descriptor = new File(root, "capture-" + captureId + ".json");
        return descriptor.exists() ? readJson(descriptor).optString("endpointIdentity", "") : "";
    }

    private boolean endpointMatches(String captureId) throws Exception {
        if (captureId.isEmpty()) return true; // Preserve pre-unification behavior for legacy queues.
        File descriptor = new File(root, "capture-" + captureId + ".json");
        if (!descriptor.exists()) return false;
        String saved = readJson(descriptor).optString("endpointIdentity");
        String current = saved.startsWith("asr:") ? currentAsrIdentity : currentEndpointIdentity;
        return !current.isEmpty() && current.equals(saved);
    }

    private boolean importComplete(String captureId) throws Exception {
        if (captureId.isEmpty()) return true;
        File descriptor = new File(root, "import-" + captureId + ".json");
        return !descriptor.exists() || readJson(descriptor).optBoolean("complete");
    }

    synchronized void boundary(String reason) {
        try {
            sealActive(clean(reason, "state_boundary"));
        } catch (Throwable error) {
            recordGap("seal_" + error.getClass().getSimpleName(), 0L, activeSource, activeRoute);
        }
    }

    synchronized void recordGap(String reason, long estimatedBytes, String source, String routeProfileId) {
        recordGapWithId("gap-" + UUID.randomUUID(), reason, estimatedBytes, source, routeProfileId, true);
    }

    private void recordGapWithId(String gapId, String reason, long estimatedBytes,
                                 String source, String routeProfileId, boolean uncaptured) {
        String auditId = "audit-" + clean(gapId, "gap-unknown");
        if (auditEventIds.contains(auditId)) return;
        rejectedBytes += Math.max(0L, estimatedBytes);
        if (uncaptured) uncapturedGapBytes += Math.max(0L, estimatedBytes);
        lastFailure = clean(reason, "capture_gap");
        try {
            long now = clock.now();
            appendAuditWithId(auditId, "gap", new JSONObject()
                    .put("gapId", gapId)
                    .put("reason", lastFailure)
                    .put("estimatedBytes", Math.max(0L, estimatedBytes))
                    .put("accountingClass", uncaptured ? "uncaptured" : "captured")
                    .put("startedAt", now)
                    .put("endedAt", now)
                    .put("previousSequence", Math.max(0L, nextSequence - 1L))
                    .put("nextSequence", Math.max(1L, nextSequence))
                    .put("source", clean(source, "phone"))
                    .put("routeProfileId", clean(routeProfileId, "")));
        } catch (Throwable error) {
            lastFailure = "audit_gap_" + error.getClass().getSimpleName();
        }
        try { persistState(); } catch (Throwable error) {
            lastFailure = "state_gap_" + error.getClass().getSimpleName();
        }
    }

    /** All-day recording never dispatches pre-recording, unscoped message audio. Originals remain on disk. */
    synchronized void retireUnscopedUploads() {
        allDayOnly = true;
        for (long sequence : new ArrayList<>(unscopedSequences)) removePending(sequence);
    }

    synchronized Segment nextUpload() { return nextUpload(pendingSequences); }
    synchronized Segment nextTranscriptionUpload() { return nextUpload(transcriptionSequences); }
    private Segment nextUpload(TreeSet<Long> candidates) {
        for (long sequence : new ArrayList<>(candidates)) {
            File metadata = metadataForSequence(sequence);
            try {
                Segment segment = readSegment(metadata);
                // Local-only and unbound recordings are retained, never guessed into a destination.
                if (segment != null && !"acked".equals(segment.uploadState)) {
                    // Archive-authorized transcription has its own coordinator. Leave bytes pending, but do not block legacy ASR.
                    if ("transcribe".equals(segment.processingPolicy) && isArchiveAuthorizedCapture(segment.captureId)) continue;
                    if (!eventCommitted(segment.eventId) || !importComplete(segment.captureId) || !endpointMatches(segment.captureId)) continue;
                    if ("local_only".equals(segment.processingPolicy)
                            || (!segment.captureId.isEmpty() && segment.routeProfileId.isEmpty() && !("transcribe".equals(segment.processingPolicy) && !segment.eventId.isEmpty()))) continue;
                    if (!"agent".equals(segment.processingPolicy) && !"transcribe".equals(segment.processingPolicy)) continue;
                    return segment;
                }
                removePending(sequence);
            } catch (Throwable error) {
                boolean isolated = poisonSequence(sequence, metadata,
                        "metadata_" + error.getClass().getSimpleName(), "unknown", "", 0L);
                if (!isolated) return null;
            }
        }
        return null;
    }

    synchronized Segment nextUpload(String source, String routeProfileId) {
        Segment segment = nextUpload();
        if (segment == null) return null;
        String normalizedSource = clean(source, "phone");
        String normalizedRoute = clean(routeProfileId, "");
        return segment.source.equals(normalizedSource) && segment.routeProfileId.equals(normalizedRoute)
                ? segment : null;
    }

    synchronized Segment assignServerSequence(Segment segment, long serverSequence) throws Exception {
        if (segment == null || serverSequence <= 0L) throw new IllegalArgumentException("invalid upload assignment");
        JSONObject value = readJson(segment.metadataFile);
        value.put("uploadState", "uploading")
                .put("serverSequence", serverSequence)
                .put("lastAttemptAt", clock.now())
                .put("attempts", value.optInt("attempts", 0) + 1);
        value.remove("lastError");
        writeJson(segment.metadataFile, value);
        return readSegment(segment.metadataFile);
    }

    synchronized boolean acknowledge(String segmentId, long serverSequence, long acceptedBytes, String checksum) throws Exception {
        File metadata = metadataForId(segmentId);
        if (!metadata.exists()) return false;
        JSONObject value = readJson(metadata);
        if (!clean(segmentId, "").equals(value.optString("id", ""))
                || value.optLong("serverSequence", 0L) != serverSequence
                || value.optLong("bytes", -1L) != acceptedBytes
                || !value.optString("sha256", "").equalsIgnoreCase(clean(checksum, ""))) {
            throw new IllegalStateException("audio acknowledgement does not match sealed shard");
        }
        if ("acked".equals(value.optString("uploadState"))) {
            ensureAckJournal(value);
            return true;
        }
        long now = clock.now();
        JSONObject receipt = new JSONObject(value.toString()).put("acknowledgedAt", now);
        ensureAckJournal(receipt);
        cutpoint.reached("ack_receipt_committed");
        completeAcknowledgement(metadata, value, receipt);
        return true;
    }

    private void completeAcknowledgement(File metadata, JSONObject value, JSONObject receipt) throws Exception {
        long localSequence = receipt.getLong("sequence");
        long acceptedBytes = receipt.getLong("bytes");
        long now = receipt.getLong("acknowledgedAt");
        value.put("uploadState", "acked")
                .put("acknowledgedAt", now)
                .put("serverSequence", receipt.getLong("serverSequence"));
        value.remove("lastError");
        writeJson(metadata, value);
        cutpoint.reached("ack_metadata_committed");
        removePending(localSequence);
        acknowledgedSequences.add(localSequence);
        accountAcknowledged(localSequence, acceptedBytes);
        lastUploadedAt = now;
        lastFailure = "";
        persistState();
        cutpoint.reached("ack_state_committed");
        appendAudit("acknowledged", new JSONObject().put("id", receipt.getString("id")).put("sequence", localSequence)
                .put("serverSequence", receipt.getLong("serverSequence")).put("bytes", acceptedBytes));
        cleanupAcknowledged(false);
        persistState();
    }

    synchronized void markUploadFailure(Segment segment, Throwable error) {
        if (segment == null) return;
        try {
            JSONObject current = readJson(segment.metadataFile);
            if ("acked".equals(current.optString("uploadState", ""))) return;
            File receiptFile = ackJournalForSequence(segment.sequence);
            if (receiptFile.exists()) {
                JSONObject receipt = readAckJournalRecord(receiptFile);
                if (!ackTupleMatchesMetadata(receipt, current)) {
                    throw new IllegalStateException("durable acknowledgement receipt conflicts with upload metadata");
                }
                completeAcknowledgement(segment.metadataFile, current, journalAsMetadata(receipt, current));
                return;
            }
            String detail = error == null ? "upload_failed" : clean(error.getMessage(), error.getClass().getSimpleName());
            if (detail.length() > 240) detail = detail.substring(0, 240);
            JSONObject value = current
                    .put("uploadState", "failed")
                    .put("lastError", detail)
                    .put("lastFailureAt", clock.now());
            writeJson(segment.metadataFile, value);
            lastFailure = value.optString("lastError", "upload_failed");
            appendAudit("upload_failed", new JSONObject().put("id", segment.id).put("reason", lastFailure));
            persistState();
        } catch (Throwable ignored) {
            lastFailure = "upload_state_write_failed";
        }
    }

    synchronized boolean reconcileLastServerAck(long serverSequence, String segmentId,
                                                 long acceptedBytes, String checksum) throws Exception {
        Segment segment = nextUpload();
        if (segment == null || segment.serverSequence <= 0L) return false;
        if (segment.serverSequence != serverSequence
                || !segment.id.equals(clean(segmentId, ""))
                || segment.bytes != acceptedBytes
                || !segment.sha256.equalsIgnoreCase(clean(checksum, ""))) return false;
        return acknowledge(segment.id, serverSequence, segment.bytes, segment.sha256);
    }

    synchronized void resetHeadServerAssignment() throws Exception {
        Segment segment = nextUpload();
        if (segment == null || segment.serverSequence == 0L) return;
        JSONObject value = readJson(segment.metadataFile).put("uploadState", "sealed").put("serverSequence", 0L);
        writeJson(segment.metadataFile, value);
    }

    private final java.util.Map<String,JSONObject> archiveSummaries = new java.util.HashMap<>();
    private final java.util.Map<String,java.util.List<File>> archiveSummaryFiles = new java.util.HashMap<>();
    private final java.util.LinkedHashMap<String,String> archiveCandidates = new java.util.LinkedHashMap<>();
    private void indexArchiveSummary(JSONObject row) throws Exception {
        String id=row.optString("eventId"); if(!archiveCandidates.containsKey(id))return;
        String capture=archiveCandidates.get(id);
        if(!capture.equals(row.optString("captureId")) || !"transcribe".equals(row.optString("processingPolicy")))return;
        JSONObject summary=archiveSummaries.get(id);
        if(summary==null) {
            summary=new JSONObject().put("recordId",id).put("eventId",id).put("captureId",capture)
                    .put("source",row.getString("source")).put("startedAt",row.getLong("startedAt"))
                    .put("endedAt",row.getLong("endedAt")).put("totalBytes",0L);
            archiveSummaries.put(id,summary);archiveSummaryFiles.put(id,new ArrayList<>());
        }
        if(!summary.getString("source").equals(row.getString("source")))throw new IllegalArgumentException("archive summary source mismatch");
        summary.put("startedAt",Math.min(summary.getLong("startedAt"),row.getLong("startedAt")))
                .put("endedAt",Math.max(summary.getLong("endedAt"),row.getLong("endedAt")))
                .put("totalBytes",summary.getLong("totalBytes")+row.getLong("bytes"));
        archiveSummaryFiles.get(id).add(new File(segmentsDirectory,new File(row.getString("pcmFileName")).getName()));
    }
    /** Metadata projection only. Media presence is not a checksum verification or upload approval. */
    synchronized JSONArray archivePendingSummaries(com.rabi.link.recording.RecordingArchiveCoordinator.Target target,int limit) throws Exception {
        JSONArray rows=new JSONArray();
        for(String id:nextArchiveCandidates(target,limit)) {
            JSONObject cached=archiveSummaries.get(id);if(cached==null)continue;
            JSONObject intent=readJson(new File(root,"event-intent-"+id+".json"));
            if(cached.getLong("totalBytes")!=intent.getLong("expectedBytes"))continue;
            boolean present=true;for(File file:archiveSummaryFiles.get(id))if(!file.isFile()){present=false;break;}
            rows.put(new JSONObject(cached.toString()).put("owner",target.owner).put("workerId",target.workerId)
                    .put("storageNamespaceId",target.namespace).put("localMediaPresent",present)
                    .put("archiveState",present?"pending":"blocked").put("reason",present?"":"missing_local_media")
                    .put("uploadable",present));
        }
        return rows;
    }
    synchronized boolean isArchiveAuthorizedCapture(String captureId) {
        try { JSONObject t=readJson(new File(root,"archive-target-"+archiveId(captureId)+".json"));
            return t.getLong("bindingRevision")>0 && !t.getString("owner").isEmpty(); }
        catch(Exception invalid){return false;}
    }
    synchronized java.util.List<String> nextArchiveCandidates(com.rabi.link.recording.RecordingArchiveCoordinator.Target target,int limit) {
        java.util.List<String> result=new ArrayList<>();
        for(java.util.Map.Entry<String,String> item:archiveCandidates.entrySet()) {
            if(result.size()>=Math.max(0,Math.min(limit,32)))break;
            try {requireArchiveTarget(item.getValue(),target);result.add(item.getKey());}catch(Exception unauthorized){}
        }
        return result;
    }
    private void recoverArchiveCandidates() throws Exception {
        archiveCandidates.clear(); archiveSummaries.clear(); archiveSummaryFiles.clear();
        File[] intents=root.listFiles((dir,name)->name.startsWith("event-intent-")&&name.endsWith(".json"));
        if(intents==null)return;
        for(File file:intents)try { JSONObject row=readJson(file); String id=row.getString("eventId");
            if("committed".equals(row.optString("state")) && "transcribe".equals(row.optString("processingPolicy"))) {
                try{validatedArchive(id);}catch(Exception absent){archiveCandidates.put(id,row.getString("captureId"));}
            }
        }catch(Exception invalid){}
    }
    private final java.util.LinkedHashMap<String,String> pendingArchiveEvictions = new java.util.LinkedHashMap<>();
    private final java.util.Set<Long> archivedLedgerSequences = new java.util.HashSet<>();
    private boolean recoveringArchiveEvictions;
    synchronized java.util.List<String> nextArchiveEvictions(com.rabi.link.recording.RecordingArchiveCoordinator.Target target,int limit) {
        java.util.List<String> ids=new ArrayList<>();
        for(java.util.Map.Entry<String,String> item:pendingArchiveEvictions.entrySet()) {
            if(ids.size()>=Math.max(0,Math.min(32,limit)))break;
            try{requireArchiveTarget(item.getValue(),target);ids.add(item.getKey());}catch(Exception unauthorized){}
        }
        return ids;
    }
    synchronized JSONObject archiveEvictionReceipt(com.rabi.link.recording.RecordingArchiveCoordinator.Target target,String id) throws Exception {
        JSONObject saved=validatedArchive(id);requireArchiveTarget(saved.getJSONObject("manifest").getString("captureId"),target);
        return new JSONObject().put("manifest",saved.getJSONObject("manifest")).put("receipt",saved.getJSONObject("receipt"));
    }
    private void recoverPendingArchiveEvictions() {
        pendingArchiveEvictions.clear();
        File[] receipts=root.listFiles((dir,name)->name.startsWith("archive-receipt-")&&name.endsWith(".json"));
        if(receipts==null)return;
        for(File file:receipts)try {
            String id=file.getName().substring("archive-receipt-".length(),file.getName().length()-5);
            JSONObject saved=validatedArchive(id);File intent=new File(root,"archive-eviction-"+id+".json");
            if(intent.exists() && "complete".equals(readJson(intent).optString("state")))continue;
            pendingArchiveEvictions.put(id,saved.getJSONObject("manifest").getString("captureId"));
        }catch(Exception invalid){lastFailure="archive_receipt_invalid";}
    }
    private void accountArchivedRow(JSONObject row) throws Exception {
        long sequence=row.getLong("sequence");
        if(archivedLedgerSequences.add(sequence)) {
            long bytes=Math.max(0L,row.getLong("bytes"));archivedBytes+=bytes;
            if(!"acked".equals(row.optString("uploadState")))archivedUnacknowledgedBytes+=bytes;
        }
        removePending(sequence);
    }
    private long archivedBytes, archivedUnacknowledgedBytes;
    /** Pin every event touched by a local reader before resolving/opening any PCM; close after its last read. */
    synchronized AutoCloseable pinLocalEvents(java.util.Collection<String> eventIds) {
        final java.util.Set<String> ids = new java.util.HashSet<>();
        for (String id : eventIds) ids.add(archiveId(id));
        for (String id : ids) archivePins.put(id, archivePins.getOrDefault(id, 0) + 1);
        return new AutoCloseable() {
            private boolean closed;
            public void close() { synchronized (RabiDurableAudioSpool.this) {
                if (closed) return; closed = true;
                for (String id : ids) { int n = archivePins.getOrDefault(id, 1) - 1;
                    if (n <= 0) archivePins.remove(id); else archivePins.put(id, n); }
            } }
        };
    }
    private final java.util.Map<String,Integer> archivePins = new java.util.HashMap<>();
    private static String archiveId(String id) {
        if (id == null || !id.matches("[A-Za-z0-9_-]{1,120}")) throw new IllegalArgumentException("archive id");
        return id;
    }
    private JSONObject archiveTarget(com.rabi.link.recording.RecordingArchiveCoordinator.Target target) throws Exception {
        if (target == null || !target.uploadAllowed || target.bindingRevision < 1) throw new IllegalArgumentException("archive authorization required");
        return new JSONObject().put("workerId", target.workerId).put("namespace", target.namespace)
                .put("owner", target.owner).put("bindingRevision", target.bindingRevision);
    }
    synchronized void authorizeArchive(String captureId, com.rabi.link.recording.RecordingArchiveCoordinator.Target target) throws Exception {
        File file = new File(root,"archive-target-" + archiveId(captureId) + ".json");
        JSONObject value = archiveTarget(target);
        if (file.exists()) { requireArchiveTarget(captureId,target); return; }
        writeJson(file,value);
    }
    private void requireArchiveTarget(String captureId, com.rabi.link.recording.RecordingArchiveCoordinator.Target target) throws Exception {
        JSONObject saved = readJson(new File(root,"archive-target-" + archiveId(captureId) + ".json"));
        JSONObject expected = archiveTarget(target);
        for (String key : new String[]{"workerId","namespace","owner","bindingRevision"})
            if (!saved.get(key).toString().equals(expected.get(key).toString())) throw new IllegalArgumentException("archive target changed");
    }
    private final java.util.Map<String,String> verifiedArchiveManifests=new java.util.HashMap<>();
    private final java.util.Map<String,Integer> archiveSnapshotRefs=new java.util.HashMap<>();
    synchronized com.rabi.link.recording.RecordingArchiveCoordinator.Snapshot acquireArchiveSnapshot(String eventId,
            com.rabi.link.recording.RecordingArchiveCoordinator.Target target) throws Exception {
        archiveId(eventId);
        JSONObject transaction = readJson(new File(root,"event-intent-" + eventId + ".json"));
        if (!"committed".equals(transaction.getString("state")) || !"transcribe".equals(transaction.getString("processingPolicy"))
                || eventId.equals(activeEventId) && activeOutput != null) throw new IllegalArgumentException("archive event not sealed");
        String capture = transaction.getString("captureId"); requireArchiveTarget(capture,target);
        java.util.List<Segment> segments = new ArrayList<>();
        java.util.List<File> indexed=archiveSummaryFiles.get(eventId);
        if(indexed==null)throw new IllegalStateException("archive event index missing");
        for (File pcmReference : new ArrayList<>(indexed)) {
            File file=metadataForSequence(sequenceFromName(pcmReference.getName()));
            JSONObject row = readJson(file);
            if (eventId.equals(row.optString("eventId"))) {
                if (!capture.equals(row.optString("captureId")) || !transaction.getString("source").equals(row.optString("source"))
                        || !"transcribe".equals(row.optString("processingPolicy"))) throw new IllegalArgumentException("archive attribution");
                Segment segment = readSegment(file); if (segment == null || !segment.pcmFile.isFile()) throw new IllegalStateException("archive media absent");
                segments.add(segment);
            }
        }
        segments.sort(Comparator.comparingLong(s -> s.sequence));
        archivePins.put(eventId,archivePins.getOrDefault(eventId,0)+1);
        return new com.rabi.link.recording.RecordingArchiveCoordinator.Snapshot() {
            private volatile boolean closed;
            private JSONObject cachedManifest;
            private String publishedHash;
            private final java.util.Map<String,long[]> objectRanges=new java.util.HashMap<>();
            private String digestHex(byte[] digest) {
                StringBuilder hex=new StringBuilder();for(byte b:digest)hex.append(String.format(Locale.US,"%02x",b&255));return hex.toString();
            }
            private synchronized void prepare() throws Exception {
                if(closed)throw new IllegalStateException("snapshot closed");
                if(cachedManifest!=null)return;
        JSONArray objects=new JSONArray();objectRanges.clear();
        byte[] buffer=new byte[1048576];cutpoint.reached("archive_buffer_1048576");
        int objectBytes=0;long totalBytes=0,objectOffset=0;
        MessageDigest eventDigest=MessageDigest.getInstance("SHA-256"),objectDigest=MessageDigest.getInstance("SHA-256");
        JSONArray items = new JSONArray(); long start = Long.MAX_VALUE, end = 0; String basis = "received";
        for (Segment s : segments) {
            MessageDigest segmentDigest=MessageDigest.getInstance("SHA-256");long segmentBytes=0;
            try(FileInputStream input=new FileInputStream(s.pcmFile)) {
                int n;while((n=input.read(buffer,0,1048576-objectBytes))!=-1) {
                    if(closed)throw new IllegalStateException("snapshot closed");
                    segmentBytes+=n;totalBytes+=n;
                    if(segmentBytes>s.bytes || totalBytes>com.rabi.link.recording.RecordingArchiveContract.MAX_BYTES)throw new IllegalArgumentException("archive size");
                    segmentDigest.update(buffer,0,n);eventDigest.update(buffer,0,n);objectDigest.update(buffer,0,n);objectBytes+=n;
                    if(objectBytes==1048576) {
                        String digest=digestHex(objectDigest.digest());
                        objects.put(new JSONObject().put("sha256",digest).put("bytes",objectBytes).put("offset",objectOffset));
                        objectRanges.putIfAbsent(digest,new long[]{objectOffset,objectBytes});objectOffset+=objectBytes;objectBytes=0;
                    }
                }
            }
            if(segmentBytes!=s.bytes || !digestHex(segmentDigest.digest()).equals(s.sha256))throw new IllegalArgumentException("archive segment integrity");
            JSONObject row = readJson(s.metadataFile); String nextBasis = row.getString("timeBasis");
            if (items.length()>0 && !basis.equals(nextBasis)) throw new IllegalArgumentException("archive time basis mismatch");
            basis = nextBasis;
            start = Math.min(start,s.startedAt); end = Math.max(end,s.startedAt + (s.bytes + 31) / 32);
            items.put(new JSONObject().put("sequence",s.sequence).put("bytes",s.bytes).put("sha256",s.sha256).put("startedAt",s.startedAt));
        }
        if (totalBytes != transaction.getLong("expectedBytes") || !digestHex(eventDigest.digest()).equals(transaction.getString("sha256"))) throw new IllegalArgumentException("archive event integrity");
        if(objectBytes>0) {
            String digest=digestHex(objectDigest.digest());
            objects.put(new JSONObject().put("sha256",digest).put("bytes",objectBytes).put("offset",objectOffset));
            objectRanges.putIfAbsent(digest,new long[]{objectOffset,objectBytes});
        }
        final JSONObject manifest = com.rabi.link.recording.RecordingArchiveContract.validateRecordingManifest(new JSONObject()
                .put("schemaVersion",1).put("recordId",eventId).put("captureId",capture).put("eventId",eventId).put("deviceId",target.owner)
                .put("source",transaction.getString("source")).put("startedAt",start).put("endedAt",end).put("timeBasis",basis)
                .put("format",new JSONObject().put("codec","pcm_s16le").put("sampleRate",16000).put("channels",1))
                .put("segments",items).put("objects",objects).put("gaps",new JSONArray()).put("processingPolicy","transcribe")
                .put("totalBytes",totalBytes).put("sealed",true));
        String verifiedHash=com.rabi.link.recording.RecordingArchiveContract.recordingManifestHash(manifest);
        synchronized(RabiDurableAudioSpool.this) {
            if(closed)throw new IllegalStateException("snapshot closed");
            String existing=verifiedArchiveManifests.get(eventId);
            if(existing!=null && !existing.equals(verifiedHash))throw new IllegalArgumentException("snapshot identity changed");
            verifiedArchiveManifests.put(eventId,verifiedHash);
            archiveSnapshotRefs.put(eventId,archiveSnapshotRefs.getOrDefault(eventId,0)+1);
            publishedHash=verifiedHash;
        }
        cachedManifest=manifest;
            }
            public JSONObject manifest() throws Exception { prepare(); return new JSONObject(cachedManifest.toString()); }
            public com.rabi.link.recording.RecordingArchiveCoordinator.Target target() { return target; }
            public boolean complete() { return !closed; }
            public synchronized java.io.InputStream openObject(String sha) throws Exception {
                prepare();long[] range=objectRanges.get(sha);if(range==null)throw new IllegalArgumentException("snapshot object");
                byte[] body=new byte[(int)range[1]];long segmentStart=0;int written=0;
                for(Segment s:segments) {
                    long from=Math.max(range[0],segmentStart),to=Math.min(range[0]+range[1],segmentStart+s.bytes);
                    if(from<to) {
                        if(closed)throw new IllegalStateException("snapshot closed");
                        try(java.io.RandomAccessFile input=new java.io.RandomAccessFile(s.pcmFile,"r")) {
                            if(input.length()!=s.bytes)throw new IllegalArgumentException("archive source length changed");
                            input.seek(from-segmentStart);int count=(int)(to-from);input.readFully(body,written,count);written+=count;
                        }
                    }
                    segmentStart+=s.bytes;
                }
                if(closed || written!=body.length || !sha256(body).equals(sha))throw new IllegalArgumentException("archive object integrity");
                return new java.io.ByteArrayInputStream(body);
            }
            public void close() { synchronized(RabiDurableAudioSpool.this) {
                if(closed)return; closed=true;
                int n=archivePins.getOrDefault(eventId,1)-1; if(n==0)archivePins.remove(eventId);else archivePins.put(eventId,n);
                if(publishedHash!=null) {
                    int refs=archiveSnapshotRefs.getOrDefault(eventId,1)-1;
                    if(refs<=0) {archiveSnapshotRefs.remove(eventId);verifiedArchiveManifests.remove(eventId,publishedHash);}
                    else archiveSnapshotRefs.put(eventId,refs);
                }
            } }
        };
    }
    synchronized void persistArchiveReceipt(com.rabi.link.recording.RecordingArchiveCoordinator.Target target, JSONObject manifest, JSONObject receipt) throws Exception {
        manifest = com.rabi.link.recording.RecordingArchiveContract.validateRecordingManifest(manifest);
        requireArchiveTarget(manifest.getString("captureId"),target);
        if(!target.owner.equals(manifest.getString("deviceId")))throw new IllegalArgumentException("archive owner");
        JSONObject verified=com.rabi.link.recording.RecordingArchiveContract.validateArchiveReceipt(receipt,target.workerId,target.namespace,manifest);
        String recordId=archiveId(manifest.getString("recordId"));
        if(!com.rabi.link.recording.RecordingArchiveContract.recordingManifestHash(manifest).equals(verifiedArchiveManifests.get(recordId)))
            throw new IllegalArgumentException("archive manifest has no verified snapshot");
        JSONObject committed=readJson(new File(root,"event-intent-"+recordId+".json"));
        if(!"committed".equals(committed.getString("state")) || committed.getLong("expectedBytes")!=manifest.getLong("totalBytes")
                || !committed.getString("captureId").equals(manifest.getString("captureId")))throw new IllegalArgumentException("archive event changed");
        writeJson(new File(root,"archive-receipt-"+archiveId(manifest.getString("recordId"))+".json"),
                new JSONObject().put("manifest",manifest).put("receipt",verified).put("target",archiveTarget(target)));
        archiveCandidates.remove(recordId); archiveSummaries.remove(recordId); archiveSummaryFiles.remove(recordId);
        pendingArchiveEvictions.put(recordId,manifest.getString("captureId"));
    }
    synchronized boolean evictArchive(com.rabi.link.recording.RecordingArchiveCoordinator.Target target, JSONObject manifest, JSONObject receipt, boolean remoteReady) throws Exception {
        if(!remoteReady)return false;
        String id=archiveId(manifest.getString("recordId"));
        if(archivePins.getOrDefault(id,0)>0 || id.equals(activeEventId) && activeOutput!=null || !eventCommitted(id))return false;
        requireArchiveTarget(manifest.getString("captureId"),target);
        com.rabi.link.recording.RecordingArchiveContract.validateArchiveReceipt(receipt,target.workerId,target.namespace,manifest);
        JSONObject saved=validatedArchive(id);
        if(!com.rabi.link.recording.RecordingArchiveContract.recordingManifestHash(saved.getJSONObject("manifest")).equals(com.rabi.link.recording.RecordingArchiveContract.recordingManifestHash(manifest)))throw new IllegalArgumentException("archive receipt not persisted");
        writeJson(new File(root,"archive-eviction-"+id+".json"),new JSONObject().put("recordId",id).put("state","pending"));
        cutpoint.reached("archive_before_delete");
        return finishArchiveEviction(id);
    }
    private JSONObject validatedArchive(String id) throws Exception {
        JSONObject saved=readJson(new File(root,"archive-receipt-"+archiveId(id)+".json"));
        JSONObject t=saved.getJSONObject("target"), m=saved.getJSONObject("manifest");
        com.rabi.link.recording.RecordingArchiveCoordinator.Target target=new com.rabi.link.recording.RecordingArchiveCoordinator.Target(t.getString("workerId"),t.getString("namespace"),t.getString("owner"),t.getLong("bindingRevision"),true);
        requireArchiveTarget(m.getString("captureId"),target);
        if(!id.equals(m.getString("recordId")) || !target.owner.equals(m.getString("deviceId")))throw new IllegalArgumentException("archive identity");
        com.rabi.link.recording.RecordingArchiveContract.validateArchiveReceipt(saved.getJSONObject("receipt"),target.workerId,target.namespace,m);
        return saved;
    }
    private boolean finishArchiveEviction(String id) throws Exception {
        if(archivePins.getOrDefault(id,0)>0)return false;
        JSONObject saved=validatedArchive(id), manifest=saved.getJSONObject("manifest");
        JSONArray segments=manifest.getJSONArray("segments");
        for(int i=0;i<segments.length();i++) {
            JSONObject expected=segments.getJSONObject(i); File metadata=metadataForSequence(expected.getLong("sequence")); JSONObject row=readJson(metadata);
            if(!id.equals(row.optString("eventId")) || !manifest.getString("captureId").equals(row.optString("captureId"))
                    || row.getLong("bytes")!=expected.getLong("bytes") || !row.getString("sha256").equals(expected.getString("sha256")))throw new IllegalArgumentException("eviction segment identity");
            String name=row.getString("pcmFileName");
            if(!name.equals(new File(name).getName()) || name.contains("/") || name.contains("\\") || !name.endsWith(".pcm")
                    || sequenceFromName(name)!=expected.getLong("sequence"))throw new IllegalArgumentException("eviction PCM path");
            File file=new File(segmentsDirectory,name);
            if(!file.getCanonicalFile().getParentFile().equals(segmentsDirectory.getCanonicalFile()))throw new IllegalArgumentException("eviction PCM path");
            if(file.exists() && (file.length()!=expected.getLong("bytes") || !sha256(Files.readAllBytes(file.toPath())).equals(expected.getString("sha256"))))throw new IllegalArgumentException("eviction media integrity");
            row.put("localMediaState","eviction_pending").put("remoteRef",id); writeJson(metadata,row);
            if(!recoveringArchiveEvictions)accountArchivedRow(row);
            if(file.exists()) {
                long removed=file.length();
                if(!file.delete())return false;
                if(!recoveringArchiveEvictions)totalStoredBytes=Math.max(0L,totalStoredBytes-removed);
            }
            cutpoint.reached("archive_after_delete");
            writeJson(metadata,row.put("localMediaState","evicted"));
        }
        writeJson(new File(root,"archive-eviction-"+id+".json"),new JSONObject().put("recordId",id).put("state","complete"));
        pendingArchiveEvictions.remove(id);
        if(!recoveringArchiveEvictions)persistState(); return true;
    }
    private void recoverArchiveEvictions() {
        File[] intents=root.listFiles((dir,name)->name.startsWith("archive-eviction-")&&name.endsWith(".json"));
        if(intents==null)return;
        for(File file:intents)try { JSONObject intent=readJson(file); if(!"complete".equals(intent.optString("state")))finishArchiveEviction(intent.getString("recordId")); }
        catch(Exception failure){lastFailure="archive_recovery_blocked";}
    }

    synchronized boolean evictArchived(File file) throws Exception {
        if (!file.getCanonicalFile().getParentFile().equals(segmentsDirectory.getCanonicalFile())
                || !com.rabi.link.recording.RecordingResourceCache.isArchived(file)) return false;
        File metadata = metadataForSequence(sequenceFromName(file.getName()));
        if (metadata.isFile() && isArchiveAuthorizedCapture(readJson(metadata).optString("captureId"))) return false;
        Segment item = readSegment(metadata);
        if (item == null || isArchiveAuthorizedCapture(item.captureId) || archivePins.getOrDefault(item.eventId,0)>0 || !("acked".equals(item.uploadState) || "local_only".equals(item.processingPolicy))) return false;
        if (!file.exists()) return true;
        byte[] bytes = RabiReliableQueueFiles.read(file);
        if (bytes.length != item.bytes || !sha256(bytes).equals(item.sha256)) return false;
        if (!file.delete()) return false;
        totalStoredBytes = Math.max(0L,totalStoredBytes-bytes.length);
        appendAudit("media_archived_to_pc",new JSONObject().put("id",item.id).put("bytes",bytes.length));
        persistState(); return true;
    }

    synchronized byte[] readPcm(Segment segment) throws Exception {
        if (segment == null) return new byte[0];
        byte[] data = RabiReliableQueueFiles.read(com.rabi.link.recording.RecordingResourceCache.resolve(segment.pcmFile));
        if (data.length != segment.bytes || !sha256(data).equalsIgnoreCase(segment.sha256)) {
            boolean isolated = poisonSegment(segment, "checksum_mismatch");
            throw new PoisonedSegmentException("sealed audio shard checksum mismatch", isolated);
        }
        return data;
    }

    synchronized JSONObject health() {
        JSONObject value = new JSONObject();
        try {
            long pendingAudioBytes = pendingAudioBytes();
            long accountedCapturedBytes = totalAcknowledgedBytes + pendingAudioBytes + activeBytes
                    + quarantinedAudioBytes + capturedGapBytes + archivedUnacknowledgedBytes;
            value.put("lastCapturedAt", lastCapturedAt)
                    .put("lastWrittenAt", lastWrittenAt)
                    .put("lastUploadedAt", lastUploadedAt)
                    .put("activePartialBytes", activeBytes)
                    .put("pendingSegments", pendingSequences.size())
                    .put("pendingBytes", pendingAudioBytes)
                    .put("acknowledgedSegments", acknowledgedSequences.size())
                    .put("storedBytes", totalStoredBytes)
                    .put("quarantineBytes", quarantineBytes)
                    .put("quarantineItems", quarantineItems)
                    .put("rejectedBytes", rejectedBytes)
                    .put("uncapturedGapBytes", uncapturedGapBytes)
                    .put("totalCapturedBytes", totalCapturedBytes)
                    .put("archivedBytes", archivedBytes)
                    .put("archivedUnacknowledgedBytes", archivedUnacknowledgedBytes)
                    .put("totalAcknowledgedBytes", totalAcknowledgedBytes)
                    .put("totalAcknowledgedSegments", totalAcknowledgedSegments)
                    .put("ackJournalRecords", ackJournalRecords)
                    .put("ackJournalBytes", ackJournalBytes)
                    .put("ackJournalMaxSourceSequence", ackJournalMaxSourceSequence)
                    .put("ackJournalRetentionHours", ACK_JOURNAL_RETENTION_MS / (60L * 60L * 1000L))
                    .put("ackJournalMaxRecords", ackJournalMaxRecords)
                    .put("ackJournalMaxBytes", ackJournalMaxBytes)
                    .put("quarantinedAudioBytes", quarantinedAudioBytes)
                    .put("capturedGapBytes", capturedGapBytes)
                    .put("accountedCapturedBytes", accountedCapturedBytes)
                    .put("accountingBalanced", totalCapturedBytes == accountedCapturedBytes)
                    .put("auditFailures", auditFailures)
                    .put("nextAuditEventSequence", nextAuditEventSequence)
                    .put("lastFailure", lastFailure);
        } catch (Throwable ignored) { }
        return value;
    }

    synchronized JSONObject acknowledgedJournal(long afterSourceSequence) throws Exception {
        JSONArray records = new JSONArray();
        long maximum = Math.max(0L, afterSourceSequence);
        for (File file : journalFiles()) {
            JSONObject record = readAckJournalRecord(file);
            long sequence = record.getLong("sourceSequence");
            maximum = Math.max(maximum, sequence);
            if (sequence > afterSourceSequence) records.put(record);
        }
        return new JSONObject()
                .put("afterSourceSequence", Math.max(0L, afterSourceSequence))
                .put("records", records)
                .put("maxSourceSequence", maximum)
                .put("retentionHours", ACK_JOURNAL_RETENTION_MS / (60L * 60L * 1000L))
                .put("maxRecords", ackJournalMaxRecords)
                .put("maxBytes", ackJournalMaxBytes);
    }

    synchronized void close() {
        boundary("process_stop");
    }

    private void recover() throws Exception {
        recoverAuditIndex();
        long persistedNext = loadState();
        recoverQuarantineTransactions();
        recoverAckJournal();
        recoverAckReceipts();
        recoverAcknowledgedCleanupTransactions();
        recoveringArchiveEvictions=true;
        try { recoverArchiveEvictions(); } finally { recoveringArchiveEvictions=false; }
        recoverPendingArchiveEvictions();
        archivedBytes=archivedUnacknowledgedBytes=0;archivedLedgerSequences.clear();
        recoverArchiveCandidates();
        totalStoredBytes = 0;
        long maximumSequence = 0L;
        File[] files = segmentsDirectory.listFiles();
        if (files == null) files = new File[0];
        Arrays.sort(files, Comparator.comparing(File::getName));
        for (File file : files) {
            long sequence = sequenceFromName(file.getName());
            maximumSequence = Math.max(maximumSequence, sequence);
            if (!file.getName().endsWith(".pcm.partial")) continue;
            File partialMetadata = partialMetadataFor(file);
            JSONObject ownership = readPartialOwnershipOrNull(partialMetadata);
            String source = ownership == null ? "unknown" : ownership.optString("source", "unknown");
            String route = ownership == null ? "" : ownership.optString("routeProfileId", "");
            if (file.length() <= 0L) {
                file.delete();
                partialMetadata.delete();
                appendAudit("partial_discarded", new JSONObject().put("sequence", sequence).put("reason", "empty"));
                continue;
            }
            if (ownership == null) {
                long bytes = file.length();
                poisonSequence(sequence, partialMetadata, "partial_missing_ownership",
                        "unknown", "", bytes, file);
                continue;
            }
            if ((file.length() & 1L) != 0L) {
                poisonSequence(sequence, partialMetadata, "partial_invalid_alignment",
                        source, route, file.length(), file);
                continue;
            }
            String base = file.getName().substring(0, file.getName().length() - ".partial".length());
            File sealed = new File(segmentsDirectory, base);
            moveReplacing(file, sealed);
            long startedAt = ownership.optLong("startedAt", timestampFromName(file.getName()));
            createMetadata(sequence, startedAt, startedAt + sealed.length() * 1000L / 32000L, sealed, source, route, "crash_recovery",
                    ownership.optString("captureId", ""), ownership.optString("processingPolicy", "agent"), ownership.optString("timeBasis", "received"), ownership.optString("eventId", ""));
            partialMetadata.delete();
            appendAudit("partial_recovered", new JSONObject().put("sequence", sequence).put("bytes", sealed.length())
                    .put("source", source).put("routeProfileId", route));
        }
        for (File pcm : pcmFiles()) {
            long sequence = sequenceFromName(pcm.getName());
            maximumSequence = Math.max(maximumSequence, sequence);
            totalStoredBytes += pcm.length();
            File metadata = metadataForSequence(sequence);
            if (!metadata.exists()) {
                File ownershipFile = partialMetadataForSealed(pcm);
                JSONObject ownership = readPartialOwnershipOrNull(ownershipFile);
                if (ownership == null) {
                    long bytes = pcm.length();
                    totalStoredBytes = Math.max(0L, totalStoredBytes - bytes);
                    poisonSequence(sequence, ownershipFile, "sealed_missing_ownership",
                            "unknown", "", bytes, pcm);
                    continue;
                }
                String source = ownership.optString("source", "unknown");
                String route = ownership.optString("routeProfileId", "");
                createMetadata(sequence, ownership.optLong("startedAt", timestampFromName(pcm.getName())),
                        ownership.optLong("startedAt", timestampFromName(pcm.getName())) + pcm.length() * 1000L / 32000L, pcm, source, route, "metadata_recovery",
                        ownership.optString("captureId", ""), ownership.optString("processingPolicy", "agent"), ownership.optString("timeBasis", "received"), ownership.optString("eventId", ""));
                ownershipFile.delete();
                appendAudit("metadata_recovered", new JSONObject().put("sequence", sequence).put("bytes", pcm.length())
                        .put("source", source).put("routeProfileId", route));
            }
        }
        pendingSequences.clear();
        transcriptionSequences.clear();
        localSequences.clear();
        unscopedSequences.clear();
        pendingByteIndex.clear();
        indexedPendingBytes = 0L;
        acknowledgedSequences.clear();
        for (File metadata : metadataFiles()) {
            try {
                JSONObject value = readJson(metadata);
                indexArchiveSummary(value);
                long sequence = value.optLong("sequence", sequenceFromName(metadata.getName()));
                if (value.has("remoteRef")) { accountArchivedRow(value); continue; } // Rebuild once in the startup metadata pass.
                if ("acked".equals(value.optString("uploadState", "sealed"))) {
                    try {
                        ensureAckJournal(value);
                    } catch (Throwable receiptError) {
                        lastFailure = "ack_receipt_" + receiptError.getClass().getSimpleName();
                        appendAudit("ack_receipt_recovery_failed", new JSONObject()
                                .put("id", value.optString("id", ""))
                                .put("sequence", sequence)
                                .put("reason", lastFailure));
                    }
                    acknowledgedSequences.add(sequence);
                    if (inferAcknowledgedAccountingSequence) {
                        acknowledgedAccountingSequence = Math.max(acknowledgedAccountingSequence, sequence);
                    } else {
                        accountAcknowledged(sequence, value.optLong("bytes", 0L));
                    }
                } else addPending(sequence, value.optLong("bytes", 0L), value);
            } catch (Throwable error) {
                poisonSequence(sequenceFromName(metadata.getName()), metadata,
                        "metadata_" + error.getClass().getSimpleName(), "unknown", "", metadata.length());
            }
        }
        inferAcknowledgedAccountingSequence = false;
        nextSequence = Math.max(persistedNext, maximumSequence + 1L);
        measureQuarantine();
        reconcileQuarantineAccounting();
        totalStoredBytes = quarantineBytes;
        for (File pcm : pcmFiles()) totalStoredBytes += pcm.length();
        reconcileCapturedAccounting();
        persistState();
        completeRecoveredCleanupTransactions();
        cleanupAcknowledged(false);
    }

    private long loadState() {
        if (!stateFile.exists()) return 1L;
        try {
            JSONObject state = readJson(stateFile);
            lastCapturedAt = state.optLong("lastCapturedAt", 0L);
            lastWrittenAt = state.optLong("lastWrittenAt", 0L);
            lastUploadedAt = state.optLong("lastUploadedAt", 0L);
            rejectedBytes = state.optLong("rejectedBytes", 0L);
            uncapturedGapBytes = state.optLong("uncapturedGapBytes", 0L);
            totalCapturedBytes = state.optLong("totalCapturedBytes", 0L);
            totalAcknowledgedBytes = state.optLong("totalAcknowledgedBytes", 0L);
            totalAcknowledgedSegments = state.optLong("totalAcknowledgedSegments", 0L);
            if (state.has("acknowledgedAccountingSequence")) {
                acknowledgedAccountingSequence = state.optLong("acknowledgedAccountingSequence", 0L);
            } else if (totalAcknowledgedSegments > 0L) {
                inferAcknowledgedAccountingSequence = true;
            }
            quarantinedAudioBytes = state.optLong("quarantinedAudioBytes", 0L);
            capturedGapBytes = state.optLong("capturedGapBytes", 0L);
            accountedQuarantineManifestAudioBytes = state.optLong("accountedQuarantineManifestAudioBytes", 0L);
            accountedQuarantineManifestGapBytes = state.optLong("accountedQuarantineManifestGapBytes", 0L);
            auditFailures = Math.max(auditFailures, state.optLong("auditFailures", 0L));
            lastFailure = state.optString("lastFailure", "");
            return Math.max(1L, state.optLong("nextSequence", 1L));
        } catch (Throwable error) {
            JSONObject details = new JSONObject();
            try { details.put("reason", error.getClass().getSimpleName()); } catch (Throwable ignored) { }
            appendAudit("state_recovered", details);
            return 1L;
        }
    }

    private void openActive(String source, String route, long startedAt) throws Exception {
        activeSequence = nextSequence++;
        persistState();
        activeStartedAt = startedAt;
        activeBytes = 0L;
        activeSource = source;
        activeRoute = route;
        activePartial = new File(segmentsDirectory, String.format(Locale.US, "%020d-%013d.pcm.partial", activeSequence, startedAt));
        activePartialMetadata = partialMetadataFor(activePartial);
        writeJson(activePartialMetadata, new JSONObject()
                .put("schemaVersion", 1)
                .put("sequence", activeSequence)
                .put("startedAt", startedAt)
                .put("source", source)
                .put("routeProfileId", route)
                .put("captureId", activeCaptureId)
                .put("eventId", activeEventId)
                .put("processingPolicy", activeProcessingPolicy)
                .put("timeBasis", activeTimeBasis)
                .put("pcmFileName", activePartial.getName()));
        activeOutput = new FileOutputStream(activePartial, true);
        lastSyncAt = startedAt;
        appendAudit("partial_opened", new JSONObject().put("sequence", activeSequence).put("source", source)
                .put("routeProfileId", route));
    }

    private void syncActive(long now) throws Exception {
        if (activeOutput == null) return;
        activeOutput.flush();
        activeOutput.getFD().sync();
        lastSyncAt = now;
        persistState();
    }

    private void sealActive(String reason) throws Exception {
        if (activeOutput == null) return;
        File partial = activePartial;
        File partialMetadata = activePartialMetadata;
        long sequence = activeSequence;
        long startedAt = activeStartedAt;
        long bytes = activeBytes;
        String source = activeSource;
        String route = activeRoute;
        syncActive(clock.now());
        activeOutput.close();
        activeOutput = null;
        activePartial = null;
        activePartialMetadata = null;
        activeBytes = 0L;
        activeSequence = 0L;
        activeSource = "";
        activeRoute = "";
        if (bytes <= 0L) {
            partial.delete();
            if (partialMetadata != null) partialMetadata.delete();
            persistState();
            return;
        }
        File sealed = new File(segmentsDirectory, partial.getName().substring(0, partial.getName().length() - ".partial".length()));
        moveReplacing(partial, sealed);
        createMetadata(sequence, startedAt, startedAt + bytes * 1000L / 32000L, sealed, source, route, reason, activeCaptureId, activeProcessingPolicy, activeTimeBasis, activeEventId);
        if (partialMetadata != null) partialMetadata.delete();
        appendAudit("sealed", new JSONObject().put("sequence", sequence).put("bytes", bytes).put("reason", reason));
        persistState();
    }

    private void createMetadata(long sequence, long startedAt, long endedAt, File pcm, String source,
                                String route, String reason, String captureId, String processingPolicy, String timeBasis, String eventId) throws Exception {
        byte[] body = RabiReliableQueueFiles.read(pcm);
        JSONObject value = new JSONObject()
                .put("schemaVersion", 1)
                .put("id", idFor(sequence))
                .put("sequence", sequence)
                .put("startedAt", startedAt)
                .put("endedAt", endedAt)
                .put("bytes", body.length)
                .put("sha256", sha256(body))
                .put("pcmFileName", pcm.getName())
                .put("source", clean(source, "phone"))
                .put("routeProfileId", clean(route, ""))
                .put("captureId", captureId)
                .put("eventId", eventId)
                .put("processingPolicy", processingPolicy)
                .put("timeBasis", timeBasis)
                .put("sealReason", clean(reason, "boundary"))
                .put("uploadState", "sealed")
                .put("serverSequence", 0L)
                .put("attempts", 0);
        writeJson(metadataForSequence(sequence), value);
        addPending(sequence, body.length, value);
    }

    private void cleanupAcknowledged(boolean pressure) {
        // All-day records retain their PCM after ASR; the retired transport cache has no live cleanup owner.
        if (allDayOnly) { lastCleanupAt = clock.now(); return; }
        long now = clock.now();
        lastCleanupAt = now;
        for (long sequence : new ArrayList<>(acknowledgedSequences)) {
            File metadata = metadataForSequence(sequence);
            try {
                Segment segment = readSegment(metadata);
                if (segment == null || !"acked".equals(segment.uploadState)) {
                    acknowledgedSequences.remove(sequence);
                    continue;
                }
                // A user-visible recording is not a disposable transport copy.
                // Retain until an explicit record retention/delete operation is implemented.
                if (!segment.captureId.isEmpty()) continue;
                boolean expired = now - segment.acknowledgedAt >= policy.acknowledgedRetentionMs;
                boolean storagePressure = pressure || totalStoredBytes > policy.maxStorageBytes;
                if (!expired && !storagePressure) continue;
                ensureAckJournal(readJson(metadata));
                File tombstone = cleanupTombstoneForSequence(sequence);
                if (!tombstone.exists()) {
                    writeJson(tombstone, new JSONObject()
                            .put("schemaVersion", 1)
                            .put("id", segment.id)
                            .put("sequence", segment.sequence)
                            .put("bytes", segment.bytes)
                            .put("sha256", segment.sha256)
                            .put("source", segment.source)
                            .put("serverSequence", segment.serverSequence)
                            .put("acknowledgedAt", segment.acknowledgedAt)
                            .put("pcmFileName", segment.pcmFile.getName())
                            .put("metadataFileName", metadata.getName())
                            .put("reason", storagePressure ? "storage_pressure" : "retention_expired")
                            .put("createdAt", now));
                }
                cleanupCutpoint("cleanup_before_pcm_delete");
                if (segment.pcmFile.exists() && !segment.pcmFile.delete()) continue;
                cleanupCutpoint("cleanup_between_pcm_and_metadata_delete");
                if (metadata.exists() && !metadata.delete()) continue;
                cleanupCutpoint("cleanup_after_metadata_delete_before_state");
                totalStoredBytes = Math.max(0L, totalStoredBytes - segment.bytes);
                acknowledgedSequences.remove(sequence);
                appendAudit(storagePressure ? "acked_pruned_for_storage" : "acked_retention_expired",
                        new JSONObject().put("id", segment.id).put("bytes", segment.bytes));
                persistState();
                if (tombstone.exists() && !tombstone.delete()) {
                    lastFailure = "cleanup_tombstone_retained";
                }
            } catch (CleanupInterruptedException error) {
                throw error;
            } catch (Throwable ignored) { }
        }
    }

    private void cleanupCutpoint(String stage) {
        try {
            cutpoint.reached(stage);
        } catch (Throwable error) {
            throw new CleanupInterruptedException(stage, error);
        }
    }

    private void recoverAcknowledgedCleanupTransactions() throws Exception {
        recoveredCleanupTombstones.clear();
        for (File tombstoneFile : cleanupTombstoneFiles()) {
            JSONObject tombstone = readJson(tombstoneFile);
            long sequence = tombstone.getLong("sequence");
            String id = tombstone.getString("id");
            if (sequence <= 0L || !idFor(sequence).equals(id)) {
                throw new IllegalStateException("invalid acknowledged cleanup tombstone identity");
            }
            ensureAckJournal(tombstone);
            File pcm = safeCleanupTarget(tombstone.getString("pcmFileName"));
            File metadata = safeCleanupTarget(tombstone.getString("metadataFileName"));
            if (pcm.exists() && !pcm.delete()) throw new IllegalStateException("cannot complete acknowledged PCM cleanup");
            if (metadata.exists() && !metadata.delete()) {
                throw new IllegalStateException("cannot complete acknowledged metadata cleanup");
            }
            recoveredCleanupTombstones.add(tombstoneFile);
        }
    }

    private void completeRecoveredCleanupTransactions() {
        for (File tombstone : new ArrayList<>(recoveredCleanupTombstones)) {
            if (!tombstone.exists() || tombstone.delete()) recoveredCleanupTombstones.remove(tombstone);
        }
    }

    private File safeCleanupTarget(String fileName) {
        String leaf = new File(clean(fileName, "")).getName();
        if (leaf.isEmpty() || !leaf.equals(fileName)) {
            throw new IllegalStateException("invalid acknowledged cleanup target");
        }
        return new File(segmentsDirectory, leaf);
    }

    private void recoverAckJournal() throws Exception {
        RabiReliableQueueFiles.cleanupTemporaryFiles(ackJournalDirectory);
        RabiReliableQueueFiles.cleanupTemporaryFiles(cleanupTombstoneDirectory);
        pruneAckJournal();
        measureAckJournal();
    }

    private void recoverAckReceipts() throws Exception {
        // Recovery holds the sole spool owner. Index once instead of scanning every file for each receipt.
        java.util.Map<Long, File> recoveredPcm = new java.util.HashMap<>();
        for (File file : pcmFiles()) recoveredPcm.putIfAbsent(sequenceFromName(file.getName()), file);
        for (File receiptFile : journalFiles()) {
            JSONObject receipt = readAckJournalRecord(receiptFile);
            long sequence = receipt.getLong("sourceSequence");
            File metadataFile = metadataForSequence(sequence);
            if (!metadataFile.exists()) continue;
            JSONObject metadata = readJson(metadataFile);
            if (!ackTupleMatchesMetadata(receipt, metadata)) {
                throw new IllegalStateException("durable acknowledgement receipt conflicts with upload metadata");
            }
            JSONObject acknowledgement = journalAsMetadata(receipt, metadata);
            if (!"acked".equals(metadata.optString("uploadState", ""))
                    || metadata.optLong("acknowledgedAt", 0L) != acknowledgement.getLong("acknowledgedAt")) {
                metadata.put("uploadState", "acked")
                        .put("acknowledgedAt", acknowledgement.getLong("acknowledgedAt"))
                        .put("serverSequence", acknowledgement.getLong("serverSequence"));
                metadata.remove("lastError");
                writeJson(metadataFile, metadata);
                appendAudit("ack_receipt_recovered", new JSONObject()
                        .put("id", acknowledgement.getString("id"))
                        .put("sequence", sequence)
                        .put("serverSequence", acknowledgement.getLong("serverSequence")));
            }
            File pcm = recoveredPcm.get(sequence);
            File archivedPcm = new File(segmentsDirectory, metadata.optString("pcmFileName", "missing"));
            if (com.rabi.link.recording.RecordingResourceCache.isArchived(archivedPcm)) continue;
            if (pcm == null || !pcm.exists()) {
                File tombstone = cleanupTombstoneForSequence(sequence);
                if (!tombstone.exists()) {
                    writeJson(tombstone, new JSONObject()
                            .put("schemaVersion", 1)
                            .put("id", acknowledgement.getString("id"))
                            .put("sequence", sequence)
                            .put("bytes", acknowledgement.getLong("bytes"))
                            .put("sha256", acknowledgement.getString("sha256"))
                            .put("source", acknowledgement.optString("source", "phone"))
                            .put("serverSequence", acknowledgement.getLong("serverSequence"))
                            .put("acknowledgedAt", acknowledgement.getLong("acknowledgedAt"))
                            .put("pcmFileName", metadata.optString("pcmFileName", pcm == null ? "missing" : pcm.getName()))
                            .put("metadataFileName", metadataFile.getName())
                            .put("reason", "receipt_recovery")
                            .put("createdAt", clock.now()));
                }
            }
        }
    }

    private void ensureAckJournal(JSONObject source) throws Exception {
        long sequence = source.optLong("sequence", source.optLong("sourceSequence", 0L));
        String chunkId = source.optString("id", source.optString("chunkId", ""));
        long bytes = source.optLong("bytes", source.optLong("acceptedBytes", -1L));
        String checksum = source.optString("sha256", "").toLowerCase(Locale.US);
        long serverSequence = source.optLong("serverSequence", 0L);
        long acknowledgedAt = source.optLong("acknowledgedAt", 0L);
        String sourceKind = clean(source.optString("source", "phone"), "phone");
        if (sequence <= 0L || !idFor(sequence).equals(chunkId) || bytes <= 0L
                || checksum.length() != 64 || serverSequence <= 0L || acknowledgedAt <= 0L) {
            throw new IllegalStateException("invalid acknowledged tuple for durable journal");
        }
        JSONObject record = new JSONObject()
                .put("schemaVersion", 1)
                .put("source", sourceKind)
                .put("chunkId", chunkId)
                .put("acceptedBytes", bytes)
                .put("sha256", checksum)
                .put("sourceSequence", sequence)
                .put("serverSequence", serverSequence)
                .put("ackedAt", acknowledgedAt);
        File target = ackJournalForSequence(sequence);
        if (target.exists()) {
            JSONObject existing = readAckJournalRecord(target);
            if (!sameAckTuple(existing, record)) {
                throw new IllegalStateException("durable acknowledgement journal tuple conflict");
            }
            return;
        }
        if (acknowledgedAt < clock.now() - ACK_JOURNAL_RETENTION_MS) return;
        pruneAckJournal();
        byte[] body = record.toString().getBytes(StandardCharsets.UTF_8);
        if (ackJournalRecords >= ackJournalMaxRecords || ackJournalBytes + body.length > ackJournalMaxBytes) {
            throw new IllegalStateException("durable acknowledgement journal retention capacity exhausted");
        }
        RabiReliableQueueFiles.writeAtomically(target, body);
        ackJournalRecords += 1L;
        ackJournalBytes += target.length();
        ackJournalMaxSourceSequence = Math.max(ackJournalMaxSourceSequence, sequence);
    }

    private JSONObject readAckJournalRecord(File file) throws Exception {
        JSONObject record = readJson(file);
        long sequence = record.getLong("sourceSequence");
        String chunkId = record.getString("chunkId");
        if (sequence <= 0L || !idFor(sequence).equals(chunkId)
                || record.getLong("acceptedBytes") <= 0L
                || record.getLong("serverSequence") <= 0L
                || record.getLong("ackedAt") <= 0L
                || record.getString("sha256").length() != 64) {
            throw new IllegalStateException("invalid durable acknowledgement journal record");
        }
        return record;
    }

    private boolean sameAckTuple(JSONObject first, JSONObject second) {
        return first.optLong("sourceSequence", -1L) == second.optLong("sourceSequence", -2L)
                && first.optLong("serverSequence", -1L) == second.optLong("serverSequence", -2L)
                && first.optLong("acceptedBytes", -1L) == second.optLong("acceptedBytes", -2L)
                && first.optString("chunkId", "").equals(second.optString("chunkId", ""))
                && first.optString("sha256", "").equalsIgnoreCase(second.optString("sha256", ""));
    }

    private boolean ackTupleMatchesMetadata(JSONObject receipt, JSONObject metadata) {
        long metadataServerSequence = metadata.optLong("serverSequence", 0L);
        return receipt.optLong("sourceSequence", -1L) == metadata.optLong("sequence", -2L)
                && (metadataServerSequence == 0L
                    || receipt.optLong("serverSequence", -1L) == metadataServerSequence)
                && receipt.optLong("acceptedBytes", -1L) == metadata.optLong("bytes", -2L)
                && receipt.optString("chunkId", "").equals(metadata.optString("id", ""))
                && receipt.optString("sha256", "").equalsIgnoreCase(metadata.optString("sha256", ""));
    }

    private JSONObject journalAsMetadata(JSONObject receipt, JSONObject metadata) throws Exception {
        return new JSONObject(metadata.toString())
                .put("id", receipt.getString("chunkId"))
                .put("sequence", receipt.getLong("sourceSequence"))
                .put("bytes", receipt.getLong("acceptedBytes"))
                .put("sha256", receipt.getString("sha256"))
                .put("source", receipt.getString("source"))
                .put("serverSequence", receipt.getLong("serverSequence"))
                .put("acknowledgedAt", receipt.getLong("ackedAt"));
    }

    private void pruneAckJournal() throws Exception {
        long now = clock.now();
        if (lastJournalPruneAt > 0 && now >= lastJournalPruneAt && now - lastJournalPruneAt < 60_000L
                && ackJournalRecords + 1 < ackJournalMaxRecords && ackJournalBytes + 65536L < ackJournalMaxBytes) return;
        lastJournalPruneAt = now;
        long cutoff = clock.now() - ACK_JOURNAL_RETENTION_MS;
        for (File file : journalFiles()) {
            JSONObject record = readAckJournalRecord(file);
            if (record.getLong("ackedAt") >= cutoff) continue;
            if (!file.delete()) throw new IllegalStateException("cannot expire durable acknowledgement journal record");
        }
        measureAckJournal();
    }

    private void measureAckJournal() throws Exception {
        long bytes = 0L;
        long records = 0L;
        long maximum = 0L;
        for (File file : journalFiles()) {
            JSONObject record = readAckJournalRecord(file);
            bytes += file.length();
            records += 1L;
            maximum = Math.max(maximum, record.getLong("sourceSequence"));
        }
        ackJournalBytes = bytes;
        ackJournalRecords = records;
        ackJournalMaxSourceSequence = maximum;
    }

    private File ackJournalForSequence(long sequence) {
        return new File(ackJournalDirectory, String.format(Locale.US, "ack-%020d.json", sequence));
    }

    private File cleanupTombstoneForSequence(long sequence) {
        return new File(cleanupTombstoneDirectory, String.format(Locale.US, "cleanup-%020d.json", sequence));
    }

    private File[] journalFiles() { return RabiReliableQueueFiles.list(ackJournalDirectory, ".json"); }
    private File[] cleanupTombstoneFiles() { return RabiReliableQueueFiles.list(cleanupTombstoneDirectory, ".json"); }

    private Segment readSegment(File metadata) throws Exception {
        JSONObject value = readJson(metadata);
        long sequence = value.optLong("sequence", sequenceFromName(metadata.getName()));
        String pcmFileName = value.optString("pcmFileName", "");
        File pcm = pcmFileName.isEmpty()
                ? pcmForSequence(sequence)
                : new File(segmentsDirectory, new File(pcmFileName).getName());
        if (value.has("remoteRef")) {
            try { validatedArchive(value.getString("remoteRef")); }
            catch (Exception invalid) { lastFailure = "archive_receipt_invalid"; }
            return null; // Never poison or retransmit remote-owned media, including blocked damaged receipts.
        }
        if (!pcm.exists() && !com.rabi.link.recording.RecordingResourceCache.isArchived(pcm)) {
            if (!poisonSequence(sequence, metadata, "missing_pcm",
                    value.optString("source", "unknown"), value.optString("routeProfileId", ""),
                    Math.max(0L, value.optLong("bytes", 0L)))) {
                throw new IllegalStateException("audio quarantine transaction is pending");
            }
            return null;
        }
        return new Segment(value, pcm, metadata);
    }

    private JSONObject readJson(File file) throws Exception {
        return new JSONObject(new String(RabiReliableQueueFiles.read(file), StandardCharsets.UTF_8));
    }

    private void writeJson(File file, JSONObject value) throws Exception {
        RabiReliableQueueFiles.writeAtomically(file, value.toString().getBytes(StandardCharsets.UTF_8));
    }

    private void persistState() throws Exception {
        long pendingAudioBytes = pendingAudioBytes();
        long accountedCapturedBytes = totalAcknowledgedBytes + pendingAudioBytes + activeBytes
                + quarantinedAudioBytes + capturedGapBytes + archivedUnacknowledgedBytes;
        writeJson(stateFile, new JSONObject()
                .put("schemaVersion", 1)
                .put("nextSequence", nextSequence)
                .put("lastCapturedAt", lastCapturedAt)
                .put("lastWrittenAt", lastWrittenAt)
                .put("lastUploadedAt", lastUploadedAt)
                .put("pendingSegments", pendingSequences.size())
                .put("pendingBytes", pendingAudioBytes)
                .put("activePartialBytes", activeBytes)
                .put("acknowledgedSegments", acknowledgedSequences.size())
                .put("storedBytes", totalStoredBytes)
                .put("quarantineBytes", quarantineBytes)
                .put("quarantineItems", quarantineItems)
                .put("rejectedBytes", rejectedBytes)
                .put("uncapturedGapBytes", uncapturedGapBytes)
                .put("totalCapturedBytes", totalCapturedBytes)
                .put("archivedBytes", archivedBytes)
                    .put("archivedUnacknowledgedBytes", archivedUnacknowledgedBytes)
                    .put("totalAcknowledgedBytes", totalAcknowledgedBytes)
                .put("totalAcknowledgedSegments", totalAcknowledgedSegments)
                .put("acknowledgedAccountingSequence", acknowledgedAccountingSequence)
                .put("ackJournalRecords", ackJournalRecords)
                .put("ackJournalBytes", ackJournalBytes)
                .put("ackJournalMaxSourceSequence", ackJournalMaxSourceSequence)
                .put("quarantinedAudioBytes", quarantinedAudioBytes)
                .put("capturedGapBytes", capturedGapBytes)
                .put("accountedCapturedBytes", accountedCapturedBytes)
                .put("accountingBalanced", totalCapturedBytes == accountedCapturedBytes)
                .put("accountedQuarantineManifestAudioBytes", accountedQuarantineManifestAudioBytes)
                .put("accountedQuarantineManifestGapBytes", accountedQuarantineManifestGapBytes)
                .put("auditFailures", auditFailures)
                .put("lastFailure", lastFailure));
    }

    private void accountAcknowledged(long sequence, long bytes) {
        if (sequence <= acknowledgedAccountingSequence) return;
        totalAcknowledgedBytes += Math.max(0L, bytes);
        totalAcknowledgedSegments += 1L;
        acknowledgedAccountingSequence = sequence;
    }

    private void appendAudit(String event, JSONObject details) {
        String eventId = String.format(Locale.US, "audit-%020d", nextAuditEventSequence);
        appendAuditWithId(eventId, event, details);
    }

    private void appendAuditWithId(String eventId, String event, JSONObject details) {
        if (auditEventIds.contains(eventId)) return;
        try {
            if (auditFile.exists() && auditFile.length() >= AUDIT_MAX_BYTES) rotateAudit();
            long eventSequence = nextAuditEventSequence;
            JSONObject row = new JSONObject()
                    .put("id", eventId)
                    .put("eventSequence", eventSequence)
                    .put("time", clock.now())
                    .put("event", event)
                    .put("details", details);
            try (FileOutputStream stream = new FileOutputStream(auditFile, true);
                 OutputStreamWriter writer = new OutputStreamWriter(stream, StandardCharsets.UTF_8)) {
                writer.write(row.toString());
                writer.write("\n");
                writer.flush();
                stream.getFD().sync();
            }
            auditEventIds.add(eventId);
            nextAuditEventSequence = eventSequence + 1L;
        } catch (Throwable error) {
            auditFailures += 1L;
            lastFailure = "audit_write_" + error.getClass().getSimpleName();
        }
    }

    private void rotateAudit() throws Exception {
        if (!auditFile.exists() || auditFile.length() <= 0L) return;
        long segmentSequence = nextAuditSegmentSequence;
        File rotated = new File(root, String.format(Locale.US, "audit-segment-%020d.jsonl", segmentSequence));
        if (rotated.exists()) throw new IllegalStateException("audit segment already exists");
        fileMover.move(auditFile, rotated);
        nextAuditSegmentSequence = segmentSequence + 1L;
        recoverAuditIndex();
    }

    private void recoverAuditIndex() throws Exception {
        auditEventIds.clear();
        long maximumEventSequence = 0L;
        long maximumSegmentSequence = 0L;
        File[] files = root.listFiles((directory, name) -> name.startsWith("audit-")
                && !AUDIT_FILE.equals(name) && name.endsWith(".jsonl"));
        if (files == null) files = new File[0];
        Arrays.sort(files, Comparator.comparing(File::getName));
        JSONArray rows = new JSONArray();
        for (File file : files) {
            JSONObject summary = summarizeAuditFile(file);
            rows.put(summary);
            maximumEventSequence = Math.max(maximumEventSequence, summary.optLong("lastEventSequence", 0L));
            maximumSegmentSequence = Math.max(maximumSegmentSequence, auditSegmentSequence(file.getName()));
        }
        if (auditFile.exists()) {
            JSONObject active = summarizeAuditFile(auditFile);
            maximumEventSequence = Math.max(maximumEventSequence, active.optLong("lastEventSequence", 0L));
        }
        nextAuditEventSequence = maximumEventSequence + 1L;
        nextAuditSegmentSequence = maximumSegmentSequence + 1L;
        writeJson(new File(root, AUDIT_INDEX_FILE), new JSONObject()
                .put("schemaVersion", 2)
                .put("rebuiltAt", clock.now())
                .put("segments", rows));
    }

    private JSONObject summarizeAuditFile(File file) throws Exception {
        byte[] raw = Files.readAllBytes(file.toPath());
        String text = new String(raw, StandardCharsets.UTF_8);
        String[] lines = text.split("\n", -1);
        long firstSequence = 0L;
        long lastSequence = 0L;
        String firstId = "";
        String lastId = "";
        long records = 0L;
        long legacyRecords = 0L;
        StringBuilder recovered = new StringBuilder();
        for (int lineIndex = 0; lineIndex < lines.length; lineIndex++) {
            String line = lines[lineIndex];
            if (line.trim().isEmpty()) continue;
            JSONObject row;
            try {
                row = new JSONObject(line);
            } catch (Throwable error) {
                boolean trailingCrashWrite = AUDIT_FILE.equals(file.getName())
                        && lineIndex == lines.length - 1 && !text.endsWith("\n");
                if (!trailingCrashWrite) {
                    if (error instanceof Exception) throw (Exception) error;
                    throw new IllegalStateException("audit segment is unreadable", error);
                }
                String tailHash = sha256(line.getBytes(StandardCharsets.UTF_8));
                File evidence = new File(root, "audit-recovery-tail-" + tailHash.substring(0, 16) + ".txt");
                RabiReliableQueueFiles.writeAtomically(evidence, line.getBytes(StandardCharsets.UTF_8));
                RabiReliableQueueFiles.writeAtomically(file, recovered.toString().getBytes(StandardCharsets.UTF_8));
                auditFailures += 1L;
                lastFailure = "audit_trailing_write_recovered";
                break;
            }
            // Legacy audit rows had only time/event/details. Keep source bytes intact
            // and give the rebuilt index a stable identity without inventing sequence numbers.
            boolean legacy = !row.has("id") && !row.has("eventSequence") && row.length() == 3
                    && row.opt("time") instanceof Number && row.opt("event") instanceof String
                    && row.opt("details") instanceof JSONObject;
            String eventId = legacy
                    ? "legacy-" + sha256((lineIndex + "\n" + line).getBytes(StandardCharsets.UTF_8))
                    : row.getString("id");
            if (legacy) legacyRecords += 1L;
            long eventSequence = row.optLong("eventSequence", 0L);
            auditEventIds.add(eventId);
            if (records == 0L) {
                firstSequence = eventSequence;
                firstId = eventId;
            }
            lastSequence = eventSequence;
            lastId = eventId;
            records += 1L;
            recovered.append(line).append('\n');
        }
        return new JSONObject()
                .put("segmentId", file.getName().replace(".jsonl", ""))
                .put("file", file.getName())
                .put("firstEventId", firstId)
                .put("lastEventId", lastId)
                .put("firstEventSequence", firstSequence)
                .put("lastEventSequence", lastSequence)
                .put("records", records)
                .put("legacyRecords", legacyRecords)
                .put("bytes", file.length())
                .put("sha256", sha256(Files.readAllBytes(file.toPath())));
    }

    private static long auditSegmentSequence(String name) {
        String value = name == null ? "" : name;
        if (!value.startsWith("audit-segment-")) return 0L;
        int start = "audit-segment-".length();
        int end = value.indexOf('.', start);
        try { return Long.parseLong(value.substring(start, end < 0 ? value.length() : end)); }
        catch (Throwable ignored) { return 0L; }
    }

    private boolean hasStorageFor(long bytes) {
        long usable = spaceProbe.usableBytes(root);
        return totalStoredBytes + bytes <= policy.maxStorageBytes
                && usable - bytes >= policy.reserveFreeBytes;
    }

    private boolean poisonSegment(Segment segment, String reason) {
        if (segment == null) return false;
        return poisonSequence(segment.sequence, segment.metadataFile, reason, segment.source,
                segment.routeProfileId, segment.bytes, segment.pcmFile);
    }

    private boolean poisonSequence(long sequence, File metadata, String reason, String source,
                                   String route, long estimatedBytes, File... related) {
        ArrayList<File> files = new ArrayList<>();
        if (metadata != null) files.add(metadata);
        File pcm = pcmForSequence(sequence);
        if (pcm.exists()) files.add(pcm);
        if (related != null) for (File file : related) if (file != null && !files.contains(file)) files.add(file);
        long pcmBytes = pcm.exists() ? pcm.length() : 0L;
        try {
            String transactionId = "audio-" + String.format(Locale.US, "%020d", sequence);
            File transaction = new File(root, QUARANTINE_TXN_PREFIX + transactionId);
            if (!transaction.exists()) ensureDirectory(transaction);
            File manifest = new File(transaction, "manifest.json");
            if (!manifest.exists()) {
                JSONArray evidence = new JSONArray();
                int index = 0;
                for (File file : files) {
                    if (file == null) continue;
                    String relative = root.toPath().relativize(file.toPath()).toString().replace('\\', '/');
                    evidence.put(new JSONObject().put("source", relative)
                            .put("staged", String.format(Locale.US, "%03d-%s", index++, file.getName())));
                }
                writeJson(manifest, new JSONObject()
                        .put("schemaVersion", 1)
                        .put("transactionId", transactionId)
                        .put("sequence", sequence)
                        .put("reason", reason)
                        .put("source", clean(source, "unknown"))
                        .put("routeProfileId", clean(route, ""))
                        .put("estimatedBytes", Math.max(estimatedBytes, pcmBytes))
                        .put("gapId", "gap-poison-" + transactionId)
                        .put("gapRecorded", false)
                        .put("evidence", evidence));
            }
            File isolated = resumeQuarantineTransaction(transaction);
            finishQuarantineRecord(isolated);
            removePending(sequence);
            persistState();
            return true;
        } catch (Throwable error) {
            lastFailure = "quarantine_transaction_" + error.getClass().getSimpleName();
            try { persistState(); } catch (Throwable ignored) { }
            return false;
        }
    }

    private void recoverQuarantineTransactions() throws Exception {
        File[] transactions = root.listFiles(file -> file.isDirectory()
                && file.getName().startsWith(QUARANTINE_TXN_PREFIX));
        if (transactions != null) {
            Arrays.sort(transactions, Comparator.comparing(File::getName));
            for (File transaction : transactions) finishQuarantineRecord(resumeQuarantineTransaction(transaction));
        }
        File quarantineRoot = new File(root, "quarantine");
        File[] isolated = quarantineRoot.listFiles(File::isDirectory);
        if (isolated != null) {
            Arrays.sort(isolated, Comparator.comparing(File::getName));
            for (File item : isolated) {
                if (new File(item, "manifest.json").exists()) finishQuarantineRecord(item);
            }
        }
    }

    private File resumeQuarantineTransaction(File transaction) throws Exception {
        File manifestFile = new File(transaction, "manifest.json");
        JSONObject manifest = readJson(manifestFile);
        JSONArray evidence = manifest.getJSONArray("evidence");
        for (int index = 0; index < evidence.length(); index++) {
            JSONObject row = evidence.getJSONObject(index);
            File source = new File(root, row.getString("source"));
            File staged = new File(transaction, row.getString("staged"));
            String rootPath = root.getCanonicalPath() + File.separator;
            if (!source.getCanonicalPath().startsWith(rootPath)) {
                throw new IllegalStateException("quarantine evidence escaped spool root");
            }
            if (source.exists() && !staged.exists()) fileMover.move(source, staged);
            if (source.exists() && staged.exists()) {
                throw new IllegalStateException("quarantine evidence exists in source and staging");
            }
        }
        File quarantineRoot = new File(root, "quarantine");
        ensureDirectory(quarantineRoot);
        File destination = new File(quarantineRoot, transaction.getName().substring(1));
        if (destination.exists()) throw new IllegalStateException("quarantine transaction destination already exists");
        fileMover.move(transaction, destination);
        return destination;
    }

    private void finishQuarantineRecord(File isolated) throws Exception {
        File manifestFile = new File(isolated, "manifest.json");
        JSONObject manifest = readJson(manifestFile);
        if (!manifest.optBoolean("accountingRecorded", false)) {
            long audioBytes = measureQuarantinedAudio(isolated);
            long estimatedBytes = Math.max(0L, manifest.optLong("estimatedBytes", 0L));
            manifest.put("quarantinedAudioBytes", Math.min(estimatedBytes, audioBytes))
                    .put("capturedGapBytes", Math.max(0L, estimatedBytes - audioBytes))
                    .put("accountingRecorded", true);
            writeJson(manifestFile, manifest);
        }
        if (!manifest.optBoolean("gapRecorded", false)) {
            recordGapWithId(manifest.getString("gapId"), manifest.getString("reason"),
                    manifest.optLong("estimatedBytes", 0L), manifest.optString("source", "unknown"),
                    manifest.optString("routeProfileId", ""), false);
            manifest.put("gapRecorded", true).put("completedAt", clock.now());
            writeJson(manifestFile, manifest);
        }
        measureQuarantine();
        reconcileQuarantineAccounting();
        recomputeStoredBytes();
    }

    private void addPending(long sequence, long bytes, JSONObject metadata) {
        if (metadata.optString("captureId").isEmpty()) unscopedSequences.add(sequence);
        if ("transcribe".equals(metadata.optString("processingPolicy")) && !metadata.optString("eventId").isEmpty()) transcriptionSequences.add(sequence);
        if ("local_only".equals(metadata.optString("processingPolicy"))) localSequences.add(sequence);
        long value = Math.max(0L, bytes);
        Long previous = pendingByteIndex.put(sequence, value);
        indexedPendingBytes += value - (previous == null ? 0L : previous);
        pendingSequences.add(sequence);
    }

    private void removePending(long sequence) {
        pendingSequences.remove(sequence);
        transcriptionSequences.remove(sequence);
        localSequences.remove(sequence);
        unscopedSequences.remove(sequence);
        Long previous = pendingByteIndex.remove(sequence);
        if (previous != null) indexedPendingBytes -= previous;
    }

    private long pendingAudioBytes() { return indexedPendingBytes; }

    private void reconcileCapturedAccounting() {
        long minimumCaptured = totalAcknowledgedBytes + pendingAudioBytes() + activeBytes
                + quarantinedAudioBytes + capturedGapBytes + archivedUnacknowledgedBytes;
        totalCapturedBytes = Math.max(totalCapturedBytes, minimumCaptured);
    }

    private void reconcileQuarantineAccounting() {
        long audio = 0L;
        long gaps = 0L;
        File quarantineRoot = new File(root, "quarantine");
        File[] items = quarantineRoot.listFiles(File::isDirectory);
        if (items != null) for (File item : items) {
            File manifestFile = new File(item, "manifest.json");
            if (!manifestFile.exists()) continue;
            try {
                JSONObject manifest = readJson(manifestFile);
                audio += Math.max(0L, manifest.optLong("quarantinedAudioBytes", 0L));
                gaps += Math.max(0L, manifest.optLong("capturedGapBytes", 0L));
            } catch (Throwable ignored) { }
        }
        if (audio > accountedQuarantineManifestAudioBytes) {
            quarantinedAudioBytes += audio - accountedQuarantineManifestAudioBytes;
        }
        if (gaps > accountedQuarantineManifestGapBytes) {
            capturedGapBytes += gaps - accountedQuarantineManifestGapBytes;
        }
        accountedQuarantineManifestAudioBytes = audio;
        accountedQuarantineManifestGapBytes = gaps;
    }

    private static long measureQuarantinedAudio(File directory) {
        if (directory == null || !directory.exists()) return 0L;
        long bytes = 0L;
        File[] children = directory.listFiles();
        if (children == null) return 0L;
        for (File child : children) {
            if (child.isDirectory()) bytes += measureQuarantinedAudio(child);
            else if (child.getName().endsWith(".pcm") || child.getName().endsWith(".pcm.partial")) {
                bytes += child.length();
            }
        }
        return bytes;
    }

    private void recomputeStoredBytes() {
        totalStoredBytes = quarantineBytes;
        for (File pcm : pcmFiles()) totalStoredBytes += pcm.length();
        if (activePartial != null && activePartial.exists()) totalStoredBytes += activePartial.length();
    }

    private void measureQuarantine() {
        File quarantineRoot = new File(root, "quarantine");
        long[] totals = measureFiles(quarantineRoot);
        quarantineBytes = totals[0];
        File[] items = quarantineRoot.listFiles(File::isDirectory);
        quarantineItems = items == null ? 0L : items.length;
    }

    private static long[] measureFiles(File directory) {
        if (directory == null || !directory.exists()) return new long[]{0L, 0L};
        long bytes = 0L;
        long files = 0L;
        File[] children = directory.listFiles();
        if (children == null) return new long[]{0L, 0L};
        for (File child : children) {
            if (child.isDirectory()) {
                long[] nested = measureFiles(child);
                bytes += nested[0];
                files += nested[1];
            } else {
                bytes += child.length();
                files += 1L;
            }
        }
        return new long[]{bytes, files};
    }

    synchronized JSONObject quarantineManifest() {
        measureQuarantine();
        JSONObject value = new JSONObject();
        try { value.put("items", quarantineItems).put("bytes", quarantineBytes); }
        catch (Throwable ignored) { }
        return value;
    }

    synchronized boolean clearQuarantineAfterUserConfirmation() {
        File quarantineRoot = new File(root, "quarantine");
        try {
            String expected = new File(root, "quarantine").getCanonicalPath();
            if (!quarantineRoot.getCanonicalPath().equals(expected)) return false;
            File[] children = quarantineRoot.listFiles();
            if (children != null) for (File child : children) deleteTree(child);
            long removed = quarantineBytes;
            quarantineBytes = 0L;
            quarantineItems = 0L;
            accountedQuarantineManifestAudioBytes = 0L;
            accountedQuarantineManifestGapBytes = 0L;
            totalStoredBytes = Math.max(0L, totalStoredBytes - removed);
            appendAudit("quarantine_cleared_by_user", new JSONObject().put("removedBytes", removed));
            persistState();
            return true;
        } catch (Throwable error) {
            lastFailure = "quarantine_clear_" + error.getClass().getSimpleName();
            return false;
        }
    }

    private static void deleteTree(File target) throws Exception {
        if (target.isDirectory()) {
            File[] children = target.listFiles();
            if (children != null) for (File child : children) deleteTree(child);
        }
        if (target.exists() && !target.delete()) throw new IllegalStateException("cannot clear quarantine item");
    }

    private void quarantine(File file, String reason) {
        try {
            long bytes = file != null && file.exists() ? file.length() : 0L;
            RabiReliableQueueFiles.quarantine(root, reason, file);
            quarantineBytes += bytes;
            quarantineItems += 1L;
            totalStoredBytes += bytes;
        }
        catch (Throwable ignored) { }
    }

    private File[] metadataFiles() { return RabiReliableQueueFiles.list(segmentsDirectory, ".json"); }
    private File[] pcmFiles() { return RabiReliableQueueFiles.list(segmentsDirectory, ".pcm"); }
    private JSONObject readPartialOwnershipOrNull(File file) {
        if (file == null || !file.exists()) return null;
        try {
            JSONObject value = readJson(file);
            String source = value.optString("source", "").trim();
            if (source.isEmpty() || value.optLong("sequence", 0L) <= 0L) return null;
            return value;
        } catch (Throwable ignored) {
            return null;
        }
    }
    private File partialMetadataFor(File partial) { return new File(partial.getPath() + ".meta"); }
    private File partialMetadataForSealed(File pcm) { return new File(pcm.getPath() + ".partial.meta"); }
    private File metadataForId(String id) {
        long sequence = 0L;
        try { sequence = Long.parseLong(clean(id, "").replace("audio-", "")); } catch (NumberFormatException ignored) { }
        return metadataForSequence(sequence);
    }
    private File metadataForSequence(long sequence) { return new File(segmentsDirectory, idFor(sequence) + ".json"); }
    private File pcmForSequence(long sequence) {
        String prefix = String.format(Locale.US, "%020d-", sequence);
        File[] matches = segmentsDirectory.listFiles((directory, name) -> name.startsWith(prefix) && name.endsWith(".pcm"));
        return matches == null || matches.length == 0 ? new File(segmentsDirectory, idFor(sequence) + ".missing.pcm") : matches[0];
    }

    private static String idFor(long sequence) { return String.format(Locale.US, "audio-%020d", sequence); }
    private static long sequenceFromName(String name) {
        String value = name == null ? "" : name;
        if (value.startsWith("audio-")) value = value.substring(6);
        int dash = value.indexOf('-');
        int dot = value.indexOf('.');
        int end = dash >= 0 ? dash : dot >= 0 ? dot : value.length();
        try { return Long.parseLong(value.substring(0, end)); } catch (Throwable ignored) { return 0L; }
    }
    private static long timestampFromName(String name) {
        String value = name == null ? "" : name;
        int dash = value.indexOf('-');
        if (dash < 0) return System.currentTimeMillis();
        int dot = value.indexOf('.', dash + 1);
        try { return Long.parseLong(value.substring(dash + 1, dot < 0 ? value.length() : dot)); }
        catch (Throwable ignored) { return System.currentTimeMillis(); }
    }
    private static String clean(String value, String fallback) {
        String result = value == null ? "" : value.trim();
        return result.isEmpty() ? fallback : result;
    }
    private static void ensureDirectory(File directory) {
        if (!directory.exists() && !directory.mkdirs()) throw new IllegalStateException("cannot create durable audio directory");
    }
    private static void moveReplacing(File source, File destination) throws Exception {
        try {
            Files.move(source.toPath(), destination.toPath(), StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING);
        } catch (AtomicMoveNotSupportedException error) {
            Files.move(source.toPath(), destination.toPath(), StandardCopyOption.REPLACE_EXISTING);
        }
    }
    private static String sha256(byte[] data) throws Exception {
        byte[] digest = MessageDigest.getInstance("SHA-256").digest(data);
        char[] hex = "0123456789abcdef".toCharArray();
        char[] value = new char[digest.length * 2];
        for (int index = 0; index < digest.length; index++) {
            int item = digest[index] & 0xff;
            value[index * 2] = hex[item >>> 4];
            value[index * 2 + 1] = hex[item & 15];
        }
        return new String(value);
    }
}
