package com.rabi.link.modules.xiaomi

import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter

internal data class HealthConnectHeartRateSample(
    val time: Instant,
    val bpm: Long
)

internal object HealthConnectFormat {
    fun instant(instant: Instant): String {
        return DateTimeFormatter.ofPattern("MM-dd HH:mm:ss")
            .withZone(ZoneId.systemDefault())
            .format(instant)
    }

    fun duration(millis: Long): String {
        val totalMinutes = millis / 60000
        val hours = totalMinutes / 60
        val minutes = totalMinutes % 60
        return "${hours}小时${minutes}分钟"
    }
}
