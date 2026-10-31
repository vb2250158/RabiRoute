package com.rabi.link.transport

import org.json.JSONObject
import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.io.InputStream
import java.io.OutputStream
import java.net.ServerSocket
import java.net.Socket
import java.util.Collections
import java.util.concurrent.CountDownLatch
import java.util.concurrent.SynchronousQueue
import java.util.concurrent.ThreadPoolExecutor
import java.util.concurrent.TimeUnit

/** Paired edge transport. Authentication and Manager path selection belong to the caller. */
internal class PhoneEyeHttpServer(
    private val http: (Request, ResponseSink) -> Unit,
    private val upgrade: ((Request, ResponseSink) -> Unit)? = null,
    private val requestTimeout: () -> Long = { 15000 }
) : AutoCloseable {
    data class Request(val method: String, val path: String, val headers: Map<String, String>, val body: InputStream, val contentLength: Long?)

    /** Forward the actual upstream 101 and raw frames without another WebSocket handshake. */
    class ResponseSink internal constructor(private val output: OutputStream, private val connection: Socket, private val headRequest: Boolean) : AutoCloseable {
        private val done = CountDownLatch(1)
        @Volatile private var ended = false
        private var begun = false
        private var rawUpgrade = false
        private var noBody = false
        private var chunked = false
        private var remaining: Long? = null
        @Synchronized fun begin(status: Int, headers: Map<String, String> = emptyMap(), contentLength: Long? = null) {
            check(!begun && !ended && status in 100..599)
            check(contentLength == null || contentLength >= 0)
            rawUpgrade = status == 101
            noBody = headRequest || status == 204 || status == 304 || (status in 100..199 && !rawUpgrade)
            remaining = if (rawUpgrade || noBody) null else contentLength
            chunked = !rawUpgrade && !noBody && contentLength == null
            val wire = StringBuilder("HTTP/1.1 $status ${if (status == 101) "Switching Protocols" else "Response"}\r\n")
            val names = mutableSetOf<String>()
            headers.forEach { (name, value) ->
                val key = name.lowercase()
                check(name.matches(Regex("[!#$%&'*+.^_`|~0-9A-Za-z-]+")) && !value.any { it == '\r' || it == '\n' || it == '\u0000' })
                check(names.add(key))
                if (key !in setOf("content-length", "transfer-encoding", "connection", "keep-alive", "proxy-connection", "upgrade")) wire.append("$name: $value\r\n")
            }
            if (rawUpgrade) wire.append("Connection: Upgrade\r\nUpgrade: websocket\r\n")
            else {
                wire.append("Connection: close\r\n")
                if (chunked) wire.append("Transfer-Encoding: chunked\r\n")
                else if (contentLength != null) wire.append("Content-Length: $contentLength\r\n")
            }
            wire.append("\r\n")
            output.write(wire.toString().toByteArray(Charsets.ISO_8859_1)); output.flush(); begun = true
        }
        @Synchronized fun write(bytes: ByteArray, offset: Int = 0, length: Int = bytes.size - offset) {
            check(begun && !ended && !noBody)
            require(offset >= 0 && length >= 0 && offset <= bytes.size - length)
            if (length == 0) return
            remaining?.let { check(length.toLong() <= it); remaining = it - length }
            if (chunked) output.write((length.toString(16) + "\r\n").toByteArray(Charsets.US_ASCII))
            output.write(bytes, offset, length)
            if (chunked) output.write("\r\n".toByteArray(Charsets.US_ASCII))
            output.flush()
        }
        @Synchronized fun end() {
            if (ended) return
            check(begun && (remaining == null || remaining == 0L))
            if (chunked) output.write("0\r\n\r\n".toByteArray(Charsets.US_ASCII))
            output.flush(); ended = true; done.countDown()
        }
        @Synchronized internal fun reject() {
            if (!begun && !ended) {
                val bytes = "{\"code\":\"PHONE_BRIDGE_REQUEST_REJECTED\"}".toByteArray()
                begin(403, mapOf("content-type" to "application/json", "cache-control" to "no-store"), bytes.size.toLong())
                write(bytes); end()
            } else close()
        }
        internal fun awaitEnd() { done.await() }
        override fun close() { ended = true; done.countDown(); runCatching { connection.close() } }
    }
    constructor(handle: (String, Map<String, String>, JSONObject) -> JSONObject) : this({ request, sink ->
        check(request.method == "POST")
        val bytes = ByteArrayOutputStream(); val buffer = ByteArray(8192)
        while (true) { val read = request.body.read(buffer); if (read < 0) break; check(bytes.size() <= 12 * 1024 * 1024 - read); bytes.write(buffer, 0, read) }
        val result = handle(request.path, request.headers, JSONObject(bytes.toString("UTF-8"))).toString().toByteArray(Charsets.UTF_8)
        sink.begin(200, mapOf("content-type" to "application/json", "cache-control" to "no-store"), result.size.toLong()); sink.write(result); sink.end()
    })
    private val socket = ServerSocket(0)
    private val active = Collections.synchronizedSet(mutableSetOf<Socket>())
    private val sinks = Collections.synchronizedSet(mutableSetOf<ResponseSink>())
    private val clients = ThreadPoolExecutor(0, 16, 30, TimeUnit.SECONDS, SynchronousQueue(), { task -> Thread(task, "RabiPhoneEyeHttp").apply { isDaemon = true } })
    @Volatile private var closed = false
    val port get() = socket.localPort
    private val acceptor = Thread({
        while (!closed) {
            try {
                val client = socket.accept(); active.add(client)
                if (closed) { active.remove(client); client.close(); continue }
                try { clients.execute { serve(client) } } catch (_: Exception) { active.remove(client); client.close() }
            } catch (_: Exception) { if (!closed) close() }
        }
    }, "RabiPhoneEyeAccept").apply { isDaemon = true; start() }
    private fun serve(client: Socket) {
        var sink: ResponseSink? = null
        try {
            check(!closed)
            client.soTimeout = requestTimeout().toInt()
            val input = client.getInputStream(); val first = line(input).split(' ')
            check(first.size == 3 && first[0].matches(Regex("[A-Z]{1,20}")) && first[1].startsWith('/') && !first[1].startsWith("//") && first[2] == "HTTP/1.1")
            check(!first[1].any { it.code < 33 || it.code > 126 })
            val headers = mutableMapOf<String, String>(); var total = 0
            while (true) {
                val value = line(input); if (value.isEmpty()) break
                total += value.length; check(total <= 16384)
                val split = value.indexOf(':'); check(split > 0)
                val key = value.substring(0, split).lowercase(); check(key.matches(Regex("[!#$%&'*+.^_`|~0-9a-z-]+")) && !headers.containsKey(key))
                val headerValue = value.substring(split + 1).trim()
                check(!headerValue.any { it.code == 127 || (it.code < 32 && it != '\t') })
                headers[key] = headerValue
            }
            val isUpgrade = headers["upgrade"].equals("websocket", true) && headers["connection"].orEmpty().split(',').any { it.trim().equals("upgrade", true) }
            val length = headers["content-length"]?.let { check(it.matches(Regex("[0-9]+"))); it.toLong().also { n -> check(n >= 0) } }; val transfer = headers["transfer-encoding"]
            check(transfer == null || (length == null && transfer.equals("chunked", true)))
            if (isUpgrade) { check(first[0] == "GET" && length == null && transfer == null); client.soTimeout = 0 }
            val body = if (isUpgrade) input else if (transfer != null) ChunkedInput(input) else if (length != null) FixedInput(input, length) else ByteArrayInputStream(ByteArray(0))
            check(length == null || length <= 12L * 1024 * 1024)
            val boundedBody = if (isUpgrade) body else BoundedInput(body, 12L * 1024 * 1024)
            val request = Request(first[0], first[1], headers.toMap(), boundedBody, length)
            sink = ResponseSink(client.getOutputStream(), client, first[0] == "HEAD"); sinks.add(sink)
            check(!closed)
            if (isUpgrade) (upgrade ?: error("UPGRADE_UNAVAILABLE"))(request, sink) else http(request, sink)
            sink.awaitEnd()
        } catch (_: Exception) {
            runCatching { (sink ?: ResponseSink(client.getOutputStream(), client, false)).reject() }
        } finally {
            sink?.close(); sinks.remove(sink); active.remove(client); runCatching { client.close() }
        }
    }
    override fun close() {
        closed = true; runCatching { socket.close() }
        synchronized(sinks) { sinks.toList().forEach { it.close() } }
        synchronized(active) { active.toList().forEach { runCatching { it.close() } } }
        clients.shutdownNow()
    }
    private class BoundedInput(private val input: InputStream, private val limit: Long) : InputStream() {
        private var total = 0L
        private val deadline = System.nanoTime() + 60_000_000_000L
        override fun read(): Int { val bytes = ByteArray(1); return if (read(bytes) < 0) -1 else bytes[0].toInt() and 255 }
        override fun read(bytes: ByteArray, offset: Int, length: Int): Int {
            check(System.nanoTime() < deadline)
            if (length == 0) return 0
            val count = input.read(bytes, offset, minOf(length.toLong(), limit - total + 1).toInt())
            check(System.nanoTime() < deadline)
            if (count > 0) { total += count; check(total <= limit) }
            return count
        }
    }
    private class FixedInput(private val input: InputStream, private var remaining: Long) : InputStream() {
        override fun read(): Int { val bytes = ByteArray(1); return if (read(bytes) < 0) -1 else bytes[0].toInt() and 255 }
        override fun read(bytes: ByteArray, offset: Int, length: Int): Int {
            if (length == 0) return 0
            if (remaining == 0L) return -1
            val count = input.read(bytes, offset, minOf(length.toLong(), remaining).toInt()); check(count >= 0)
            remaining -= count; return count
        }
    }
    private class ChunkedInput(private val input: InputStream) : InputStream() {
        private var remaining = 0L; private var finished = false; private var delimiter = false
        override fun read(): Int { val bytes = ByteArray(1); return if (read(bytes) < 0) -1 else bytes[0].toInt() and 255 }
        override fun read(bytes: ByteArray, offset: Int, length: Int): Int {
            if (length == 0) return 0
            if (finished) return -1
            if (remaining == 0L) {
                if (delimiter) check(line(input).isEmpty())
                val text = line(input).substringBefore(';'); check(text.matches(Regex("[0-9a-fA-F]{1,16}")))
                remaining = text.toLong(16); check(remaining >= 0)
                if (remaining == 0L) {
                    var total = 0
                    while (true) { val trailer = line(input); if (trailer.isEmpty()) break; total += trailer.length; check(total <= 16384) }
                    finished = true; return -1
                }
                delimiter = true
            }
            val count = input.read(bytes, offset, minOf(length.toLong(), remaining).toInt()); check(count >= 0)
            remaining -= count; return count
        }
    }
    companion object {
        private fun line(input: InputStream): String {
            val bytes = ByteArrayOutputStream()
            while (true) { val value = input.read(); check(value >= 0); if (value == 10) break; check(bytes.size() < 8192); if (value != 13) bytes.write(value) }
            return bytes.toString("US-ASCII")
        }
    }
}
