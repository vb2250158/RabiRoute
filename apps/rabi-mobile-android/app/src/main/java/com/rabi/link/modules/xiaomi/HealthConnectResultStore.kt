package com.rabi.link.modules.xiaomi

import android.content.Context
import org.json.JSONObject
import java.io.File
import java.time.Instant

internal class HealthConnectResultStore(
    context: Context,
    private val log: (String) -> Unit
) {
    private val heartRateResultFile = File(context.getExternalFilesDir(null), HEART_RATE_RESULT_FILE)

    fun saveHeartRateResult(result: JSONObject) {
        runCatching {
            heartRateResultFile.parentFile?.mkdirs()
            result.put("writtenAt", Instant.now().toString())
            heartRateResultFile.writeText(result.toString(2))
            log("心率 JSON 已保存：${heartRateResultFile.absolutePath}")
        }.onFailure { error ->
            log("保存心率 JSON 失败：${error.javaClass.simpleName}: ${error.message}")
        }
    }

    private companion object {
        const val HEART_RATE_RESULT_FILE = "health-connect-heart-rate.json"
    }
}
