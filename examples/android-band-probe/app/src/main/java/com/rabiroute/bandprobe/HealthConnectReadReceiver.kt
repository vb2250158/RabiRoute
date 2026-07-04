package com.rabiroute.bandprobe

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.util.Log
import androidx.health.connect.client.HealthConnectClient
import androidx.health.connect.client.permission.HealthPermission
import androidx.health.connect.client.records.HeartRateRecord
import androidx.health.connect.client.records.SleepSessionRecord
import androidx.health.connect.client.records.StepsRecord
import androidx.health.connect.client.request.ReadRecordsRequest
import androidx.health.connect.client.time.TimeRangeFilter
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.util.Locale

class HealthConnectReadReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        val pendingResult = goAsync()
        CoroutineScope(Dispatchers.IO).launch {
            try {
                val heartRateHours = intent.getLongExtra("heart_rate_hours", 24L).coerceAtLeast(1L)
                val sleepHours = intent.getLongExtra("sleep_hours", 48L).coerceAtLeast(1L)
                val stepsHours = intent.getLongExtra("steps_hours", 24L).coerceAtLeast(1L)
                HealthConnectBackgroundProbe(context.applicationContext).run(
                    heartRateHours = heartRateHours,
                    sleepHours = sleepHours,
                    stepsHours = stepsHours
                )
            } finally {
                pendingResult.finish()
            }
        }
    }
}

private class HealthConnectBackgroundProbe(
    private val context: Context
) {
    private val tag = "RabiHealthBgRead"
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
            return
        }

        val client = HealthConnectClient.getOrCreate(context)
        val granted = client.permissionController.getGrantedPermissions()
        log("已授权权限：${granted.sorted().joinToString()}")

        if (heartRatePermission in granted) {
            readHeartRate(client, heartRateHours)
        } else {
            log("未授权读取心率：$heartRatePermission")
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
        val end = Instant.now()
        val start = end.minusSeconds(hours * 60 * 60)
        log("读取心率范围：${format(start)} -> ${format(end)}")

        runCatching {
            client.readRecords(
                ReadRecordsRequest(
                    recordType = HeartRateRecord::class,
                    timeRangeFilter = TimeRangeFilter.between(start, end)
                )
            )
        }.onSuccess { response ->
            val samples = response.records.flatMap { record ->
                record.samples.map { sample ->
                    HeartRateSample(sample.time, sample.beatsPerMinute)
                }
            }.sortedBy { it.time }

            log("心率记录条数：${response.records.size}")
            log("心率样本数量：${samples.size}")
            if (samples.isEmpty()) {
                return@onSuccess
            }

            val min = samples.minOf { it.bpm }
            val max = samples.maxOf { it.bpm }
            val avg = samples.map { it.bpm }.average()
            log("最低心率：$min bpm")
            log("最高心率：$max bpm")
            log(String.format(Locale.US, "平均心率：%.1f bpm", avg))
            log("最近一条心率：${format(samples.last().time)} -> ${samples.last().bpm} bpm")
            samples.takeLast(10).forEach {
                log("心率样本：${format(it.time)} -> ${it.bpm} bpm")
            }
        }.onFailure { error ->
            log("读取心率失败：${error.javaClass.simpleName}: ${error.message}")
        }
    }

    private suspend fun readSleep(client: HealthConnectClient, hours: Long) {
        val end = Instant.now()
        val start = end.minusSeconds(hours * 60 * 60)
        log("读取睡眠范围：${format(start)} -> ${format(end)}")

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
                log("睡眠：${format(record.startTime)} -> ${format(record.endTime)}，${formatDuration(durationMillis)}，阶段数 ${record.stages.size}")
            }
            log("睡眠合计：${formatDuration(totalMillis)}")
        }.onFailure { error ->
            log("读取睡眠失败：${error.javaClass.simpleName}: ${error.message}")
        }
    }

    private suspend fun readSteps(client: HealthConnectClient, hours: Long) {
        val end = Instant.now()
        val start = end.minusSeconds(hours * 60 * 60)
        log("读取步数范围：${format(start)} -> ${format(end)}")

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
                log("步数：${format(record.startTime)} -> ${format(record.endTime)}，${record.count}")
            }
        }.onFailure { error ->
            log("读取步数失败：${error.javaClass.simpleName}: ${error.message}")
        }
    }

    private fun log(message: String) {
        Log.i(tag, message)
    }

    private fun format(instant: Instant): String {
        return DateTimeFormatter.ofPattern("MM-dd HH:mm:ss")
            .withZone(ZoneId.systemDefault())
            .format(instant)
    }

    private fun formatDuration(millis: Long): String {
        val totalMinutes = millis / 60000
        val hours = totalMinutes / 60
        val minutes = totalMinutes % 60
        return "${hours}小时${minutes}分钟"
    }

    private data class HeartRateSample(
        val time: Instant,
        val bpm: Long
    )
}
