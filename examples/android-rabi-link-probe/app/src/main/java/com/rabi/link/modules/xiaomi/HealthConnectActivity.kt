package com.rabi.link.modules.xiaomi

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.provider.Settings
import android.util.Log
import android.view.Gravity
import android.widget.Button
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import androidx.activity.ComponentActivity
import androidx.health.connect.client.HealthConnectClient
import androidx.health.connect.client.PermissionController
import androidx.health.connect.client.permission.HealthPermission
import androidx.health.connect.client.records.HeartRateRecord
import androidx.health.connect.client.records.SleepSessionRecord
import androidx.health.connect.client.request.ReadRecordsRequest
import androidx.health.connect.client.time.TimeRangeFilter
import androidx.lifecycle.lifecycleScope
import com.rabi.link.RabiGuidanceTone
import com.rabi.link.RabiMobileUi
import com.rabi.link.RabiSetupGuidance
import kotlinx.coroutines.launch
import java.time.Instant

class HealthConnectActivity : ComponentActivity() {
    private val logTag = "RabiHealthProbe"
    private val report = StringBuilder()
    private val heartRateProbe = HealthConnectForegroundHeartRateProbe()
    private lateinit var logView: TextView
    private lateinit var statusView: TextView
    private lateinit var page: ScrollView
    private var client: HealthConnectClient? = null

    private val requiredPermissions = setOf(
        HealthPermission.getReadPermission(HeartRateRecord::class),
        HealthPermission.getReadPermission(SleepSessionRecord::class)
    )

    private val permissionLauncher = registerForActivityResult(
        PermissionController.createRequestPermissionResultContract()
    ) { granted ->
        append("权限结果：${granted.joinToString()}")
        if (granted.containsAll(requiredPermissions)) {
            readHealthData()
        } else {
            append("没有同时获得心率和睡眠读取权限；穿戴持续采集只能读取已授权的数据类型。")
            showGuidance(RabiSetupGuidance(
                "权限没有全部通过",
                "Android 只允许 App 读取你明确勾选的健康类型；心率或睡眠至少有一项未授权。",
                "再次点“授权并读取”，在系统页面允许心率和睡眠；不想授权时可以安全返回，App 不会绕过系统读取。",
                RabiGuidanceTone.WARNING,
            ))
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        buildUi()
        checkAvailability()
        if (intent.getBooleanExtra("auto_read", false)) {
            append("收到 adb 自动读取参数，准备读取最近24小时。")
            logView.postDelayed({ requestPermissionThenRead() }, 800)
        }
    }

    private fun buildUi() {
        val content = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(16), dp(16), dp(16), dp(28))
            setBackgroundColor(RabiMobileUi.background)
        }
        content.addView(RabiMobileUi.hero(
            this,
            "连接 Health Connect",
            "App 会先检查系统支持，再由 Android 请求心率和睡眠权限；你不需要填写任何参数。",
        ), full(0, 0, 0, 12))

        statusView = RabiMobileUi.guidance(this, RabiSetupGuidance(
            "正在检查系统健康服务",
            "App 正在确认这台手机能否使用 Health Connect。",
            "请稍候。",
        ))
        content.addView(statusView, full(0, 0, 0, 12))

        val actionCard = RabiMobileUi.card(this).apply {
            addView(RabiMobileUi.title(this@HealthConnectActivity, "1. 授权并自动读取"))
            addView(RabiMobileUi.note(this@HealthConnectActivity, "Android 会弹出自己的权限页。Rabi 只能读取你允许的类型，也无法代替你点击同意。"))
            addView(RabiMobileUi.primary(this@HealthConnectActivity, "授权并读取最近 24 小时") { requestPermissionThenRead() }, full(0, 0, 0, 8))
            addView(RabiMobileUi.secondary(this@HealthConnectActivity, "打开 Health Connect 设置") { openHealthConnectSettings() }, full(0, 0, 0, 8))
            addView(RabiMobileUi.secondary(this@HealthConnectActivity, "复制诊断结果") { copyReport() })
        }
        content.addView(actionCard, full(0, 0, 0, 12))

        val resultCard = RabiMobileUi.card(this).apply {
            addView(RabiMobileUi.title(this@HealthConnectActivity, "2. 读取结果"))
            addView(RabiMobileUi.note(this@HealthConnectActivity, "这里保留系统返回的记录数和失败原因，方便确认小米运动健康是否真的把数据写进了 Health Connect。"))
            logView = TextView(this@HealthConnectActivity).apply {
                textSize = 13f
                gravity = Gravity.START
                setTextColor(RabiMobileUi.text)
                setPadding(dp(12), dp(10), dp(12), dp(10))
                background = RabiMobileUi.panel(this@HealthConnectActivity, RabiMobileUi.surface, RabiMobileUi.border, 10)
                minHeight = dp(180)
            }
            addView(logView, LinearLayout.LayoutParams(-1, -2))
        }
        content.addView(resultCard)

