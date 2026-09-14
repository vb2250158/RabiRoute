package com.rabi.link.recording

import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

class RecordingTranscriptProjectionTest {
    // Wire shape from rabispeech/app.py speech_records and speech_records.py append_asr.
    private val pythonResponse = """{"object":"list","data":[
      {"id":"asr-1","kind":"asr","source":"microphone","time":1800000000.0,"source_device_id":"rabi-phone-test","source_device_kind":"mobile","source_stream_id":"stream-test","text":"会议记录","captureId":"capture-a","processedAt":1800000123.125,"processing_policy":"transcribe"},
      {"id":"old","kind":"asr","source_device_id":"rabi-phone-test","text":"旧电脑结果","captureId":null,"time":1800000001.0},
      {"id":"other","kind":"asr","source_device_id":"other-phone","text":"别的设备","captureId":"capture-a","processedAt":1800000123},
      {"id":"tts","kind":"tts","source_device_id":"rabi-phone-test","text":"回复","captureId":"capture-a","processedAt":1800000123},
      {"id":"empty","kind":"asr","source_device_id":"rabi-phone-test","text":" ","captureId":"capture-a","processedAt":1800000123}
    ]}"""
    @Test fun parsesActualPythonListAndAssociatesOnlyExactCaptureId() {
        val result = RecordingTranscriptProjection.parse(JSONObject(pythonResponse), "rabi-phone-test", 1900000000000L)
        assertEquals(1, result.records.size)
        assertEquals(1, result.unassigned)
        assertEquals("capture-a", result.records[0].captureId)
        assertEquals("会议记录", result.records[0].text)
        assertEquals(1800000123125L, result.records[0].processedAt)
        assertEquals(1900000000000L, result.fetchedAt)
    }
    @Test fun missingProcessedAtNeverFallsBackToPythonVadTime() {
        val input = JSONObject("""{"object":"list","data":[{"kind":"asr","id":"x","source_device_id":"d","captureId":"c","text":"hello","time":1800000000}]}""")
        assertEquals(0L, RecordingTranscriptProjection.parse(input,"d",1).records.single().processedAt)
    }
    @Test fun relayAddsFenceToRealPythonCapabilitiesAndOldRelayFailsClosed() {
        val python = JSONObject("""{"object":"rabispeech.capabilities","rabilinkAudioStream":{"version":1,"processingPolicies":["transcribe","agent"],"processingPolicyFrozen":true},"streaming":false}""")
        assertFalse(RecordingTranscriptProjection.supportsFencedRecords(python))
        // scripts/rabilink-relay-server.mjs handleSpeechProxy adds this field after upstream response.
        python.getJSONObject("rabilinkAudioStream").put("expectedWorkerFencing", true)
        assertTrue(RecordingTranscriptProjection.supportsFencedRecords(python))
        assertEquals("/api/rabilink/speech/v1/capabilities", RecordingTranscriptProjection.CAPABILITIES_PATH)
    }
    @Test fun portsValidateBoundariesAndRejectCollision() {
        assertEquals(1024, LocalMediaSettings(1024,65535).rtmpPort)
        assertEquals(65535, LocalMediaSettings(1024,65535).previewPort)
        for(pair in listOf(1023 to 8554, 65536 to 8554, 1936 to 1936)) {
            try { LocalMediaSettings(pair.first,pair.second); fail("invalid ports accepted") } catch(expected: IllegalArgumentException) { }
        }
    }
}
