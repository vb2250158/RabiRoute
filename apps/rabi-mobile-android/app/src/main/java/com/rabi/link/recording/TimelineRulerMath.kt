package com.rabi.link.recording

/** A movable wall-clock viewport, independent of day boundaries and retained-record count. */
object TimelineRulerMath {
    const val MIN_WINDOW = 30_000L
    const val MAX_WINDOW = 7 * 86_400_000L
    fun pan(time: Long, deltaPixels: Double, width: Int, window: Long, now: Long): Long =
        (time - deltaPixels * window / width.coerceAtLeast(1)).coerceIn(0.0,now.toDouble()).toLong()
    fun zoom(window: Long, factor: Double): Long =
        (window / factor.coerceIn(0.1,10.0)).toLong().coerceIn(MIN_WINDOW,MAX_WINDOW)
    fun range(time: Long, window: Long): LongRange = (time - window / 2).coerceAtLeast(0)..(time + window / 2)
    fun overlaps(start: Long, duration: Long, range: LongRange) = duration > 0 && start <= range.last && start + duration > range.first
    fun majorStep(window: Long, widthDp: Float): Long {
        val minimum = window * 76 / widthDp.coerceAtLeast(1f)
        return listOf(1000L,5000,10000,30000,60000,300000,900000,1800000,3600000,10800000,21600000,43200000,86400000,172800000,604800000)
            .firstOrNull { it >= minimum } ?: 604800000
    }
}
