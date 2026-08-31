package com.rabiroute.sdk

import java.net.InetAddress

fun main() {
    check(RabiRouteDiscoveryContract.SERVICE_TYPE == "_rabiroute._tcp.")
    check(RabiRouteDiscoveryContract.WELL_KNOWN_PATH == "/.well-known/rabiroute-manager")
    check(RabiRouteDiscoveryContract.PROTOCOL_VERSION == 1)
    check(RabiRouteDiscoveryContract.MAX_TOTAL_RESOLUTION_MS == 6_000L)
    check(RabiRouteDiscoveryContract.discoveryWindowMs(160) == 1_500L)
    check(RabiRouteDiscoveryContract.discoveryWindowMs(2_400) == 2_400L)

    val ipv6 = InetAddress.getByName("2001:db8::1")
    val ipv4 = InetAddress.getByName("192.0.2.42")
    check(RabiRouteDiscoveryContract.preferredAddress(listOf(ipv6, ipv4)) == ipv4)
    check(RabiRouteDiscoveryContract.preferredAddress(listOf(ipv6)) == ipv6)
    check(RabiRouteDiscoveryContract.preferredAddress(emptyList()) == null)

    check(RabiRouteDiscoveryContract.managerBaseUrl("192.0.2.42", 43127) == "http://192.0.2.42:43127")
    check(
        RabiRouteDiscoveryContract.managerBaseUrl("2001:db8::1", 43127) ==
            "http://[2001:db8::1]:43127"
    )
    check(runCatching { RabiRouteDiscoveryContract.managerBaseUrl("192.0.2.42", 0) }.isFailure)
    check(runCatching { RabiRouteDiscoveryContract.managerBaseUrl("", 43127) }.isFailure)

    RabiRouteDiscoveryContract.requireValidIdentity(1, "generation-a", "manager-a", "rabi-a")
    check(runCatching {
        RabiRouteDiscoveryContract.requireValidIdentity(2, "generation-a", "manager-a", "rabi-a")
    }.isFailure)
    check(runCatching {
        RabiRouteDiscoveryContract.requireValidIdentity(1, "", "manager-a", "rabi-a")
    }.isFailure)
    check(runCatching {
        RabiRouteDiscoveryContract.requireValidIdentity(1, "generation-a", "", "rabi-a")
    }.isFailure)
    check(runCatching {
        RabiRouteDiscoveryContract.requireValidIdentity(1, "generation-a", "manager-a", "")
    }.isFailure)

    val advertised = RabiRouteManagerLifecycleIdentity("generation-a", "manager-a")
    RabiRouteDiscoveryContract.requireMatchingIdentity(advertised, advertised.copy())
    val generationMismatch = runCatching {
        RabiRouteDiscoveryContract.requireMatchingIdentity(
            advertised,
            advertised.copy(applicationGenerationId = "generation-b")
        )
    }.exceptionOrNull()
    check(generationMismatch?.message?.contains("applicationGenerationId") == true)
    val managerMismatch = runCatching {
        RabiRouteDiscoveryContract.requireMatchingIdentity(
            advertised,
            advertised.copy(managerInstanceId = "manager-b")
        )
    }.exceptionOrNull()
    check(managerMismatch?.message?.contains("managerInstanceId") == true)
}
