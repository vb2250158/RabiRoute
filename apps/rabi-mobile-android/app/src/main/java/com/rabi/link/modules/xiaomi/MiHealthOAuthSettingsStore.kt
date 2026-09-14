package com.rabi.link.modules.xiaomi

import android.content.Context
import android.content.Intent

internal data class MiHealthOAuthSettings(
    val appId: String,
    val accessToken: String,
    val redirectUri: String,
    val scope: String,
    val dataTypes: String,
    val hours: Long,
    val sliceHours: Long,
    val limit: Int,
    val maxPages: Int
)

internal class MiHealthOAuthSettingsStore(private val context: Context) {
    private val prefs = context.getSharedPreferences(MiHealthCloudContract.PREFS, Context.MODE_PRIVATE)

    fun initialSettings(intent: Intent): MiHealthOAuthSettings {
        return MiHealthOAuthSettings(
            appId = intent.getStringExtra(MiHealthCloudContract.EXTRA_APP_ID)
                ?: prefs.getString(MiHealthCloudContract.KEY_APP_ID, "").orEmpty(),
            accessToken = intent.getStringExtra(MiHealthCloudContract.EXTRA_ACCESS_TOKEN)
                ?: prefs.getString(MiHealthCloudContract.KEY_ACCESS_TOKEN, "").orEmpty(),
            redirectUri = intent.getStringExtra(MiHealthCloudContract.KEY_REDIRECT_URI)
                ?: prefs.getString(MiHealthCloudContract.KEY_REDIRECT_URI, MiHealthCloudContract.DEFAULT_REDIRECT_URI).orEmpty(),
            scope = intent.getStringExtra(MiHealthCloudContract.KEY_SCOPE)
                ?: prefs.getString(MiHealthCloudContract.KEY_SCOPE, "").orEmpty(),
            dataTypes = intent.getStringExtra(MiHealthCloudContract.EXTRA_DATA_TYPES)
                ?: prefs.getString(MiHealthCloudContract.KEY_DATA_TYPES, MiHealthCloudContract.DEFAULT_HEART_RATE_DATA_TYPES).orEmpty(),
            hours = intent.getLongExtra(MiHealthCloudContract.EXTRA_HOURS, prefs.getLong(MiHealthCloudContract.KEY_HOURS, 24L)),
            sliceHours = intent.getLongExtra(MiHealthCloudContract.EXTRA_SLICE_HOURS, prefs.getLong(MiHealthCloudContract.KEY_SLICE_HOURS, 0L)),
            limit = intent.getIntExtra(MiHealthCloudContract.EXTRA_LIMIT, prefs.getInt(MiHealthCloudContract.KEY_LIMIT, 500)),
            maxPages = intent.getIntExtra(MiHealthCloudContract.EXTRA_MAX_PAGES, prefs.getInt(MiHealthCloudContract.KEY_MAX_PAGES, 20))
        )
    }

    fun saveAuthorizationRequest(settings: MiHealthOAuthSettings, state: String) {
        prefs.edit()
            .putString(MiHealthCloudContract.KEY_APP_ID, settings.appId)
            .putString(MiHealthCloudContract.KEY_REDIRECT_URI, settings.redirectUri)
            .putString(MiHealthCloudContract.KEY_SCOPE, settings.scope)
            .putString(MiHealthCloudContract.KEY_DATA_TYPES, settings.dataTypes)
            .putLong(MiHealthCloudContract.KEY_HOURS, settings.hours)
            .putLong(MiHealthCloudContract.KEY_SLICE_HOURS, settings.sliceHours)
            .putInt(MiHealthCloudContract.KEY_LIMIT, settings.limit)
            .putInt(MiHealthCloudContract.KEY_MAX_PAGES, settings.maxPages)
            .putString(MiHealthCloudContract.KEY_STATE, state)
            .apply()
    }

    fun expectedState(): String {
        return prefs.getString(MiHealthCloudContract.KEY_STATE, "").orEmpty()
    }

    fun saveCallbackToken(callbackParams: Map<String, String>, accessToken: String) {
        prefs.edit()
            .putString(MiHealthCloudContract.KEY_ACCESS_TOKEN, accessToken)
            .putString(MiHealthCloudContract.KEY_TOKEN_TYPE, callbackParams["token_type"].orEmpty())
            .putString(MiHealthCloudContract.KEY_SCOPE, callbackParams["scope"] ?: prefs.getString(MiHealthCloudContract.KEY_SCOPE, ""))
            .putLong(MiHealthCloudContract.KEY_TOKEN_SAVED_AT, System.currentTimeMillis())
            .apply()
    }

