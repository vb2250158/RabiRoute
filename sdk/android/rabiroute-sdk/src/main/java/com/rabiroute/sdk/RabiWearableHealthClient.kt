package com.rabiroute.sdk

import org.json.JSONArray
import org.json.JSONObject

data class RabiWearableHealthPolicy(
    val enabled: Boolean = true,
    val heartRateHighBpm: Int = 120,
    val heartRateLowBpm: Int = 0,
    val heartRateAlertCooldownMinutes: Int = 15,
    val sleepStateAlertEnabled: Boolean = false,
    val heartRateStaleAfterMinutes: Int = 15,
    val sleepStateStaleAfterMinutes: Int = 180
) {
    internal fun toJson(): JSONObject = JSONObject()
        .put("enabled", enabled)
        .put("heartRateHighBpm", heartRateHighBpm.coerceIn(40, 240))
        .put("heartRateLowBpm", heartRateLowBpm.coerceIn(0, 150))
        .put("heartRateAlertCooldownMinutes", heartRateAlertCooldownMinutes.coerceIn(1, 1440))
        .put("sleepStateAlertEnabled", sleepStateAlertEnabled)
        .put("heartRateStaleAfterMinutes", heartRateStaleAfterMinutes.coerceIn(1, 1440))
        .put("sleepStateStaleAfterMinutes", sleepStateStaleAfterMinutes.coerceIn(1, 2880))
}

data class RabiWearableHealthSample(
    val id: String,
    val metric: String,
    val recordedAt: String,
    val startAt: String = recordedAt,
    val endAt: String = "",
    val value: Int? = null,
    val sleepState: String = "",
    val sleepStage: String = "",
    val source: String = "health-connect"
) {
    internal fun toJson(): JSONObject = JSONObject()
        .put("id", id)
        .put("metric", metric)
        .put("recordedAt", recordedAt)
        .put("startAt", startAt)
        .apply {
            if (endAt.isNotBlank()) put("endAt", endAt)
            if (value != null) {
                put("value", value)
                put("unit", "bpm")
            }
            if (sleepState.isNotBlank()) put("sleepState", sleepState)
            if (sleepStage.isNotBlank()) put("sleepStage", sleepStage)
            if (source.isNotBlank()) put("source", source)
        }
}

class RabiWearableHealthClient(
    private val sdk: RabiRouteSdk = RabiRouteSdk()
) {
    fun publish(
        relayBaseUrl: String,
        token: String,
        sourceDeviceId: String,
        sourceDeviceKind: String,
        sourceDeviceName: String,
        samples: List<RabiWearableHealthSample>,
        policy: RabiWearableHealthPolicy,
        clientMessageId: String = "wearable-health-${System.currentTimeMillis()}",
        capturedAt: Long = System.currentTimeMillis(),
        transport: String = "phone-companion"
    ): RabiLinkPortableObservationReceipt {
        require(samples.isNotEmpty()) { "Wearable health observation requires at least one sample." }
        val payload = JSONObject()
            .put("text", observationSummary(samples))
            .put("type", "wearable.health")
            .put("deliveryMode", "observe")
            .put("source", "rabilink-wearable")
            .put("sourceDeviceId", sourceDeviceId)
            .put("sourceDeviceKind", sourceDeviceKind)
            .put("sourceDeviceName", sourceDeviceName)
            .put("transport", transport)
            .put("clientMessageId", clientMessageId)
            .put("capturedAt", capturedAt)
            .put(
                "health",
                JSONObject()
                    .put("schemaVersion", 1)
                    .put("policy", policy.toJson())
                    .put("samples", JSONArray(samples.map { it.toJson() }))
            )
        val json = sdk.requestJson(
            "${relayBaseUrl.trimEnd('/')}/api/rabilink/devices/input",
            "POST",
            payload.toString(),
            mapOf("X-RabiLink-Token" to token),
            readTimeoutMs = 10000
        )
        return RabiLinkPortableObservationReceipt(
            eventId = json.optString("eventId"),
            status = json.optString("status"),
            cursor = json.optString("nextCursor", json.optString("cursor")),
            acceptedAt = json.optLong("acceptedAt"),
            rawJson = json
        )
    }

    private fun observationSummary(samples: List<RabiWearableHealthSample>): String {
        val heartRates = samples.mapNotNull { sample -> sample.value?.takeIf { sample.metric == "heart_rate" } }
        val sleepSessions = samples.count { it.metric == "sleep_session" }
        return buildList {
            add("智能手表/手环健康数据 ${samples.size} 条")
            if (heartRates.isNotEmpty()) add("最近心率 ${heartRates.last()} bpm")
            if (sleepSessions > 0) add("睡眠记录 $sleepSessions 条")
        }.joinToString("，")
    }
}
