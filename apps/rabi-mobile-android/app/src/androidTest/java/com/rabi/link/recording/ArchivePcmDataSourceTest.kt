package com.rabi.link.recording

import android.net.Uri
import androidx.media3.common.C
import androidx.media3.datasource.DataSpec
import org.json.JSONArray
import org.json.JSONObject
import android.app.Activity
import android.app.Instrumentation
import android.os.Bundle
import java.io.Closeable
import java.io.IOException
import java.security.MessageDigest

@androidx.annotation.OptIn(androidx.media3.common.util.UnstableApi::class)
class ArchivePcmDataSourceTest : Instrumentation() {
    override fun onCreate(arguments: Bundle) { super.onCreate(arguments); start() }
    override fun onStart() {
        val output = Bundle()
        try {
            seekRangeEofAndCloseReleasePin()
            rejectedUriAndOutOfRangeReleaseResources()
            output.putString("stream", "ArchivePcmDataSource: PASS (2 scenarios)\n")
            finish(Activity.RESULT_OK, output)
        } catch (failure: Throwable) {
            output.putString("stream", "ArchivePcmDataSource: FAIL\n${android.util.Log.getStackTraceString(failure)}")
            finish(Activity.RESULT_CANCELED, output)
        }
    }
    private fun assertEquals(expected: Any?, actual: Any?) { check(expected == actual) { "Expected $expected, got $actual" } }
    private fun assertArrayEquals(expected: ByteArray, actual: ByteArray) { check(expected.contentEquals(actual)) { "Byte arrays differ" } }
    private fun assertNull(actual: Any?) { check(actual == null) { "Expected null, got $actual" } }
    private fun assertThrows(type: Class<out Throwable>, action: () -> Unit) {
        try { action() } catch (failure: Throwable) {
            check(type.isInstance(failure)) { "Expected ${type.name}, got ${failure.javaClass.name}" }
            return
        }
        error("Expected ${type.name}")
    }
    private fun manifest(bytes: ByteArray): JSONObject {
        val hash = MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it.toInt() and 255) }
        return JSONObject().put("schemaVersion",1).put("recordId","r").put("captureId","c").put("eventId","e").put("deviceId","d")
            .put("source","phone").put("startedAt",1000).put("endedAt",2000).put("timeBasis","received")
            .put("format",JSONObject().put("codec","pcm_s16le").put("sampleRate",16000).put("channels",1))
            .put("segments",JSONArray().put(JSONObject().put("sequence",1).put("bytes",bytes.size).put("sha256",hash).put("startedAt",1000)))
            .put("objects",JSONArray().put(JSONObject().put("sha256",hash).put("bytes",bytes.size).put("offset",0)))
            .put("gaps",JSONArray()).put("processingPolicy","transcribe").put("totalBytes",bytes.size).put("sealed",true)
    }
    private fun seekRangeEofAndCloseReleasePin() {
        val bytes = ByteArray(32000) { (it % 127).toByte() }
        val manifest = manifest(bytes)
        var opened = 0; var released = 0; var reads = 0
        val factory = ArchivePcmDataSource.Factory("a".repeat(64)) {
            opened++
            ArchivePcmDataSource.Session(ArchivePcmReader(manifest) { _, _ -> reads++; bytes }, Closeable { released++ })
        }
        val source = factory.createDataSource()
        assertEquals(0, opened)
        assertEquals(4L, source.open(DataSpec.Builder().setUri(factory.uri()).setPosition(46).setLength(4).build()))
        assertEquals(0, reads)
        val result = ByteArray(8)
        assertEquals(4,source.read(result,0,8)); assertArrayEquals(bytes.copyOfRange(2,6),result.copyOfRange(0,4))
        assertEquals(C.RESULT_END_OF_INPUT,source.read(result,0,8));assertEquals(0,source.read(result,0,0))
        assertEquals(factory.uri(),source.uri)
        source.close();source.close();assertEquals(1,released);assertNull(source.uri)
        assertThrows(IOException::class.java) { source.read(result,0,1) }
        assertEquals(0L,source.open(DataSpec.Builder().setUri(factory.uri()).setPosition(32044).build()))
        assertEquals(C.RESULT_END_OF_INPUT,source.read(result,0,1));source.close();assertEquals(2,released)
    }
    private fun rejectedUriAndOutOfRangeReleaseResources() {
        val bytes=ByteArray(32000)
        var opens=0;var releases=0
        val factory=ArchivePcmDataSource.Factory("b".repeat(64)) {
            opens++;ArchivePcmDataSource.Session(ArchivePcmReader(manifest(bytes)) { _,_->bytes },Closeable { releases++ })
        }
        val source=factory.createDataSource()
        assertThrows(IOException::class.java) { source.open(DataSpec(Uri.parse("https://example.invalid/private"))) }
        assertEquals(0,opens)
        assertThrows(IOException::class.java) { source.open(DataSpec.Builder().setUri(factory.uri()).setPosition(32045).build()) }
        assertEquals(1,releases);assertNull(source.uri)
        source.close();assertEquals(1,releases)
    }
}
