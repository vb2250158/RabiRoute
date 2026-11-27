package com.rabi.link.location

import android.Manifest
import android.app.ActivityManager
import android.content.Context
import android.content.pm.PackageManager
import android.location.Location
import android.location.LocationManager
import android.os.CancellationSignal
import android.os.SystemClock
import org.json.JSONObject
import java.time.Instant
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicReference

/** Executes a bounded location read on the selected phone without changing track recording. */
class PhoneLocationAccess(context: Context) {
    private val app = context.applicationContext
    private val settings = LocationSettings(app)

    fun execute(action: String, input: JSONObject, guard: Runnable): JSONObject {
        guard.run()
        if (action == "location.settings.update") {
            val enabled = input.opt("enabled")
            require(enabled is Boolean)
            settings.setRemoteAccess(enabled)
        }
        if (action == "location.settings.read" || action == "location.settings.update") {
            return JSONObject().put("enabled", settings.remoteAccess).put("permission", precision() ?: "none")
        }
        require(action == "location.read")
        if (!settings.remoteAccess) return state("feature-disabled")
        val grantedPrecision = precision() ?: return state("permission-required")
        val manager = app.getSystemService(LocationManager::class.java) ?: return state("location-disabled")
        if (!manager.isLocationEnabled) return state("location-disabled")

        val maxAge = input.optLong("maxAgeMs", 30_000).coerceIn(1_000, 120_000)
        val wait = input.optLong("waitMs", 8_000).coerceIn(100, 10_000)
        val providers = if (grantedPrecision == "precise") listOf(LocationManager.FUSED_PROVIDER, LocationManager.GPS_PROVIDER, LocationManager.NETWORK_PROVIDER)
            else listOf(LocationManager.FUSED_PROVIDER, LocationManager.NETWORK_PROVIDER)
        val enabledProviders = providers.filter { manager.hasProvider(it) && manager.isProviderEnabled(it) }
        val point: LocationPoint
        try {
            val cached = enabledProviders.mapNotNull { fresh(manager.getLastKnownLocation(it), maxAge) }
                .maxByOrNull { it.elapsedNanos }
            point = if (cached != null) cached else {
                val process = ActivityManager.RunningAppProcessInfo()
                ActivityManager.getMyMemoryState(process)
                if (process.importance > ActivityManager.RunningAppProcessInfo.IMPORTANCE_VISIBLE) {
                    return state("foreground-required")
                }
                if (enabledProviders.isEmpty()) return state("location-disabled")
                val started = SystemClock.elapsedRealtime()
                val answer = AtomicReference<LocationPoint?>()
                val done = CountDownLatch(1)
                val outstanding = AtomicInteger(enabledProviders.size)
                val cancellations = enabledProviders.associateWith { CancellationSignal() }
                try {
                    for ((provider, cancellation) in cancellations) {
                        manager.getCurrentLocation(provider, cancellation, app.mainExecutor) {
                            val fix = fresh(it, maxAge)
                            if (fix != null && answer.compareAndSet(null, fix) || outstanding.decrementAndGet() == 0) {
                                done.countDown()
                            }
                        }
                    }
                    while (SystemClock.elapsedRealtime() - started < wait && !done.await(75, TimeUnit.MILLISECONDS)) guard.run()
                    guard.run()
                    answer.get() ?: return state("timeout")
                } finally {
                    cancellations.values.forEach { it.cancel() }
                }
            }
        } catch (_: SecurityException) {
            return state(if (precision() == null) "permission-required" else "foreground-required")
        }

        val result = state("ok").put("latitude", point.latitude).put("longitude", point.longitude)
            .put("coordinateSystem", "WGS84").put("observedAt", Instant.ofEpochMilli(point.time).toString())
            .put("accuracyMeters", point.accuracy.toDouble()).put("provider", point.provider).put("precision", grantedPrecision)
        if (input.optBoolean("includePlace")) {
            runCatching { addPlace(result, point, grantedPrecision, guard) }
                .onFailure { result.put("placeState", "unavailable") }
        }
        guard.run()
        if (!settings.remoteAccess) return state("feature-disabled")
        if (precision() != grantedPrecision) return state("permission-changed")
        if (!manager.isLocationEnabled) return state("location-disabled")
        return result
    }

    private fun addPlace(result: JSONObject, point: LocationPoint, precision: String, guard: Runnable) {
        if (precision != "precise" || point.accuracy > LocationPolicy.CACHE_RADIUS_METERS) {
            result.put("placeState", "insufficient-accuracy")
            return
        }
        LocationRepository(app).use { repository ->
            val now = System.currentTimeMillis()
            val cached = repository.cached(point, now)
            if (cached != null) {
                result.put("place", cached).put("placeState", "cached")
                return
            }
            if (!settings.addresses || !settings.hasKey || !settings.privacyAccepted) {
                result.put("placeState", "not-configured")
                return
            }
            if (!settings.reserveAddressAttempt(now)) {
                result.put("placeState", "rate-limited")
                return
            }
            val label = runCatching {
                AmapLocationLookup(app) {
                    guard.run()
                    settings.remoteAccess && repository.reserveRequest(System.currentTimeMillis(), settings.monthlyLimit)
                }.use { it.resolve(settings.key(), point, maxWaitMs = 8_000) }
            }.getOrNull()
            if (label == null) result.put("placeState", "unavailable")
            else {
                guard.run()
                result.put("place", label).put("placeState", "ok")
                runCatching { repository.cachePlace(point, label) }
            }
        }
    }

    private fun precision(): String? = when {
        app.checkSelfPermission(Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED -> "precise"
        LocationController.permitted(app) -> "approximate"
        else -> null
    }

    private fun fresh(location: Location?, maxAgeMs: Long): LocationPoint? {
        if (location == null) return null
        val point = LocationPoint(location.time, location.elapsedRealtimeNanos, location.latitude,
            location.longitude, location.accuracy, location.provider.orEmpty())
        val now = SystemClock.elapsedRealtimeNanos()
        return point.takeIf { LocationPolicy.valid(it, now) && now - it.elapsedNanos <= maxAgeMs * 1_000_000L }
    }

    private fun state(value: String): JSONObject = JSONObject().put("state", value)
}
