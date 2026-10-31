package com.rabi.link.location

import kotlin.math.max
import kotlin.math.min

data class SamplingConfig(val normalIntervalMs: Long = 60_000, val fastIntervalMs: Long = 5_000,
    val distanceMeters: Double = 10.0) {
    init {
        require(normalIntervalMs in 5_000..300_000) { "常规间隔需在 5–300 秒之间" }
        require(fastIntervalMs in 5_000..60_000 && fastIntervalMs <= normalIntervalMs) { "最快间隔需在 5–60 秒之间，且不大于常规间隔" }
        require(distanceMeters.isFinite() && distanceMeters in 5.0..1000.0) { "位移阈值需在 5–1000 米之间" }
    }
}

data class SamplingDecision(val intervalMs: Long, val reason: String)

/** Monotonic time only. Sensors suggest motion; fresh fixes confirm speed and quiet periods. */
class MotionSamplingPolicy {
    private var lastFix: LocationPoint? = null
    private var anchor: LocationPoint? = null
    private var motionAt: Long? = null
    private var fastAt: Long? = null
    private var quietSince: Long? = null
    private var quietFixAt: Long? = null

    fun motion(now: Long) { motionAt = now; quietSince = null; quietFixAt = null }

    // Call only after validating fix age and coordinate/accuracy ranges at the controller boundary.
    fun observe(point: LocationPoint, speed: Float?, speedAccuracy: Float?, config: SamplingConfig) {
        if (lastFix?.let { point.elapsedNanos <= it.elapsedNanos } == true) return
        val previous = lastFix
        lastFix = point
        val now = point.elapsedNanos / 1_000_000
        if (point.accuracy > 50) { quietSince = null; quietFixAt = null; return }
        val origin = anchor
        val moved = origin != null && LocationPolicy.distance(origin, point) >=
            LocationPolicy.movementThreshold(origin, point, config.distanceMeters)
        val uncertainty = speedAccuracy?.takeIf { it.isFinite() && it >= 0 }
        val usableSpeed = speed?.takeIf { it.isFinite() && it >= 0 && (speedAccuracy == null || uncertainty != null) }
        val lowerSpeed = usableSpeed?.minus(uncertainty ?: 0f)
        if (moved || (lowerSpeed != null && lowerSpeed >= 0.5f)) {
            motion(now)
            val inferredSpeed = origin?.let {
                val seconds = (point.elapsedNanos - it.elapsedNanos) / 1_000_000_000.0
                if (seconds > 0) (LocationPolicy.distance(it, point) - LocationPolicy.movementThreshold(it, point, config.distanceMeters)) / seconds else 0.0
            } ?: 0.0
            if ((lowerSpeed != null && lowerSpeed >= 2f) || (usableSpeed == null && inferredSpeed >= 2.0)) fastAt = now
            anchor = point
            return
        }
        if (origin == null) anchor = point
        // Uncertain speed must not establish rest; no-speed providers use an accuracy-aware anchor.
        val quiet = usableSpeed == null || usableSpeed + (uncertainty ?: 0f) <= 0.5f
        if (quiet) {
            if (previous == null || now - previous.elapsedNanos / 1_000_000 > 600_000) quietSince = now
            if (quietSince == null) quietSince = now
            quietFixAt = now
        } else { quietSince = null; quietFixAt = null }
    }

    fun decision(now: Long, config: SamplingConfig): SamplingDecision {
        fun recent(at: Long?, window: Long) = at != null && now - at in 0..window
        if (recent(fastAt, 60_000)) return SamplingDecision(config.fastIntervalMs, "快速移动")
        if (recent(motionAt, 90_000)) return SamplingDecision(min(config.normalIntervalMs, max(config.fastIntervalMs, 15_000)), "检测到移动")
        val quietFor = quietSince?.let { (quietFixAt ?: it) - it } ?: 0
        if (recent(quietFixAt, 600_000)) {
            if (quietFor >= 600_000) return SamplingDecision(max(config.normalIntervalMs, 300_000), "持续静止")
            if (quietFor >= 180_000) return SamplingDecision(max(config.normalIntervalMs, 120_000), "静止省电")
        }
        return SamplingDecision(config.normalIntervalMs, "常规定位")
    }
}
