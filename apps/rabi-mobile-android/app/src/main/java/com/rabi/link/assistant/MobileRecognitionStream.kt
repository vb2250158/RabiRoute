package com.rabi.link.assistant

import com.rabi.link.transport.RabiSpeechTunnel
import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.io.InputStream
import java.util.concurrent.ArrayBlockingQueue
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean

/** Body and ordered result stream for one bound mobile recognition round. */
internal class MobileRecognitionStream(
    val id: String,
    private val emit: (JSONObject) -> Unit
) : AutoCloseable {
    private val closed = AtomicBoolean(false)
    private val input = AudioBlocks()
    @Volatile private var tunnel: RabiSpeechTunnel? = null

    fun offer(sequence: Int, bytes: ByteArray): Boolean = !closed.get() && input.offer(sequence, bytes)

    fun run(connection: RabiSpeechTunnel, path: String, stillCurrent: () -> Boolean) {
        try {
            if (closed.get()) return
            tunnel = connection
            if (closed.get()) return
            check(stillCurrent()) { "MOBILE_COMPUTER_CHANGED" }
            val meta = connection.requestHttp("GET", "/meta", JSONObject(), ByteArray(0), 12_000)
            check(meta.status == 200) { "MOBILE_COMPUTER_UNAVAILABLE" }
            val identity = JSONObject(String(meta.body, Charsets.UTF_8))
            val generation = identity.getString("applicationGenerationId")
            val owner = identity.getString("managerInstanceId")
            val health = identity.getJSONObject("health")
            check(health.getBoolean("live") && health.getString("state") in listOf("healthy", "degraded")) {
                "MOBILE_COMPUTER_UNAVAILABLE"
            }
            val results = RecognitionLines { event ->
                check(stillCurrent()) { "MOBILE_COMPUTER_CHANGED" }
                if (!closed.get()) emit(event)
            }
            connection.streamHttp("POST", path, JSONObject()
                .put("accept", "application/x-ndjson")
                .put("content-type", "application/octet-stream")
                .put("x-rabiroute-expected-application-generation-id", generation)
                .put("x-rabiroute-expected-manager-instance-id", owner), input, false,
                { status, headers ->
                    check(status == 200) { "MOBILE_STREAM_HTTP_" + status }
                    check(headers.optString("content-type").substringBefore(';') == "application/x-ndjson") {
                        "MOBILE_STREAM_CONTENT_INVALID"
                    }
                }, results::accept, 300_000)
            results.end()
            if (!closed.get()) emit(JSONObject().put("type", "end"))
        } catch (error: Exception) {
            if (!closed.get()) {
                val code = error.message.orEmpty().takeIf { it.matches(Regex("[A-Z][A-Z0-9_]{1,100}")) }
                emit(JSONObject().put("type", "error").put("code", code ?: "MOBILE_STREAM_FAILED"))
            }
        } finally {
            close()
            connection.close()
        }
    }

    override fun close() {
        if (!closed.compareAndSet(false, true)) return
        input.close()
        tunnel?.close()
    }

    private class RecognitionLines(private val emit: (JSONObject) -> Unit) {
        private val pending = ByteArrayOutputStream()
        fun accept(bytes: ByteArray) {
            for (byte in bytes) {
                if (byte == 10.toByte()) {
                    if (pending.size() > 0) emit(JSONObject(pending.toString("UTF-8")))
                    pending.reset()
                } else {
                    check(pending.size() < 8192) { "MOBILE_STREAM_EVENT_TOO_LARGE" }
                    pending.write(byte.toInt())
                }
            }
        }
        fun end() {
            check(pending.size() == 0) { "MOBILE_STREAM_EVENT_TRUNCATED" }
        }
    }

    private class AudioBlocks : InputStream() {
        private val blocks = ArrayBlockingQueue<ByteArray>(48)
        @Volatile private var ended = false
        private var expected = 0
        private var offset = 0
        private var current = ByteArray(0)

        @Synchronized fun offer(sequence: Int, frame: ByteArray): Boolean {
            if (ended || sequence != expected || frame.size !in 2..3200 || frame.size % 2 != 0) return false
            if (!blocks.offer(frame)) return false
            expected++
            return true
        }

        override fun read(): Int {
            val byte = ByteArray(1)
            return if (read(byte, 0, 1) == -1) -1 else byte[0].toInt() and 255
        }

        override fun read(buffer: ByteArray, start: Int, max: Int): Int {
            if (max == 0) return 0
            while (!ended) {
                if (offset == current.size) {
                    current = blocks.poll(250, TimeUnit.MILLISECONDS) ?: continue
                    offset = 0
                }
                val length = minOf(max, current.size - offset)
                current.copyInto(buffer, start, offset, offset + length)
                offset += length
                return length
            }
            return -1
        }

        override fun close() {
            ended = true
            blocks.clear()
        }
    }
}