    fun saveManualToken(settings: MiHealthOAuthSettings) {
        prefs.edit()
            .putString(MiHealthCloudContract.KEY_APP_ID, settings.appId)
            .putString(MiHealthCloudContract.KEY_ACCESS_TOKEN, settings.accessToken)
            .putString(MiHealthCloudContract.KEY_DATA_TYPES, settings.dataTypes)
            .putLong(MiHealthCloudContract.KEY_HOURS, settings.hours)
            .putLong(MiHealthCloudContract.KEY_SLICE_HOURS, settings.sliceHours)
            .putInt(MiHealthCloudContract.KEY_LIMIT, settings.limit)
            .putInt(MiHealthCloudContract.KEY_MAX_PAGES, settings.maxPages)
            .putLong(MiHealthCloudContract.KEY_TOKEN_SAVED_AT, System.currentTimeMillis())
            .apply()
    }

    fun settingsWithSavedCredentials(settings: MiHealthOAuthSettings): MiHealthOAuthSettings {
        return settings.copy(
            appId = settings.appId.ifBlank { prefs.getString(MiHealthCloudContract.KEY_APP_ID, "").orEmpty() },
            accessToken = settings.accessToken.ifBlank { prefs.getString(MiHealthCloudContract.KEY_ACCESS_TOKEN, "").orEmpty() }
        )
    }

    fun saveProbeSettings(settings: MiHealthOAuthSettings) {
        prefs.edit()
            .putString(MiHealthCloudContract.KEY_APP_ID, settings.appId)
            .putString(MiHealthCloudContract.KEY_ACCESS_TOKEN, settings.accessToken)
            .putLong(MiHealthCloudContract.KEY_TOKEN_SAVED_AT, System.currentTimeMillis())
            .putString(MiHealthCloudContract.KEY_DATA_TYPES, settings.dataTypes)
            .putLong(MiHealthCloudContract.KEY_HOURS, settings.hours)
            .putLong(MiHealthCloudContract.KEY_SLICE_HOURS, settings.sliceHours)
            .putInt(MiHealthCloudContract.KEY_LIMIT, settings.limit)
            .putInt(MiHealthCloudContract.KEY_MAX_PAGES, settings.maxPages)
            .apply()
    }

    fun buildProbeIntent(settings: MiHealthOAuthSettings, requestTimeoutSeconds: Long): Intent {
        return Intent(context, MiHealthCloudProbeService::class.java).apply {
            putExtra(MiHealthCloudContract.EXTRA_APP_ID, settings.appId)
            putExtra(MiHealthCloudContract.EXTRA_ACCESS_TOKEN, settings.accessToken)
            putExtra(MiHealthCloudContract.EXTRA_DATA_TYPES, settings.dataTypes)
            putExtra(MiHealthCloudContract.EXTRA_HOURS, settings.hours)
            putExtra(MiHealthCloudContract.EXTRA_SLICE_HOURS, settings.sliceHours)
            putExtra(MiHealthCloudContract.EXTRA_LIMIT, settings.limit)
            putExtra(MiHealthCloudContract.EXTRA_MAX_PAGES, settings.maxPages)
            putExtra(MiHealthCloudContract.EXTRA_AUTO_SAVE_ZIP, true)
            putExtra(MiHealthCloudContract.EXTRA_REQUEST_TIMEOUT_SECONDS, requestTimeoutSeconds)
        }
    }

    fun clearToken() {
        prefs.edit()
            .remove(MiHealthCloudContract.KEY_ACCESS_TOKEN)
            .remove(MiHealthCloudContract.KEY_TOKEN_TYPE)
            .remove(MiHealthCloudContract.KEY_TOKEN_SAVED_AT)
            .apply()
    }

    fun statusText(): String {
        val token = prefs.getString(MiHealthCloudContract.KEY_ACCESS_TOKEN, "").orEmpty()
        val savedAt = prefs.getLong(MiHealthCloudContract.KEY_TOKEN_SAVED_AT, 0L)
        return buildString {
            append("状态：")
            append(if (token.isBlank()) "未保存 token" else "已保存 token，长度=${token.length}")
            if (savedAt > 0L) {
                append("\n保存时间戳：").append(savedAt)
            }
            append("\n默认回调：").append(MiHealthCloudContract.DEFAULT_REDIRECT_URI)
            append("\n当前数据类型：").append(prefs.getString(MiHealthCloudContract.KEY_DATA_TYPES, MiHealthCloudContract.DEFAULT_HEART_RATE_DATA_TYPES))
            append("\n当前拉取范围：").append(prefs.getLong(MiHealthCloudContract.KEY_HOURS, 24L)).append(" 小时")
            append("\n当前分片：").append(prefs.getLong(MiHealthCloudContract.KEY_SLICE_HOURS, 0L)).append(" 小时")
            append("\n注意：小米开放平台里的 redirect_uri 必须和这里一致。")
        }
    }
}
