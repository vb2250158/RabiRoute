package com.rabi.link.location

import kotlin.math.*

/** WGS84 samples are the record truth; address labels never replace these coordinates. */
data class LocationPoint(val time: Long, val elapsedNanos: Long, val latitude: Double,
    val longitude: Double, val accuracy: Float, val provider: String)

object LocationPolicy {
    const val ADDRESS_INTERVAL_MS = 600_000L
    const val CACHE_RADIUS_METERS = 150.0
    const val DEFAULT_MONTHLY_LIMIT = 10_000
    fun distance(a: LocationPoint, b: LocationPoint): Double {
        val lat = Math.toRadians(b.latitude - a.latitude)
        val lon = Math.toRadians(b.longitude - a.longitude)
        val h = sin(lat / 2).pow(2) + cos(Math.toRadians(a.latitude)) * cos(Math.toRadians(b.latitude)) * sin(lon / 2).pow(2)
        return 6_371_000 * 2 * asin(sqrt(h.coerceIn(0.0, 1.0)))
    }
    fun valid(point: LocationPoint, elapsedNowNanos: Long): Boolean {
        if (!point.latitude.isFinite() || !point.longitude.isFinite() || point.latitude !in -90.0..90.0 || point.longitude !in -180.0..180.0) return false
        if (!point.accuracy.isFinite() || point.accuracy <= 0 || point.accuracy > 10_000 || point.time <= 0) return false
        val age = elapsedNowNanos - point.elapsedNanos
        if (point.elapsedNanos <= 0 || age < 0 || age > 120_000_000_000L) return false
        return true
    }
    fun movementThreshold(a: LocationPoint, b: LocationPoint, distanceMeters: Double) =
        max(distanceMeters, hypot(a.accuracy.toDouble(), b.accuracy.toDouble()))

    fun accept(point: LocationPoint, previous: LocationPoint?, elapsedNowNanos: Long,
        config: SamplingConfig = SamplingConfig()): Boolean {
        if (!valid(point, elapsedNowNanos)) return false
        if (previous == null) return true
        val delta = point.elapsedNanos - previous.elapsedNanos
        return delta >= config.fastIntervalMs * 1_000_000 &&
            (distance(previous, point) >= movementThreshold(previous, point, config.distanceMeters) || delta >= 300_000_000_000L)
    }
    fun addressDue(now: Long, lastAttempt: Long): Boolean = now - lastAttempt >= ADDRESS_INTERVAL_MS
}
