package com.rabi.link.modules.wearable

import android.content.Context
import com.rabiroute.sdk.RabiWearableHealthPolicy

enum class WearableHealthCollectorMode(val storageValue: String) {
    HEALTH_CONNECT("health_connect"),
    XIAOMI_ADB_COMPANION("xiaomi_adb_companion");

    companion object {
        fun fromStorage(value: String?): WearableHealthCollectorMode = entries.firstOrNull {
            it.storageValue == value?.trim()?.lowercase()
        } ?: HEALTH_CONNECT
    }
}

data class WearableHealthConfig(
    val enabled: Boolean,
    val collectorMode: WearableHealthCollectorMode,
    val sourceDeviceId: String,
    val sourceDeviceName: String,
    val sourceDeviceKind: String,
    val pollIntervalMinutes: Int,
    val lookbackHours: Int,
    val policy: RabiWearableHealthPolicy,
    val hasAuthKey: Boolean
)

object WearableHealthSettings {
    private const val PREFS = "rabilink_wearable_health"
    private const val SECRET_AUTH_KEY = "xiaomi_auth_key"
    private val authKeyPattern = Regex("^[0-9a-fA-F]{32}$")

    @JvmStatic
    fun load(context: Context): WearableHealthConfig {
        val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        return WearableHealthConfig(
            enabled = prefs.getBoolean("enabled", false),
            collectorMode = WearableHealthCollectorMode.fromStorage(prefs.getString("collectorMode", null)),
            sourceDeviceId = prefs.getString("sourceDeviceId", "").orEmpty().trim(),
            sourceDeviceName = prefs.getString("sourceDeviceName", "").orEmpty().trim(),
            sourceDeviceKind = prefs.getString("sourceDeviceKind", "wearable").orEmpty().trim().ifBlank { "wearable" },
            pollIntervalMinutes = prefs.getInt("pollIntervalMinutes", 5).coerceIn(1, 1440),
            lookbackHours = prefs.getInt("lookbackHours", 24).coerceIn(1, 168),
            policy = RabiWearableHealthPolicy(
                enabled = prefs.getBoolean("policyEnabled", true),
                heartRateHighBpm = prefs.getInt("heartRateHighBpm", 120).coerceIn(40, 240),
                heartRateLowBpm = prefs.getInt("heartRateLowBpm", 0).coerceIn(0, 150),
                heartRateAlertCooldownMinutes = prefs.getInt("heartRateAlertCooldownMinutes", 15).coerceIn(1, 1440),
                sleepStateAlertEnabled = prefs.getBoolean("sleepStateAlertEnabled", false),
                heartRateStaleAfterMinutes = prefs.getInt("heartRateStaleAfterMinutes", 15).coerceIn(1, 1440),
                sleepStateStaleAfterMinutes = prefs.getInt("sleepStateStaleAfterMinutes", 180).coerceIn(1, 2880)
            ),
            hasAuthKey = authKey(context).isNotBlank()
        )
    }

    @JvmStatic
    fun save(context: Context, config: WearableHealthConfig, authKey: String? = null) {
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            .edit()
            .putBoolean("enabled", config.enabled)
            .putString("collectorMode", config.collectorMode.storageValue)
            .putString("sourceDeviceId", config.sourceDeviceId.trim())
            .putString("sourceDeviceName", config.sourceDeviceName.trim())
            .putString("sourceDeviceKind", config.sourceDeviceKind.trim().lowercase())
            .putInt("pollIntervalMinutes", config.pollIntervalMinutes.coerceIn(1, 1440))
            .putInt("lookbackHours", config.lookbackHours.coerceIn(1, 168))
            .putBoolean("policyEnabled", config.policy.enabled)
            .putInt("heartRateHighBpm", config.policy.heartRateHighBpm.coerceIn(40, 240))
            .putInt("heartRateLowBpm", config.policy.heartRateLowBpm.coerceIn(0, 150))
            .putInt("heartRateAlertCooldownMinutes", config.policy.heartRateAlertCooldownMinutes.coerceIn(1, 1440))
            .putBoolean("sleepStateAlertEnabled", config.policy.sleepStateAlertEnabled)
            .putInt("heartRateStaleAfterMinutes", config.policy.heartRateStaleAfterMinutes.coerceIn(1, 1440))
            .putInt("sleepStateStaleAfterMinutes", config.policy.sleepStateStaleAfterMinutes.coerceIn(1, 2880))
            .apply()
        if (authKey != null && authKey.isNotBlank()) {
            val normalized = authKey.trim()
            require(authKeyPattern.matches(normalized)) { "小米手表/手环密钥必须是 32 位十六进制。" }
            SecureSecretStore.write(context, SECRET_AUTH_KEY, normalized.lowercase())
        }
    }

    @JvmStatic
    fun authKey(context: Context): String = SecureSecretStore.read(context, SECRET_AUTH_KEY)

    @JvmStatic
    fun clearAuthKey(context: Context) = SecureSecretStore.write(context, SECRET_AUTH_KEY, "")

    @JvmStatic
    fun saveLastStatus(context: Context, status: String, atMillis: Long = System.currentTimeMillis()) {
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            .edit()
            .putString("lastStatus", status.take(500))
            .putLong("lastStatusAt", atMillis)
            .apply()
    }

    @JvmStatic
    fun lastStatus(context: Context): Pair<String, Long> {
        val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        return prefs.getString("lastStatus", "尚未同步").orEmpty() to prefs.getLong("lastStatusAt", 0L)
    }
}
