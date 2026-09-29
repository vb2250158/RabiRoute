package com.rabi.link.recording

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

class RecordingArchiveReviewAccessTest {
    private val target = RecordingArchiveCoordinator.Target("pc", "11111111-1111-1111-1111-111111111111", "phone", 1, true)
    private fun row() = JSONObject().put("recordId","record").put("eventId","event").put("captureId","capture")
        .put("source","phone").put("startedAt",1000).put("endedAt",2000).put("totalBytes",32000)
        .put("owner",target.owner).put("workerId",target.workerId).put("storageNamespaceId",target.namespace)
    @Test fun explicitLocalViewIsNotOverriddenByConfiguredArchive() {
        assertFalse(RecordingArchiveReviewAccess.useRemoteHistory(false,true))
        assertFalse(RecordingArchiveReviewAccess.useRemoteHistory(false,false))
        assertFalse(RecordingArchiveReviewAccess.useRemoteHistory(true,false))
        assertTrue(RecordingArchiveReviewAccess.useRemoteHistory(true,true))
    }
    @Test fun pendingPreviewPreservesEmptyTextAndUnarchivedIdentity() {
        val result = RecordingArchiveReviewAccess.pendingRows(JSONArray().put(row()),target).single()
        assertFalse(result.archived); assertEquals("pending",result.uploadState)
        assertEquals("",result.text); assertEquals("not_requested",result.asrState)
        assertEquals(target.owner,result.identity.owner); assertEquals(32000L,result.totalBytes)
    }
    @Test fun missingMediaRemainsVisibleButBlocked() {
        val result = RecordingArchiveReviewAccess.pendingRows(JSONArray().put(row().put("localMediaPresent",false).put("uploadable",false)),target).single()
        assertEquals("blocked_missing_media",result.uploadState); assertFalse(result.archived)
    }
    @Test fun pendingPreviewRejectsWrongTargetAndUnboundedResults() {
        assertThrows(IllegalArgumentException::class.java) {
            RecordingArchiveReviewAccess.pendingRows(JSONArray().put(row().put("workerId","other")),target)
        }
        val oversized = JSONArray(); repeat(33) { oversized.put(row()) }
        assertThrows(IllegalArgumentException::class.java) { RecordingArchiveReviewAccess.pendingRows(oversized,target) }
    }
}
