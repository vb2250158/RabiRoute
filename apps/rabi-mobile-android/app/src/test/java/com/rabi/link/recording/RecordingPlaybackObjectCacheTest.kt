package com.rabi.link.recording

import org.junit.Test
import org.junit.Rule
import org.junit.rules.TemporaryFolder
import org.junit.Assert.*
import java.security.MessageDigest

class RecordingPlaybackObjectCacheTest {
    @get:Rule val temporary = TemporaryFolder()
    private fun hash(bytes: ByteArray) = MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it.toInt() and 255) }
    @Test fun playbackBytesAreVerifiedExpireAndRemainBounded() {
        val root = temporary.newFolder(); var time = 1000L
        val cache = RecordingPlaybackObjectCache(root,1000L,8L) { time }
        val first = byteArrayOf(1,2,3,4); val second = byteArrayOf(5,6,7,8); val third = byteArrayOf(9,10,11,12)
        cache.retain(hash(first),first); assertArrayEquals(first,cache.read(hash(first),4))
        time++; cache.retain(hash(second),second); time++; cache.retain(hash(third),third)
        assertNull(cache.read(hash(first),4)); assertTrue(root.listFiles()!!.sumOf { it.length() } <= 8)
        java.io.File(root,"${hash(second)}.pcm").writeBytes(first)
        assertNull(cache.read(hash(second),4))
        time += 1000; assertNull(cache.read(hash(third),4))
    }
    @Test fun disabledRetentionDoesNotCreateCacheFiles() {
        val root = temporary.newFolder(); val bytes = byteArrayOf(1,2)
        val cache = RecordingPlaybackObjectCache(root,0)
        cache.retain(hash(bytes),bytes); assertEquals(0,root.listFiles()!!.size)
    }
}
