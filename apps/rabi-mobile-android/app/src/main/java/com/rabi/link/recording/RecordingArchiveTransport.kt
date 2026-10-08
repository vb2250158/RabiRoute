package com.rabi.link.recording

import android.content.Context
import com.rabi.link.RabiLinkRelayConfig
import com.rabi.link.RabiMobileDeviceIdentity
import com.rabi.link.transport.RabiSpeechTunnel
import com.rabiroute.sdk.RabiLinkPc
import org.json.JSONObject
import java.io.IOException
import java.net.URLEncoder
import java.nio.ByteBuffer
import java.nio.charset.CodingErrorAction
import java.security.MessageDigest

/** Frozen destination, no selected-worker lookup and no business-request replay.
 * The production channel exclusively uses the existing resources LAN -> P2P -> Relay tunnel.
 * Resource paths are relative to its authenticated /api/resource-cache/data service prefix.
 */
class RecordingArchiveTransport internal constructor(
    private val workerId: String,
    private val ownerId: String,
    private val channels: () -> Channel
) : RecordingArchiveCoordinator.Transport {
    internal data class Reply(val status: Int, val body: ByteArray)
    internal interface Channel : AutoCloseable {
        fun request(method: String, path: String, contentType: String, body: ByteArray): Reply
    }
    constructor(context: Context, relay: RabiLinkRelayConfig, worker: RabiLinkPc) : this(
        worker.id, RabiMobileDeviceIdentity.load(context), production(context.applicationContext, relay, worker)
    )
    class HttpFailure(val status: Int) : IOException("Archive request failed ($status)")
    private fun target(t: RecordingArchiveCoordinator.Target) {
        require(t.workerId == workerId && t.owner == ownerId && t.bindingRevision > 0) { "Archive target mismatch" }
        id(workerId); id(ownerId)
        require(t.namespace.matches(Regex("[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}")))
        require(t.namespace != "00000000-0000-0000-0000-000000000000")
    }
    private fun json(bytes: ByteArray): JSONObject {
        val decoder = Charsets.UTF_8.newDecoder().onMalformedInput(CodingErrorAction.REPORT).onUnmappableCharacter(CodingErrorAction.REPORT)
        return JSONObject(decoder.decode(ByteBuffer.wrap(bytes)).toString())
    }
    private fun probe(c: Channel): JSONObject {
        id(workerId); id(ownerId)
        val r = c.request("GET", "/archive-capabilities", "application/json", byteArrayOf())
        if (r.status != 200) throw HttpFailure(r.status)
        return json(r.body).also {
            require(it.getString("protocol") == "record-archive-v1" && it.getString("workerId") == workerId) { "Archive capability identity mismatch" }
            val ns = it.getString("storageNamespaceId")
            require(ns.matches(Regex("[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}"))
                && ns != "00000000-0000-0000-0000-000000000000")
            for (key in listOf("maxObjectBytes", "maxManifestBytes", "bindingRevision")) {
                val value = it.get(key)
                require(value is Number && value.toDouble().isFinite() && value.toDouble() == value.toLong().toDouble()
                    && value.toLong() in 1..9007199254740991L) { "Invalid archive capability integer" }
            }
            require(it.get("uploadAllowed") is Boolean) { "Invalid archive capability authorization" }
        }
    }
    /** Read-only authenticated discovery for explicit settings; never fabricates or updates a frozen Target. */
    fun probeCapabilities(): JSONObject = channels().use { probe(it) }
    private fun capabilities(c: Channel, t: RecordingArchiveCoordinator.Target): JSONObject {
        target(t)
        return probe(c).also {
            require(it.getString("storageNamespaceId") == t.namespace && it.getLong("bindingRevision") == t.bindingRevision) {
                "Archive binding changed; explicit configuration required"
            }
        }
    }
    fun initialize(t: RecordingArchiveCoordinator.Target): JSONObject = channels().use { capabilities(it, t) }
    private fun read(t: RecordingArchiveCoordinator.Target, path: String, missingAllowed: Boolean = false): ByteArray? {
        target(t)
        return channels().use { c ->
            capabilities(c, t)
            val r = c.request("GET", path, "application/json", byteArrayOf())
            if (r.status == 404 && missingAllowed) null else {
                if (r.status != 200) throw HttpFailure(r.status)
                r.body
            }
        }
    }
    override fun readReceipt(t: RecordingArchiveCoordinator.Target, recordId: String, manifestHash: String): JSONObject? {
        id(recordId); hashId(manifestHash)
        return read(t, "/recordings/$recordId/receipts/$manifestHash", true)?.let { bytes -> json(bytes).also {
            require(it.getString("workerId") == workerId && it.getString("storageNamespaceId") == t.namespace
                && it.getString("recordId") == recordId && it.getString("manifestHash") == manifestHash)
            require(it.getString("durability") == "archived" && it.getString("retention") == "indefinite")
        } }
    }
    private fun write(t: RecordingArchiveCoordinator.Target, path: String, type: String, bytes: ByteArray,
                      limitName: String, verify: (JSONObject) -> Unit): JSONObject {
        target(t); require(t.uploadAllowed) { "Archive upload not authorized" }
        return channels().use { c ->
            val cap = capabilities(c, t) // Failure before dispatch is not an absent receipt.
            require(cap.getBoolean("uploadAllowed")) { "Archive upload disabled by computer" }
            require(bytes.size.toLong() <= cap.getLong(limitName)) { "Archive request exceeds capability" }
            try {
                val r = c.request("PUT", path, type, bytes)
                if (r.status >= 500 || r.status in listOf(408, 425, 429)) throw RecordingArchiveCoordinator.UnknownWrite("Archive write outcome unknown")
                if (r.status !in 200..299) throw HttpFailure(r.status)
                json(r.body).also(verify)
            } catch (e: HttpFailure) { throw e }
            catch (e: Exception) { throw RecordingArchiveCoordinator.UnknownWrite("Archive write outcome unknown") }
        }
    }
    override fun putObject(t: RecordingArchiveCoordinator.Target, sha256: String, pcm: ByteArray) {
        hashId(sha256); require(pcm.isNotEmpty() && pcm.size <= 1024 * 1024 && digest(pcm) == sha256)
        write(t, "/objects/$sha256", "application/octet-stream", pcm, "maxObjectBytes") {
            require(it.getString("sha256") == sha256 && it.getLong("bytes") == pcm.size.toLong()
                && it.getString("storageNamespaceId") == t.namespace)
        }
    }
    override fun commitManifest(t: RecordingArchiveCoordinator.Target, recordId: String, hash: String, manifest: JSONObject): JSONObject {
        id(recordId); hashId(hash)
        val validated = RecordingArchiveContract.validateRecordingManifest(manifest)
        require(validated.getString("recordId") == recordId && validated.getString("deviceId") == ownerId)
        require(RecordingArchiveContract.recordingManifestHash(validated) == hash)
        val body = RecordingArchiveContract.recordingManifestCanonicalJson(validated).toByteArray(Charsets.UTF_8)
        require(body.size <= 1024 * 1024)
        return write(t, "/recordings/$recordId/manifests/$hash", "application/json", body, "maxManifestBytes") {
            RecordingArchiveContract.validateArchiveReceipt(it, workerId, t.namespace, validated)
        }
    }
    fun getManifest(t: RecordingArchiveCoordinator.Target, recordId: String): JSONObject {
        id(recordId)
        return RecordingArchiveContract.validateRecordingManifest(json(requireNotNull(read(t, "/recordings/$recordId/manifest")))).also {
            require(it.getString("recordId") == recordId && it.getString("deviceId") == ownerId)
        }
    }
    fun readObject(t: RecordingArchiveCoordinator.Target, sha256: String, expectedBytes: Int): ByteArray {
        hashId(sha256); require(expectedBytes in 1..1024 * 1024)
        return requireNotNull(read(t, "/objects/$sha256")).also { require(it.size == expectedBytes && digest(it) == sha256) }
    }
    /** Verify the exact remote recording and its playback bytes before releasing the phone original. */
    fun verifyArchivedPlayback(t: RecordingArchiveCoordinator.Target, manifest: JSONObject): Boolean {
        val remote = getManifest(t,manifest.getString("recordId"))
        require(RecordingArchiveContract.recordingManifestHash(remote) == RecordingArchiveContract.recordingManifestHash(manifest))
        val expectedHash = RecordingArchiveContract.recordingManifestHash(manifest)
        var cursor: String? = null
        val cursors = mutableSetOf<String>()
        var visible = false
        do {
            val page = readCatalog(t,cursor,100,manifest.getLong("startedAt"),manifest.getLong("endedAt"))
            require(!page.optBoolean("offline",false)) { "Archive history is unavailable" }
            val rows = page.getJSONArray("items")
            for(i in 0 until rows.length()) {
                val row = rows.getJSONObject(i)
                if(row.getString("recordId") == manifest.getString("recordId") && row.getString("manifestHash") == expectedHash) visible = true
            }
            cursor = if(page.isNull("nextCursor")) null else page.getString("nextCursor")
            require(cursor == null || cursors.add(cursor)) { "Archive history cursor did not advance" }
        } while(!visible && cursor != null)
        require(visible) { "Recording is absent from archive history" }
        val objects = remote.getJSONArray("objects")
        for(i in 0 until objects.length()) {
            val value = objects.getJSONObject(i)
            readObject(t,value.getString("sha256"),value.getInt("bytes"))
        }
        return true
    }
    fun readCatalog(t: RecordingArchiveCoordinator.Target, cursor: String? = null, limit: Int = 50,
                    from: Long? = null, to: Long? = null, source: String? = null): JSONObject {
        require(limit in 1..100 && (cursor == null || cursor.length <= 8192))
        require(from == null || from in 0..9007199254740991L); require(to == null || to in 0..9007199254740991L)
        require(from == null || to == null || from <= to)
        require(source == null || source in listOf("phone", "glasses", "video"))
        val params = mutableListOf("limit=$limit")
        if (cursor != null) params.add("cursor=" + URLEncoder.encode(cursor, "UTF-8"))
        if (from != null) params.add("from=$from"); if (to != null) params.add("to=$to")
        if (source != null) params.add("source=$source")
        return json(requireNotNull(read(t, "/recordings?" + params.joinToString("&")))).also {
            require(it.getString("storageNamespaceId") == t.namespace)
        }
    }
    companion object {
        private fun id(v: String) { require(v.matches(Regex("[A-Za-z0-9_-]{1,128}"))) }
        private fun hashId(v: String) { require(v.matches(Regex("[a-f0-9]{64}"))) }
        private fun digest(b: ByteArray) = MessageDigest.getInstance("SHA-256").digest(b).joinToString("") { "%02x".format(it.toInt() and 255) }
        private fun production(context: Context, relay: RabiLinkRelayConfig, worker: RabiLinkPc): () -> Channel {
            require(relay.configured)
            // Freeze the discovery record; callers changing their original JSONObject cannot redirect us.
            val frozen = RabiLinkPc(worker.id, "", worker.rawJson.optString("name"), "", "", true, "", JSONObject(worker.rawJson.toString()))
            return {
                val tunnel = RabiSpeechTunnel(context, relay.copy(), frozen, "resources")
                object : Channel {
                    override fun request(method: String, path: String, contentType: String, body: ByteArray): Reply {
                        require(frozen.id == worker.id)
                        val r = tunnel.request(method, path, contentType, body)
                        return Reply(r.status, r.body)
                    }
                    override fun close() = tunnel.close()
                }
            }
        }
    }
}
