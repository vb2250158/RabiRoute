package com.rabi.link.modules.wearable

/** Half-open, current run only. Crossing sleep sessions are omitted, never fabricated/clipped. */
internal object WearableHealthWindow {
    fun contains(windowStart: Long, windowEnd: Long, recordedAt: Long, startAt: Long = recordedAt, endAt: Long = recordedAt): Boolean =
        windowStart > 0 && windowEnd >= windowStart && recordedAt in windowStart..windowEnd &&
            startAt >= windowStart && endAt <= windowEnd && endAt >= startAt
}
