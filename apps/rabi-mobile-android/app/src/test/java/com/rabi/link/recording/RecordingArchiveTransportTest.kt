package com.rabi.link.recording

import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import java.io.IOException
import java.security.MessageDigest

class RecordingArchiveTransportTest {
    private val ns = "11111111-1111-4111-8111-111111111111"
    private fun target() = RecordingArchiveCoordinator.Target("pc", ns, "phone", 1, true)
    private fun cap() = JSONObject().put("protocol", "record-archive-v1").put("workerId", "pc")
        .put("storageNamespaceId", ns).put("maxObjectBytes", 1048576).put("maxManifestBytes", 1048576)
        .put("bindingRevision", 1L).put("uploadAllowed", true)
    private fun reply(status: Int, value: JSONObject = JSONObject()) = RecordingArchiveTransport.Reply(status, value.toString().toByteArray())
    private fun transport(block: (String, String, ByteArray) -> RecordingArchiveTransport.Reply) =
        RecordingArchiveTransport("pc", "phone") { object : RecordingArchiveTransport.Channel {
            override fun request(method: String, path: String, contentType: String, body: ByteArray) = block(method, path, body)
            override fun close() {}
        } }
    private inline fun <reified T : Throwable> fails(block: () -> Unit) {
        try { block(); fail("Expected ${T::class.java.name}") } catch (e: Throwable) { if (e !is T) throw e }
    }
    @Test fun probeDiscoversWithoutFakeTargetAndOldRevisionBlocks() {
        val capability = cap().put("bindingRevision", 2L)
        var calls = 0
        val t = transport { method, path, body ->
            calls++; assertEquals("GET", method); assertEquals("/archive-capabilities", path); assertEquals(0, body.size)
            reply(200, capability)
        }
        assertEquals(ns, t.probeCapabilities().getString("storageNamespaceId"))
        assertEquals(2L, t.probeCapabilities().getLong("bindingRevision"))
        fails<IllegalArgumentException> { t.initialize(target()) }
        assertEquals(3, calls)
        capability.put("bindingRevision", 0)
        fails<IllegalArgumentException> { t.probeCapabilities() }
        capability.put("bindingRevision", 1).put("workerId", "other")
        fails<IllegalArgumentException> { t.probeCapabilities() }
    }
    @Test fun serverUploadDisabledNeverDispatchesPut() {
        val pcm = byteArrayOf(1, 2)
        val hash = MessageDigest.getInstance("SHA-256").digest(pcm).joinToString("") { "%02x".format(it.toInt() and 255) }
        val t = transport { method, _, _ ->
            assertEquals("GET", method)
            reply(200, cap().put("uploadAllowed", false))
        }
        assertFalse(t.probeCapabilities().getBoolean("uploadAllowed"))
        fails<IllegalArgumentException> { t.putObject(target(), hash, pcm) }
    }
    @Test fun onlyVerifiedCapabilityThen404MeansMissing() {
        val paths = mutableListOf<String>()
        val t = transport { _, path, _ -> paths.add(path); if (path == "/archive-capabilities") reply(200, cap()) else reply(404) }
        assertNull(t.readReceipt(target(), "record", "a".repeat(64)))
        assertEquals(listOf("/archive-capabilities", "/recordings/record/receipts/" + "a".repeat(64)), paths)
        fails<RecordingArchiveTransport.HttpFailure> { transport { _, _, _ -> reply(404) }.readReceipt(target(), "record", "a".repeat(64)) }
        for (status in listOf(403, 503)) fails<RecordingArchiveTransport.HttpFailure> {
            transport { _, path, _ -> if (path == "/archive-capabilities") reply(200, cap()) else reply(status) }
                .readReceipt(target(), "record", "a".repeat(64))
        }
    }
    @Test fun wrongTargetOrNamespaceNeverWrites() {
        var writes = 0
        val t = transport { method, _, _ -> if (method == "PUT") writes++; reply(200, cap().put("storageNamespaceId", "other")) }
        fails<IllegalArgumentException> { t.initialize(target()) }
        fails<IllegalArgumentException> { t.initialize(RecordingArchiveCoordinator.Target("other", ns, "phone", 1, true)) }
        assertEquals(0, writes)
    }
    @Test fun unknownWriteIsNotReplayed() {
        val pcm = byteArrayOf(1, 2)
        val hash = MessageDigest.getInstance("SHA-256").digest(pcm).joinToString("") { "%02x".format(it.toInt() and 255) }
        for (kind in 0..2) {
            var writes = 0
            val t = transport { method, _, _ ->
                if (method == "GET") reply(200, cap()) else {
                    writes++
                    when(kind) { 0 -> throw IOException("lost response"); 1 -> reply(503); else -> RecordingArchiveTransport.Reply(200, byteArrayOf(0xff.toByte())) }
                }
            }
            fails<RecordingArchiveCoordinator.UnknownWrite> { t.putObject(target(), hash, pcm) }
            assertEquals(1, writes)
        }
    }
    @Test fun catalogUsesProductionStorageNamespaceIdField() {
        // Exact response keys from RecordingArchiveCatalog.list; runtime returns this object unchanged.
        val page = JSONObject().put("items", org.json.JSONArray()).put("nextCursor", JSONObject.NULL)
            .put("snapshotRevision", "snapshot-1").put("storageNamespaceId", ns)
            .put("offline", false).put("lastSyncedAt", 123L)
        val t = transport { _, path, _ ->
            if (path == "/archive-capabilities") reply(200, cap()) else {
                assertEquals("/recordings?limit=50", path)
                reply(200, page)
            }
        }
        assertEquals(ns, t.readCatalog(target()).getString("storageNamespaceId"))
        assertFalse(t.readCatalog(target()).has("namespace"))
        page.put("storageNamespaceId", "22222222-2222-4222-8222-222222222222")
        fails<IllegalArgumentException> { t.readCatalog(target()) }
        page.remove("storageNamespaceId")
        page.put("namespace", ns) // The obsolete client-only name must not be accepted.
        fails<org.json.JSONException> { t.readCatalog(target()) }
    }
    @Test fun objectIntegrityAndCapabilityChecked() {
        val pcm = byteArrayOf(1, 2)
        val hash = MessageDigest.getInstance("SHA-256").digest(pcm).joinToString("") { "%02x".format(it.toInt() and 255) }
        val t = transport { method, path, _ ->
            if (path == "/archive-capabilities") reply(200, cap())
            else if (method == "PUT") reply(200, JSONObject().put("sha256", hash).put("bytes", 2).put("storageNamespaceId", ns))
            else RecordingArchiveTransport.Reply(200, pcm)
        }
        t.putObject(target(), hash, pcm)
        assertArrayEquals(pcm, t.readObject(target(), hash, 2))
        fails<IllegalArgumentException> { t.readObject(target(), hash, 4) }
        fails<IllegalArgumentException> { t.putObject(target(), "a".repeat(64), pcm) }
    }
}
