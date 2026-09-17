package com.rabi.link.modules.wearable

import android.content.Context
import androidx.health.connect.client.HealthConnectClient
import androidx.health.connect.client.permission.HealthPermission
import androidx.health.connect.client.records.HeartRateRecord
import androidx.health.connect.client.records.SleepSessionRecord
import androidx.health.connect.client.records.StepsRecord
import androidx.health.connect.client.request.ReadRecordsRequest
import androidx.health.connect.client.time.TimeRangeFilter
import com.rabi.link.modules.xiaomi.HealthConnectHeartRateReader
import com.rabiroute.sdk.RabiWearableHealthSample
import java.time.Instant
import java.time.ZoneId

internal object WearableHealthCollector {
    private val heartRatePermission = HealthPermission.getReadPermission(HeartRateRecord::class)
    private val sleepPermission = HealthPermission.getReadPermission(SleepSessionRecord::class)
    private val stepsPermission = HealthPermission.getReadPermission(StepsRecord::class)

    suspend fun collect(context: Context, config: WearableHealthConfig, windowStart: Long, windowEnd: Long): List<RabiWearableHealthSample> {
        check(config.collectorMode == WearableHealthCollectorMode.HEALTH_CONNECT) {
            "当前采集来源由 PC ADB Companion 负责，不在 Android 后台服务中读取。"
        }
        val status = HealthConnectClient.getSdkStatus(context)
        check(status == HealthConnectClient.SDK_AVAILABLE) { "Health Connect 当前不可用（状态 $status）。" }
        val client = HealthConnectClient.getOrCreate(context)
        val granted = client.permissionController.getGrantedPermissions()
        val result = ArrayList<RabiWearableHealthSample>()
        val start = Instant.ofEpochMilli(maxOf(windowStart, windowEnd - config.lookbackHours * 3_600_000L))
        val end = Instant.ofEpochMilli(windowEnd)
        if (heartRatePermission in granted) result += collectHeartRate(client, start, end)
        if (sleepPermission in granted) result += collectSleep(client, start, end)
        if (stepsPermission in granted) result += collectSteps(client, start, end)
        if (heartRatePermission !in granted && sleepPermission !in granted && stepsPermission !in granted) {
            error("尚未授权 Health Connect 心率、睡眠或步数读取权限。")
        }
        return result.filter { sample ->
            WearableHealthWindow.contains(windowStart, windowEnd, Instant.parse(sample.recordedAt).toEpochMilli(),
                Instant.parse(sample.startAt).toEpochMilli(), Instant.parse(sample.endAt.ifBlank { sample.recordedAt }).toEpochMilli())
        }.sortedBy { it.recordedAt }
    }

    private suspend fun collectHeartRate(client: HealthConnectClient, start: Instant, end: Instant): List<RabiWearableHealthSample> {
        val records = ArrayList<HeartRateRecord>()
        var page: String? = null
        do {
            val response = client.readRecords(ReadRecordsRequest(recordType = HeartRateRecord::class,
                timeRangeFilter = TimeRangeFilter.between(start, end), pageToken = page))
            records += response.records
            page = response.pageToken
        } while (page != null)
        return records.flatMap { it.samples }.filter { !it.time.isBefore(start) && !it.time.isAfter(end) }.map { sample ->
            val at = sample.time.toString()
            RabiWearableHealthSample(
                id = "health-connect-heart-${sample.time.toEpochMilli()}-${sample.beatsPerMinute}",
                metric = "heart_rate",
                recordedAt = at,
                value = sample.beatsPerMinute.toInt(),
                source = "health-connect"
            )
        }
    }

