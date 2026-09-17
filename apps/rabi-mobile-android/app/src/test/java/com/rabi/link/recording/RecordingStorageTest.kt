package com.rabi.link.recording

import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.File

class RecordingStorageTest {
    @get:Rule val temporary = TemporaryFolder()
    @Test fun countsOnlyRecordingRootsAndRefreshesGrowingFiles() {
        val files = temporary.newFolder("files"); val cache = temporary.newFolder("cache")
        fun file(root: File, path: String, bytes: Int): File = File(root,path).apply { parentFile!!.mkdirs(); writeBytes(ByteArray(bytes)) }
        val audio = file(files,"rabi-conversation/audio-spool/segments/active.pcm.partial",1100)
        file(files,"rabi-conversation/audio-spool/asr-event.json",30)
        file(files,"rabi-records/session/session.json",70)
        file(files,"rabi-live-recordings/sessions/session/video.mp4",2000)
        file(cache,"recording-playback/audio.wav",300)
        file(files,"unrelated/model.bin",9999)
        file(cache,"unrelated.bin",9999)
        val first = RecordingStorage.scan(files,cache)
        assertEquals(3500L,first.totalBytes)
        assertEquals(1100L,first.bytes.getValue(RecordingStorage.Kind.AUDIO))
        assertEquals(300L,first.bytes.getValue(RecordingStorage.Kind.CACHE))
        assertEquals(0,first.unavailable)
        audio.appendBytes(ByteArray(500))
        assertEquals(4000L,RecordingStorage.scan(files,cache).totalBytes)
    }
    @Test fun formatsDecimalStorageUnitsWithoutIntegerOverflow() {
        assertEquals("0 B",RecordingStorage.formatBytes(0))
        assertEquals("1.50 GB",RecordingStorage.formatBytes(1_500_000_000L))
        assertEquals("3.00 TB",RecordingStorage.formatBytes(3_000_000_000_000L))
    }
}
