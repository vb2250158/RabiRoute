package com.rabi.link.modules.xiaomi

import android.app.Activity
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.util.Log
import android.view.View
import android.widget.Button
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import com.rabi.link.RabiGuidanceTone
import com.rabi.link.RabiMobileUi
import com.rabi.link.RabiSetupGuidance
import java.util.UUID

class MiHealthOAuthActivity : Activity() {
    private lateinit var settingsStore: MiHealthOAuthSettingsStore
    private lateinit var form: MiHealthOAuthForm
    private lateinit var statusView: TextView
    private lateinit var detailView: TextView
    private lateinit var page: ScrollView

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
        val content = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(16), dp(16), dp(16), dp(28))
            setBackgroundColor(RabiMobileUi.background)
        }

        content.addView(RabiMobileUi.hero(
            this,
            "小米健康云合作方接入",
            "这是企业或合作方的高级数据接口。普通手环用户不需要填写 AppID 或 token，请优先使用 Health Connect。",
        ), full(0, 0, 0, 12))

        statusView = RabiMobileUi.guidance(this, RabiSetupGuidance(
            "这项能力不能自动开通",
            "小米健康云要求在开放平台审核合作方应用，并签发 AppID；Rabi App 无权替你创建第三方平台凭据。",
            "已有合作方 AppID 时在下方填写并完成小米账号授权；没有时返回健康设置使用 Health Connect。",
            RabiGuidanceTone.WARNING,
        ))
        content.addView(statusView, full(0, 0, 0, 12))

        form = MiHealthOAuthForm(this, initial)
        val credentialCard = RabiMobileUi.card(this).apply {
            addView(RabiMobileUi.title(this@MiHealthOAuthActivity, "1. 合作方凭据"))
            addView(RabiMobileUi.note(this@MiHealthOAuthActivity, "AppID 和回调地址来自小米开放平台；授权成功后的 token 会自动保存到本机，不写入日志。"))
            form.addCredentialFieldsTo(this)
            addView(RabiMobileUi.primary(this@MiHealthOAuthActivity, "打开小米账号授权") { openAuthorization() }, full(0, 6, 0, 8))
            addView(RabiMobileUi.secondary(this@MiHealthOAuthActivity, "保存手动粘贴的 token") { saveManualToken() }, full(0, 0, 0, 8))
            addView(RabiMobileUi.secondary(this@MiHealthOAuthActivity, "用已保存 token 拉取心率") { startCloudProbeFromSavedToken() })
        }
        content.addView(credentialCard, full(0, 0, 0, 12))

        val advancedCard = RabiMobileUi.card(this).apply {
            visibility = View.GONE
            addView(RabiMobileUi.title(this@MiHealthOAuthActivity, "高级拉取参数"))
            addView(RabiMobileUi.note(this@MiHealthOAuthActivity, "默认值适合普通诊断；只有开发者明确要求时才需要修改。"))
            form.addAdvancedFieldsTo(this)
            addView(RabiMobileUi.secondary(this@MiHealthOAuthActivity, "清除本机 token") { clearToken() }, full(0, 8, 0, 0))
        }
        lateinit var advancedToggle: Button
        advancedToggle = RabiMobileUi.secondary(this, "显示高级参数") {
            val show = advancedCard.visibility != View.VISIBLE
            advancedCard.visibility = if (show) View.VISIBLE else View.GONE
            advancedToggle.text = if (show) "收起高级参数" else "显示高级参数"
        }
        content.addView(advancedToggle, full(0, 0, 0, 12))
        content.addView(advancedCard, full(0, 0, 0, 12))

        val detailCard = RabiMobileUi.card(this).apply {
            addView(RabiMobileUi.title(this@MiHealthOAuthActivity, "当前凭据状态"))
            detailView = RabiMobileUi.note(this@MiHealthOAuthActivity, "尚未读取状态")
            addView(detailView)
        }
        content.addView(detailCard)

        page = ScrollView(this).apply { addView(content) }
        setContentView(page)
        refreshStatus()
    }

    private fun openAuthorization() {
        val settings = readSettings()
        if (settings.appId.isBlank() || settings.redirectUri.isBlank()) {
            showGuidance(RabiSetupGuidance(
                "还不能打开小米授权",
                "合作方 AppID 或 OAuth 回调地址为空。这两项必须和小米开放平台审核配置完全一致，App 不能猜测。",
                "填写开放平台提供的 AppID；回调地址通常保持 rabi-link://oauth/xiaomi。",
                RabiGuidanceTone.WARNING,
            ))
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
            showGuidance(RabiSetupGuidance(
                "小米账号授权失败",
                "$error ${desc.ifBlank { "开放平台没有接受本次授权。" }}",
                "检查 AppID、回调地址和开放平台权限范围后重试。",
                RabiGuidanceTone.ERROR,
            ))
            return
        }

        val accessToken = callbackParams[MiHealthCloudContract.OAUTH_PARAM_ACCESS_TOKEN].orEmpty()
        if (accessToken.isBlank()) {
            showGuidance(RabiSetupGuidance(
                "授权回调缺少 token",
                "小米页面返回了 Rabi，但没有携带可用于云端读取的 access token。",
                "检查应用是否获批健康云权限；普通小米账号登录本身并不等于开放健康数据。",
                RabiGuidanceTone.ERROR,
            ))
            return
        }

        val expectedState = settingsStore.expectedState()
        val returnedState = callbackParams["state"].orEmpty()
        if (expectedState.isNotBlank() && returnedState != expectedState) {
            showGuidance(RabiSetupGuidance(
                "为安全起见已拒绝这次回调",
                "返回的 OAuth state 与本机发起授权时记录的不一致，可能是过期页面或错误回调。",
                "从本页重新点“打开小米账号授权”，不要复用旧授权页面。",
                RabiGuidanceTone.ERROR,
            ))
            return
        }

        settingsStore.saveCallbackToken(callbackParams, accessToken)

        Log.i(TAG, "小米 OAuth token 已保存，token 长度=${accessToken.length}")
        form.setToken(accessToken)
        showGuidance(RabiSetupGuidance(
            "小米授权完成",
            "access token 已安全保存在本机，App 将开始拉取已获批的健康数据。",
            "等待页面显示拉取结果；完成后会自动保存诊断 ZIP。",
            RabiGuidanceTone.SUCCESS,
        ))
        refreshStatus()
        startCloudProbeFromSavedToken()
    }

    private fun startCloudProbeFromSavedToken() {
        val settings = settingsStore.settingsWithSavedCredentials(readSettings())
        if (settings.appId.isBlank() || settings.accessToken.isBlank()) {
            showGuidance(RabiSetupGuidance(
                "还不能拉取小米云数据",
                "合作方 AppID 或授权 token 不完整；没有它们，小米云会拒绝请求。",
                "先完成“打开小米账号授权”，或粘贴有效 token 后保存。",
                RabiGuidanceTone.WARNING,
            ))
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
        showGuidance(RabiSetupGuidance(
            "已开始拉取小米云心率",
            "正在读取最近 ${settings.hours} 小时的数据；分页和分片参数已自动应用。",
            "等待系统通知或诊断结果；完成后会自动保存 ZIP 到下载目录。",
            RabiGuidanceTone.SUCCESS,
        ))
    }

    private fun saveManualToken() {
        val settings = readSettings()
        if (settings.accessToken.isBlank()) {
            showGuidance(RabiSetupGuidance(
                "没有可保存的 token",
                "token 输入框为空。App 不会生成或猜测第三方账号凭据。",
                "优先通过小米授权自动取得；仅在开发者提供 token 时手动粘贴。",
                RabiGuidanceTone.WARNING,
            ))
            return
        }
        settingsStore.saveManualToken(settings)
        showGuidance(RabiSetupGuidance(
            "token 已保存在本机",
            "手动凭据已写入 App 私有存储。",
            "现在可以点“用已保存 token 拉取心率”。",
            RabiGuidanceTone.SUCCESS,
        ))
        refreshStatus()
    }

    private fun clearToken() {
        settingsStore.clearToken()
        form.clearToken()
        showGuidance(RabiSetupGuidance(
            "本机 token 已清除",
            "App 不再保存小米健康云访问凭据。",
            "需要重新使用时，再完成一次小米账号授权。",
            RabiGuidanceTone.SUCCESS,
        ))
        refreshStatus()
    }

    private fun readSettings(): MiHealthOAuthSettings {
        return form.readSettings()
    }

    private fun refreshStatus() {
        if (::detailView.isInitialized) detailView.text = settingsStore.statusText()
    }

    private fun showGuidance(value: RabiSetupGuidance) {
        if (!::statusView.isInitialized) return
        val styled = RabiMobileUi.guidance(this, value)
        statusView.text = styled.text
        statusView.setTextColor(styled.currentTextColor)
        statusView.background = styled.background
        if (::page.isInitialized) statusView.post { page.smoothScrollTo(0, 0) }
    }

    private fun full(left: Int, top: Int, right: Int, bottom: Int) =
        LinearLayout.LayoutParams(-1, -2).apply { setMargins(dp(left), dp(top), dp(right), dp(bottom)) }

    private fun dp(value: Int) = RabiMobileUi.dp(this, value)

    private companion object {
        const val TAG = "RabiMiHealthOAuth"
    }
}
