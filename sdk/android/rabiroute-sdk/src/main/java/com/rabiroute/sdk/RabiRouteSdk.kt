package com.rabiroute.sdk

import android.content.Context
import android.net.wifi.WifiManager
import org.json.JSONArray
import org.json.JSONObject
import java.io.BufferedReader
import java.io.InputStreamReader
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
    val version: String?
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

data class RabiRouteInfo(
    val id: String,
    val name: String,
    val configName: String,
    val routeName: String,
    val enabled: Boolean,
    val running: Boolean,
    val agentAdapters: List<String>,
    val codexCwd: String,
    val codexThreadName: String,
    val rawJson: JSONObject
)

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
    private val ports: List<Int> = listOf(8790),
    private val rabiLinkPorts: List<Int> = listOf(8794),
    private val timeoutMs: Int = 650
) {
    fun scanLan(context: Context): List<RabiInstance> {
        val hosts = candidateHosts(context)
        val executor = Executors.newFixedThreadPool(32)
        val results = Collections.synchronizedMap(LinkedHashMap<String, RabiInstance>())
        for (host in hosts) {
            for (port in ports.distinct()) {
                executor.submit {
                    val baseUrl = "http://$host:$port"
                    val instance = runCatching { readIdentity(baseUrl) }.getOrNull()
                    if (instance != null) results[instance.guid] = instance.copy(host = host, port = port, baseUrl = baseUrl)
                }
            }
        }
        executor.shutdown()
        executor.awaitTermination((timeoutMs * hosts.size.coerceAtMost(254) / 8L).coerceAtLeast(1500L), TimeUnit.MILLISECONDS)
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
        val data = getJson("$baseUrl/api/rabi/identity").getJSONObject("data")
        val host = URL(baseUrl).host
        val port = URL(baseUrl).port.takeIf { it > 0 } ?: 8790
        return RabiInstance(
            guid = data.optString("guid"),
            name = data.optString("name", data.optString("computerName", "RabiRoute")),
            computerName = data.optString("computerName"),
            deviceType = data.optString("deviceType", "RabiRoute Manager"),
            baseUrl = baseUrl.trimEnd('/'),
            host = host,
            port = port,
            version = data.optString("version").ifBlank { null }
        )
    }

    fun getRoutes(instance: RabiInstance): List<RabiRouteInfo> {
        val url = "${instance.baseUrl}/api/rabi/instances/${encodePath(instance.guid)}/routes"
        val routes = getJson(url).getJSONObject("data").getJSONArray("routes")
        return (0 until routes.length()).map { index ->
            val item = routes.getJSONObject(index)
            RabiRouteInfo(
                id = item.optString("id"),
                name = item.optString("name"),
                configName = item.optString("configName"),
                routeName = item.optString("routeName"),
                enabled = item.optBoolean("enabled"),
                running = item.optBoolean("running"),
                agentAdapters = item.optJSONArray("agentAdapters").toStringList(),
                codexCwd = item.optString("codexCwd"),
                codexThreadName = item.optString("codexThreadName"),
                rawJson = item
            )
        }
    }

    fun getAgentOptions(instance: RabiInstance, routeId: String): JSONObject {
        val url = "${instance.baseUrl}/api/rabi/instances/${encodePath(instance.guid)}/routes/${encodePath(routeId)}/agent-options"
        return getJson(url).getJSONObject("data")
    }

    fun setAgentBinding(instance: RabiInstance, routeId: String, binding: RabiAgentBinding): JSONObject {
        val url = "${instance.baseUrl}/api/rabi/instances/${encodePath(instance.guid)}/routes/${encodePath(routeId)}/agent-binding"
        return requestJson(url, "PATCH", binding.toJson().toString()).getJSONObject("data")
    }

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
        val replyContext = JSONObject()
            .put("runtimeRouteId", routeId)
            .put("gatewayId", routeId)
            .put("routeProfileId", routeId)
            .put("routeProfileName", routeId)
            .put("routeKind", "rabilink")
            .put("targetType", "rabilink")
            .put("messageId", messageId)
            .put("adapterType", "rabilink")
            .put("replyApiUrl", "${instance.baseUrl}/api/agent/replies")
            .put("outputAdapter", "codex")
            .put("outputPipeline", "codex")
            .put("replyToSource", false)
        val payload = JSONObject()
            .put("text", text)
            .put("replyContext", replyContext)
        return requestJson("${instance.baseUrl}/api/agent/replies", "POST", payload.toString())
    }

    fun getRabiLinkReplies(instance: RabiInstance, routeId: String, limit: Int = 10, afterId: String = ""): JSONObject {
        val safeLimit = limit.coerceIn(1, 100)
        val after = if (afterId.isBlank()) "" else "&afterId=${encodeQuery(afterId)}"
        val url = "${instance.baseUrl}/api/rabi/instances/${encodePath(instance.guid)}/routes/${encodePath(routeId)}/rabilink-replies?limit=$safeLimit$after"
        return getJson(url).getJSONObject("data")
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
        waitMs: Int = 60000,
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

    fun getMobileRoutes(relayBaseUrl: String, token: String, targetDeviceId: String = ""): List<RabiRouteInfo> {
        val target = targetQuery(targetDeviceId)
        val json = requestJson(
            "${relayBaseUrl.trimEnd('/')}/api/rabilink/mobile/routes$target",
            "GET",
            null,
            mapOf("X-RabiLink-Token" to token),
            readTimeoutMs = 45000
        )
        val routes = json.getJSONObject("data").getJSONArray("routes")
        return (0 until routes.length()).map { index -> routeInfoFromJson(routes.getJSONObject(index)) }
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

    fun setMobileAgentBinding(relayBaseUrl: String, token: String, routeId: String, binding: RabiAgentBinding, targetDeviceId: String = ""): JSONObject {
        val target = targetQuery(targetDeviceId)
        return requestJson(
            "${relayBaseUrl.trimEnd('/')}/api/rabilink/mobile/routes/${encodePath(routeId)}/agent-binding$target",
            "PATCH",
            binding.toJson().toString(),
            mapOf("X-RabiLink-Token" to token),
            readTimeoutMs = 45000
        ).getJSONObject("data")
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

    private fun requestJson(
        url: String,
        method: String,
        body: String?,
        headers: Map<String, String> = emptyMap(),
        readTimeoutMs: Int = timeoutMs
    ): JSONObject {
        val connection = (URL(url).openConnection() as HttpURLConnection).apply {
            requestMethod = method
            connectTimeout = timeoutMs
            readTimeout = readTimeoutMs
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
            val text = stream?.let {
                BufferedReader(InputStreamReader(it, Charsets.UTF_8)).use { reader -> reader.readText() }
            }.orEmpty()
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
            agentAdapters = item.optJSONArray("agentAdapters").toStringList(),
            codexCwd = item.optString("codexCwd"),
            codexThreadName = item.optString("codexThreadName"),
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

    private fun JSONArray?.toStringList(): List<String> {
        if (this == null) return emptyList()
        return (0 until length()).map { optString(it) }.filter { it.isNotBlank() }
    }
}
