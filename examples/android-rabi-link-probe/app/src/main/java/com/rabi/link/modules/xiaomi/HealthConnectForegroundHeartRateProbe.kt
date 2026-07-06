package com.rabi.link.modules.xiaomi

import androidx.health.connect.client.HealthConnectClient
import java.util.Locale

internal class HealthConnectForegroundHeartRateProbe {
    suspend fun readLast24Hours(client: HealthConnectClient): List<String> {
        val lines = mutableListOf<String>()

        runCatching {
            HealthConnectHeartRateReader.readLastHours(client, 24L)
        }.onSuccess { result ->
            lines += "读取时间范围：${HealthConnectFormat.instant(result.start)} -> ${HealthConnectFormat.instant(result.end)}"
            lines += "心率记录条数：${result.recordCount}"
            lines += "心率样本数量：${result.sampleCount}"

            if (result.samples.isEmpty()) {
                lines += emptyResultHints()
                return lines
            }

            lines += sampleStats(result.samples)
            lines += "前10个样本："
            result.samples.take(10).forEach {
                lines += "${HealthConnectFormat.instant(it.time)} -> ${it.bpm} bpm"
            }
        }.onFailure { error ->
            lines += "读取失败：${error.javaClass.simpleName}: ${error.message}"
        }

        return lines
    }

    private fun sampleStats(samples: List<HealthConnectHeartRateSample>): List<String> {
        val min = samples.minOf { it.bpm }
        val max = samples.maxOf { it.bpm }
        val avg = samples.map { it.bpm }.average()
        return listOf(
            "最低心率：$min bpm",
            "最高心率：$max bpm",
            String.format(Locale.US, "平均心率：%.1f bpm", avg),
            "最近一条：${HealthConnectFormat.instant(samples.last().time)} -> ${samples.last().bpm} bpm"
        )
    }

    private fun emptyResultHints(): List<String> {
        return listOf(
            "没有读到心率样本。可能原因：",
            "1. 小米运动健康没有写入 Health Connect。",
            "2. Health Connect 里没有给小米运动健康写入权限。",
            "3. Health Connect 里没有给本测试 App 读取权限。",
            "4. 最近24小时手机未同步手环数据。"
        )
    }

}
