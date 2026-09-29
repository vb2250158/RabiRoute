package com.rabi.link.recording
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

class RecordingArchiveRepositoryAdapterTest {
    // Actual catalog.ts row() and list() fields; deliberately no text, owner or namespace aliases.
    private val wire = """{"items":[{"recordId":"record","captureId":"capture","eventId":"event","deviceId":"phone","source":"phone","startedAt":1,"endedAt":2,"totalBytes":32,"manifestHash":"hash","manifestReference":"ref","processingPolicy":"transcribe","asrState":"queued"}],"nextCursor":null,"snapshotRevision":"revision","storageNamespaceId":"ns","offline":false,"lastSyncedAt":12}"""
    private val identity = RecordingArchiveRepository.Identity("phone","worker","ns")
    @Test fun mapsActualCatalogWithoutInventingAsrCompletion() {
        val page = RecordingArchiveRepositoryAdapter.decodePage(JSONObject(wire),identity)
        assertEquals(1,page.items.size); assertEquals("",page.items[0].text)
        assertEquals("queued",page.items[0].asrState); assertTrue(page.items[0].archived)
        assertEquals("committed",page.items[0].uploadState); assertNull(page.nextCursor)
    }
    @Test fun rejectsLegacyWrongNamespaceFieldAndCrossOwner() {
        val wrong = JSONObject(wire);wrong.put("namespace",wrong.remove("storageNamespaceId"))
        try { RecordingArchiveRepositoryAdapter.decodePage(wrong,identity); fail() } catch(_: org.json.JSONException) { }
        val cross = JSONObject(wire);cross.getJSONArray("items").getJSONObject(0).put("deviceId","another")
        try { RecordingArchiveRepositoryAdapter.decodePage(cross,identity);fail() } catch(_: IllegalArgumentException) { }
    }
    @Test fun preservesExplicitEmptyTextAndOfflineTime() {
        val json=JSONObject(wire).put("offline",true);json.getJSONArray("items").getJSONObject(0).put("text","")
        val page=RecordingArchiveRepositoryAdapter.decodePage(json,identity)
        assertTrue(page.offline);assertEquals(12L,page.lastSyncedAt);assertEquals("",page.items[0].text)
    }
}
