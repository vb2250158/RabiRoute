package com.rabi.link.recording

import android.content.Context
import android.media.MediaCodec
import android.media.MediaExtractor
import android.media.MediaFormat
import android.media.MediaMetadataRetriever
import android.media.MediaMuxer
import java.io.File
import java.nio.ByteBuffer
import java.security.MessageDigest

/** Fragmented recordings may advertise only their first fragment's duration. Read sample times. */
object RecordedMedia {
    private val durations = android.util.LruCache<String, Long>(128)
    private fun key(file: File) = "${file.absolutePath}:${file.length()}:${file.lastModified()}"

    fun duration(file: File): Long {
        val key = key(file)
        durations.get(key)?.let { return it }
        val value = if(file.extension.equals("mp4", true)) {
            val extractor = MediaExtractor()
            try {
                extractor.setDataSource(file.absolutePath)
                val first = LongArray(extractor.trackCount) { -1 }
                val last = LongArray(extractor.trackCount) { -1 }
                val step = LongArray(extractor.trackCount)
                for(index in first.indices) extractor.selectTrack(index)
                while(extractor.sampleTrackIndex >= 0) {
                    val index = extractor.sampleTrackIndex
                    val time = extractor.sampleTime
                    if(first[index] < 0) first[index] = time
                    if(last[index] >= 0 && time > last[index]) step[index] = time - last[index]
                    last[index] = maxOf(last[index],time)
                    if(!extractor.advance()) break
                }
                first.indices.maxOfOrNull { if(first[it] < 0) 0 else (last[it] - first[it] + step[it]) / 1000 } ?: 0
            } finally { extractor.release() }
        } else {
            val reader = MediaMetadataRetriever()
            try { reader.setDataSource(file.absolutePath); reader.extractMetadata(MediaMetadataRetriever.METADATA_KEY_DURATION)?.toLongOrNull() ?: 0 }
            finally { reader.release() }
        }
        require(value > 0) { "无法读取媒体时长" }
        durations.put(key,value)
        return value
    }

    /** Build a seekable cache index without re-encoding or changing the original recording. */
    @Synchronized fun playbackFile(context: Context, source: File): File {
        if(!source.extension.equals("mp4", true)) return source
        val hash = MessageDigest.getInstance("SHA-256").digest(key(source).toByteArray()).joinToString("") { "%02x".format(it) }
        val root = File(context.cacheDir,"recording-playback").apply { mkdirs() }
        val target = File(root,"$hash.mp4")
        if(target.isFile && target.length() > 0) return target
        val pending = File(root,"$hash.tmp")
        val extractor = MediaExtractor()
        var muxer: MediaMuxer? = null
        try {
            extractor.setDataSource(source.absolutePath)
            val output = MediaMuxer(pending.absolutePath,MediaMuxer.OutputFormat.MUXER_OUTPUT_MPEG_4)
            muxer = output
            val tracks = mutableMapOf<Int,Int>()
            for(index in 0 until extractor.trackCount) {
                val format = extractor.getTrackFormat(index)
                val mime = format.getString(MediaFormat.KEY_MIME).orEmpty()
                if(mime.startsWith("audio/") || mime.startsWith("video/")) {
                    tracks[index] = output.addTrack(format); extractor.selectTrack(index)
                }
            }
            check(tracks.isNotEmpty()) { "没有可播放轨道" }
            output.start()
            var buffer = ByteBuffer.allocate(1024 * 1024)
            val info = MediaCodec.BufferInfo()
            val start = extractor.sampleTime.coerceAtLeast(0)
            while(extractor.sampleTrackIndex >= 0) {
                val size = extractor.sampleSize
                check(size <= 32L * 1024 * 1024) { "媒体帧过大" }
                if(size > buffer.capacity()) buffer = ByteBuffer.allocate(size.toInt())
                buffer.clear()
                val read = extractor.readSampleData(buffer,0)
                if(read < 0) break
                info.set(0,read,(extractor.sampleTime-start).coerceAtLeast(0),
                    if(extractor.sampleFlags and MediaExtractor.SAMPLE_FLAG_SYNC != 0) MediaCodec.BUFFER_FLAG_KEY_FRAME else 0)
                output.writeSampleData(tracks.getValue(extractor.sampleTrackIndex),buffer,info)
                if(!extractor.advance()) break
            }
            output.stop(); output.release(); muxer = null
            check(pending.renameTo(target)) { "无法保存播放索引" }
            return target
        } finally { runCatching { muxer?.release() }; extractor.release(); pending.delete() }
    }
}