    private suspend fun collectSleep(client: HealthConnectClient, start: Instant, end: Instant): List<RabiWearableHealthSample> {
        val records = ArrayList<SleepSessionRecord>()
        var page: String? = null
        do {
            val response = client.readRecords(ReadRecordsRequest(recordType = SleepSessionRecord::class,
                timeRangeFilter = TimeRangeFilter.between(start, end), pageToken = page))
            records += response.records.filter { !it.startTime.isBefore(start) && !it.endTime.isAfter(end) }
            page = response.pageToken
        } while (page != null)
        records.sortBy { it.startTime }
        val result = ArrayList<RabiWearableHealthSample>()
        for (record in records) {
            result += RabiWearableHealthSample(
                id = "health-connect-sleep-${record.startTime.toEpochMilli()}-${record.endTime.toEpochMilli()}",
                metric = "sleep_session",
                recordedAt = record.endTime.toString(),
                startAt = record.startTime.toString(),
                endAt = record.endTime.toString(),
                source = "health-connect"
            )
            for (stage in record.stages) {
                result += RabiWearableHealthSample(
                    id = "health-connect-sleep-stage-${stage.startTime.toEpochMilli()}-${stage.endTime.toEpochMilli()}-${stage.stage}",
                    metric = "sleep_stage",
                    recordedAt = stage.endTime.toString(),
                    startAt = stage.startTime.toString(),
                    endAt = stage.endTime.toString(),
                    sleepStage = sleepStageName(stage.stage),
                    source = "health-connect"
                )
            }
        }
        records.lastOrNull()?.let { latest ->
            val state = if (!latest.startTime.isAfter(end) && latest.endTime.isAfter(end)) "sleeping" else "awake"
            val at = if (state == "sleeping") end else latest.endTime
            result += RabiWearableHealthSample(
                id = "health-connect-sleep-state-${state}-${at.toEpochMilli()}",
                metric = "sleep_state",
                recordedAt = at.toString(),
                sleepState = state,
                source = "health-connect"
            )
        }
        return result
    }

    private fun sleepStageName(value: Int): String = when (value) {
        SleepSessionRecord.STAGE_TYPE_AWAKE,
        SleepSessionRecord.STAGE_TYPE_AWAKE_IN_BED,
        SleepSessionRecord.STAGE_TYPE_OUT_OF_BED -> "awake"
        SleepSessionRecord.STAGE_TYPE_LIGHT -> "light"
        SleepSessionRecord.STAGE_TYPE_DEEP -> "deep"
        SleepSessionRecord.STAGE_TYPE_REM -> "rem"
        else -> "unknown"
    }

    /**
     * Health Connect 把步数写成许多累计小段，同一天重复读取会得到不同分段边界。
     * 这里按本地自然日聚合成一个累计值，并用「日期」生成稳定 ID，
     * 使同一天的回看重读被下游按 id 去重，而不是把步数重复累加。
     */
    private suspend fun collectSteps(client: HealthConnectClient, start: Instant, end: Instant): List<RabiWearableHealthSample> {
        val records = ArrayList<StepsRecord>()
        var page: String? = null
        do {
            val response = client.readRecords(ReadRecordsRequest(recordType = StepsRecord::class,
                timeRangeFilter = TimeRangeFilter.between(start, end), pageToken = page))
            records += response.records.filter { !it.startTime.isBefore(start) && !it.endTime.isAfter(end) }
            page = response.pageToken
        } while (page != null)
        return aggregateDailySteps(
            records.map { StepSegment(it.startTime, it.endTime, it.count) },
            ZoneId.systemDefault()
        )
    }
}

/** 一段 Health Connect 步数记录，抽成纯数据以便脱离 Android 单元测试。 */
internal data class StepSegment(val startTime: Instant, val endTime: Instant, val count: Long)

/**
 * 按本地自然日把累计步数小段合成「一天一条」的样本。
 * ID 只依赖日期，因此同一自然日的重复读取产生同一 ID，由下游去重。
 */
internal fun aggregateDailySteps(
    segments: List<StepSegment>,
    zone: ZoneId
): List<RabiWearableHealthSample> {
    if (segments.isEmpty()) return emptyList()
    return segments.groupBy { it.startTime.atZone(zone).toLocalDate() }
        .entries.sortedBy { it.key }
        .map { (day, daySegments) ->
            val lastEnd = daySegments.maxOf { it.endTime }
            RabiWearableHealthSample(
                id = "health-connect-steps-$day",
                metric = "steps",
                recordedAt = lastEnd.toString(),
                startAt = day.atStartOfDay(zone).toInstant().toString(),
                endAt = lastEnd.toString(),
                value = daySegments.sumOf { it.count }.toInt(),
                unit = "count",
                source = "health-connect"
            )
        }
}
