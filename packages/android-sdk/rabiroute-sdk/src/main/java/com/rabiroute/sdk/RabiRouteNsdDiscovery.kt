package com.rabiroute.sdk

import android.content.Context
import android.net.nsd.NsdManager
import android.net.nsd.NsdServiceInfo
import android.os.Build
import java.net.InetAddress
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicReference

internal class RabiRouteNsdDiscovery(
    context: Context,
    private val configuredTimeoutMs: Int
) {
    private val nsdManager = context.applicationContext
        .getSystemService(Context.NSD_SERVICE) as? NsdManager
        ?: throw IllegalStateException("Android DNS-SD service is unavailable.")

    fun discoverManagerEndpoints(): List<RabiRouteDiscoveredManagerEndpoint> {
        val services = discoverServices()
        if (services.isEmpty()) return emptyList()

        val endpoints = LinkedHashSet<RabiRouteDiscoveredManagerEndpoint>()
        val resolutionErrors = ArrayList<String>()
        val resolutionDeadlineNanos = System.nanoTime() +
            TimeUnit.MILLISECONDS.toNanos(RabiRouteDiscoveryContract.MAX_TOTAL_RESOLUTION_MS)
        for (serviceInfo in services.take(RabiRouteDiscoveryContract.MAX_RESOLVED_SERVICES)) {
            val remainingMs = TimeUnit.NANOSECONDS.toMillis(resolutionDeadlineNanos - System.nanoTime())
            if (remainingMs <= 0L) {
                throw IllegalStateException("DNS-SD Manager resolution exceeded its total time budget.")
            }
            val resolveTimeoutMs = remainingMs.coerceAtMost(RabiRouteDiscoveryContract.RESOLVE_TIMEOUT_MS)
            when (val result = resolveService(serviceInfo, resolveTimeoutMs)) {
                is ResolveResult.Success -> endpoints.add(result.endpoint)
                is ResolveResult.Failure -> resolutionErrors.add(result.message)
                is ResolveResult.Timeout -> throw IllegalStateException(result.message)
            }
        }
        if (endpoints.isEmpty()) {
            throw IllegalStateException(
                "DNS-SD found ${services.size} RabiRoute service(s), but none could be resolved: " +
                    resolutionErrors.joinToString("; ")
            )
        }
        return endpoints.toList()
    }

    private fun discoverServices(): List<NsdServiceInfo> {
        val discovered = LinkedHashMap<String, NsdServiceInfo>()
        val discoveredLock = Any()
        val started = AtomicBoolean(false)
        val startCompleted = CountDownLatch(1)
        val stopCompleted = CountDownLatch(1)
        val startError = AtomicReference<IllegalStateException?>()
        val stopError = AtomicReference<IllegalStateException?>()
        val listener = object : NsdManager.DiscoveryListener {
            override fun onDiscoveryStarted(serviceType: String) {
                started.set(true)
                startCompleted.countDown()
            }

            override fun onStartDiscoveryFailed(serviceType: String, errorCode: Int) {
                startError.set(
                    IllegalStateException("Android DNS-SD discovery failed to start (error $errorCode).")
                )
                startCompleted.countDown()
            }

            override fun onServiceFound(serviceInfo: NsdServiceInfo) {
                if (!sameServiceType(serviceInfo.serviceType)) return
                synchronized(discoveredLock) {
                    discovered[serviceKey(serviceInfo)] = serviceInfo
                }
            }

            override fun onServiceLost(serviceInfo: NsdServiceInfo) {
                synchronized(discoveredLock) {
                    discovered.remove(serviceKey(serviceInfo))
                }
            }

            override fun onDiscoveryStopped(serviceType: String) {
                stopCompleted.countDown()
            }

            override fun onStopDiscoveryFailed(serviceType: String, errorCode: Int) {
                stopError.set(
                    IllegalStateException("Android DNS-SD discovery failed to stop (error $errorCode).")
                )
                stopCompleted.countDown()
            }
        }

        try {
            nsdManager.discoverServices(
                RabiRouteDiscoveryContract.SERVICE_TYPE,
                NsdManager.PROTOCOL_DNS_SD,
                listener
            )
        } catch (error: RuntimeException) {
            throw IllegalStateException("Android DNS-SD discovery could not be started.", error)
        }

        if (!awaitWithoutThrowing(startCompleted, START_CALLBACK_TIMEOUT_MS)) {
            runCatching { nsdManager.stopServiceDiscovery(listener) }
            throw IllegalStateException("Android DNS-SD discovery did not report startup.")
        }
        startError.get()?.let { throw it }
        check(started.get()) { "Android DNS-SD discovery did not enter the started state." }

        try {
            awaitDiscoveryWindow(RabiRouteDiscoveryContract.discoveryWindowMs(configuredTimeoutMs))
        } finally {
            try {
                nsdManager.stopServiceDiscovery(listener)
            } catch (error: RuntimeException) {
                throw IllegalStateException("Android DNS-SD discovery could not be stopped.", error)
            }
            if (!awaitWithoutThrowing(stopCompleted, STOP_CALLBACK_TIMEOUT_MS)) {
                throw IllegalStateException("Android DNS-SD discovery did not report shutdown.")
            }
            stopError.get()?.let { throw it }
        }

        return synchronized(discoveredLock) { discovered.values.toList() }
    }

    private fun resolveService(serviceInfo: NsdServiceInfo, resolveTimeoutMs: Long): ResolveResult {
        val completed = CountDownLatch(1)
        val result = AtomicReference<ResolveResult>()
        val listener = object : NsdManager.ResolveListener {
            override fun onServiceResolved(resolvedServiceInfo: NsdServiceInfo) {
                result.set(resolveBaseUrl(resolvedServiceInfo))
                completed.countDown()
            }

            override fun onResolveFailed(failedServiceInfo: NsdServiceInfo, errorCode: Int) {
                result.set(
                    ResolveResult.Failure(
                        "${failedServiceInfo.serviceName.ifBlank { "unnamed" }} failed with error $errorCode"
                    )
                )
                completed.countDown()
            }
        }

        try {
            @Suppress("DEPRECATION")
            nsdManager.resolveService(serviceInfo, listener)
        } catch (error: RuntimeException) {
            return ResolveResult.Failure(
                "${serviceInfo.serviceName.ifBlank { "unnamed" }} could not start resolution: " +
                    (error.message ?: error.javaClass.simpleName)
            )
        }

        if (!awaitWithoutThrowing(completed, resolveTimeoutMs)) {
            if (Build.VERSION.SDK_INT >= 34) {
                runCatching { nsdManager.stopServiceResolution(listener) }
            }
            return ResolveResult.Timeout(
                "DNS-SD resolution timed out for " +
                    "${serviceInfo.serviceName.ifBlank { "unnamed" }}; no overlapping resolve was started."
            )
        }
        return result.get()
            ?: ResolveResult.Failure("${serviceInfo.serviceName.ifBlank { "unnamed" }} returned no resolution result")
    }

    private fun resolveBaseUrl(serviceInfo: NsdServiceInfo): ResolveResult {
        return runCatching {
            val lifecycleIdentity = lifecycleIdentityFromTxt(serviceInfo)
            val address = requireNotNull(
                RabiRouteDiscoveryContract.preferredAddress(hostAddresses(serviceInfo))
            ) {
                "${serviceInfo.serviceName.ifBlank { "unnamed" }} resolved without a host address"
            }
            ResolveResult.Success(
                RabiRouteDiscoveredManagerEndpoint(
                    baseUrl = RabiRouteDiscoveryContract.managerBaseUrl(
                        address.hostAddress.orEmpty(),
                        serviceInfo.port
                    ),
                    lifecycleIdentity = lifecycleIdentity
                )
            )
        }.getOrElse { error ->
            ResolveResult.Failure(
                "${serviceInfo.serviceName.ifBlank { "unnamed" }} returned an invalid endpoint: " +
                    (error.message ?: error.javaClass.simpleName)
            )
        }
    }

    private fun lifecycleIdentityFromTxt(serviceInfo: NsdServiceInfo): RabiRouteManagerLifecycleIdentity {
        val serviceName = serviceInfo.serviceName.ifBlank { "unnamed" }
        val protocol = txtValue(serviceInfo, "protocol")
        require(protocol == RabiRouteDiscoveryContract.PROTOCOL_VERSION.toString()) {
            "$serviceName advertised unsupported DNS-SD protocol ${protocol ?: "<missing>"}"
        }
        val path = txtValue(serviceInfo, "path")
        require(path == RabiRouteDiscoveryContract.WELL_KNOWN_PATH) {
            "$serviceName advertised unexpected discovery path ${path ?: "<missing>"}"
        }
        val applicationGenerationId = txtValue(serviceInfo, "applicationGenerationId")
        require(!applicationGenerationId.isNullOrBlank()) {
            "$serviceName omitted applicationGenerationId from DNS-SD TXT"
        }
        val managerInstanceId = txtValue(serviceInfo, "managerInstanceId")
        require(!managerInstanceId.isNullOrBlank()) {
            "$serviceName omitted managerInstanceId from DNS-SD TXT"
        }
        return RabiRouteManagerLifecycleIdentity(applicationGenerationId, managerInstanceId)
    }

    private fun txtValue(serviceInfo: NsdServiceInfo, key: String): String? =
        serviceInfo.attributes[key]?.toString(Charsets.UTF_8)?.trim()

    private fun hostAddresses(serviceInfo: NsdServiceInfo): List<InetAddress> =
        if (Build.VERSION.SDK_INT >= 34) {
            serviceInfo.hostAddresses
        } else {
            @Suppress("DEPRECATION")
            listOfNotNull(serviceInfo.host)
        }

    private fun serviceKey(serviceInfo: NsdServiceInfo): String =
        "${serviceInfo.serviceName}\u0000${normalizedServiceType(serviceInfo.serviceType)}"

    private fun sameServiceType(value: String): Boolean =
        normalizedServiceType(value).equals(
            normalizedServiceType(RabiRouteDiscoveryContract.SERVICE_TYPE),
            ignoreCase = true
        )

    private fun normalizedServiceType(value: String): String = value.trim().trimEnd('.') + "."

    private fun awaitDiscoveryWindow(durationMs: Long) {
        awaitWithoutThrowing(CountDownLatch(1), durationMs)
    }

    private fun awaitWithoutThrowing(latch: CountDownLatch, timeoutMs: Long): Boolean = try {
        latch.await(timeoutMs, TimeUnit.MILLISECONDS)
    } catch (error: InterruptedException) {
        Thread.currentThread().interrupt()
        throw IllegalStateException("Android DNS-SD discovery was interrupted.", error)
    }

    private sealed interface ResolveResult {
        data class Success(val endpoint: RabiRouteDiscoveredManagerEndpoint) : ResolveResult
        data class Failure(val message: String) : ResolveResult
        data class Timeout(val message: String) : ResolveResult
    }

    private companion object {
        const val START_CALLBACK_TIMEOUT_MS = 5_000L
        const val STOP_CALLBACK_TIMEOUT_MS = 1_500L
    }
}
