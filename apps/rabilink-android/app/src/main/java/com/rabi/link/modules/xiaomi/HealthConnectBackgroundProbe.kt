package com.rabi.link.modules.xiaomi

import android.content.Context
import android.util.Log
import androidx.health.connect.client.HealthConnectClient
import androidx.health.connect.client.permission.HealthPermission
import androidx.health.connect.client.records.HeartRateRecord
import androidx.health.connect.client.records.SleepSessionRecord
import androidx.health.connect.client.records.StepsRecord
import androidx.health.connect.client.request.ReadRecordsRequest
import androidx.health.connect.client.time.TimeRangeFilter
import org.json.JSONArray
import org.json.JSONObject
import java.time.Instant
import java.util.Locale

internal class HealthConnectBackgroundProbe(
    private val context: Context
) {
    private val tag = "RabiHealthBgRead"
    private val resultStore = HealthConnectResultStore(context, ::log)
    private val heartRatePermission = HealthPermission.getReadPermission(HeartRateRecord::class)
    private val sleepPermission = HealthPermission.getReadPermission(SleepSessionRecord::class)
    private val stepsPermission = HealthPermission.getReadPermission(StepsRecord::class)

    suspend fun run(
        heartRateHours: Long,
        sleepHours: Long,
        stepsHours: Long
    ) {
        val status = HealthConnectClient.getSdkStatus(context)
        log("Health Connect 状态：$status")
        if (status != HealthConnectClient.SDK_AVAILABLE) {
            log("Health Connect 不可用，停止后台读取。")
            resultStore.saveHeartRateResult(
                JSONObject()
                    .put("status", "sdk_unavailable")
                    .put("sdkStatus", status)
            )
            return
        }

        val client = HealthConnectClient.getOrCreate(context)
        val granted = client.permissionController.getGrantedPermissions()
        log("已授权权限：${granted.sorted().joinToString()}")

        if (heartRatePermission in granted) {
            readHeartRate(client, heartRateHours)
        } else {
            log("未授权读取心率：$heartRatePermission")
            resultStore.saveHeartRateResult(
                JSONObject()
                    .put("status", "missing_permission")
                    .put("permission", heartRatePermission)
                    .put("granted", JSONArray(granted.sorted()))
            )
        }

        if (sleepPermission in granted) {
            readSleep(client, sleepHours)
        } else {
            log("未授权读取睡眠：$sleepPermission")
        }

        if (stepsPermission in granted) {
            readSteps(client, stepsHours)
        } else {
            log("未授权读取步数：$stepsPermission")
        }
    }

    private suspend fun readHeartRate(client: HealthConnectClient, hours: Long) {
        runCatching {
            HealthConnectHeartRateReader.readLastHours(client, hours)
        }.onSuccess { result ->
            log("读取心率范围：${HealthConnectFormat.instant(result.start)} -> ${HealthConnectFormat.instant(result.end)}")
            log("心率记录条数：${result.recordCount}")
            log("心率样本数量：${result.sampleCount}")

            resultStore.saveHeartRateResult(
                JSONObject()
                    .put("status", "ok")
                    .put("start", result.start.toString())
                    .put("end", result.end.toString())
                    .put("recordCount", result.recordCount)
                    .put("sampleCount", result.sampleCount)
                    .put(
                        "samples",
                        JSONArray(result.samples.map { sample ->
                            JSONObject()
                                .put("time", sample.time.toString())
                                .put("localTime", HealthConnectFormat.instant(sample.time))
                                .put("bpm", sample.bpm)
                        })
                    )
            )
            if (result.samples.isEmpty()) {
                return@onSuccess
            }

            val min = result.samples.minOf { it.bpm }
            val max = result.samples.maxOf { it.bpm }
            val avg = result.samples.map { it.bpm }.average()
            log("最低心率：$min bpm")
            log("最高心率：$max bpm")
            log(String.format(Locale.US, "平均心率：%.1f bpm", avg))
            log("最近一条心率：${HealthConnectFormat.instant(result.samples.last().time)} -> ${result.samples.last().bpm} bpm")
            result.samples.takeLast(10).forEach {
                log("心率样本：${HealthConnectFormat.instant(it.time)} -> ${it.bpm} bpm")
            }
        }.onFailure { error ->
            log("读取心率失败：${error.javaClass.simpleName}: ${error.message}")
            resultStore.saveHeartRateResult(
                JSONObject()
                    .put("status", "error")
                    .put("errorType", error.javaClass.simpleName)
                    .put("message", error.message)
            )
        }
    }

    private suspend fun readSleep(client: HealthConnectClient, hours: Long) {
        val end = Instant.now()
        val start = end.minusSeconds(hours * 60 * 60)
        log("读取睡眠范围：${HealthConnectFormat.instant(start)} -> ${HealthConnectFormat.instant(end)}")

        runCatching {
            client.readRecords(
                ReadRecordsRequest(
                    recordType = SleepSessionRecord::class,
                    timeRangeFilter = TimeRangeFilter.between(start, end)
                )
            )
        }.onSuccess { response ->
            log("睡眠记录条数：${response.records.size}")
            if (response.records.isEmpty()) {
                return@onSuccess
            }

            var totalMillis = 0L
            response.records.sortedBy { it.startTime }.forEach { record ->
                val durationMillis = record.endTime.toEpochMilli() - record.startTime.toEpochMilli()
                totalMillis += durationMillis
                log("睡眠：${HealthConnectFormat.instant(record.startTime)} -> ${HealthConnectFormat.instant(record.endTime)}，${HealthConnectFormat.duration(durationMillis)}，阶段数 ${record.stages.size}")
            }
            log("睡眠合计：${HealthConnectFormat.duration(totalMillis)}")
        }.onFailure { error ->
            log("读取睡眠失败：${error.javaClass.simpleName}: ${error.message}")
        }
    }

    private suspend fun readSteps(client: HealthConnectClient, hours: Long) {
        val end = Instant.now()
        val start = end.minusSeconds(hours * 60 * 60)
        log("读取步数范围：${HealthConnectFormat.instant(start)} -> ${HealthConnectFormat.instant(end)}")

        runCatching {
            client.readRecords(
                ReadRecordsRequest(
                    recordType = StepsRecord::class,
                    timeRangeFilter = TimeRangeFilter.between(start, end)
                )
            )
        }.onSuccess { response ->
            val total = response.records.sumOf { it.count }
            log("步数记录条数：${response.records.size}")
            log("步数合计：$total")
            response.records.sortedBy { it.startTime }.takeLast(10).forEach { record ->
                log("步数：${HealthConnectFormat.instant(record.startTime)} -> ${HealthConnectFormat.instant(record.endTime)}，${record.count}")
            }
        }.onFailure { error ->
            log("读取步数失败：${error.javaClass.simpleName}: ${error.message}")
        }
    }

    private fun log(message: String) {
        Log.i(tag, message)
    }
}
