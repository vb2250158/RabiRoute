package com.rabi.link.recording

import java.io.File
import java.io.RandomAccessFile
import kotlin.math.sqrt

/** Read-only levels from the existing capture owner; this never opens another microphone. */
object AudioLevels {
    private const val COUNT = 120
    private val levels = FloatArray(COUNT)
    private var written = 0L
    private var lastReceived = -1L
    private var energy = 0.0
    private var samples = 0

    // One bar is 1600 real PCM samples (100 ms at 16 kHz), regardless of callback batching.
    @JvmStatic @Synchronized fun accept(pcm: ByteArray, elapsedMs: Long) {
        require(pcm.size % 2 == 0)
        if(pcm.isEmpty()) return
        if(lastReceived >= 0 && elapsedMs-lastReceived > maxOf(1000L,pcm.size/32L+200)) reset()
        lastReceived = elapsedMs
        var index = 0
        while(index + 1 < pcm.size) {
            val value = ((pcm[index].toInt() and 255) or (pcm[index+1].toInt() shl 8)).toShort().toDouble()/32768.0
            energy += value*value; samples++; index += 2
            if(samples == 1600) {
                levels[(written % COUNT).toInt()] = sqrt(energy/samples).toFloat()
                written++; energy = 0.0; samples = 0
            }
        }
    }
    @JvmStatic @Synchronized fun reset() { levels.fill(0f); written = 0; lastReceived = -1; energy = 0.0; samples = 0 }
    @Synchronized fun snapshot(elapsedMs: Long): FloatArray {
        if(lastReceived < 0 || elapsedMs-lastReceived > 1000) return FloatArray(COUNT)
        val partial = if(samples > 0) 1 else 0
        val count = minOf(written, (COUNT-partial).toLong()).toInt()
        return FloatArray(COUNT).also { result ->
            for(i in 0 until count) result[COUNT-partial-count+i] = levels[((written-count+i)%COUNT).toInt()]
            if(partial == 1) result[COUNT-1] = sqrt(energy/samples).toFloat()
        }
    }

    /** PCM16 RIFF chunks, including nonstandard headers; aggregate actual samples in bounded memory. */
    fun wave(file: File): FloatArray = RandomAccessFile(file,"r").use { input ->
        fun tag(): String = ByteArray(4).also { input.readFully(it) }.toString(Charsets.US_ASCII)
        fun uint(): Long = Integer.reverseBytes(input.readInt()).toLong() and 0xffffffffL
        require(tag() == "RIFF"); uint(); require(tag() == "WAVE")
        var pcm16 = false
        while(input.filePointer + 8 <= input.length()) {
            val kind = tag(); val length = uint(); val start = input.filePointer
            require(length <= input.length() - start) { "音频文件不完整" }
            if(kind == "fmt ") {
                require(length >= 16)
                val format = java.lang.Short.reverseBytes(input.readShort()).toInt()
                input.skipBytes(12)
                val bits = java.lang.Short.reverseBytes(input.readShort()).toInt()
                pcm16 = format == 1 && bits == 16
            } else if(kind == "data") {
                require(pcm16) { "波形仅支持 PCM16" }
                val count = length / 2
                val sum = DoubleArray(COUNT); val sizes = LongArray(COUNT)
                val buffer = ByteArray(8192); var readSamples = 0L
                while(readSamples < count) {
                    val bytes = minOf(buffer.size.toLong(),(count - readSamples) * 2).toInt()
                    input.readFully(buffer,0,bytes)
                    for(index in 0 until bytes step 2) {
                        val value = ((buffer[index].toInt() and 255) or (buffer[index+1].toInt() shl 8)).toShort().toDouble() / 32768.0
                        val bin = (readSamples * COUNT / count).toInt().coerceAtMost(COUNT-1)
                        sum[bin] += value * value; sizes[bin]++; readSamples++
                    }
                }
                return@use FloatArray(COUNT) { if(sizes[it] > 0) sqrt(sum[it]/sizes[it]).toFloat() else 0f }
            }
            input.seek(start + length + length % 2)
        }
        error("没有音频数据")
    }
}
