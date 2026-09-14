package com.rabi.link.modules.xiaomi

import android.content.Context
import android.content.Intent

internal data class MiHealthCloudProbeRequest(
    val appId: String,
    val accessToken: String,
    val dataUrl: String,
    val dataTypeNames: List<String>,
    val hours: Long,
    val sliceHours: Long,
    val limit: Int,
    val maxPages: Int,
    val requestTimeoutSeconds: Long,
    val autoSaveZip: Boolean
) {
    companion object {
        private const val DEFAULT_DATA_URL = "https://data.micloud.xiaomi.net"

        private const val ALL_SDK_DATA_TYPES =
            "com.xiaomi.micloud.fit.step_count.delta," +
                "com.xiaomi.micloud.fit.step_count.cumulative," +
                "com.xiaomi.micloud.fit.step_count.cadence," +
                "com.xiaomi.micloud.fit.activity.segment," +
                "com.xiaomi.micloud.fit.calories.consumed," +
                "com.xiaomi.micloud.fit.calories.expended," +
                "com.xiaomi.micloud.fit.calories.bmr," +
                "com.xiaomi.micloud.fit.power.sample," +
                "com.xiaomi.micloud.fit.activity.sample," +
                "com.xiaomi.micloud.fit.heart_rate.bpm," +
                "com.xiaomi.micloud.fit.location.sample," +
                "com.xiaomi.micloud.fit.location.track," +
                "com.xiaomi.micloud.fit.distance.delta," +
                "com.xiaomi.micloud.fit.distance.cumulative," +
                "com.xiaomi.micloud.fit.speed," +
                "com.xiaomi.micloud.fit.cycling.wheel_revolution.cumulative," +
                "com.xiaomi.micloud.fit.cycling.wheel_revolution.rpm," +
                "com.xiaomi.micloud.fit.cycling.pedaling.cumulative," +
                "com.xiaomi.micloud.fit.cycling.pedaling.cadence," +
                "com.xiaomi.micloud.fit.height," +
                "com.xiaomi.micloud.fit.weight," +
                "com.xiaomi.micloud.fit.body.fat.percentage," +
                "com.xiaomi.micloud.fit.activity.summary," +
                "com.xiaomi.micloud.fit.calories.bmr.summary," +
                "com.xiaomi.micloud.fit.distance.delta," +
                "com.xiaomi.micloud.fit.calories.consumed," +
                "com.xiaomi.micloud.fit.calories.expended," +
                "com.xiaomi.micloud.fit.heart_rate.summary," +
                "com.xiaomi.micloud.fit.location.bounding_box," +
                "com.xiaomi.micloud.fit.power.summary," +
                "com.xiaomi.micloud.fit.speed.summary," +
                "com.xiaomi.micloud.fit.body.fat.percentage.summary," +
                "com.xiaomi.micloud.fit.weight.summary"

        fun from(context: Context, intent: Intent): MiHealthCloudProbeRequest {
            val prefs = MiHealthCloudArtifacts.prefs(context)
            return MiHealthCloudProbeRequest(
                appId = intent.getStringExtra(MiHealthCloudContract.EXTRA_APP_ID)
                    ?: prefs.getString(MiHealthCloudContract.KEY_APP_ID, "").orEmpty(),
                accessToken = intent.getStringExtra(MiHealthCloudContract.EXTRA_ACCESS_TOKEN)
                    ?: prefs.getString(MiHealthCloudContract.KEY_ACCESS_TOKEN, "").orEmpty(),
                dataUrl = intent.getStringExtra("data_url") ?: DEFAULT_DATA_URL,
                dataTypeNames = readDataTypeNames(intent),
                hours = intent.getLongExtra(MiHealthCloudContract.EXTRA_HOURS, 24L).coerceAtLeast(1L),
                sliceHours = intent.getLongExtra(MiHealthCloudContract.EXTRA_SLICE_HOURS, 0L).coerceAtLeast(0L),
                limit = intent.getIntExtra(MiHealthCloudContract.EXTRA_LIMIT, 500).coerceIn(1, 5000),
                maxPages = intent.getIntExtra(MiHealthCloudContract.EXTRA_MAX_PAGES, 20).coerceIn(1, 200),
                requestTimeoutSeconds = intent.getLongExtra(
                    MiHealthCloudContract.EXTRA_REQUEST_TIMEOUT_SECONDS,
                    30L
                ).coerceIn(5L, 180L),
                autoSaveZip = intent.getBooleanExtra(MiHealthCloudContract.EXTRA_AUTO_SAVE_ZIP, false)
            )
        }

        private fun readDataTypeNames(intent: Intent): List<String> {
            val raw = intent.getStringExtra(MiHealthCloudContract.EXTRA_DATA_TYPES)
                ?: intent.getStringExtra("data_type")
                ?: MiHealthCloudContract.DEFAULT_HEART_RATE_DATA_TYPES
            if (raw.trim().equals(MiHealthCloudContract.ALL_SDK_DATA_TYPES_SENTINEL, ignoreCase = true)) {
                return ALL_SDK_DATA_TYPES.split(',')
            }
            return raw.split(',', ';', '\n')
                .map { it.trim() }
                .filter { it.isNotBlank() }
                .distinct()
                .ifEmpty { MiHealthCloudContract.DEFAULT_HEART_RATE_DATA_TYPES.split(',') }
        }
    }
}
