package com.rabiroute.sdk

import java.io.BufferedReader
import java.io.InputStreamReader
import java.lang.reflect.InvocationTargetException
import java.net.InetAddress
import java.net.ServerSocket
import java.net.Socket
import java.net.SocketException
import java.util.Locale
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicReference
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class RabiRouteSdkLifecycleLeaseJvmTest {
    @Test
    fun everyManagerOperationCarriesTheDiscoveredLifecycleLease() {
        val observedGeneration = AtomicReference("")
        val observedManager = AtomicReference("")
        val observedOperationId = AtomicReference("")
        val observedContentHash = AtomicReference("")
        TinyHttpServer { request ->
            when (request.path) {
                RabiRouteDiscoveryContract.WELL_KNOWN_PATH -> HttpResponse(body = identityDocument())
                "/api/rabi/instances/guid-a/routes" -> {
                    observedGeneration.set(request.headers["x-rabiroute-expected-application-generation-id"].orEmpty())
                    observedManager.set(request.headers["x-rabiroute-expected-manager-instance-id"].orEmpty())
                    HttpResponse(body = routeCatalogDocument())
                }
                "/api/rabi/instances/guid-a/routes/route-a/agent-binding" -> {
                    observedGeneration.set(request.headers["x-rabiroute-expected-application-generation-id"].orEmpty())
                    observedManager.set(request.headers["x-rabiroute-expected-manager-instance-id"].orEmpty())
                    observedOperationId.set(request.headers["idempotency-key"].orEmpty())
                    observedContentHash.set(request.headers["if-match"].orEmpty())
                    HttpResponse(body = """{"code":0,"data":{"agentAdapter":"codex"},"receipt":{"state":"committed","operationId":"android-binding-1","routeConfigHash":"${"b".repeat(64)}"}}""")
                }
                else -> HttpResponse(status = 404, body = "{}")
            }
        }.use { server ->
            val sdk = RabiRouteSdk(timeoutMs = 1_000)
            val instance = sdk.readIdentity(server.baseUrl)
            val legacyRoutes: List<RabiRouteInfo> = sdk.getRoutes(instance)
            assertTrue(legacyRoutes.isEmpty())
            val routes = sdk.getRouteCatalog(instance)
            assertTrue(routes.isEmpty())
            assertTrue(routes.routeCatalog.isStrong)
            assertEquals("a".repeat(64), routes.contentHash)
            assertEquals("c".repeat(64), routes.routeCatalog.routeConfigHash)
            assertEquals("a".repeat(64), routes.rawJson.getJSONObject("routeCatalog").getString("contentHash"))
            sdk.setAgentBinding(
                instance = instance,
                routeId = "route-a",
                binding = RabiAgentBinding(agentAdapter = "codex"),
                operationId = "android-binding-1",
                expectedContentHash = routes.routeCatalog.routeConfigHash
            )
            assertEquals("generation-a", observedGeneration.get())
            assertEquals("manager-a", observedManager.get())
            assertEquals("android-binding-1", observedOperationId.get())
            assertEquals("c".repeat(64), observedContentHash.get())
        }
    }

    @Test
    fun oldRelayRoutesRemainReadableButCannotBeUsedForRevisionlessWrites() {
        TinyHttpServer { request ->
            when (request.path) {
                "/api/rabilink/mobile/routes?includeProfiles=true" ->
                    HttpResponse(body = """{"code":0,"data":{"routes":[]}}""")
                else -> HttpResponse(status = 500, body = "{}")
            }
        }.use { server ->
            val sdk = RabiRouteSdk(timeoutMs = 1_000)
            val legacyRoutes: List<RabiRouteInfo> = sdk.getMobileRoutes(server.baseUrl, "token")
            assertTrue(legacyRoutes.isEmpty())
            val routes = sdk.getMobileRouteCatalog(server.baseUrl, "token")
            assertTrue(routes.isEmpty())
            assertEquals("", routes.contentHash)
            assertFalse(routes.routeCatalog.isStrong)
            val error = runCatching {
                sdk.setMobileAgentBinding(
                    relayBaseUrl = server.baseUrl,
                    token = "token",
                    routeId = "route-a",
                    binding = RabiAgentBinding(agentAdapter = "codex"),
                    operationId = "android-binding-legacy",
                    expectedContentHash = routes.contentHash
                )
            }.exceptionOrNull()
            assertTrue(error?.message?.contains("current strong route catalog content hash") == true)
        }
    }

    @Suppress("DEPRECATION")
    @Test
    fun legacyJvmDescriptorsRemainPresentAndMutationsFailClosedBeforeNetwork() {
        val methods = RabiRouteSdk::class.java.declaredMethods.toList()
        fun hasMethod(name: String, returnType: Class<*>, vararg parameterTypes: Class<*>): Boolean =
            methods.any { method ->
                method.name == name &&
                    method.returnType == returnType &&
                    method.parameterTypes.contentEquals(parameterTypes)
            }

        assertTrue(hasMethod("getRoutes", java.util.List::class.java, RabiInstance::class.java))
        assertTrue(hasMethod("getRouteCatalog", RabiRouteCatalogResult::class.java, RabiInstance::class.java))
        assertTrue(
            hasMethod(
                "getMobileRoutes",
                java.util.List::class.java,
                String::class.java,
                String::class.java,
                String::class.java
            )
        )
        assertTrue(
            hasMethod(
                "getMobileRouteCatalog",
                RabiRouteCatalogResult::class.java,
                String::class.java,
                String::class.java,
                String::class.java
            )
        )
        assertTrue(
            methods.any {
                it.name == "getMobileRoutes\$default" &&
                    it.returnType == java.util.List::class.java &&
                    it.parameterTypes.size == 6
            }
        )

        val legacyManagerMutation = methods.single {
            it.name == "setAgentBinding" &&
                it.parameterTypes.contentEquals(
                    arrayOf(RabiInstance::class.java, String::class.java, RabiAgentBinding::class.java)
                )
        }
        val legacyMobileMutation = methods.single {
            it.name == "setMobileAgentBinding" &&
                it.parameterTypes.contentEquals(
                    arrayOf(
                        String::class.java,
                        String::class.java,
                        String::class.java,
                        RabiAgentBinding::class.java,
                        String::class.java
                    )
                )
        }
        assertTrue(
            hasMethod(
                "setAgentBinding",
                org.json.JSONObject::class.java,
                RabiInstance::class.java,
                String::class.java,
                RabiAgentBinding::class.java,
                String::class.java,
                String::class.java
            )
        )
        assertTrue(
            hasMethod(
                "setMobileAgentBinding",
                org.json.JSONObject::class.java,
                String::class.java,
                String::class.java,
                String::class.java,
                RabiAgentBinding::class.java,
                String::class.java,
                String::class.java,
                String::class.java
            )
        )
        assertTrue(
            methods.any {
                it.name == "setMobileAgentBinding\$default" &&
                    it.returnType == org.json.JSONObject::class.java &&
                    it.parameterTypes.size == 8
            }
        )

        val sdk = RabiRouteSdk(timeoutMs = 25)
        val instance = RabiInstance(
            guid = "guid-a",
            name = "Rabi PC",
            computerName = "RABI-PC",
            deviceType = "RabiRoute Manager",
            baseUrl = "http://127.0.0.1:1",
            host = "127.0.0.1",
            port = 1,
            version = "0.2.1",
            applicationGenerationId = "generation-a",
            managerInstanceId = "manager-a"
        )
        val binding = RabiAgentBinding(agentAdapter = "codex")
        val managerError = runCatching {
            legacyManagerMutation.invoke(sdk, instance, "route-a", binding)
        }.exceptionOrNull()
        val mobileError = runCatching {
            legacyMobileMutation.invoke(sdk, "http://127.0.0.1:1", "token", "route-a", binding, "")
        }.exceptionOrNull()
        assertLegacyMutationFailure(managerError)
        assertLegacyMutationFailure(mobileError)
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

    private fun routeCatalogDocument(): String = """
        {"code":0,"data":{"routes":[]},"routeCatalog":{"contentHash":"${"a".repeat(64)}","routeConfigHash":"${"c".repeat(64)}","presentationHash":"${"d".repeat(64)}","revision":7}}
    """.trimIndent()

    private fun assertLegacyMutationFailure(error: Throwable?) {
        assertTrue(error is InvocationTargetException)
        val cause = (error as InvocationTargetException).targetException
        assertTrue(cause is UnsupportedOperationException)
        assertTrue(cause.message?.contains("lifecycle lease") == true)
        assertTrue(cause.message?.contains("operationId") == true)
        assertTrue(cause.message?.contains("content hash") == true)
    }

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
