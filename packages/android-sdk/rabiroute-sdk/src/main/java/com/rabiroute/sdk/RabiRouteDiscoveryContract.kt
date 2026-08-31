package com.rabiroute.sdk

import java.net.Inet4Address
import java.net.InetAddress

internal data class RabiRouteManagerLifecycleIdentity(
    val applicationGenerationId: String,
    val managerInstanceId: String
)

internal data class RabiRouteDiscoveredManagerEndpoint(
    val baseUrl: String,
    val lifecycleIdentity: RabiRouteManagerLifecycleIdentity
)

internal object RabiRouteDiscoveryContract {
    const val SERVICE_TYPE = "_rabiroute._tcp."
    const val WELL_KNOWN_PATH = "/.well-known/rabiroute-manager"
    const val PROTOCOL_VERSION = 1
    const val MIN_DISCOVERY_WINDOW_MS = 1_500L
    const val MAX_RESOLVED_SERVICES = 16
    const val RESOLVE_TIMEOUT_MS = 1_500L
    const val MAX_TOTAL_RESOLUTION_MS = 6_000L

    fun discoveryWindowMs(configuredTimeoutMs: Int): Long =
        configuredTimeoutMs.toLong().coerceAtLeast(MIN_DISCOVERY_WINDOW_MS)

    fun preferredAddress(addresses: List<InetAddress>): InetAddress? =
        addresses.firstOrNull { it is Inet4Address } ?: addresses.firstOrNull()

    fun managerBaseUrl(hostAddress: String, port: Int): String {
        require(port in 1..65535) { "DNS-SD Manager port must be between 1 and 65535." }
        val host = hostAddress.trim().removePrefix("[").removeSuffix("]")
        require(host.isNotBlank()) { "DNS-SD Manager host must not be blank." }
        val authorityHost = if (':' in host) "[${host.replace("%", "%25")}]" else host
        return "http://$authorityHost:$port"
    }

    fun requireValidIdentity(
        protocolVersion: Int,
        applicationGenerationId: String,
        managerInstanceId: String,
        guid: String
    ): RabiRouteManagerLifecycleIdentity {
        require(protocolVersion == PROTOCOL_VERSION) {
            "RabiRoute discovery protocol version is unsupported."
        }
        require(applicationGenerationId.isNotBlank()) {
            "RabiRoute discovery document omitted applicationGenerationId."
        }
        require(managerInstanceId.isNotBlank()) {
            "RabiRoute discovery document omitted managerInstanceId."
        }
        require(guid.isNotBlank()) { "RabiRoute discovery document omitted guid." }
        return RabiRouteManagerLifecycleIdentity(applicationGenerationId, managerInstanceId)
    }

    fun requireMatchingIdentity(
        advertised: RabiRouteManagerLifecycleIdentity,
        observed: RabiRouteManagerLifecycleIdentity
    ) {
        require(advertised.applicationGenerationId == observed.applicationGenerationId) {
            "DNS-SD applicationGenerationId does not match the Manager discovery document."
        }
        require(advertised.managerInstanceId == observed.managerInstanceId) {
            "DNS-SD managerInstanceId does not match the Manager discovery document."
        }
    }
}
