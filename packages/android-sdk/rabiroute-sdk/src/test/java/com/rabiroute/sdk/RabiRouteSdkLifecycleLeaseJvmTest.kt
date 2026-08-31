package com.rabiroute.sdk

import java.io.BufferedReader
import java.io.InputStreamReader
import java.net.InetAddress
import java.net.ServerSocket
import java.net.Socket
import java.net.SocketException
import java.util.Locale
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicReference
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class RabiRouteSdkLifecycleLeaseJvmTest {
    @Test
    fun everyManagerOperationCarriesTheDiscoveredLifecycleLease() {
        val observedGeneration = AtomicReference("")
        val observedManager = AtomicReference("")
        TinyHttpServer { request ->
            when (request.path) {
                RabiRouteDiscoveryContract.WELL_KNOWN_PATH -> HttpResponse(body = identityDocument())
                "/api/rabi/instances/guid-a/routes" -> {
                    observedGeneration.set(request.headers["x-rabiroute-expected-application-generation-id"].orEmpty())
                    observedManager.set(request.headers["x-rabiroute-expected-manager-instance-id"].orEmpty())
                    HttpResponse(body = """{"code":0,"data":{"routes":[]}}""")
                }
                else -> HttpResponse(status = 404, body = "{}")
            }
        }.use { server ->
            val sdk = RabiRouteSdk(timeoutMs = 1_000)
            val instance = sdk.readIdentity(server.baseUrl)
            assertTrue(sdk.getRoutes(instance).isEmpty())
            assertEquals("generation-a", observedGeneration.get())
            assertEquals("manager-a", observedManager.get())
        }
    }

    @Test
    fun redirectingWellKnownAuthorityIsRejected() {
        TinyHttpServer { request ->
            when (request.path) {
                RabiRouteDiscoveryContract.WELL_KNOWN_PATH -> HttpResponse(status = 302, headers = mapOf("Location" to "/redirected"))
                "/redirected" -> HttpResponse(body = identityDocument())
                else -> HttpResponse(status = 404, body = "{}")
            }
        }.use { server ->
            val error = runCatching { RabiRouteSdk(timeoutMs = 1_000).readIdentity(server.baseUrl) }.exceptionOrNull()
            assertTrue(error?.message?.contains("HTTP 302") == true)
        }
    }

    @Test
    fun oversizedWellKnownDocumentIsRejectedBeforeParsing() {
        TinyHttpServer { HttpResponse(body = "x".repeat(64 * 1024 + 1)) }.use { server ->
            val error = runCatching { RabiRouteSdk(timeoutMs = 1_000).readIdentity(server.baseUrl) }.exceptionOrNull()
            assertTrue(error?.message?.contains("bounded client size") == true)
        }
    }

    private fun identityDocument(): String = """
        {"code":0,"data":{"protocolVersion":1,"applicationGenerationId":"generation-a","managerInstanceId":"manager-a","guid":"guid-a","name":"Rabi PC","computerName":"RABI-PC","deviceType":"RabiRoute Manager","version":"0.2.1"}}
    """.trimIndent()

    private data class HttpRequest(val path: String, val headers: Map<String, String>)
    private data class HttpResponse(val status: Int = 200, val headers: Map<String, String> = emptyMap(), val body: String = "")

    private class TinyHttpServer(private val responder: (HttpRequest) -> HttpResponse) : AutoCloseable {
        private val socket = ServerSocket(0, 16, InetAddress.getByName("127.0.0.1"))
        private val executor = Executors.newCachedThreadPool()
        val baseUrl: String = "http://127.0.0.1:${socket.localPort}"

        init {
            executor.execute {
                while (!socket.isClosed) {
                    try {
                        val client = socket.accept()
                        executor.execute { handle(client) }
                    } catch (error: SocketException) {
                        if (!socket.isClosed) throw error
                    }
                }
            }
        }

        private fun handle(client: Socket) {
            client.use { connection ->
                val reader = BufferedReader(InputStreamReader(connection.getInputStream(), Charsets.US_ASCII))
                val requestLine = reader.readLine().orEmpty()
                val path = requestLine.split(" ").getOrNull(1).orEmpty()
                val headers = LinkedHashMap<String, String>()
                while (true) {
                    val line = reader.readLine() ?: break
                    if (line.isEmpty()) break
                    val separator = line.indexOf(':')
                    if (separator > 0) headers[line.substring(0, separator).trim().lowercase(Locale.ROOT)] = line.substring(separator + 1).trim()
                }
                val response = responder(HttpRequest(path, headers))
                val bytes = response.body.toByteArray(Charsets.UTF_8)
                val reason = when (response.status) { 200 -> "OK"; 302 -> "Found"; 404 -> "Not Found"; else -> "Error" }
                val output = connection.getOutputStream()
                output.write("HTTP/1.1 ${response.status} $reason\r\n".toByteArray(Charsets.US_ASCII))
                output.write("Content-Type: application/json\r\n".toByteArray(Charsets.US_ASCII))
                output.write("Content-Length: ${bytes.size}\r\n".toByteArray(Charsets.US_ASCII))
                output.write("Connection: close\r\n".toByteArray(Charsets.US_ASCII))
                for ((name, value) in response.headers) output.write("$name: $value\r\n".toByteArray(Charsets.US_ASCII))
                output.write("\r\n".toByteArray(Charsets.US_ASCII))
                output.write(bytes)
                output.flush()
            }
        }

        override fun close() {
            socket.close()
            executor.shutdownNow()
        }
    }
}
