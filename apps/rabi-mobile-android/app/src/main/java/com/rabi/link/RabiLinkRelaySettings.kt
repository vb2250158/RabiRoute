package com.rabi.link

import android.content.Context
import org.json.JSONArray
import org.json.JSONObject
import java.util.UUID
import com.rabi.link.recording.TargetWorkerIdentity

data class RabiLinkRelayConfig(
    val baseUrl: String,
    val token: String,
    val statusSyncEnabled: Boolean
) {
    val configured: Boolean
        get() = baseUrl.isNotBlank() && token.isNotBlank()
}

class SavedComputer(val id: String, val name: String, val workerId: String, val connection: RabiLinkRelayConfig)

object RabiLinkRelaySettings {
    // Saved computers own their credentials; existing scalar keys remain the active transport projection.
    @Synchronized fun computers(context: Context): List<SavedComputer> {
        val prefs = context.getSharedPreferences(PREFS_NAME,Context.MODE_PRIVATE)
        val raw = prefs.getString("computers",null)
        if(raw != null) return decodeComputers(raw)
        val active = load(context)
        val migrated = if(active.configured) listOf(SavedComputer(UUID.randomUUID().toString(),"已连接电脑",
            TargetWorkerIdentity.load(context,active.baseUrl,active.token),active)) else emptyList()
        writeComputers(context,migrated)
        return migrated
    }
    internal fun decodeComputers(raw: String): List<SavedComputer> {
        val rows = JSONArray(raw)
        return (0 until rows.length()).map { i ->
            val row = rows.getJSONObject(i)
            SavedComputer(row.getString("id"),row.getString("name"),row.getString("workerId"),
                RabiLinkRelayConfig(row.getString("baseUrl"),row.getString("token"),true))
        }
    }
    internal fun mergeComputer(existing: List<SavedComputer>, name: String, workerId: String, connection: RabiLinkRelayConfig): List<SavedComputer> {
        require(connection.configured && workerId.isNotBlank())
        val found = existing.firstOrNull { it.connection.baseUrl == connection.baseUrl && it.connection.token == connection.token && (it.workerId == workerId || it.workerId.isBlank()) }
        val item = SavedComputer(found?.id ?: UUID.randomUUID().toString(),name.ifBlank { "电脑" },workerId,connection)
        return if(found == null) existing+item else existing.map { if(it.id == found.id) item else it }
    }
    @Synchronized fun rememberComputer(context: Context, name: String, workerId: String, baseUrl: String, token: String) {
        writeComputers(context,mergeComputer(computers(context),name,workerId,RabiLinkRelayConfig(baseUrl.trim().trimEnd('/'),token.trim(),true)))
    }
    fun isActive(context: Context, computer: SavedComputer): Boolean {
        val active = load(context)
        return active.baseUrl == computer.connection.baseUrl && active.token == computer.connection.token &&
            TargetWorkerIdentity.load(context,active.baseUrl,active.token) == computer.workerId
    }
    private fun writeComputers(context: Context, computers: List<SavedComputer>) {
        val rows = JSONArray()
        computers.forEach { rows.put(JSONObject().put("id",it.id).put("name",it.name).put("workerId",it.workerId)
            .put("baseUrl",it.connection.baseUrl).put("token",it.connection.token)) }
        check(context.getSharedPreferences(PREFS_NAME,Context.MODE_PRIVATE).edit().putString("computers",rows.toString()).commit()) { "无法保存电脑列表" }
    }

    private const val PREFS_NAME = "rabi_link_relay_bridge"
    private const val KEY_BASE_URL = "relayBaseUrl"
    private const val KEY_TOKEN = "token"
    private const val KEY_STATUS_SYNC_ENABLED = "deviceStatusSyncEnabled"

    @JvmStatic
    fun load(context: Context): RabiLinkRelayConfig {
        val prefs = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
        return RabiLinkRelayConfig(
            baseUrl = prefs.getString(KEY_BASE_URL, "").orEmpty().trim().trimEnd('/'),
            token = prefs.getString(KEY_TOKEN, "").orEmpty().trim(),
            statusSyncEnabled = prefs.getBoolean(KEY_STATUS_SYNC_ENABLED, false)
        )
    }

    @JvmStatic
    fun save(context: Context, baseUrl: String, token: String) {
        context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
            .edit()
            .putString(KEY_BASE_URL, baseUrl.trim().trimEnd('/'))
            .putString(KEY_TOKEN, token.trim())
            .putBoolean(KEY_STATUS_SYNC_ENABLED, true)
            .apply()
    }
}
