package com.rabi.link.modules.xiaomi

import android.app.Activity
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.util.Log
import android.widget.Button
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import android.widget.Toast
import java.util.UUID

class MiHealthOAuthActivity : Activity() {
    private lateinit var settingsStore: MiHealthOAuthSettingsStore
    private lateinit var form: MiHealthOAuthForm
    private lateinit var statusView: TextView

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        settingsStore = MiHealthOAuthSettingsStore(this)
        buildUi()
        handleCallback(intent)
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        handleCallback(intent)
    }

    private fun buildUi() {
        val initial = settingsStore.initialSettings(intent)
        val root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(32, 32, 32, 32)
        }

        root.addView(TextView(this).apply {
            text = "小米健康云 OAuth"
            textSize = 20f
        })

        form = MiHealthOAuthForm(this, initial)
        form.addFieldsTo(root)

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
        val settings = readSettings()
        if (settings.appId.isBlank() || settings.redirectUri.isBlank()) {
            toast("需要 AppID 和 redirect_uri")
            return
        }

        val state = UUID.randomUUID().toString()
        settingsStore.saveAuthorizationRequest(settings, state)

        val url = MiHealthOAuthAuthorizationUrlBuilder.build(settings.appId, settings.redirectUri, settings.scope, state)
        Log.i(TAG, "打开小米 OAuth 授权页，appId=${settings.appId} redirectUri=${settings.redirectUri} scope=${settings.scope}")
        startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url)))
    }

    private fun handleCallback(intent: Intent?) {
        val data = intent?.data ?: return
        if (data.scheme != "rabi-link") {
            return
        }

        val callbackParams = MiHealthOAuthCallbackParser.parse(data)
        val error = callbackParams["error"]
        if (!error.isNullOrBlank()) {
            val desc = callbackParams["error_description"].orEmpty()
            statusView.text = "授权失败：$error $desc"
            return
        }

        val accessToken = callbackParams[MiHealthCloudContract.OAUTH_PARAM_ACCESS_TOKEN].orEmpty()
        if (accessToken.isBlank()) {
            statusView.text = "收到回调，但没有 access_token：$data"
            return
        }

        val expectedState = settingsStore.expectedState()
        val returnedState = callbackParams["state"].orEmpty()
        if (expectedState.isNotBlank() && returnedState != expectedState) {
            statusView.text = "state 不一致，已拒绝保存 token。"
            return
        }

        settingsStore.saveCallbackToken(callbackParams, accessToken)

        Log.i(TAG, "小米 OAuth token 已保存，token 长度=${accessToken.length}")
        form.setToken(accessToken)
        toast("授权成功，开始拉取心率列表")
        refreshStatus()
        startCloudProbeFromSavedToken()
    }

    private fun startCloudProbeFromSavedToken() {
        val settings = settingsStore.settingsWithSavedCredentials(readSettings())
        if (settings.appId.isBlank() || settings.accessToken.isBlank()) {
            toast("还没有 AppID 或 token")
            refreshStatus()
            return
        }
        settingsStore.saveProbeSettings(settings)

        val serviceIntent = settingsStore.buildProbeIntent(settings, intent.getLongExtra(MiHealthCloudContract.EXTRA_REQUEST_TIMEOUT_SECONDS, 30L))
        if (Build.VERSION.SDK_INT >= 26) {
            startForegroundService(serviceIntent)
        } else {
            startService(serviceIntent)
        }
        statusView.text = "已触发云端心率列表拉取：${settings.dataTypes}，最近 ${settings.hours} 小时，分片 ${settings.sliceHours} 小时，每页 ${settings.limit} 条，最多 ${settings.maxPages} 页。完成后会自动保存 ZIP 到下载目录。"
    }

    private fun saveManualToken() {
        val settings = readSettings()
        if (settings.accessToken.isBlank()) {
            toast("token 为空")
            return
        }
        settingsStore.saveManualToken(settings)
        toast("token 已保存")
        refreshStatus()
    }

    private fun clearToken() {
        settingsStore.clearToken()
        form.clearToken()
        toast("token 已清除")
        refreshStatus()
    }

    private fun readSettings(): MiHealthOAuthSettings {
        return form.readSettings()
    }

    private fun refreshStatus() {
        statusView.text = settingsStore.statusText()
    }

    private fun toast(message: String) {
        Toast.makeText(this, message, Toast.LENGTH_SHORT).show()
    }

    private companion object {
        const val TAG = "RabiMiHealthOAuth"
    }
}
