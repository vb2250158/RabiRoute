package com.rabi.link.modules.xiaomi

import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.util.concurrent.TimeUnit

internal object MiHealthCloudTimeFormatter {
    fun formatNs(ns: Long): String {
        if (ns <= 0L) {
            return "unknown"
        }
        val instant = Instant.ofEpochMilli(TimeUnit.NANOSECONDS.toMillis(ns))
        return DateTimeFormatter.ofPattern("MM-dd HH:mm:ss")
            .withZone(ZoneId.systemDefault())
            .format(instant)
    }
}
