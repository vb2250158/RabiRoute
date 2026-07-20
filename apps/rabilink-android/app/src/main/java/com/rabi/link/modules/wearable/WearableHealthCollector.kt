package com.rabi.link.modules.wearable

import android.content.Context
import androidx.health.connect.client.HealthConnectClient
import androidx.health.connect.client.permission.HealthPermission
import androidx.health.connect.client.records.HeartRateRecord
import androidx.health.connect.client.records.SleepSessionRecord
import androidx.health.connect.client.request.ReadRecordsRequest
import androidx.health.connect.client.time.TimeRangeFilter
import com.rabi.link.modules.xiaomi.HealthConnectHeartRateReader
import com.rabiroute.sdk.RabiWearableHealthSample
import java.time.Instant

internal object WearableHealthCollector {
    private val heartRatePermission = HealthPermission.getReadPermission(HeartRateRecord::class)
    private val sleepPermission = HealthPermission.getReadPermission(SleepSessionRecord::class)

    suspend fun collect(context: Context, config: WearableHealthConfig): List<RabiWearableHealthSample> {
        check(config.collectorMode == WearableHealthCollectorMode.HEALTH_CONNECT) {
            "当前采集来源由 PC ADB Companion 负责，不在 Android 后台服务中读取。"
        }
        val status = HealthConnectClient.getSdkStatus(context)
        check(status == HealthConnectClient.SDK_AVAILABLE) { "Health Connect 当前不可用（状态 $status）。" }
        val client = HealthConnectClient.getOrCreate(context)
        val granted = client.permissionController.getGrantedPermissions()
        val result = ArrayList<RabiWearableHealthSample>()
        if (heartRatePermission in granted) result += collectHeartRate(client, config.lookbackHours)
        if (sleepPermission in granted) result += collectSleep(client, config.lookbackHours)
        if (heartRatePermission !in granted && sleepPermission !in granted) {
            error("尚未授权 Health Connect 心率或睡眠读取权限。")
        }
        return result.sortedBy { it.recordedAt }
    }

    private suspend fun collectHeartRate(client: HealthConnectClient, lookbackHours: Int): List<RabiWearableHealthSample> {
        return HealthConnectHeartRateReader.readLastHours(client, lookbackHours.toLong()).samples.map { sample ->
            val at = sample.time.toString()
            RabiWearableHealthSample(
                id = "health-connect-heart-${sample.time.toEpochMilli()}-${sample.bpm}",
                metric = "heart_rate",
                recordedAt = at,
                value = sample.bpm.toInt(),
                source = "health-connect"
            )
        }
    }

    private suspend fun collectSleep(client: HealthConnectClient, lookbackHours: Int): List<RabiWearableHealthSample> {
        val end = Instant.now()
        val start = end.minusSeconds(lookbackHours.toLong() * 60L * 60L)
        val records = client.readRecords(
            ReadRecordsRequest(
                recordType = SleepSessionRecord::class,
                timeRangeFilter = TimeRangeFilter.between(start, end)
            )
        ).records.sortedBy { it.startTime }
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
}
