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
                    .put("sequence",i).put("bytes",32000).put("startedAt",1000L+i).put("endedAt",2000L+i).put("source","mobile").toString())
                if(i == 0 || i == 204) File(spool,"asr-$id.json").writeText(JSONObject().put("eventId",id).put("captureId",id).put("text","recognized").put("completedAt",99999999).toString())
            }
            val asr = com.rabi.link.recording.RabiAudioRecordRepository.page(isolated,Long.MAX_VALUE,"\uffff",true,0,true)
            check(asr.length() == 2) { "Hidden audio must not consume a page" }
            check(asr.getJSONObject(0).getLong("startedAt") == 1204L)
            val previous = com.rabi.link.recording.RabiAudioRecordRepository.page(isolated,1204,"audio-204",true,0,true)
            check(previous.length() == 1 && previous.getJSONObject(0).getString("id") == "audio-000")
            val next = com.rabi.link.recording.RabiAudioRecordRepository.page(isolated,1000,"audio-000",false,0,true)
            check(next.length() == 1 && next.getJSONObject(0).getString("id") == "audio-204")
            File(spool,"asr-audio-100.json").writeText(JSONObject().put("eventId","audio-100").put("captureId","audio-100").put("text","  ").toString())
            check(com.rabi.link.recording.RabiAudioRecordRepository.listAsrRecords(isolated,0,10000).length() == 2)
            File(spool,"asr-audio-100.json").writeText(JSONObject().put("eventId","audio-100").put("captureId","audio-100").put("text","late recognized words").toString())
            check(com.rabi.link.recording.RabiAudioRecordRepository.listAsrRecords(isolated,0,10000).length() == 3)
            output.putString("result","PASS: ASR visibility, original time, adjacent navigation across 203 hidden recordings, late transcript refresh; 3-second/24-hour zoom bounds; 205 events, both directions, same-time IDs, 90-day gap, source filter, real EOF")
        } catch(error: Throwable) { code = Activity.RESULT_CANCELED; output.putString("error",error.stackTraceToString()) }
        finally { root.deleteRecursively() }
        finish(code,output)
    }
}
