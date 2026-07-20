package com.rabi.link

import android.content.Context

data class RabiLinkRelayConfig(
    val baseUrl: String,
    val token: String,
    val statusSyncEnabled: Boolean
) {
    val configured: Boolean
        get() = baseUrl.isNotBlank() && token.isNotBlank()
}

object RabiLinkRelaySettings {
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
