package com.rabi.link.modules.wearable

import android.app.Instrumentation
import android.os.Bundle
import android.util.Log
import com.rabiroute.sdk.RabiWearableHealthPolicy
import com.rabiroute.sdk.RabiWearableHealthSample

/**
 * 真机验证 [WearableHealthOutbox] 的写入/回读往返不串位。
 *
 * 重点回归：过去 [WearableHealthOutbox.pending] 用「位置参数」重建样本，
 * 一旦样本新增字段（如 unit），后续字段会静默错位。此用例锁住命名参数行为。
 */
class WearableHealthOutboxInstrumentation : Instrumentation() {
    private val tag = "RabiOutboxAccept"

    override fun onCreate(arguments: Bundle?) {
        super.onCreate(arguments)
        start()
    }

    override fun onStart() {
        super.onStart()
        val result = Bundle()
        runCatching {
            val outbox = WearableHealthOutbox(targetContext)
            val config = WearableHealthConfig(
                enabled = true,
                collectorMode = WearableHealthCollectorMode.HEALTH_CONNECT,
                sourceDeviceId = "accept-device",
                sourceDeviceName = "验收设备",
                sourceDeviceKind = "wearable",
                lookbackHours = 24,
                policy = RabiWearableHealthPolicy(
                    enabled = true, heartRateHighBpm = 120, heartRateLowBpm = 45,
                    heartRateAlertCooldownMinutes = 30, sleepStateAlertEnabled = true,
                    heartRateStaleAfterMinutes = 60, sleepStateStaleAfterMinutes = 60
                ),
                hasAuthKey = false
            )

            val day = "2026-09-16"
            val written = listOf(
                RabiWearableHealthSample(
                    id = "health-connect-steps-$day",
                    metric = "steps",
                    recordedAt = "${day}T11:55:00Z",
                    startAt = "${day}T00:00:00Z",
                    endAt = "${day}T11:55:00Z",
                    value = 8420,
                    unit = "count",
                    source = "health-connect"
                ),
                RabiWearableHealthSample(
                    id = "health-connect-sleep-state-awake-1",
                    metric = "sleep_state",
                    recordedAt = "${day}T07:00:00Z",
                    sleepState = "awake",
                    source = "health-connect"
                ),
                RabiWearableHealthSample(
                    id = "health-connect-heart-1",
                    metric = "heart_rate",
                    recordedAt = "${day}T08:00:00Z",
                    value = 68,
                    unit = "bpm",
                    source = "health-connect"
                )
            )

            outbox.save(config, written, "http://accept.local:1", 1L, "", "local_only", "route-accept", "worker-accept")
            val read = outbox.pending()
                .flatMap { it.samples }
                .filter { it.id in written.map { w -> w.id } }
                .associateBy { it.id }

            result.putInt("written_count", written.size)
            result.putInt("read_count", read.size)

            val steps = read["health-connect-steps-$day"]
            result.putString("steps_unit", steps?.unit.orEmpty())
            result.putInt("steps_value", steps?.value ?: -1)
            // 关键断言：unit 不能落进 sleepState 槽；sleepState 必须保持 "awake"
            result.putString("steps_sleep_state", steps?.sleepState.orEmpty())

            val sleepState = read["health-connect-sleep-state-awake-1"]
            result.putString("sleep_state_field", sleepState?.sleepState.orEmpty())
            result.putString("sleep_state_unit", sleepState?.unit.orEmpty())

            val heart = read["health-connect-heart-1"]
            result.putString("heart_unit", heart?.unit.orEmpty())
            result.putInt("heart_value", heart?.value ?: -1)

            val ok = steps?.unit == "count" && steps.value == 8420 && steps.sleepState == "" &&
                sleepState?.sleepState == "awake" && heart?.unit == "bpm"
            result.putBoolean("roundtrip_ok", ok)
            Log.i(tag, "往返写入 ${written.size} 条，回读 ${read.size} 条，字段对齐：$ok")
            Log.i(tag, "步数 unit=${steps?.unit} value=${steps?.value} sleepState='${steps?.sleepState}'")
            Log.i(tag, "睡眠睡态 sleepState='${sleepState?.sleepState}' unit='${sleepState?.unit}'")
            Log.i(tag, "心率 unit=${heart?.unit} value=${heart?.value}")

            // 清理本次验收产生的队列文件
            outbox.pending().filter { it.routeProfileId == "route-accept" }.forEach { outbox.ack(it) }
            Log.i(tag, "已清理验收队列条目")
        }.onFailure { error ->
            result.putString("error", "${error.javaClass.simpleName}: ${error.message}")
            Log.e(tag, "验收失败：${error.javaClass.simpleName}: ${error.message}", error)
        }
        finish(0, result)
    }
}
