package com.rabi.link.modules.wearable

import android.app.Instrumentation
import android.os.Bundle
import android.util.Log
import kotlinx.coroutines.runBlocking

/**
 * 真机验证：[WearableHealthCollector.collect] 能否从 Health Connect 读出步数，
 * 并按本地自然日聚合成「一天一条」。用于人工验收，不是常规 CI 用例。
 *
 * 跑法（需设备已授权 Health Connect 步数，且 HC 里有步数数据）：
 *   adb shell am instrument -w -e class com.rabi.link.modules.wearable.WearableHealthCollectorInstrumentation \
 *     com.rabi.link.test/com.rabi.link.modules.wearable.WearableHealthCollectorInstrumentation
 */
class WearableHealthCollectorInstrumentation : Instrumentation() {
    private val tag = "RabiWearableAccept"
    private var startArguments: Bundle? = null

    override fun onCreate(arguments: Bundle?) {
        super.onCreate(arguments)
        startArguments = arguments
        start()
    }

    override fun onStart() {
        super.onStart()
        val result = Bundle()
        runCatching {
            val lookbackHours = startArguments?.getString("lookback_hours")?.toLongOrNull() ?: 24L * 7
            val now = System.currentTimeMillis()
            val stored = WearableHealthSettings.load(targetContext)
            val config = stored.copy(
                collectorMode = WearableHealthCollectorMode.HEALTH_CONNECT,
                lookbackHours = lookbackHours.coerceIn(1, 168).toInt()
            )

            Log.i(tag, "开始采集：来源=${config.collectorMode}，回溯 $lookbackHours 小时")
            val windowStart = now - lookbackHours * 3_600_000L
            val samples = runBlocking {
                WearableHealthCollector.collect(
                    targetContext,
                    config,
                    windowStart,
                    now
                )
            }

            val steps = samples.filter { it.metric == "steps" }
            Log.i(tag, "采集到样本总数：${samples.size}")
            Log.i(tag, "步数样本数量：${steps.size}")
            steps.forEach { s ->
                Log.i(tag, "步数样本：id=${s.id} 值=${s.value} 单位=${s.unit} " +
                    "记录于=${s.recordedAt} 起=${s.startAt} 止=${s.endAt}")
            }

            result.putInt("sample_count", samples.size)
            result.putInt("steps_sample_count", steps.size)
            result.putString("steps_ids", steps.joinToString("; ") { it.id })
            result.putString("steps_values", steps.joinToString("; ") { "${it.value}" })
            result.putString("steps_units", steps.joinToString("; ") { it.unit })

            // 断言一：步数样本必须是「一天一条」，而不是每段一条
            val distinctDays = steps.map { it.id.substringAfterLast('-') }.distinct()
            result.putBoolean("one_sample_per_day", steps.size == distinctDays.size)
            Log.i(tag, "一天一条：${steps.size == distinctDays.size}（样本 ${steps.size} / 天 ${distinctDays.size}）")

            // 断言二：ID 只含日期，重复读取必须完全一致
            val secondPass = runBlocking {
                WearableHealthCollector.collect(
                    targetContext,
                    config,
                    windowStart,
                    now
                )
            }.filter { it.metric == "steps" }
            val stable = secondPass.map { it.id } == steps.map { it.id } &&
                secondPass.map { it.value } == steps.map { it.value }
            result.putBoolean("stable_ids_and_values", stable)
            Log.i(tag, "重复读取 ID 与数值一致：$stable")

            // 断言三：单位必须是 count，不能是 bpm
            val unitOk = steps.all { it.unit == "count" }
            result.putBoolean("unit_is_count", unitOk)
            Log.i(tag, "单位全为 count：$unitOk")
        }.onFailure { error ->
            result.putString("error", "${error.javaClass.simpleName}: ${error.message}")
            Log.e(tag, "验收失败：${error.javaClass.simpleName}: ${error.message}", error)
        }
        finish(0, result)
    }
}
