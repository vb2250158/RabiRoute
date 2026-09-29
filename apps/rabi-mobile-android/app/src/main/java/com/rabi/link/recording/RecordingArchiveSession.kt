package com.rabi.link.recording

import android.content.Context
import com.rabi.link.RabiLinkRelaySettings
import com.rabi.link.RabiMobileDeviceIdentity
import com.rabi.link.modules.rokid.RabiGlassPcBackend
import com.rabiroute.sdk.RabiLinkPc
import org.json.JSONObject
import java.io.File
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean

/** Service-owned network actor. The spool remains the only durable queue and writer. */
class RecordingArchiveSession(context: Context, private val backend: RabiGlassPcBackend) : AutoCloseable {
    private val app = context.applicationContext
    private val executor = Executors.newSingleThreadScheduledExecutor()
    private val scheduled = AtomicBoolean(false)
    private val wakeup = ArchiveWakeup()
    @Volatile private var closed = false
    private val retryUsed = AtomicBoolean(false)
    class FrozenConfig internal constructor(val target: RecordingArchiveCoordinator.Target, private val raw: String) {
        fun createTransport(context: Context): RecordingArchiveTransport {
            val json = JSONObject(raw)
            val pc = RabiLinkPc(target.workerId, "", json.optString("name"), "", "", true, "", json)
            return RecordingArchiveTransport(context, RabiLinkRelaySettings.load(context), pc)
        }
        fun createRepository(context: Context, local: RecordingArchiveRepository.Local): RecordingArchiveRepositoryAdapter =
            RecordingArchiveRepositoryAdapter(createTransport(context), target, local, File(context.cacheDir, "recording-archive-pages"))
    }
    companion object {
        private fun prefs(c: Context) = c.getSharedPreferences("recording_archive_session", Context.MODE_PRIVATE)
        @JvmStatic fun load(context: Context): FrozenConfig? {
            val raw = prefs(context).getString("frozen", null) ?: return null
            return runCatching {
                val j = JSONObject(raw)
                require(j.getInt("schemaVersion") == 1)
                val t = RecordingArchiveCoordinator.Target(j.getString("workerId"), j.getString("storageNamespaceId"), j.getString("owner"), j.getLong("bindingRevision"), j.getBoolean("uploadAllowed"))
                require(t.owner == RabiMobileDeviceIdentity.load(context) && t.bindingRevision > 0)
                val worker = j.getJSONObject("worker")
                require(worker.getString("id") == t.workerId)
                FrozenConfig(t, worker.toString())
            }.getOrNull()
        }
        /** Explicit UI action, blocking capability verification: invoke on an IO worker, never main. */
        @JvmStatic fun configure(context: Context, worker: RabiLinkPc, namespace: String, bindingRevision: Long, uploadAllowed: Boolean): FrozenConfig {
            val t = RecordingArchiveCoordinator.Target(worker.id, namespace, RabiMobileDeviceIdentity.load(context), bindingRevision, uploadAllowed)
            // Persist a discovery identity, never credentials or the current selection.
            val raw = JSONObject().put("id", worker.id).put("name", worker.rawJson.optString("name"))
            // Only LAN discovery endpoints are required by resources Tunnel; no arbitrary secret fields.
            worker.rawJson.optJSONArray("peerUrls")?.let { urls ->
                raw.put("peerUrls", org.json.JSONArray(urls.toString()))
            }
            val frozen = FrozenConfig(t, raw.toString())
            frozen.createTransport(context).initialize(t)
            val previous = load(context)
            require(previous == null || previous.target.workerId == t.workerId && previous.target.namespace == t.namespace && previous.target.owner == t.owner) { "Archive target migration requires an explicit migration" }
            val value = JSONObject().put("schemaVersion", 1).put("workerId", t.workerId).put("storageNamespaceId", t.namespace)
                .put("owner", t.owner).put("bindingRevision", t.bindingRevision).put("uploadAllowed", t.uploadAllowed).put("worker", raw)
            check(prefs(context).edit().putString("frozen", value.toString()).commit())
            return frozen
        }
    }
    /** New capture authorization only; existing captures require authorizeHistory explicitly. */
    fun targetForNewCapture(): RecordingArchiveCoordinator.Target? = load(app)?.target?.takeIf { it.uploadAllowed }
    fun authorizeHistory(captureId: String) {
        val cfg = requireNotNull(load(app)) { "Archive is not configured" }
        require(cfg.target.uploadAllowed)
        backend.archiveAuthorize(captureId, cfg.target)
        kick()
    }
    fun kick() { wakeup.signal(); retryUsed.set(false); schedule(0) }
    private fun schedule(delaySeconds: Long) {
        if (closed || !scheduled.compareAndSet(false, true)) return
        try { executor.schedule({
            // Consume only wakeups preceding this batch. Arrivals during IO survive until finally.
            wakeup.consume()
            var more = false
            var failed = false
            try {
                val cfg = load(app)
                if (cfg != null && cfg.target.uploadAllowed) {
                    val ids = backend.archiveCandidates(cfg.target, 16)
                    val coordinator = RecordingArchiveCoordinator(
                        { id -> backend.archiveSnapshot(id, cfg.target) }, cfg.createTransport(app),
                        object : RecordingArchiveCoordinator.Persistence {
                            override fun persistVerifiedReceipt(t: RecordingArchiveCoordinator.Target, m: JSONObject, r: JSONObject) { check(!closed) { "Archive session stopped; receipt will be recovered" }; backend.archivePersist(t, m, r) }
                            override fun requestEviction(t: RecordingArchiveCoordinator.Target, m: JSONObject, r: JSONObject) = backend.archiveEvict(t, m, r)
                            override fun remoteHistoryAndPlaybackReady(t: RecordingArchiveCoordinator.Target) = false
                            override fun state(id: String, state: String, reason: String) { prefs(app).edit().putString("status", state).putString("reason", reason).apply() }
                        })
                    for (id in ids) {
                        if (closed) break
                        val result = coordinator.runOne(id)
                        if (result.archiveState != "committed") { failed = true; break }
                    }
                    more = ids.size == 16 && !failed
                    if (!closed) refreshCleanupPending(cfg.target)
                }
            } catch (_: Exception) { failed = true }
            finally {
                scheduled.set(false)
                if (!closed && (more || wakeup.consume())) schedule(0)
                else if (!closed && failed && retryUsed.compareAndSet(false, true)) schedule(60)
            }
        }, delaySeconds, TimeUnit.SECONDS) } catch (_: java.util.concurrent.RejectedExecutionException) { scheduled.set(false) }
    }
    /** Bounded observation only. Cleanup has its own queue and is not an upload retry reason. */
    private fun refreshCleanupPending(target: RecordingArchiveCoordinator.Target) {
        try {
            val pending = backend.archiveEvictionCandidates(target, 32)
            prefs(app).edit().putInt("cleanupPendingObserved", pending.size)
                .putBoolean("cleanupPendingMayHaveMore", pending.size == 32)
                .putBoolean("cleanupPendingKnown", true)
                .putString("cleanupState", "disabled_pending_playback_verification").apply()
        } catch (_: Exception) {
            // Do not overwrite a previously observed count with a false zero or schedule a cleanup loop.
            prefs(app).edit().putBoolean("cleanupPendingKnown", false)
                .putString("cleanupState", "unavailable").apply()
        }
    }
    override fun close() {
        closed = true
        executor.shutdownNow()
        // onDestroy can run on main. Joining belongs to the service shutdown worker.
    }
    fun awaitStopped(): Boolean = try { executor.awaitTermination(5, TimeUnit.SECONDS) }
        catch (_: InterruptedException) { Thread.currentThread().interrupt(); false }
}

/** Coalesced edge notification, not a polling timer. */
internal class ArchiveWakeup {
    private val dirty = AtomicBoolean(false)
    fun signal() { dirty.set(true) }
    fun consume(): Boolean = dirty.getAndSet(false)
}
