package com.rabi.link.modules.xiaomi

import androidx.health.connect.client.HealthConnectClient
import androidx.health.connect.client.records.HeartRateRecord
import androidx.health.connect.client.request.ReadRecordsRequest
import androidx.health.connect.client.time.TimeRangeFilter
import java.time.Instant

internal data class HealthConnectHeartRateReadResult(
    val start: Instant,
    val end: Instant,
    val recordCount: Int,
    val samples: List<HealthConnectHeartRateSample>
) {
    val sampleCount: Int
        get() = samples.size
}

internal object HealthConnectHeartRateReader {
    suspend fun readLastHours(
        client: HealthConnectClient,
        hours: Long
    ): HealthConnectHeartRateReadResult {
        val end = Instant.now()
        val start = end.minusSeconds(hours * SECONDS_PER_HOUR)
        val response = client.readRecords(
            ReadRecordsRequest(
                recordType = HeartRateRecord::class,
                timeRangeFilter = TimeRangeFilter.between(start, end)
            )
        )

        val samples = response.records.flatMap { record ->
            record.samples.map { sample ->
                HealthConnectHeartRateSample(sample.time, sample.beatsPerMinute)
            }
        }.sortedBy { it.time }

        return HealthConnectHeartRateReadResult(
            start = start,
            end = end,
            recordCount = response.records.size,
            samples = samples
        )
    }

    private const val SECONDS_PER_HOUR = 60L * 60L
}
