package com.rabiroute.sdk

import java.net.URL
import org.json.JSONObject

internal data class RabiLinkCallbackCatalogPage(
    val snapshot: String,
    val nextCursor: String,
    val urls: List<String>
)

/** Consume the current public owner publication; configuration ports are not readiness evidence. */
internal object RabiLinkCallbackDiscovery {
    private val digestPattern = Regex("sha256:[a-f0-9]{64}")
    private val leasePattern = Regex("[a-fA-F0-9]{8}(?:-[a-fA-F0-9]{4}){3}-[a-fA-F0-9]{12}")
    private val operationPattern = Regex("gateway\\.[a-f0-9]{16}\\.webhook\\.rabilink\\.ready")
    private fun loopbackLiteral(hostname: String): Boolean = hostname.lowercase().removePrefix("[").removeSuffix("]").let {
        it == "localhost" || it == "::1" || it.startsWith("127.")
    }

    fun callbackUrl(value: String): URL {
        val parsed = URL(value.trim())
        require(parsed.protocol in listOf("http", "https") && parsed.host.isNotBlank()) { "Callback must be an HTTP or HTTPS URL" }
        require(parsed.userInfo == null && parsed.query == null && parsed.ref == null) { "Callback URL must not contain credentials, query or fragment" }
        val port = if (parsed.port == -1) parsed.defaultPort else parsed.port
        require(port in 1..65535) { "Callback URL must have a valid port" }
        return if (parsed.path.isEmpty() || parsed.path == "/") URL(parsed, "/rabilink") else parsed
    }

    fun readPage(managerBaseUrl: String, applicationGenerationId: String, managerInstanceId: String,
                 response: JSONObject, expectedSnapshot: String?): RabiLinkCallbackCatalogPage {
        require(response.optInt("code", -1) == 0) { "Callback catalog did not confirm success" }
        val data = response.getJSONObject("data")
        require(data.optString("schemaVersion") == "2"
            && data.optString("applicationGenerationId") == applicationGenerationId
            && data.optString("managerInstanceId") == managerInstanceId) { "Callback catalog Manager identity changed" }
        val revision = data.optLong("catalogRevision", 0)
        val digest = data.optString("catalogDigest")
        val pluginGeneration = data.optString("pluginGenerationId")
        require(revision > 0 && digestPattern.matches(digest) && pluginGeneration.isNotBlank()) { "Callback catalog identity is incomplete" }
        val snapshot = listOf(applicationGenerationId, managerInstanceId, pluginGeneration, revision.toString(), digest).joinToString("\n")
        require(expectedSnapshot == null || expectedSnapshot == snapshot) { "Callback catalog changed during pagination" }
        val operations = data.getJSONArray("operations")
        val listeners = data.getJSONArray("listeners")
        require(operations.length() <= 200 && listeners.length() <= 4096) { "Callback catalog exceeds discovery limits" }
        val listenersByLease = LinkedHashMap<Pair<String,String>, MutableList<JSONObject>>()
        for (index in 0 until listeners.length()) {
            val item = listeners.optJSONObject(index) ?: continue
            val binding = item.optJSONObject("binding") ?: continue
            val key = binding.optString("listenerId") to binding.optString("leaseId")
            listenersByLease.getOrPut(key) { ArrayList() }.add(item)
        }
        val urls = ArrayList<String>()
        for (index in 0 until operations.length()) {
            val operation = operations.optJSONObject(index) ?: continue
            val id = operation.optString("id")
            if (!operationPattern.matches(id) || operation.optString("method") != "GET") continue
            val binding = operation.getJSONObject("binding")
            val listenerId = id.removeSuffix("ready") + "listener"
            val leaseId = binding.optString("leaseId")
            require(binding.optString("kind") == "external-listener" && binding.optString("listenerId") == listenerId
                && leasePattern.matches(leaseId) && binding.optString("protocol") == "rabi-webhook-json"
                && binding.optString("invocation") == "native"
                && binding.getJSONObject("authentication").optString("kind") == "none") { "Invalid RabiLink listener publication" }
            val owner = operation.getJSONObject("owner")
            require(owner.optString("instanceId").isNotBlank()) { "RabiLink publication has no owner" }
            val matching = listenersByLease[listenerId to leaseId].orEmpty()
            require(matching.size == 1) { "RabiLink listener lease is absent or ambiguous" }
            val current = matching.single()
            val currentOwner = current.getJSONObject("owner")
            require(listOf("instanceId", "activationId", "revision").all { owner.optString(it) == currentOwner.optString(it) }) { "RabiLink listener owner changed" }
            val address = binding.getJSONObject("address")
            val publishedAddress = current.getJSONObject("binding").getJSONObject("address")
            require(listOf("protocol", "hostname", "port").all { address.optString(it) == publishedAddress.optString(it) }) { "RabiLink listener address changed" }
            val protocol = address.optString("protocol")
            val port = address.optInt("port", 0)
            require(protocol in listOf("http", "https") && port in 1..65535) { "Invalid published callback address" }
            val hostname = address.optString("hostname").let {
                if (it.isBlank() || it in listOf("0.0.0.0", "::", "[::]")) URL(managerBaseUrl).host else it
            }
            // A PC-only listener must not turn into a request to the phone's loopback interface.
            if (loopbackLiteral(hostname) && !loopbackLiteral(URL(managerBaseUrl).host)) continue
            val route = operation.optString("pathTemplate")
            require(route.startsWith("/") && !route.contains('{') && route.split('/').none { it.startsWith(":") }
                && !route.contains('?') && !route.contains('#') && !route.contains('\\')) { "Callback publication has no concrete path" }
            val url = URL(protocol, hostname, port, route).toExternalForm()
            callbackUrl(url)
            urls.add(url)
        }
        val cursor = data.optString("nextCursor")
        require(cursor.length <= 4096) { "Callback catalog cursor exceeds discovery limit" }
        return RabiLinkCallbackCatalogPage(snapshot, cursor, urls.distinct())
    }
}
