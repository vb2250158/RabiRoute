package com.rabiroute.bandprobe

import android.app.Activity
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.text.InputType
import android.util.Log
import android.widget.Button
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import android.widget.Toast
import java.net.URLEncoder
import java.nio.charset.StandardCharsets
import java.util.UUID

class MiHealthOAuthActivity : Activity() {
    private lateinit var appIdInput: EditText
    private lateinit var tokenInput: EditText
    private lateinit var redirectInput: EditText
    private lateinit var scopeInput: EditText
    private lateinit var dataTypesInput: EditText
    private lateinit var hoursInput: EditText
    private lateinit var sliceHoursInput: EditText
    private lateinit var limitInput: EditText
    private lateinit var maxPagesInput: EditText
    private lateinit var statusView: TextView

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        buildUi()
        handleCallback(intent)
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        handleCallback(intent)
    }

    private fun buildUi() {
        val prefs = getSharedPreferences(PREFS, MODE_PRIVATE)
        val root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(32, 32, 32, 32)
        }

        root.addView(TextView(this).apply {
            text = "小米健康云 OAuth"
            textSize = 20f
        })

        appIdInput = EditText(this).apply {
            hint = "小米开放平台 AppID"
            inputType = InputType.TYPE_CLASS_TEXT
            setText(intent.getStringExtra("app_id") ?: prefs.getString(KEY_APP_ID, ""))
        }
        root.addView(appIdInput)

        tokenInput = EditText(this).apply {
            hint = "access_token，可手动粘贴"
            inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_VISIBLE_PASSWORD
            setSingleLine(false)
            minLines = 2
            setText(intent.getStringExtra("access_token") ?: prefs.getString(KEY_ACCESS_TOKEN, ""))
        }
        root.addView(tokenInput)

        redirectInput = EditText(this).apply {
            hint = "OAuth redirect_uri，必须和小米开放平台配置一致"
            inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_URI
            setText(intent.getStringExtra("redirect_uri") ?: prefs.getString(KEY_REDIRECT_URI, DEFAULT_REDIRECT_URI))
        }
        root.addView(redirectInput)

        scopeInput = EditText(this).apply {
            hint = "scope，可留空使用应用已授权范围"
            inputType = InputType.TYPE_CLASS_TEXT
            setText(intent.getStringExtra("scope") ?: prefs.getString(KEY_SCOPE, ""))
        }
        root.addView(scopeInput)

        dataTypesInput = EditText(this).apply {
            hint = "data_types，逗号分隔"
            inputType = InputType.TYPE_CLASS_TEXT
            setText(intent.getStringExtra("data_types") ?: prefs.getString(KEY_DATA_TYPES, DEFAULT_DATA_TYPES))
        }
        root.addView(dataTypesInput)

        hoursInput = EditText(this).apply {
            hint = "拉取最近多少小时，默认 24"
            inputType = InputType.TYPE_CLASS_NUMBER
            setText((intent.getLongExtra("hours", prefs.getLong(KEY_HOURS, 24L))).toString())
        }
        root.addView(hoursInput)

        sliceHoursInput = EditText(this).apply {
            hint = "分片小时，0 表示不分片；例如 24 表示按天拉"
            inputType = InputType.TYPE_CLASS_NUMBER
            setText((intent.getLongExtra("slice_hours", prefs.getLong(KEY_SLICE_HOURS, 0L))).toString())
        }
        root.addView(sliceHoursInput)

        limitInput = EditText(this).apply {
            hint = "每页条数，默认 500"
            inputType = InputType.TYPE_CLASS_NUMBER
            setText((intent.getIntExtra("limit", prefs.getInt(KEY_LIMIT, 500))).toString())
        }
        root.addView(limitInput)

        maxPagesInput = EditText(this).apply {
            hint = "最大页数，默认 20"
            inputType = InputType.TYPE_CLASS_NUMBER
            setText((intent.getIntExtra("max_pages", prefs.getInt(KEY_MAX_PAGES, 20))).toString())
        }
        root.addView(maxPagesInput)

        root.addView(Button(this).apply {
            text = "打开小米授权"
            setOnClickListener { openAuthorization() }
        })

        root.addView(Button(this).apply {
            text = "保存当前 token"
            setOnClickListener { saveManualToken() }
        })

        root.addView(Button(this).apply {
            text = "用已保存 token 拉取心率列表"
            setOnClickListener { startCloudProbeFromSavedToken() }
        })

        root.addView(Button(this).apply {
            text = "清除 token"
            setOnClickListener { clearToken() }
        })

        statusView = TextView(this).apply {
            textSize = 14f
            setPadding(0, 24, 0, 0)
        }
        root.addView(statusView)

        setContentView(ScrollView(this).apply { addView(root) })
        refreshStatus()
    }

    private fun openAuthorization() {
        val appId = appIdInput.text.toString().trim()
        val redirectUri = redirectInput.text.toString().trim()
        val scope = scopeInput.text.toString().trim()
        val dataTypes = readDataTypes()
        val hours = readHours()
        val sliceHours = readSliceHours()
        val limit = readLimit()
        val maxPages = readMaxPages()
        if (appId.isBlank() || redirectUri.isBlank()) {
            toast("需要 AppID 和 redirect_uri")
            return
        }

        val state = UUID.randomUUID().toString()
        getSharedPreferences(PREFS, MODE_PRIVATE).edit()
            .putString(KEY_APP_ID, appId)
            .putString(KEY_REDIRECT_URI, redirectUri)
            .putString(KEY_SCOPE, scope)
            .putString(KEY_DATA_TYPES, dataTypes)
            .putLong(KEY_HOURS, hours)
            .putLong(KEY_SLICE_HOURS, sliceHours)
            .putInt(KEY_LIMIT, limit)
            .putInt(KEY_MAX_PAGES, maxPages)
            .putString(KEY_STATE, state)
            .apply()

        val url = buildString {
            append("https://account.xiaomi.com/oauth2/authorize")
            append("?client_id=").append(enc(appId))
            append("&redirect_uri=").append(enc(redirectUri))
            append("&response_type=token")
            if (scope.isNotBlank()) {
                append("&scope=").append(enc(scope))
            }
            append("&state=").append(enc(state))
            append("&skip_confirm=false")
        }
        Log.i(TAG, "打开小米 OAuth 授权页，appId=$appId redirectUri=$redirectUri scope=$scope")
        startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url)))
    }

    private fun handleCallback(intent: Intent?) {
        val data = intent?.data ?: return
        if (data.scheme != "rabiroute-bandprobe") {
            return
        }

        val callbackParams = parseCallbackParams(data)
        val error = callbackParams["error"]
        if (!error.isNullOrBlank()) {
            val desc = callbackParams["error_description"].orEmpty()
            statusView.text = "授权失败：$error $desc"
            return
        }

        val accessToken = callbackParams["access_token"].orEmpty()
        if (accessToken.isBlank()) {
            statusView.text = "收到回调，但没有 access_token：$data"
            return
        }

        val prefs = getSharedPreferences(PREFS, MODE_PRIVATE)
        val expectedState = prefs.getString(KEY_STATE, "")
        val returnedState = callbackParams["state"].orEmpty()
        if (!expectedState.isNullOrBlank() && returnedState != expectedState) {
            statusView.text = "state 不一致，已拒绝保存 token。"
            return
        }

        prefs.edit()
            .putString(KEY_ACCESS_TOKEN, accessToken)
            .putString(KEY_TOKEN_TYPE, callbackParams["token_type"].orEmpty())
            .putString(KEY_SCOPE, callbackParams["scope"] ?: prefs.getString(KEY_SCOPE, ""))
            .putLong(KEY_TOKEN_SAVED_AT, System.currentTimeMillis())
            .apply()

        Log.i(TAG, "小米 OAuth token 已保存，token 长度=${accessToken.length}")
        tokenInput.setText(accessToken)
        toast("授权成功，开始拉取心率列表")
        refreshStatus()
        startCloudProbeFromSavedToken()
    }

    private fun parseCallbackParams(uri: Uri): Map<String, String> {
        val text = listOfNotNull(uri.fragment, uri.encodedQuery).joinToString("&")
        if (text.isBlank()) {
            return emptyMap()
        }
        return text.split("&")
            .mapNotNull { part ->
                val index = part.indexOf("=")
                if (index <= 0) {
                    null
                } else {
                    val key = Uri.decode(part.substring(0, index))
                    val value = Uri.decode(part.substring(index + 1))
                    key to value
                }
            }
            .toMap()
    }

    private fun startCloudProbeFromSavedToken() {
        val prefs = getSharedPreferences(PREFS, MODE_PRIVATE)
        val appId = appIdInput.text.toString().trim().ifBlank { prefs.getString(KEY_APP_ID, "").orEmpty() }
        val accessToken = tokenInput.text.toString().trim().ifBlank { prefs.getString(KEY_ACCESS_TOKEN, "").orEmpty() }
        if (appId.isBlank() || accessToken.isBlank()) {
            toast("还没有 AppID 或 token")
            refreshStatus()
            return
        }
        val hours = readHours()
        val sliceHours = readSliceHours()
        val limit = readLimit()
        val maxPages = readMaxPages()
        val dataTypes = readDataTypes()
        prefs.edit()
            .putString(KEY_APP_ID, appId)
            .putString(KEY_ACCESS_TOKEN, accessToken)
            .putLong(KEY_TOKEN_SAVED_AT, System.currentTimeMillis())
            .putString(KEY_DATA_TYPES, dataTypes)
            .putLong(KEY_HOURS, hours)
            .putLong(KEY_SLICE_HOURS, sliceHours)
            .putInt(KEY_LIMIT, limit)
            .putInt(KEY_MAX_PAGES, maxPages)
            .apply()

        val serviceIntent = Intent(this, MiHealthCloudProbeService::class.java).apply {
            putExtra("app_id", appId)
            putExtra("access_token", accessToken)
            putExtra("data_types", dataTypes)
            putExtra("hours", hours)
            putExtra("slice_hours", sliceHours)
            putExtra("limit", limit)
            putExtra("max_pages", maxPages)
            putExtra("auto_save_zip", true)
            putExtra("request_timeout_seconds", intent.getLongExtra("request_timeout_seconds", 30L))
        }
        if (Build.VERSION.SDK_INT >= 26) {
            startForegroundService(serviceIntent)
        } else {
            startService(serviceIntent)
        }
        statusView.text = "已触发云端心率列表拉取：$dataTypes，最近 ${hours} 小时，分片 ${sliceHours} 小时，每页 $limit 条，最多 $maxPages 页。完成后会自动保存 ZIP 到下载目录。"
    }

    private fun saveManualToken() {
        val token = tokenInput.text.toString().trim()
        val appId = appIdInput.text.toString().trim()
        if (token.isBlank()) {
            toast("token 为空")
            return
        }
        getSharedPreferences(PREFS, MODE_PRIVATE).edit()
            .putString(KEY_APP_ID, appId)
            .putString(KEY_ACCESS_TOKEN, token)
            .putString(KEY_DATA_TYPES, readDataTypes())
            .putLong(KEY_HOURS, readHours())
            .putLong(KEY_SLICE_HOURS, readSliceHours())
            .putInt(KEY_LIMIT, readLimit())
            .putInt(KEY_MAX_PAGES, readMaxPages())
            .putLong(KEY_TOKEN_SAVED_AT, System.currentTimeMillis())
            .apply()
        toast("token 已保存")
        refreshStatus()
    }

    private fun clearToken() {
        getSharedPreferences(PREFS, MODE_PRIVATE).edit()
            .remove(KEY_ACCESS_TOKEN)
            .remove(KEY_TOKEN_TYPE)
            .remove(KEY_TOKEN_SAVED_AT)
            .apply()
        tokenInput.setText("")
        toast("token 已清除")
        refreshStatus()
    }

    private fun readDataTypes(): String {
        return dataTypesInput.text.toString().trim().ifBlank { DEFAULT_DATA_TYPES }
    }

    private fun readHours(): Long {
        return hoursInput.text.toString().trim().toLongOrNull()?.coerceIn(1L, 24L * 365L) ?: 24L
    }

    private fun readSliceHours(): Long {
        return sliceHoursInput.text.toString().trim().toLongOrNull()?.coerceIn(0L, 24L * 365L) ?: 0L
    }

    private fun readLimit(): Int {
        return limitInput.text.toString().trim().toIntOrNull()?.coerceIn(1, 5000) ?: 500
    }

    private fun readMaxPages(): Int {
        return maxPagesInput.text.toString().trim().toIntOrNull()?.coerceIn(1, 200) ?: 20
    }

    private fun refreshStatus() {
        val prefs = getSharedPreferences(PREFS, MODE_PRIVATE)
        val token = prefs.getString(KEY_ACCESS_TOKEN, "").orEmpty()
        val savedAt = prefs.getLong(KEY_TOKEN_SAVED_AT, 0L)
        statusView.text = buildString {
            append("状态：")
            append(if (token.isBlank()) "未保存 token" else "已保存 token，长度=${token.length}")
            if (savedAt > 0L) {
                append("\n保存时间戳：").append(savedAt)
            }
            append("\n默认回调：").append(DEFAULT_REDIRECT_URI)
            append("\n当前数据类型：").append(prefs.getString(KEY_DATA_TYPES, DEFAULT_DATA_TYPES))
            append("\n当前拉取范围：").append(prefs.getLong(KEY_HOURS, 24L)).append(" 小时")
            append("\n当前分片：").append(prefs.getLong(KEY_SLICE_HOURS, 0L)).append(" 小时")
            append("\n注意：小米开放平台里的 redirect_uri 必须和这里一致。")
        }
    }

    private fun enc(value: String): String {
        return URLEncoder.encode(value, StandardCharsets.UTF_8.name())
    }

    private fun toast(message: String) {
        Toast.makeText(this, message, Toast.LENGTH_SHORT).show()
    }

    private companion object {
        const val TAG = "RabiMiHealthOAuth"
        const val PREFS = "mi_health_cloud"
        const val KEY_APP_ID = "app_id"
        const val KEY_ACCESS_TOKEN = "access_token"
        const val KEY_TOKEN_TYPE = "token_type"
        const val KEY_TOKEN_SAVED_AT = "token_saved_at"
        const val KEY_REDIRECT_URI = "redirect_uri"
        const val KEY_SCOPE = "scope"
        const val KEY_STATE = "state"
        const val KEY_DATA_TYPES = "data_types"
        const val KEY_HOURS = "hours"
        const val KEY_SLICE_HOURS = "slice_hours"
        const val KEY_LIMIT = "limit"
        const val KEY_MAX_PAGES = "max_pages"
        const val DEFAULT_REDIRECT_URI = "rabiroute-bandprobe://oauth/xiaomi"
        const val DEFAULT_DATA_TYPES = "com.xiaomi.micloud.fit.heart_rate.bpm,com.xiaomi.micloud.fit.heart_rate.summary"
    }
}
