package com.rabi.link.transport

import com.rabi.link.RabiLinkRelayConfig
import com.rabiroute.sdk.RabiLinkAsrSettings
import com.rabiroute.sdk.RabiRouteSdk

/** Directory refresh is independent of audio transport. A rendezvous outage retains known peers. */
object AsrDirectory {
    @JvmStatic fun accountIdentity(baseUrl: String, token: String): String = "asr:" +
        java.security.MessageDigest.getInstance("SHA-256").digest((baseUrl.trimEnd('/') + "\n" + token).toByteArray(Charsets.UTF_8))
            .joinToString("") { "%02x".format(it.toInt() and 255) }
    private var scope = ""
    private var checkedAt = 0L
    private var snapshot: RabiLinkAsrSettings? = null
    @Synchronized fun load(relay: RabiLinkRelayConfig): RabiLinkAsrSettings {
        val current = relay.baseUrl + "\n" + relay.token
        if(scope != current) { scope = current; snapshot = null; checkedAt = 0 }
        if(snapshot != null && System.nanoTime() - checkedAt < 30_000_000_000L) return snapshot!!
        checkedAt = System.nanoTime()
        return try { RabiRouteSdk().mobileAsrSettings(relay.baseUrl,relay.token).also { snapshot = it } }
        catch(error: Exception) { snapshot ?: throw error }
    }
    @Synchronized fun update(relay: RabiLinkRelayConfig, value: RabiLinkAsrSettings) {
        scope = relay.baseUrl + "\n" + relay.token
        snapshot = value; checkedAt = System.nanoTime()
    }
}
