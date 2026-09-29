package com.rabi.link.test

import android.app.Activity
import android.app.Instrumentation
import android.content.ContextWrapper
import android.os.Bundle
import com.rabi.link.recording.RecordingStore
import org.json.JSONObject
import java.io.File

/** Fixtures use a unique cache directory; never reads or exports the user's recordings. */
class RecordingPaginationInstrumentation : Instrumentation() {
    override fun onCreate(arguments: Bundle) { super.onCreate(arguments); start() }
    override fun onStart() {
        val output = Bundle()
        var code = Activity.RESULT_OK
        val root = File(targetContext.cacheDir, "pagination-${System.nanoTime()}").apply { check(mkdirs()) }
        try {
            val minimum = com.rabi.link.recording.TimelineRulerMath.zoom(3_000,10.0)
            val maximum = com.rabi.link.recording.TimelineRulerMath.zoom(86_400_000,0.1)
            check(minimum == 3_000L && maximum == 86_400_000L)
            for (span in listOf(minimum,maximum)) {
                val bounds = com.rabi.link.recording.TimelineRulerMath.range(System.currentTimeMillis(),span)
                check(bounds.last-bounds.first == span)
            }
            val isolated = object : ContextWrapper(targetContext) { override fun getFilesDir() = root }
            val expected = (0 until 205).map { "event-%03d".format(it) }
            expected.forEachIndexed { index, id ->
                val dir = File(root, "rabi-records/$id").apply { mkdirs() }
                File(dir, "sample.wav").writeBytes(byteArrayOf(0))
                File(dir, "session.json").writeText(JSONObject().put("id",id).put("kind","audio").put("source","phone")
                    .put("started",if(index < 100) 1000L else 90L * 86400000).put("ended",90L * 86400000 + 1000)
                    .put("state","saved").put("directory","rabi-records/$id").toString())
            }
            val store = RecordingStore(isolated)
            for (older in listOf(true,false)) {
                val seen = mutableListOf<String>()
                var time = if(older) Long.MAX_VALUE else 0L
                var cursor = if(older) "\uffff" else ""
                do {
                    val page = store.page(time,cursor,older,0)
                    val rows = page.take(100)
                    seen.addAll(rows.map { it.id })
                    rows.lastOrNull()?.let { time = it.started; cursor = it.id }
                } while(page.size > 100)
                check(seen == if(older) expected.reversed() else expected) { "Lost or duplicated records: ${seen.size}" }
            }
            check(store.page(Long.MAX_VALUE,"\uffff",true,2).isEmpty())
            val spool = File(root,"rabi-conversation/audio-spool").apply { mkdirs() }
            val segments = File(spool,"segments").apply { mkdirs() }
            for(i in 0 until 205) {
                val id = "audio-%03d".format(i)
                File(segments,"$id.json").writeText(JSONObject().put("eventId",id).put("captureId",id).put("sha256","a".repeat(64))
                    .put("sequence",i).put("bytes",32000).put("startedAt",1000L+i).put("endedAt",2000L+i).put("source","mobile")
                    .put("processingPolicy",if(i == 1) "local_only" else "transcribe").toString())
                if(i == 0 || i == 204) File(spool,"asr-$id.json").writeText(JSONObject().put("eventId",id).put("captureId",id).put("text","recognized").put("completedAt",99999999).toString())
            }
            com.rabi.link.transport.AsrEventProgress.processing("audio-002")
            com.rabi.link.transport.AsrEventProgress.retry("audio-003")
            File(spool,"asr-audio-100.json").writeText(JSONObject().put("eventId","audio-100").put("captureId","audio-100").put("text","  ").toString())
            val allAudio = com.rabi.link.recording.RabiAudioRecordRepository.listCaptureRecords(isolated,0L,10000L)
            check(allAudio.length() == 205) { "Saved audio must not depend on ASR receipts" }
            val byId = (0 until allAudio.length()).map { allAudio.getJSONObject(it) }.associateBy { it.getString("id") }
            check(byId.getValue("audio-001").getString("processingPolicy") == "local_only")
            check(byId.getValue("audio-002").getString("asrState") == "processing")
            check(byId.getValue("audio-003").getString("asrState") == "retry")
            check(byId.getValue("audio-004").getString("asrState") == "pending")
            check(byId.getValue("audio-100").getJSONObject("transcript").getString("text").isBlank())
            check(byId.values.sumOf { it.getLong("durationMs") } == 205000L)
            check(byId.values.all { it.getJSONArray("playbackSpans").length() == 1 })
            for (older in listOf(true,false)) {
                val seen = mutableListOf<String>()
                var time = if(older) Long.MAX_VALUE else 0L
                var cursor = if(older) "\uffff" else ""
                do {
                    val page = com.rabi.link.recording.RabiAudioRecordRepository.page(isolated,time,cursor,older,0)
                    val rows = (0 until page.length()).map { page.getJSONObject(it) }
                        .sortedBy { it.getLong("startedAt") }.let { if(older) it.reversed() else it }.take(100)
                    seen.addAll(rows.map { it.getString("id") })
                    rows.lastOrNull()?.let { time = it.getLong("startedAt"); cursor = it.getString("id") }
                } while(page.length() > 100)
                val expectedAudio = (0 until 205).map { "audio-%03d".format(it) }
                check(seen == if(older) expectedAudio.reversed() else expectedAudio) { "ASR state changed audio pagination: ${seen.size}" }
            }
            check(com.rabi.link.recording.RabiAudioRecordRepository.page(isolated,Long.MAX_VALUE,"\uffff",true,2).length() == 0)
            File(spool,"asr-audio-100.json").writeText(JSONObject().put("eventId","audio-100").put("captureId","audio-100").put("text","late recognized words").toString())
            val refreshed = com.rabi.link.recording.RabiAudioRecordRepository.listCaptureRecords(isolated,0L,10000L)
            check(refreshed.length() == 205)
            check((0 until refreshed.length()).map { refreshed.getJSONObject(it) }.single { it.getString("id") == "audio-100" }
                .getJSONObject("transcript").getString("text") == "late recognized words")
            output.putString("result","PASS: all 205 saved audio events visible across local-only/pending/processing/retry/empty/nonempty ASR; both pagination directions, source filter, playback coverage, late transcript refresh; 3-second/24-hour zoom bounds; same-time IDs, 90-day gap, real EOF")
        } catch(error: Throwable) { code = Activity.RESULT_CANCELED; output.putString("error",error.stackTraceToString()) }
        finally {
            com.rabi.link.transport.AsrEventProgress.complete("audio-002")
            com.rabi.link.transport.AsrEventProgress.complete("audio-003")
            root.deleteRecursively()
        }
        finish(code,output)
    }
}
