package com.rabi.link.recording

import android.content.Context
import java.security.MessageDigest

/** UI read-only access. No second target preference, ASR selection or eviction permission. */
class RecordingArchiveReviewAccess(val config: RecordingArchiveSession.FrozenConfig, val repository: RecordingArchiveRepository,
                                 val transport: RecordingArchiveTransport, val pendingAvailable: Boolean) {
    companion object {
        internal fun useRemoteHistory(archiveViewSelected: Boolean, configured: Boolean): Boolean = archiveViewSelected && configured
        fun load(context: Context, local: RecordingArchiveRepository.Local? = null): RecordingArchiveReviewAccess? {
            val config = RecordingArchiveSession.load(context) ?: return null
            // Snapshot only the writer-owned lightweight index; never open PCM or scan old metadata.
            val rows = if(local == null) com.rabi.link.RabiConversationService.archivePendingSummaries(config.target,32) else null
            val preview = rows?.let { pendingRows(it,config.target) }.orEmpty()
            val pending = local ?: RecordingArchiveRepository.Local { identity, query, limit ->
                require(limit <= 32)
                preview.filter { it.identity == identity && (query.from == null || it.startedAt >= query.from) &&
                    (query.to == null || it.startedAt <= query.to) && (query.source == null || it.source == query.source) }.take(limit)
            }
            return RecordingArchiveReviewAccess(config, config.createRepository(context, pending).repository,
                config.createTransport(context), local != null || rows != null)
        }
        internal fun pendingRows(rows: org.json.JSONArray, target: RecordingArchiveCoordinator.Target): List<RecordingArchiveRepository.Row> {
            require(rows.length() <= 32) { "Unbounded pending preview" }
            val identity = RecordingArchiveRepository.Identity(target.owner,target.workerId,target.namespace)
            return (0 until rows.length()).map { index ->
                val row = rows.getJSONObject(index)
                require(row.getString("owner") == target.owner && row.getString("workerId") == target.workerId && row.getString("storageNamespaceId") == target.namespace)
                val state = when {
                    !row.optBoolean("localMediaPresent",true) -> "blocked_missing_media"
                    !row.optBoolean("uploadable",true) || row.optString("archiveState") == "blocked" -> "blocked"
                    row.optString("archiveState") == "retry_wait" -> "retry_wait"
                    else -> "pending"
                }
                RecordingArchiveRepository.Row(identity,row.getString("recordId"),row.getString("captureId"),row.getString("eventId"),
                    row.getString("source"),row.getLong("startedAt"),row.getLong("endedAt"),row.getLong("totalBytes"),
                    "","","transcribe","not_requested","",state,false)
            }
        }
        fun key(row: RecordingArchiveRepository.Row): String = MessageDigest.getInstance("SHA-256")
            .digest(listOf(row.identity.owner,row.identity.worker,row.identity.namespace,row.recordId,row.manifestHash).joinToString("\u0000").toByteArray(Charsets.UTF_8))
            .joinToString("") { "%02x".format(it.toInt() and 255) }
    }
}
