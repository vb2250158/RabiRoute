package com.rabi.link.recording

import org.junit.Assert.*
import org.junit.Test
import java.io.File

class AudioLevelsTest {
    @Test fun liveLevelsUseSignedPcmAndExpireWithoutInventedMotion() {
        AudioLevels.reset()
        AudioLevels.accept(byteArrayOf(0,64,0,-64),12000)
        assertEquals(0.5f,AudioLevels.snapshot(12000).last(),0.0001f)
        assertTrue(AudioLevels.snapshot(24100).all { it == 0f })
        AudioLevels.reset()
        assertTrue(AudioLevels.snapshot(12000).all { it == 0f })
    }
    @Test fun batchingAndCallbackJitterDoNotCreateHoles() {
        val pcm = ByteArray(16000) { if(it % 2 == 0) 0 else 64 }
        AudioLevels.reset(); AudioLevels.accept(pcm,1000)
        val batch = AudioLevels.snapshot(1000)
        AudioLevels.reset()
        pcm.asList().chunked(640).forEachIndexed { i, chunk -> AudioLevels.accept(chunk.toByteArray(),1000L+i*23) }
        assertArrayEquals(batch,AudioLevels.snapshot(1552),0.00001f)
        assertTrue(batch.takeLast(5).all { it == 0.5f })
    }
    @Test fun realGapClearsOldBarsButSilenceRemainsZero() {
        AudioLevels.reset(); AudioLevels.accept(ByteArray(3200) { if(it % 2 == 0) 0 else 64 },1000)
        assertTrue(AudioLevels.snapshot(2101).all { it == 0f })
        AudioLevels.accept(ByteArray(3200),2200)
        assertTrue(AudioLevels.snapshot(2200).all { it == 0f })
    }
    @Test fun savedWavePreservesSilenceAndSignalAcrossBins() {
        val file = File.createTempFile("waveform-test",".wav")
        try {
            PcmWaveWriter(file).use { writer ->
                writer.write(ByteArray(480))
                writer.write(ByteArray(480) { if(it % 2 == 0) 0 else 64 })
            }
            val levels = AudioLevels.wave(file)
            assertEquals(120,levels.size)
            assertTrue(levels.take(60).all { it == 0f })
            assertTrue(levels.drop(60).all { kotlin.math.abs(it-0.5f) < 0.0001f })
        } finally { file.delete() }
    }
}
