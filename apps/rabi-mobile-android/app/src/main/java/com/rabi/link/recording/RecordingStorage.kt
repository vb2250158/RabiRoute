package com.rabi.link.recording

import java.io.File
import java.nio.file.Files
import java.nio.file.Path
import java.nio.file.SimpleFileVisitor
import java.nio.file.FileVisitResult
import java.nio.file.attribute.BasicFileAttributes
import java.io.IOException
import java.util.Locale

/** Read-only, non-overlapping recording roots. Never opens media contents or follows symbolic links. */
object RecordingStorage {
    enum class Kind(val title: String) { AUDIO("录音"), VIDEO("录像"), TRANSCRIPT("转录文字"), INDEX("记录索引与日志"), CACHE("回看与导出缓存") }
    data class Snapshot(val bytes: Map<Kind, Long>, val unavailable: Int, val availableBytes: Long) {
        val totalBytes: Long get() = bytes.values.sum()
    }
    fun scan(files: File, cache: File): Snapshot {
        val totals = Kind.values().associateWith { 0L }.toMutableMap()
        var unavailable = 0
        val roots = listOf("rabi-conversation/audio-spool", "rabi-records", "rabi-live-recordings",
            "rabi-record-markers", "recording-resource-index", "video-audio-derivation", "video-audio-session-queue").map { File(files,it) to false } +
            listOf("recording-playback", "recording-exports").map { File(cache,it) to true }
        roots.forEach { (root, cached) ->
            if (!Files.exists(root.toPath(), java.nio.file.LinkOption.NOFOLLOW_LINKS)) return@forEach
            try {
                Files.walkFileTree(root.toPath(), object : SimpleFileVisitor<Path>() {
                    override fun visitFile(path: Path, attrs: BasicFileAttributes): FileVisitResult {
                        if (Thread.currentThread().isInterrupted) return FileVisitResult.TERMINATE
                        if (attrs.isRegularFile) {
                            val name = path.fileName.toString().lowercase(Locale.ROOT).removeSuffix(".partial")
                            val kind = when {
                                cached -> Kind.CACHE
                                name.endsWith(".pcm") || name.endsWith(".wav") || name.endsWith(".m4a") || name.endsWith(".aac") -> Kind.AUDIO
                                name.endsWith(".mp4") || name.endsWith(".mkv") || name.endsWith(".h264") || name.endsWith(".h265") || name.endsWith(".ts") -> Kind.VIDEO
                                name.startsWith("asr-") && name.endsWith(".json") -> Kind.TRANSCRIPT
                                else -> Kind.INDEX
                            }
                            totals[kind] = totals.getValue(kind) + attrs.size()
                        }
                        return FileVisitResult.CONTINUE
                    }
                    override fun visitFileFailed(path: Path, error: IOException): FileVisitResult {
                        unavailable++; return FileVisitResult.CONTINUE
                    }
                })
            } catch (_: IOException) { unavailable++ }
        }
        return Snapshot(totals, unavailable, files.usableSpace)
    }
    fun formatBytes(bytes: Long): String {
        var value = bytes.coerceAtLeast(0).toDouble()
        val units = arrayOf("B", "KB", "MB", "GB", "TB")
        var index = 0
        while(value >= 1000 && index < units.lastIndex) { value /= 1000; index++ }
        return if(index == 0) "${value.toLong()} B" else String.format(Locale.ROOT,"%.2f %s",value,units[index])
    }
}
