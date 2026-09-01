package com.rabiroute.sdk

import android.content.Context
import android.net.wifi.WifiManager
import org.json.JSONArray
import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.io.InputStream
import java.net.HttpURLConnection
import java.net.NetworkInterface
import java.net.URL
import java.util.Collections
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

data class RabiInstance(
    val guid: String,
    val name: String,
    val computerName: String,
    val deviceType: String,
    val baseUrl: String,
    val host: String,
    val port: Int,
    val version: String?,
    val applicationGenerationId: String,
    val managerInstanceId: String
)

data class RabiLinkEndpoint(
    val url: String,
    val host: String,
    val port: Int,
    val ok: Boolean,
    val status: String,
    val error: String? = null
)

data class RabiLinkDeliveryResult(
    val url: String,
    val ok: Boolean,
    val status: String,
    val messageId: String,
    val replyText: String,
    val rawJson: JSONObject
)

data class RabiLinkBidirectionalResult(
    val inbound: RabiLinkDeliveryResult,
    val outboundJson: JSONObject,
    val repliesJson: JSONObject
)

data class RabiLinkRelayTask(
    val id: String,
    val text: String,
    val normalizedText: String,
    val rawJson: JSONObject
)

data class RabiLinkPc(
    val id: String,
    val guid: String,
    val name: String,
    val appId: String,
    val appName: String,
    val online: Boolean,
    val lastSeenAt: String,
    val rawJson: JSONObject
)

data class RabiLinkMobileState(
    val appId: String,
    val appName: String,
    val selectedTargetDeviceId: String,
    val selectedWorker: RabiLinkPc?,
    val workers: List<RabiLinkPc>,
    val rawJson: JSONObject
)

data class RabiLinkDeviceStatus(
    val batteryLevel: Int,
    val charging: Boolean,
    val observedAt: String,
    val receivedAt: String,
    val stale: Boolean,
    val rawJson: JSONObject
)

data class RabiLinkPortableObservationReceipt(
    val eventId: String,
    val status: String,
    val cursor: String,
    val acceptedAt: Long,
    val rawJson: JSONObject
)

data class RabiLinkPortableMessage(
    val id: String,
    val text: String,
    val createdAt: Long,
    val proactive: Boolean,
    val final: Boolean,
    val targetDeviceIds: List<String>,
    val targetDeviceKinds: List<String>,
    val presentation: List<String>,
    val priority: String,
    val routeProfileId: String,
    val attachments: List<JSONObject>,
    val rawJson: JSONObject
)

data class RabiLinkPortableMessagePage(
    val messages: List<RabiLinkPortableMessage>,
    val nextCursor: String,
    val cursorReset: Boolean,
    val cursorResetReason: String,
    val shouldContinue: Boolean,
    val status: String,
    val rawJson: JSONObject
)

data class RabiRouteInfo(
    val id: String,
    val name: String,
    val configName: String,
    val routeName: String,
    val enabled: Boolean,
    val running: Boolean,
    val agentRoleId: String,
    val personaDisplayName: String,
    val messageAdapters: List<String>,
    val agentAdapters: List<String>,
    val codexCwd: String,
    val codexThreadName: String,
    val avatarConfigured: Boolean,
    val avatarVersion: String,
    val rawJson: JSONObject
)

data class RabiRouteCatalogRevision(
    val contentHash: String,
    val routeConfigHash: String,
    val presentationHash: String,
    val revision: Long,
    val rawJson: JSONObject
) {
    val isStrong: Boolean
        get() = CONTENT_HASH_PATTERN.matches(contentHash)

    private companion object {
        val CONTENT_HASH_PATTERN = Regex("^[a-f0-9]{64}$")
    }
}

class RabiRouteCatalogResult(
    val routes: List<RabiRouteInfo>,
    val routeCatalog: RabiRouteCatalogRevision,
    val rawJson: JSONObject
) : List<RabiRouteInfo> by routes {
    val contentHash: String
        get() = routeCatalog.contentHash
}

data class RabiAgentBinding(
    val agentAdapter: String? = null,
    val codexCwd: String? = null,
    val codexThreadName: String? = null,
    val copilotCwd: String? = null,
    val copilotCliBin: String? = null,
    val marvisAppId: String? = null,
    val astrbotUrl: String? = null,
    val astrbotUsername: String? = null,
    val astrbotPassword: String? = null,
    val astrbotProjectId: String? = null,
    val astrbotSessionId: String? = null
) {
    fun toJson(): JSONObject {
        val json = JSONObject()
        fun putIfPresent(key: String, value: String?) {
            if (value != null) json.put(key, value)
        }
        putIfPresent("agentAdapter", agentAdapter)
        putIfPresent("codexCwd", codexCwd)
        putIfPresent("codexThreadName", codexThreadName)
        putIfPresent("copilotCwd", copilotCwd)
        putIfPresent("copilotCliBin", copilotCliBin)
        putIfPresent("marvisAppId", marvisAppId)
        putIfPresent("astrbotUrl", astrbotUrl)
        putIfPresent("astrbotUsername", astrbotUsername)
        putIfPresent("astrbotPassword", astrbotPassword)
        putIfPresent("astrbotProjectId", astrbotProjectId)
        putIfPresent("astrbotSessionId", astrbotSessionId)
        return json
    }
}

