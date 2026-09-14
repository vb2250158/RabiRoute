package com.rabi.link

import android.content.Context
import android.util.AtomicFile
import com.rabiroute.sdk.RabiRouteInfo
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.io.FileOutputStream
import java.nio.charset.StandardCharsets
import java.security.MessageDigest

/**
 * Private, endpoint-scoped conversation metadata cache.  It deliberately
 * contains no login token, message text, or local filesystem path: it only
 * lets the conversation picker render immediately while the next Relay read
 * is in flight.
 */
object RabiRouteMetadataCache {
    fun load(context: Context, relay: RabiLinkRelayConfig): List<RabiRouteInfo> {
        if (!relay.configured) return emptyList()
        val file = AtomicFile(cacheFile(context, relay))
        return runCatching { decode(read(file)) }.getOrDefault(emptyList())
    }

    fun save(context: Context, relay: RabiLinkRelayConfig, routes: List<RabiRouteInfo>) {
        if (!relay.configured) return
        val file = AtomicFile(cacheFile(context, relay))
        runCatching { write(file, encode(routes)) }
    }

    internal fun encode(routes: List<RabiRouteInfo>): String = JSONArray().apply {
        routes.forEach { route -> put(JSONObject().apply {
            put("id", route.id); put("name", route.name); put("configName", route.configName); put("routeName", route.routeName)
            put("enabled", route.enabled); put("running", route.running); put("agentRoleId", route.agentRoleId)
            put("personaDisplayName", route.personaDisplayName); put("messageAdapters", JSONArray(route.messageAdapters))
            put("agentAdapters", JSONArray(route.agentAdapters)); put("avatarConfigured", route.avatarConfigured); put("avatarVersion", route.avatarVersion)
            put("messageAdaptersDisabled", safeStringArray(route.rawJson.optJSONArray("messageAdaptersDisabled")))
            if (route.rawJson.has("chatAvailable")) put("chatAvailable", route.rawJson.optBoolean("chatAvailable"))
            put("adapterStates", safeAdapterStates(route.rawJson.optJSONArray("adapterStates")))
        }) }
    }.toString()

    internal fun decode(value: String): List<RabiRouteInfo> {
        val rows = JSONArray(value)
        return (0 until rows.length()).mapNotNull { index -> rows.optJSONObject(index)?.let(::routeFromJson) }
            .filter { it.id.isNotBlank() }
    }

    private fun routeFromJson(item: JSONObject): RabiRouteInfo = RabiRouteInfo(
        id = item.optString("id"), name = item.optString("name"), configName = item.optString("configName"), routeName = item.optString("routeName"),
        enabled = item.optBoolean("enabled"), running = item.optBoolean("running"), agentRoleId = item.optString("agentRoleId"),
        personaDisplayName = item.optString("personaDisplayName"),
        messageAdapters = stringList(item.optJSONArray("messageAdapters")), agentAdapters = stringList(item.optJSONArray("agentAdapters")),
        codexCwd = "", codexThreadName = "", avatarConfigured = item.optBoolean("avatarConfigured"), avatarVersion = item.optString("avatarVersion"), rawJson = item
    )

    private fun cacheFile(context: Context, relay: RabiLinkRelayConfig): File =
        File(File(context.filesDir, "rabi-conversation-routes").apply { mkdirs() }, "${digest(relay.baseUrl + '\u0000' + relay.token)}.json")

    private fun stringList(values: JSONArray?): List<String> =
        (0 until (values?.length() ?: 0)).mapNotNull { values?.optString(it)?.trim()?.takeIf(String::isNotBlank) }

    private fun safeStringArray(values: JSONArray?): JSONArray = JSONArray().apply {
        stringList(values).forEach(::put)
    }

    private fun safeAdapterStates(values: JSONArray?): JSONArray = JSONArray().apply {
        for (index in 0 until (values?.length() ?: 0)) {
            val item = values?.optJSONObject(index) ?: continue
            val type = item.optString("type").trim()
            val summary = item.optString("summary").trim()
            if (type.isBlank() || summary.isBlank()) continue
            put(JSONObject().apply {
                put("type", type)
                put("label", item.optString("label").trim())
                put("state", item.optString("state").trim())
                put("summary", summary)
            })
        }
    }

    private fun read(file: AtomicFile): String = file.openRead().use { input -> input.readBytes().toString(StandardCharsets.UTF_8) }
    private fun write(file: AtomicFile, value: String) {
        var output: FileOutputStream? = null
        try { output = file.startWrite(); output.write(value.toByteArray(StandardCharsets.UTF_8)); file.finishWrite(output) }
        catch (error: Throwable) { if (output != null) file.failWrite(output); throw error }
    }
    private fun digest(value: String): String = MessageDigest.getInstance("SHA-256").digest(value.toByteArray(StandardCharsets.UTF_8)).joinToString("") { "%02x".format(it) }
}
