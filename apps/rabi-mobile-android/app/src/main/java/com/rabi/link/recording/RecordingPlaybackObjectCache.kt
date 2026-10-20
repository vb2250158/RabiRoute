package com.rabi.link.recording

import java.io.File
import java.io.FileOutputStream
import java.security.MessageDigest

/** Replaceable playback bytes only. A cache hit is never evidence that the PC still has an original. */
class RecordingPlaybackObjectCache(private val root: File, private val ttlMs: Long,
    private val maximumBytes: Long = 256L * 1024 * 1024, private val now: () -> Long = System::currentTimeMillis) {
    companion object { private val lock = Any() }
    private fun digest(bytes: ByteArray) = MessageDigest.getInstance("SHA-256").digest(bytes)
        .joinToString("") { "%02x".format(it.toInt() and 255) }
    private fun file(hash: String): File {
        require(hash.matches(Regex("[a-f0-9]{64}")))
        return File(root,"$hash.pcm")
    }
    fun read(hash: String, bytes: Int): ByteArray? { synchronized(lock) {
        val file = file(hash)
        if(ttlMs <= 0 || !file.isFile) return null
        if(now()-file.lastModified() >= ttlMs || file.length() != bytes.toLong()) { file.delete(); return null }
        val value = file.readBytes()
        if(digest(value) != hash) { file.delete(); return null }
        file.setLastModified(now())
        return value
    } }
    fun retain(hash: String, bytes: ByteArray) { synchronized(lock) {
        require(bytes.isNotEmpty() && bytes.size <= 1024*1024 && digest(bytes) == hash)
        if(ttlMs <= 0 || bytes.size > maximumBytes) return
        check(root.isDirectory || root.mkdirs())
        val destination = file(hash)
        val temporary = File(root,"$hash.partial")
        try {
            FileOutputStream(temporary).use { it.write(bytes); it.fd.sync() }
            if(destination.exists()) check(destination.delete())
            check(temporary.renameTo(destination)); destination.setLastModified(now())
            var total = 0L
            root.listFiles { f -> f.isFile && f.name.matches(Regex("[a-f0-9]{64}\\.pcm")) }.orEmpty()
                .sortedByDescending { it.lastModified() }.forEach { f ->
                    total += f.length()
                    if(total > maximumBytes || now()-f.lastModified() >= ttlMs) f.delete()
                }
        } finally { temporary.delete() }
    } }
}
