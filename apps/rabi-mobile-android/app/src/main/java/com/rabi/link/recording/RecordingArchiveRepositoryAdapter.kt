package com.rabi.link.recording

import android.util.AtomicFile
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.io.IOException
import java.security.MessageDigest
import com.rabi.link.recording.RecordingArchiveRepository.*

/** Instantiate only after a frozen target is configured. No discovery or metadata scanning here.
 * Blocking IO: call from the existing repository worker, never the UI thread.
 */
class RecordingArchiveRepositoryAdapter(
    private val transport: RecordingArchiveTransport,
    private val target: RecordingArchiveCoordinator.Target,
    local: Local,
    cacheDirectory: File
) {
    val identity = Identity(target.owner, target.workerId, target.namespace)
    val repository: RecordingArchiveRepository
    init {
        require(target.bindingRevision > 0 && target.workerId.isNotBlank() && target.owner.isNotBlank() && target.namespace.isNotBlank())
        val remote = object : Remote {
            override fun page(identity: Identity, query: Query, cursor: String?): RemotePage {
                require(identity == this@RecordingArchiveRepositoryAdapter.identity)
                try {
                    return decodePage(transport.readCatalog(target, cursor, query.limit, query.from, query.to, query.source), identity)
                } catch (e: RecordingArchiveTransport.HttpFailure) {
                    if (e.status == 409) throw Stale()
                    if (e.status >= 500 || e.status == 408) throw Unavailable()
                    throw e
                } catch (e: IOException) { throw Unavailable() }
            }
            override fun manifest(identity: Identity, recordId: String): Manifest {
                require(identity == this@RecordingArchiveRepositoryAdapter.identity)
                val m = transport.getManifest(target, recordId)
                return Manifest(identity, recordId, RecordingArchiveContract.recordingManifestHash(m), RecordingArchiveContract.recordingManifestCanonicalJson(m))
            }
        }
        repository = RecordingArchiveRepository(identity, remote, local, MetadataCache(cacheDirectory))
    }
    companion object {
        /** A null target means unconfigured, not an empty ready remote history. */
        fun configured(transport: RecordingArchiveTransport, target: RecordingArchiveCoordinator.Target?, local: Local, cacheDirectory: File): RecordingArchiveRepositoryAdapter? =
            target?.let { RecordingArchiveRepositoryAdapter(transport, it, local, cacheDirectory) }
        internal fun decodePage(json: JSONObject, identity: Identity): RemotePage {
            require(json.getString("storageNamespaceId") == identity.namespace)
            val array = json.getJSONArray("items")
            require(array.length() <= 100)
            val rows = (0 until array.length()).map { index ->
                val r = array.getJSONObject(index)
                require(r.getString("deviceId") == identity.owner)
                Row(identity, r.getString("recordId"), r.getString("captureId"), r.getString("eventId"), r.getString("source"),
                    r.getLong("startedAt"), r.getLong("endedAt"), r.getLong("totalBytes"), r.getString("manifestHash"),
                    r.getString("manifestReference"), r.getString("processingPolicy"), r.getString("asrState"),
                    if (r.has("text") && !r.isNull("text")) r.getString("text") else "", "committed", true)
            }
            return RemotePage(identity, rows, if(json.isNull("nextCursor")) null else json.getString("nextCursor"),
                json.getString("snapshotRevision"), json.getBoolean("offline"), json.getLong("lastSyncedAt"))
        }
        private fun encode(page: RemotePage): JSONObject {
            val items = JSONArray()
            page.items.forEach { r -> items.put(JSONObject().put("recordId",r.recordId).put("captureId",r.captureId).put("eventId",r.eventId)
                .put("deviceId",r.identity.owner).put("source",r.source).put("startedAt",r.startedAt).put("endedAt",r.endedAt)
                .put("totalBytes",r.totalBytes).put("manifestHash",r.manifestHash).put("manifestReference",r.manifestReference)
                .put("processingPolicy",r.processingPolicy).put("asrState",r.asrState).put("text",r.text)) }
            return JSONObject().put("items",items).put("storageNamespaceId",page.identity.namespace).put("nextCursor",page.nextCursor ?: JSONObject.NULL)
                .put("snapshotRevision",page.snapshotRevision).put("offline",page.offline).put("lastSyncedAt",page.lastSyncedAt)
        }
        private fun keyJson(k: Key) = JSONObject().put("owner",k.identity.owner).put("worker",k.identity.worker).put("namespace",k.identity.namespace)
            .put("limit",k.query.limit).put("from",k.query.from ?: JSONObject.NULL).put("to",k.query.to ?: JSONObject.NULL)
            .put("source",k.query.source ?: JSONObject.NULL).put("cursor",k.cursor ?: JSONObject.NULL).toString()
    }
    /** Only replaceable metadata, bounded to 8 MiB/128 pages. No media or credentials. */
    class MetadataCache(private val root: File) : Cache {
        @Synchronized override fun load(key: Key): RemotePage? {
            val file = file(key)
            return try {
                if(file.length() > 1024 * 1024) return null
                val value = AtomicFile(file).openRead().bufferedReader(Charsets.UTF_8).use { JSONObject(it.readText()) }
                if(value.getString("key") != keyJson(key)) return null
                decodePage(value.getJSONObject("page"),key.identity).also { file.setLastModified(System.currentTimeMillis()) }
            } catch (_: Exception) { null }
        }
        @Synchronized override fun save(key: Key, page: RemotePage) {
            require(key.identity == page.identity)
            val bytes = JSONObject().put("key",keyJson(key)).put("page",encode(page)).toString().toByteArray(Charsets.UTF_8)
            require(bytes.size <= 1024 * 1024)
            check(root.isDirectory || root.mkdirs())
            val file = file(key); val atomic = AtomicFile(file); val stream = atomic.startWrite()
            try { stream.write(bytes); atomic.finishWrite(stream) } catch(e: Exception) { atomic.failWrite(stream); throw e }
            var size = 0L; var count = 0
            root.listFiles { f -> f.isFile && f.name.matches(Regex("[a-f0-9]{64}\\.json")) }?.sortedByDescending { it.lastModified() }?.forEach {
                size += it.length(); count++
                if(size > 8L * 1024 * 1024 || count > 128) AtomicFile(it).delete()
            }
        }
        private fun file(key: Key): File {
            val hash = MessageDigest.getInstance("SHA-256").digest(keyJson(key).toByteArray(Charsets.UTF_8)).joinToString("") { "%02x".format(it.toInt() and 255) }
            return File(root,"$hash.json")
        }
    }
}