class RabiRouteSdk @JvmOverloads constructor(
    private val managerBaseUrls: List<String> = emptyList(),
    private val rabiLinkPorts: List<Int> = listOf(8794),
    private val timeoutMs: Int = 650
) {
    fun scanLan(context: Context): List<RabiInstance> {
        val discoveredEndpoints = RabiRouteNsdDiscovery(context, timeoutMs).discoverManagerEndpoints()
        val discoveredInstances = discoveredEndpoints.map { endpoint ->
            val verified = readIdentityDocument(endpoint.baseUrl)
            RabiRouteDiscoveryContract.requireMatchingIdentity(
                advertised = endpoint.lifecycleIdentity,
                observed = verified.lifecycleIdentity
            )
            verified.instance
        }
        val discoveredBaseUrls = discoveredEndpoints.mapTo(HashSet()) { it.baseUrl }
        val configuredBaseUrls = managerBaseUrls
            .map(::normalizeManagerBaseUrl)
            .distinct()
            .filterNot(discoveredBaseUrls::contains)
        val configuredInstances = scanManagerBaseUrls(configuredBaseUrls)
        val instancesByGuid = LinkedHashMap<String, RabiInstance>()
        for (instance in configuredInstances) instancesByGuid[instance.guid] = instance
        for (instance in discoveredInstances) instancesByGuid[instance.guid] = instance
        return instancesByGuid.values.sortedBy { it.name }
    }

    fun scanManagerBaseUrls(baseUrls: List<String>): List<RabiInstance> {
        val targets = baseUrls.map(::normalizeManagerBaseUrl).distinct()
        if (targets.isEmpty()) return emptyList()
        val executor = Executors.newFixedThreadPool(targets.size.coerceAtMost(32))
        val results = Collections.synchronizedMap(LinkedHashMap<String, RabiInstance>())
        for (baseUrl in targets) {
            executor.submit {
                val instance = runCatching { readIdentity(baseUrl) }.getOrNull()
                if (instance != null) results[instance.guid] = instance
            }
        }
        executor.shutdown()
        val completed = executor.awaitTermination(
            (timeoutMs.toLong() * targets.size / 8L).coerceAtLeast(1500L),
            TimeUnit.MILLISECONDS
        )
        if (!completed) executor.shutdownNow()
        return results.values.sortedBy { it.name }
    }

    fun scanRabiLinkCallbacks(context: Context): List<RabiLinkEndpoint> {
        val hosts = candidateHosts(context)
        val executor = Executors.newFixedThreadPool(32)
        val results = Collections.synchronizedList(ArrayList<RabiLinkEndpoint>())
        for (host in hosts) {
            for (port in rabiLinkPorts.distinct()) {
                executor.submit {
                    probeRabiLinkCallback(host, port)?.let { results.add(it) }
                }
            }
        }
        executor.shutdown()
        executor.awaitTermination((timeoutMs * hosts.size.coerceAtMost(254) / 8L).coerceAtLeast(1500L), TimeUnit.MILLISECONDS)
        return results.sortedWith(compareBy<RabiLinkEndpoint> { !it.ok }.thenBy { it.host }.thenBy { it.port })
    }

    fun probeRabiLinkCallback(baseUrl: String): RabiLinkEndpoint {
        val trimmed = baseUrl.trimEnd('/')
        val url = if (trimmed.endsWith("/rabilink")) trimmed else "$trimmed/rabilink"
        val parsed = URL(url)
        return probeRabiLinkCallback(parsed.host, parsed.port.takeIf { it > 0 } ?: 8794)
            ?: RabiLinkEndpoint(url, parsed.host, parsed.port.takeIf { it > 0 } ?: 8794, false, "unreachable", "No response")
    }

    fun readIdentity(baseUrl: String): RabiInstance {
        return readIdentityDocument(baseUrl).instance
    }

    private fun readIdentityDocument(baseUrl: String): VerifiedManagerIdentity {
        val normalizedBaseUrl = normalizeManagerBaseUrl(baseUrl)
        val parsedBaseUrl = URL(normalizedBaseUrl)
        val response = requestJson(
            "$normalizedBaseUrl${RabiRouteDiscoveryContract.WELL_KNOWN_PATH}",
            "GET",
            null,
            maxResponseBytes = 64 * 1024
        )
        require(response.optInt("code", -1) == 0) {
            "RabiRoute discovery document returned a non-success code."
        }
        val data = response.getJSONObject("data")
        val lifecycleIdentity = RabiRouteDiscoveryContract.requireValidIdentity(
            protocolVersion = data.optInt("protocolVersion", -1),
            applicationGenerationId = data.optString("applicationGenerationId"),
            managerInstanceId = data.optString("managerInstanceId"),
            guid = data.optString("guid")
        )
        return VerifiedManagerIdentity(
            instance = RabiInstance(
                guid = data.optString("guid"),
                name = data.optString("name", data.optString("computerName", "RabiRoute")),
                computerName = data.optString("computerName"),
                deviceType = data.optString("deviceType", "RabiRoute Manager"),
                baseUrl = normalizedBaseUrl,
                host = parsedBaseUrl.host,
                port = parsedBaseUrl.port,
                version = data.optString("version").ifBlank { null },
                applicationGenerationId = lifecycleIdentity.applicationGenerationId,
                managerInstanceId = lifecycleIdentity.managerInstanceId
            ),
            lifecycleIdentity = lifecycleIdentity
        )
    }

    private fun normalizeManagerBaseUrl(value: String): String {
        val parsed = URL(value.trim())
        require(parsed.protocol == "http" && parsed.host.isNotBlank()) {
            "Manager base URL must be an explicit HTTP address."
        }
        require(parsed.userInfo == null && parsed.query == null && parsed.ref == null && (parsed.path.isEmpty() || parsed.path == "/")) {
            "Manager base URL must not contain credentials, a path, query, or fragment."
        }
        val port = if (parsed.port == -1) parsed.defaultPort else parsed.port
        require(port in 1..65535) { "Manager base URL must include a valid port." }
        return RabiRouteDiscoveryContract.managerBaseUrl(parsed.host, port)
    }

    fun getRoutes(instance: RabiInstance): List<RabiRouteInfo> =
        getRouteCatalog(instance).routes

    fun getRouteCatalog(instance: RabiInstance): RabiRouteCatalogResult {
        val url = "${instance.baseUrl}/api/rabi/instances/${encodePath(instance.guid)}/routes"
        return routeCatalogResult(getManagerJson(instance, url))
    }

    fun getAgentOptions(instance: RabiInstance, routeId: String): JSONObject {
        val url = "${instance.baseUrl}/api/rabi/instances/${encodePath(instance.guid)}/routes/${encodePath(routeId)}/agent-options"
        return getManagerJson(instance, url).getJSONObject("data")
    }

    fun setAgentBinding(
        instance: RabiInstance,
        routeId: String,
        binding: RabiAgentBinding,
        operationId: String,
        expectedContentHash: String
    ): JSONObject {
        val url = "${instance.baseUrl}/api/rabi/instances/${encodePath(instance.guid)}/routes/${encodePath(routeId)}/agent-binding"
        val response = requestManagerJson(
            instance,
            url,
            "PATCH",
            binding.toJson().toString(),
            routeMutationHeaders(operationId, expectedContentHash)
        )
        requireCommittedMutationReceipt(response, operationId)
        return response.getJSONObject("data")
    }

    @Deprecated(
        message = "Legacy route mutation is disabled: a verified lifecycle lease, caller-owned operationId, and current strong route catalog content hash are required."
    )
    fun setAgentBinding(
        instance: RabiInstance,
        routeId: String,
        binding: RabiAgentBinding
    ): JSONObject = throw UnsupportedOperationException(LEGACY_ROUTE_MUTATION_MESSAGE)

    fun deliverRabiLinkMessage(callbackUrl: String, text: String, routeId: String? = null): RabiLinkDeliveryResult {
        val trimmed = callbackUrl.trimEnd('/')
        val url = if (trimmed.endsWith("/rabilink")) trimmed else "$trimmed/rabilink"
        val payload = JSONObject()
            .put("type", "rabilink")
            .put("source", "rabilink-phone-probe")
            .put("sender", "RabiLink 手机测试")
            .put("message", text)
            .put("text", text)
            .put("messageId", "rabilink-phone-probe-${System.currentTimeMillis()}")
        if (!routeId.isNullOrBlank()) payload.put("routeId", routeId)
        val json = requestJson(url, "POST", payload.toString())
        return RabiLinkDeliveryResult(
            url = url,
            ok = json.optBoolean("ok"),
            status = json.optString("status", "unknown"),
            messageId = json.optString("messageId"),
            replyText = json.optString("text", json.optString("reply", json.optString("answer"))),
            rawJson = json
        )
    }

    fun sendRabiLinkReply(instance: RabiInstance, routeId: String, messageId: String, text: String): JSONObject {
        val payload = JSONObject()
            .put("deliveryId", "rabilink-$routeId-$messageId-${text.hashCode()}")
            .put("routeId", routeId)
            .put("channel", "rabilink")
            .put("params", JSONObject()
                .put("proactive", false)
                .put("sourceMessageId", messageId)
                .put("targetDeviceKinds", JSONArray().put("phone")))
            .put("payload", JSONObject()
                .put("type", "text")
                .put("text", text))
        return requestManagerJson(instance, "${instance.baseUrl}/api/agent/send", "POST", payload.toString())
    }

    fun getRabiLinkReplies(instance: RabiInstance, routeId: String, limit: Int = 10, afterId: String = ""): JSONObject {
        val safeLimit = limit.coerceIn(1, 100)
        val after = if (afterId.isBlank()) "" else "&afterId=${encodeQuery(afterId)}"
        val url = "${instance.baseUrl}/api/rabi/instances/${encodePath(instance.guid)}/routes/${encodePath(routeId)}/rabilink-replies?limit=$safeLimit$after"
        return getManagerJson(instance, url).getJSONObject("data")
    }

    fun getRabiLinkReplies(callbackUrl: String, routeId: String, limit: Int = 10, afterId: String = ""): JSONObject {
        val safeLimit = limit.coerceIn(1, 100)
        val trimmed = callbackUrl.trimEnd('/')
        val base = if (trimmed.endsWith("/rabilink")) trimmed else "$trimmed/rabilink"
        val after = if (afterId.isBlank()) "" else "&afterId=${encodeQuery(afterId)}"
        val route = if (routeId.isBlank()) "" else "&routeId=${encodeQuery(routeId)}"
        val json = getJson("$base/replies?limit=$safeLimit$route$after")
        return json.optJSONObject("data") ?: json
    }

    fun runRabiLinkBidirectionalSmoke(instance: RabiInstance, routeId: String, callbackUrl: String): RabiLinkBidirectionalResult {
        val inbound = deliverRabiLinkMessage(
            callbackUrl,
            "RabiLink 双向烟测：手机投递到 Codex，请忽略。",
            routeId
        )
        val outbound = sendRabiLinkReply(
            instance,
            routeId,
            inbound.messageId,
            "RabiLink 双向烟测回包：Codex 到电脑端 worker，请忽略。"
        )
        val replies = getRabiLinkReplies(instance, routeId, 10)
        return RabiLinkBidirectionalResult(inbound, outbound, replies)
    }

    fun claimRabiLinkRelayTasks(
        relayBaseUrl: String,
        token: String,
        deviceId: String,
        waitMs: Int = 0,
        limit: Int = 1
    ): List<RabiLinkRelayTask> {
        val url = "${relayBaseUrl.trimEnd('/')}/worker/tasks" +
            "?limit=${limit.coerceIn(1, 10)}" +
            "&waitMs=${waitMs.coerceIn(0, 60000)}" +
            "&deviceId=${encodeQuery(deviceId)}"
        val json = requestJson(
            url,
            "GET",
            null,
            mapOf("X-RabiLink-Token" to token),
            readTimeoutMs = waitMs.coerceAtLeast(1000) + 8000
        )
        val tasks = json.optJSONArray("tasks") ?: return emptyList()
        return (0 until tasks.length()).mapNotNull { index ->
            val item = tasks.optJSONObject(index) ?: return@mapNotNull null
            val id = item.optString("id")
            if (id.isBlank()) return@mapNotNull null
            RabiLinkRelayTask(
                id = id,
                text = item.optString("text"),
                normalizedText = item.optString("normalizedText"),
                rawJson = item
            )
        }
    }

    fun appendRabiLinkRelayMessage(relayBaseUrl: String, token: String, taskId: String, text: String, final: Boolean = false): JSONObject {
        val payload = JSONObject()
            .put("text", text)
            .put("final", final)
        return requestJson(
            "${relayBaseUrl.trimEnd('/')}/worker/tasks/${encodePath(taskId)}/messages",
            "POST",
            payload.toString(),
            mapOf("X-RabiLink-Token" to token),
            readTimeoutMs = 10000
        )
    }

    fun finishRabiLinkRelayTask(relayBaseUrl: String, token: String, taskId: String, text: String = "", ok: Boolean = true): JSONObject {
        val payload = JSONObject()
            .put("ok", ok)
            .put("final", true)
        if (text.isNotBlank()) payload.put("text", text)
        return requestJson(
            "${relayBaseUrl.trimEnd('/')}/worker/tasks/${encodePath(taskId)}/finish",
            "POST",
            payload.toString(),
            mapOf("X-RabiLink-Token" to token),
            readTimeoutMs = 10000
        )
    }

    fun getMobileState(relayBaseUrl: String, token: String): RabiLinkMobileState {
        val json = requestJson(
            "${relayBaseUrl.trimEnd('/')}/api/rabilink/mobile/state",
            "GET",
            null,
            mapOf("X-RabiLink-Token" to token),
            readTimeoutMs = 10000
        )
        return mobileStateFromJson(json)
    }

    @JvmOverloads
    fun publishPortableObservation(
        relayBaseUrl: String,
        token: String,
        text: String,
        sourceDeviceId: String,
        sourceDeviceKind: String,
        sourceDeviceName: String = "",
        transport: String = "phone-companion",
        clientMessageId: String = "portable-${System.currentTimeMillis()}",
        capturedAt: Long = System.currentTimeMillis(),
        sessionId: String = ""
    ): RabiLinkPortableObservationReceipt {
        val payload = JSONObject()
            .put("text", text)
            .put("type", "rabilink.observation")
            .put("deliveryMode", "observe")
            .put("source", "rabilink-portable-device")
            .put("sourceDeviceId", sourceDeviceId)
            .put("sourceDeviceKind", sourceDeviceKind)
            .put("transport", transport)
            .put("clientMessageId", clientMessageId)
            .put("capturedAt", capturedAt)
        if (sourceDeviceName.isNotBlank()) payload.put("sourceDeviceName", sourceDeviceName)
        if (sessionId.isNotBlank()) payload.put("sessionId", sessionId)
        val json = requestJson(
            "${relayBaseUrl.trimEnd('/')}/api/rabilink/devices/input",
            "POST",
            payload.toString(),
            mapOf("X-RabiLink-Token" to token),
            readTimeoutMs = 10000
        )
        return RabiLinkPortableObservationReceipt(
            eventId = json.optString("eventId"),
            status = json.optString("status"),
            cursor = json.optString("nextCursor", json.optString("cursor")),
            acceptedAt = json.optLong("acceptedAt"),
            rawJson = json
        )
    }

    @JvmOverloads
    fun getPortableMessages(
        relayBaseUrl: String,
        token: String,
        deviceId: String,
        deviceKind: String,
        after: String = "",
        waitMs: Int = 0,
        continuous: Boolean = true
    ): RabiLinkPortableMessagePage {
        val query = listOf(
            "deviceId=${encodeQuery(deviceId)}",
            "deviceKind=${encodeQuery(deviceKind)}",
            "after=${encodeQuery(after)}",
            "waitMs=${waitMs.coerceIn(0, 60000)}",
            "stream=${if (continuous) 1 else 0}"
        ).joinToString("&")
        val json = requestJson(
            "${relayBaseUrl.trimEnd('/')}/api/rabilink/devices/messages?$query",
            "GET",
            null,
            mapOf("X-RabiLink-Token" to token),
            readTimeoutMs = waitMs.coerceAtLeast(1000) + 8000
        )
        val items = json.optJSONArray("messages")
        val messages = (0 until (items?.length() ?: 0)).mapNotNull { index ->
            items?.optJSONObject(index)?.let { portableMessageFromJson(it) }
        }
        return RabiLinkPortableMessagePage(
            messages = messages,
            nextCursor = json.optString("nextCursor", json.optString("cursor")),
            cursorReset = json.optBoolean("cursorReset"),
            cursorResetReason = json.optString("cursorResetReason"),
            shouldContinue = json.optBoolean("shouldContinue"),
            status = json.optString("status"),
            rawJson = json
        )
    }

    fun publishMobileDeviceStatus(
        relayBaseUrl: String,
        token: String,
        batteryLevel: Int,
        charging: Boolean,
        observedAt: String
    ): RabiLinkDeviceStatus {
        val payload = JSONObject()
            .put("batteryLevel", batteryLevel.coerceIn(0, 100))
            .put("charging", charging)
            .put("observedAt", observedAt)
        val json = requestJson(
            "${relayBaseUrl.trimEnd('/')}/api/rabilink/mobile/device-status",
            "POST",
            payload.toString(),
            mapOf("X-RabiLink-Token" to token),
            readTimeoutMs = 10000
        )
        val status = json.getJSONObject("deviceStatus")
        return RabiLinkDeviceStatus(
            batteryLevel = status.getInt("batteryLevel"),
            charging = status.optBoolean("charging"),
            observedAt = status.optString("observedAt"),
            receivedAt = status.optString("receivedAt"),
            stale = status.optBoolean("stale"),
            rawJson = status
        )
    }

    fun selectMobileRabiPc(relayBaseUrl: String, token: String, targetDeviceId: String): RabiLinkMobileState {
        val payload = JSONObject().put("targetDeviceId", targetDeviceId)
        val json = requestJson(
            "${relayBaseUrl.trimEnd('/')}/api/rabilink/mobile/target",
            "PATCH",
            payload.toString(),
            mapOf("X-RabiLink-Token" to token),
            readTimeoutMs = 10000
        )
        return mobileStateFromJson(json)
    }

    fun getMobileRoutes(relayBaseUrl: String, token: String, targetDeviceId: String = ""): List<RabiRouteInfo> =
        getMobileRouteCatalog(relayBaseUrl, token, targetDeviceId).routes

    fun getMobileRouteCatalog(
        relayBaseUrl: String,
        token: String,
        targetDeviceId: String = ""
    ): RabiRouteCatalogResult {
        val target = targetQuery(targetDeviceId)
        val profiles = if (target.isBlank()) "?includeProfiles=true" else "$target&includeProfiles=true"
        val json = requestJson(
            "${relayBaseUrl.trimEnd('/')}/api/rabilink/mobile/routes$profiles",
            "GET",
            null,
            mapOf("X-RabiLink-Token" to token),
            readTimeoutMs = 45000
        )
        return routeCatalogResult(json)
    }

    fun getMobileAgentOptions(relayBaseUrl: String, token: String, routeId: String, targetDeviceId: String = ""): JSONObject {
        val target = targetQuery(targetDeviceId)
        return requestJson(
            "${relayBaseUrl.trimEnd('/')}/api/rabilink/mobile/routes/${encodePath(routeId)}/agent-options$target",
            "GET",
            null,
            mapOf("X-RabiLink-Token" to token),
            readTimeoutMs = 45000
        ).getJSONObject("data")
    }

    fun setMobileAgentBinding(
        relayBaseUrl: String,
        token: String,
        routeId: String,
        binding: RabiAgentBinding,
        operationId: String,
        expectedContentHash: String,
        targetDeviceId: String = ""
    ): JSONObject {
        val target = targetQuery(targetDeviceId)
        val response = requestJson(
            "${relayBaseUrl.trimEnd('/')}/api/rabilink/mobile/routes/${encodePath(routeId)}/agent-binding$target",
            "PATCH",
            binding.toJson().toString(),
            mapOf("X-RabiLink-Token" to token) + routeMutationHeaders(operationId, expectedContentHash),
            readTimeoutMs = 45000
        )
        requireCommittedMutationReceipt(response, operationId)
        return response.getJSONObject("data")
    }

    @Deprecated(
        message = "Legacy route mutation is disabled: a verified lifecycle lease, caller-owned operationId, and current strong route catalog content hash are required."
    )
    fun setMobileAgentBinding(
        relayBaseUrl: String,
        token: String,
        routeId: String,
        binding: RabiAgentBinding,
        targetDeviceId: String = ""
    ): JSONObject = throw UnsupportedOperationException(LEGACY_ROUTE_MUTATION_MESSAGE)

    private fun managerLifecycleHeaders(instance: RabiInstance): Map<String, String> {
        require(instance.applicationGenerationId.isNotBlank() && instance.managerInstanceId.isNotBlank()) {
            "Manager operations require a complete lifecycle lease."
        }
        return mapOf(
            "x-rabiroute-expected-application-generation-id" to instance.applicationGenerationId,
            "x-rabiroute-expected-manager-instance-id" to instance.managerInstanceId
        )
    }

    private fun getManagerJson(instance: RabiInstance, url: String): JSONObject =
        requestJson(url, "GET", null, managerLifecycleHeaders(instance))

    private fun requestManagerJson(
        instance: RabiInstance,
        url: String,
        method: String,
        body: String?,
        headers: Map<String, String> = emptyMap()
    ): JSONObject = requestJson(url, method, body, managerLifecycleHeaders(instance) + headers)

    private fun routeCatalogResult(json: JSONObject): RabiRouteCatalogResult {
        val data = json.optJSONObject("data") ?: JSONObject()
        val items = data.optJSONArray("routes") ?: json.optJSONArray("routes") ?: JSONArray()
        val routes = (0 until items.length()).mapNotNull { index ->
            items.optJSONObject(index)?.let { routeInfoFromJson(it) }
        }
        val catalog = json.optJSONObject("routeCatalog")
            ?: data.optJSONObject("routeCatalog")
            ?: JSONObject()
        val contentHash = catalog.optString("contentHash").trim().lowercase()
        val routeConfigHash = catalog.optString("routeConfigHash", contentHash).trim().lowercase()
        val presentationHash = catalog.optString("presentationHash").trim().lowercase()
        return RabiRouteCatalogResult(
            routes = routes,
            routeCatalog = RabiRouteCatalogRevision(
                contentHash = contentHash,
                routeConfigHash = routeConfigHash,
                presentationHash = presentationHash,
                revision = catalog.optLong("revision", 0L),
                rawJson = catalog
            ),
            rawJson = json
        )
    }

    private fun routeMutationHeaders(operationId: String, expectedContentHash: String): Map<String, String> {
        val normalizedOperationId = operationId.trim()
        val normalizedContentHash = expectedContentHash.trim().lowercase()
        require(OPERATION_ID_PATTERN.matches(normalizedOperationId)) {
            "Route mutation requires a caller-owned stable operationId."
        }
        require(CONTENT_HASH_PATTERN.matches(normalizedContentHash)) {
            "Route mutation requires the current strong route catalog content hash."
        }
        return mapOf(
            "Idempotency-Key" to normalizedOperationId,
            "If-Match" to normalizedContentHash
        )
    }

    private fun requireCommittedMutationReceipt(json: JSONObject, expectedOperationId: String) {
        val data = json.optJSONObject("data")
        val receipt = json.optJSONObject("receipt")
            ?: json.optJSONObject("mutationReceipt")
            ?: data?.optJSONObject("receipt")
            ?: throw IllegalStateException("Route mutation response is missing an explicit committed receipt.")
        val operationId = receipt.optString("operationId").trim()
        val status = receipt.optString("status", receipt.optString("state")).trim().lowercase()
        val contentHash = receipt.optString("contentHash", receipt.optString("routeConfigHash"))
            .trim()
            .lowercase()
            .ifBlank {
                val catalog = json.optJSONObject("routeCatalog")
                catalog?.let { it.optString("routeConfigHash", it.optString("contentHash")) }
                    ?.trim()
                    ?.lowercase()
                    .orEmpty()
        }
        require(operationId == expectedOperationId.trim()) {
            "Route mutation receipt does not match the caller-owned operationId."
        }
        require(status == "committed") {
            "Route mutation response is not an explicit committed receipt."
        }
        require(CONTENT_HASH_PATTERN.matches(contentHash)) {
            "Route mutation receipt is missing a strong committed content hash."
        }
    }

    private fun getJson(url: String): JSONObject = requestJson(url, "GET", null)

    private fun probeRabiLinkCallback(host: String, port: Int): RabiLinkEndpoint? {
        val url = "http://$host:$port/rabilink"
        return try {
            val json = getJson(url)
            val ok = json.optBoolean("ok") && json.optString("adapterType") == "rabilink"
            RabiLinkEndpoint(
                url = url,
                host = host,
                port = port,
                ok = ok,
                status = json.optString("status", if (ok) "ready" else "unexpected")
            )
        } catch (error: Throwable) {
            null
        }
    }

    internal fun requestJson(
        url: String,
        method: String,
        body: String?,
        headers: Map<String, String> = emptyMap(),
        readTimeoutMs: Int = timeoutMs,
        maxResponseBytes: Int = 4 * 1024 * 1024
    ): JSONObject {
        val connection = (URL(url).openConnection() as HttpURLConnection).apply {
            requestMethod = method
            connectTimeout = timeoutMs
            readTimeout = readTimeoutMs
            instanceFollowRedirects = false
            setRequestProperty("accept", "application/json")
            for ((key, value) in headers) setRequestProperty(key, value)
            if (body != null) {
                doOutput = true
                setRequestProperty("content-type", "application/json; charset=utf-8")
            }
        }
        try {
            if (body != null) connection.outputStream.use { it.write(body.toByteArray(Charsets.UTF_8)) }
            val responseCode = connection.responseCode
            val stream = if (responseCode in 200..299) connection.inputStream else connection.errorStream
            if (connection.contentLengthLong > maxResponseBytes) {
                throw IllegalStateException("JSON response exceeds the bounded client size.")
            }
            val text = stream?.use { readBoundedUtf8(it, maxResponseBytes) }.orEmpty()
            val json = JSONObject(text.ifBlank { "{}" })
            if (responseCode !in 200..299) {
                throw IllegalStateException(json.optString("message", "HTTP $responseCode"))
            }
            return json
        } finally {
            connection.disconnect()
        }
    }

    private fun candidateHosts(context: Context): List<String> {
        val hosts = LinkedHashSet<String>()
        for (address in localIpv4Addresses()) {
            hosts.add(address)
            val prefix = address.substringBeforeLast('.', "")
            if (prefix.isNotBlank()) for (i in 1..254) hosts.add("$prefix.$i")
        }
        wifiIpv4(context)?.let { address ->
            hosts.add(address)
            val prefix = address.substringBeforeLast('.', "")
            if (prefix.isNotBlank()) for (i in 1..254) hosts.add("$prefix.$i")
        }
        return hosts.toList()
    }

    private fun localIpv4Addresses(): List<String> {
        val result = ArrayList<String>()
        val interfaces = NetworkInterface.getNetworkInterfaces() ?: return result
        for (networkInterface in interfaces) {
            val addresses = networkInterface.inetAddresses
            for (address in addresses) {
                val text = address.hostAddress ?: continue
                if (!address.isLoopbackAddress && text.count { it == '.' } == 3) result.add(text)
            }
        }
        return result.distinct()
    }

    private fun wifiIpv4(context: Context): String? {
        val manager = context.applicationContext.getSystemService(Context.WIFI_SERVICE) as? WifiManager ?: return null
        val value = manager.connectionInfo?.ipAddress ?: return null
        if (value == 0) return null
        return listOf(
            value and 0xff,
            value shr 8 and 0xff,
            value shr 16 and 0xff,
            value shr 24 and 0xff
        ).joinToString(".")
    }

    private fun encodePath(value: String): String =
        java.net.URLEncoder.encode(value, "UTF-8").replace("+", "%20")

    private fun encodeQuery(value: String): String =
        java.net.URLEncoder.encode(value, "UTF-8")

    private fun targetQuery(targetDeviceId: String): String =
        if (targetDeviceId.isBlank()) "" else "?targetDeviceId=${encodeQuery(targetDeviceId)}"

    private fun routeInfoFromJson(item: JSONObject): RabiRouteInfo =
        RabiRouteInfo(
            id = item.optString("id"),
            name = item.optString("name"),
            configName = item.optString("configName"),
            routeName = item.optString("routeName"),
            enabled = item.optBoolean("enabled"),
            running = item.optBoolean("running"),
            agentRoleId = item.optString("agentRoleId"),
            personaDisplayName = item.optString("personaDisplayName"),
            messageAdapters = item.optJSONArray("messageAdapters").toStringList(),
            agentAdapters = item.optJSONArray("agentAdapters").toStringList(),
            codexCwd = item.optString("codexCwd"),
            codexThreadName = item.optString("codexThreadName"),
            avatarConfigured = item.optBoolean("avatarConfigured"),
            avatarVersion = item.optString("avatarVersion"),
            rawJson = item
        )

    private fun rabiLinkPcFromJson(item: JSONObject): RabiLinkPc =
        RabiLinkPc(
            id = item.optString("id"),
            guid = item.optString("guid"),
            name = item.optString("name", item.optString("id", "Rabi PC")),
            appId = item.optString("appId"),
            appName = item.optString("appName"),
            online = item.optBoolean("online"),
            lastSeenAt = item.optString("lastSeenAt"),
            rawJson = item
        )

    private fun mobileStateFromJson(json: JSONObject): RabiLinkMobileState {
        val workersJson = json.optJSONArray("workers")
        val workers = (0 until (workersJson?.length() ?: 0)).mapNotNull { index ->
            workersJson?.optJSONObject(index)?.let { rabiLinkPcFromJson(it) }
        }
        val app = json.optJSONObject("app") ?: JSONObject()
        return RabiLinkMobileState(
            appId = app.optString("id"),
            appName = app.optString("name"),
            selectedTargetDeviceId = json.optString("selectedTargetDeviceId"),
            selectedWorker = json.optJSONObject("selectedWorker")?.let { rabiLinkPcFromJson(it) },
            workers = workers,
            rawJson = json
        )
    }

    private fun portableMessageFromJson(item: JSONObject): RabiLinkPortableMessage =
        RabiLinkPortableMessage(
            id = item.optString("id"),
            text = item.optString("text"),
            createdAt = item.optLong("createdAt"),
            proactive = item.optBoolean("proactive"),
            final = item.optBoolean("final"),
            targetDeviceIds = item.optJSONArray("targetDeviceIds").toStringList(),
            targetDeviceKinds = item.optJSONArray("targetDeviceKinds").toStringList(),
            presentation = item.optJSONArray("presentation").toStringList(),
            priority = item.optString("priority", "normal"),
            routeProfileId = item.optString("routeProfileId"),
            attachments = item.optJSONArray("attachments").toObjectList(),
            rawJson = item
        )

    private fun JSONArray?.toStringList(): List<String> {
        if (this == null) return emptyList()
        return (0 until length()).map { optString(it) }.filter { it.isNotBlank() }
    }

    private fun JSONArray?.toObjectList(): List<JSONObject> {
        if (this == null) return emptyList()
        return (0 until length()).mapNotNull { optJSONObject(it) }
    }

    private companion object {
        val CONTENT_HASH_PATTERN = Regex("^[a-f0-9]{64}$")
        val OPERATION_ID_PATTERN = Regex("^[A-Za-z0-9:._-]{1,256}$")
        const val LEGACY_ROUTE_MUTATION_MESSAGE =
            "Legacy route mutation is disabled: a verified lifecycle lease, caller-owned operationId, and current strong route catalog content hash are required."
    }

    private fun readBoundedUtf8(stream: InputStream, maxBytes: Int): String {
        val output = ByteArrayOutputStream(minOf(maxBytes, 16 * 1024))
        val buffer = ByteArray(8 * 1024)
        while (true) {
            val read = stream.read(buffer)
            if (read < 0) break
            if (output.size() + read > maxBytes) throw IllegalStateException("JSON response exceeds the bounded client size.")
            output.write(buffer, 0, read)
        }
        return output.toByteArray().toString(Charsets.UTF_8)
    }

    private data class VerifiedManagerIdentity(
        val instance: RabiInstance,
        val lifecycleIdentity: RabiRouteManagerLifecycleIdentity
    )
}
