package com.rabi.link.transport

import android.content.Context
import com.rabi.link.RabiLinkRelayConfig
import com.rabiroute.sdk.RabiTimeoutSettings
import org.json.JSONObject

/** Reads the existing per-account/per-PC cache; never owns or writes configuration. */
class ScopedManagerTimeouts(context: Context, relay: RabiLinkRelayConfig, targetId: String) {
    companion object {
        @JvmStatic fun active(context: Context): ScopedManagerTimeouts {
            val relay = com.rabi.link.RabiLinkRelaySettings.load(context)
            val target = com.rabi.link.recording.TargetWorkerIdentity.load(context, relay.baseUrl, relay.token)
            return ScopedManagerTimeouts(context, relay, target)
        }
    }
    private val prefs = context.applicationContext.getSharedPreferences("manager-timeout-cache", Context.MODE_PRIVATE)
    private val scope = AsrDirectory.accountIdentity(relay.baseUrl, relay.token) + ':' + targetId
    private var previous: String? = null
    private var snapshot = RabiTimeoutSettings()
    @Synchronized fun get(key: String, fallback: Long): Long {
        val raw = prefs.getString(scope, "{}") ?: "{}"
        if (raw != previous) {
            snapshot = runCatching { RabiTimeoutSettings(JSONObject(raw)) }.getOrDefault(RabiTimeoutSettings())
            previous = raw
        }
        return snapshot.get(key, fallback)
    }
}