        page = ScrollView(this).apply { addView(content) }
        setContentView(page)
    }

    private fun checkAvailability() {
        val status = HealthConnectClient.getSdkStatus(this)
        append("Health Connect 状态：$status")
        when (status) {
            HealthConnectClient.SDK_AVAILABLE -> {
                client = HealthConnectClient.getOrCreate(this)
                append("Health Connect 可用。请点击“授权并读取24小时”。")
                showGuidance(RabiSetupGuidance(
                    "Health Connect 可以使用",
                    "系统健康服务已就绪，剩下只需要你确认读取心率和睡眠权限。",
                    "点“授权并读取最近 24 小时”，按系统页面完成授权。",
                    RabiGuidanceTone.SUCCESS,
                ))
            }
            HealthConnectClient.SDK_UNAVAILABLE_PROVIDER_UPDATE_REQUIRED -> {
                append("Health Connect 需要安装或更新。请点击设置按钮，或到应用商店安装/更新 Health Connect。")
                showGuidance(RabiSetupGuidance(
                    "Health Connect 需要安装或更新",
                    "这台手机支持健康连接，但系统提供程序缺失或版本过旧；App 不能替你安装系统组件。",
                    "点“打开 Health Connect 设置”，按系统提示安装或更新后返回。",
                    RabiGuidanceTone.WARNING,
                ))
            }
            else -> {
                append("Health Connect 当前不可用。此手机系统可能不支持，或服务被禁用。")
                showGuidance(RabiSetupGuidance(
                    "这台手机暂时不能使用 Health Connect",
                    "系统没有提供可用的健康连接服务，或服务被停用。",
                    "更新系统或启用 Health Connect；也可以返回健康设置改用已配置的小米 ADB Companion。",
                    RabiGuidanceTone.WARNING,
                ))
            }
        }
    }

    private fun requestPermissionThenRead() {
        val healthClient = client
        if (healthClient == null) {
            append("Health Connect client 不可用，无法读取。")
            showGuidance(RabiSetupGuidance(
                "现在还不能读取健康数据",
                "Health Connect 服务没有准备好，因此 App 无法打开权限和读取接口。",
                "先安装或启用 Health Connect，再返回重试。",
                RabiGuidanceTone.ERROR,
            ))
            return
        }

        lifecycleScope.launch {
            val granted = healthClient.permissionController.getGrantedPermissions()
            append("已授权权限：${granted.joinToString()}")
            if (granted.containsAll(requiredPermissions)) {
                readHealthData()
            } else {
                append("正在请求心率和睡眠读取权限...")
                append("如果系统打开权限页，请允许“心率”和“睡眠”读取权限后返回本应用。")
                showGuidance(RabiSetupGuidance(
                    "等待系统授权",
                    "心率和睡眠属于敏感健康数据，Android 要求由你亲自确认。",
                    "在接下来的系统页面允许心率和睡眠读取，然后返回 Rabi。",
                ))
                permissionLauncher.launch(requiredPermissions)
            }
        }
    }

    private fun readHealthData() {
        val healthClient = client ?: return
        showGuidance(RabiSetupGuidance(
            "正在读取健康数据",
            "权限已满足，App 正在读取最近 24 小时的心率和睡眠记录。",
            "请稍候，不需要重复点击。",
        ))
        lifecycleScope.launch {
            var failed = false
            runCatching { heartRateProbe.readLast24Hours(healthClient).forEach(::append) }
                .onFailure { error ->
                    failed = true
                    append("HeartRateRecord 读取失败：${error.javaClass.simpleName}: ${error.message}")
                }
            runCatching {
                val end = Instant.now()
                val sleepRecords = healthClient.readRecords(
                    ReadRecordsRequest(
                        recordType = SleepSessionRecord::class,
                        timeRangeFilter = TimeRangeFilter.between(end.minusSeconds(24 * 60 * 60), end)
                    )
                ).records
                val stageCount = sleepRecords.sumOf { it.stages.size }
                append("SleepSessionRecord 最近24小时：记录=${sleepRecords.size} 阶段=$stageCount")
            }.onFailure { error ->
                failed = true
                append("SleepSessionRecord 读取失败：${error.javaClass.simpleName}: ${error.message}")
            }
            showGuidance(if (failed) RabiSetupGuidance(
                "部分健康数据没有读到",
                "系统返回了读取错误，具体类型和原因已保留在下方结果中。",
                "检查 Health Connect 里对 Rabi 的心率和睡眠权限，再重试。",
                RabiGuidanceTone.WARNING,
            ) else RabiSetupGuidance(
                "读取完成",
                "App 已完成最近 24 小时心率和睡眠查询；即使记录数为 0，也代表系统正常返回了空结果。",
                "查看下方记录数；如果为 0，请确认小米运动健康是否已开启写入 Health Connect。",
                RabiGuidanceTone.SUCCESS,
            ))
        }
    }

    private fun openHealthConnectSettings() {
        try {
            startActivity(Intent("android.health.connect.action.HEALTH_HOME_SETTINGS"))
        } catch (_: Throwable) {
            startActivity(Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS).apply {
                data = Uri.parse("package:com.google.android.apps.healthdata")
            })
        }
    }

    private fun append(message: String) {
        val line = message + "\n"
        report.append(line)
        Log.i(logTag, message)
        logView.append(line)
    }

    private fun copyReport() {
        val clipboard = getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
        clipboard.setPrimaryClip(ClipData.newPlainText("手机健康权限与数据探针结果", report.toString()))
        showGuidance(RabiSetupGuidance(
            "诊断结果已复制",
            "下方完整记录已经放进系统剪贴板。",
            "可以粘贴给 Rabi 或开发者继续排查。",
            RabiGuidanceTone.SUCCESS,
        ))
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

}
