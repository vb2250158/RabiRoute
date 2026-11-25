package com.rabi.link

import android.content.Context
import com.rabiroute.sdk.RabiLinkPc
import org.json.JSONArray
import org.json.JSONObject
import java.security.MessageDigest

/** A bounded display snapshot. Device addresses, credentials and live status are never stored. */
internal object RabiComputerDirectoryCache {
    data class Computer(val id: String, val name: String)

    private const val MAX_COMPUTERS = 100
    private const val MAX_AGE_MS = 86_400_000L
    private const val KEY = "last-computer-directory"

    fun read(context: Context, relay: RabiLinkRelayConfig, directory: String = KEY): List<Computer>? = runCatching {
        if (!relay.configured) return null
        val snapshot = JSONObject(prefs(context).getString(directory, null) ?: return null)
        if (snapshot.getString("scope") != scope(context, relay)) return null
        if (System.currentTimeMillis() - snapshot.getLong("storedAt") !in 0L until MAX_AGE_MS) return null
        val rows = snapshot.getJSONArray("computers")
        (0 until minOf(rows.length(), MAX_COMPUTERS)).mapNotNull { index ->
            val row = rows.optJSONObject(index) ?: return@mapNotNull null
            val id = row.optString("id")
            if (id.isBlank()) null else Computer(id, row.optString("name").ifBlank { id })
        }
    }.getOrNull()

    fun save(context: Context, relay: RabiLinkRelayConfig, workers: List<RabiLinkPc>, directory: String = KEY) {
        if (!relay.configured) return
        val rows = JSONArray()
        workers.take(MAX_COMPUTERS).forEach { worker ->
            rows.put(JSONObject().put("id", worker.id.take(200)).put("name", worker.name.take(200)))
        }
        val snapshot = JSONObject().put("scope", scope(context, relay)).put("storedAt", System.currentTimeMillis())
            .put("computers", rows)
        runCatching { prefs(context).edit().putString(directory, snapshot.toString()).apply() }
    }

    fun clear(context: Context, relay: RabiLinkRelayConfig, directory: String = KEY) {
        val prefs = prefs(context)
        runCatching {
            val snapshot = JSONObject(prefs.getString(directory, null) ?: return)
            if (snapshot.optString("scope") == scope(context, relay)) prefs.edit().remove(directory).apply()
        }
    }

    private fun prefs(context: Context) = context.getSharedPreferences("rabi_read_previews", Context.MODE_PRIVATE)

    private fun scope(context: Context, relay: RabiLinkRelayConfig): String {
        val identity = "${RabiLinkRelaySettings.accountId(context)}\u0000${relay.baseUrl}\u0000${relay.token}"
        return MessageDigest.getInstance("SHA-256").digest(identity.toByteArray(Charsets.UTF_8))
            .joinToString("") { "%02x".format(it) }
    }
}
