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
import android.widget.Toast
import androidx.activity.ComponentActivity
import androidx.health.connect.client.HealthConnectClient
import androidx.health.connect.client.PermissionController
import androidx.health.connect.client.permission.HealthPermission
import androidx.health.connect.client.records.HeartRateRecord
import androidx.health.connect.client.records.SleepSessionRecord
import androidx.health.connect.client.request.ReadRecordsRequest
import androidx.health.connect.client.time.TimeRangeFilter
import androidx.lifecycle.lifecycleScope
import kotlinx.coroutines.launch
import java.time.Instant

class HealthConnectActivity : ComponentActivity() {
    private val logTag = "RabiHealthProbe"
    private val report = StringBuilder()
    private val heartRateProbe = HealthConnectForegroundHeartRateProbe()
    private lateinit var logView: TextView
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
        val root = LinearLayout(this)
        root.orientation = LinearLayout.VERTICAL
        root.setPadding(24, 24, 24, 24)

        val title = TextView(this)
        title.text = "手机健康权限与数据探针"
        title.textSize = 22f
        root.addView(title, LinearLayout.LayoutParams(-1, -2))

        val hint = TextView(this)
        hint.text = "用于授权并测试小米运动健康是否把手环心率和睡眠同步到了 Android Health Connect。"
        hint.textSize = 13f
        root.addView(hint, LinearLayout.LayoutParams(-1, -2))

        val buttons = LinearLayout(this)
        buttons.orientation = LinearLayout.HORIZONTAL

        val readButton = Button(this)
        readButton.text = "授权并读取24小时"
        readButton.setOnClickListener { requestPermissionThenRead() }
        buttons.addView(readButton, LinearLayout.LayoutParams(0, -2, 1f))

        val copyButton = Button(this)
        copyButton.text = "复制结果"
        copyButton.setOnClickListener { copyReport() }
        buttons.addView(copyButton, LinearLayout.LayoutParams(0, -2, 1f))

        root.addView(buttons, LinearLayout.LayoutParams(-1, -2))

        val settingsButton = Button(this)
        settingsButton.text = "打开 Health Connect 设置"
        settingsButton.setOnClickListener { openHealthConnectSettings() }
        root.addView(settingsButton, LinearLayout.LayoutParams(-1, -2))

        logView = TextView(this)
        logView.textSize = 13f
        logView.gravity = Gravity.START
        val scroll = ScrollView(this)
        scroll.addView(logView)
        root.addView(scroll, LinearLayout.LayoutParams(-1, 0, 1f))

        setContentView(root)
    }

    private fun checkAvailability() {
        val status = HealthConnectClient.getSdkStatus(this)
        append("Health Connect 状态：$status")
        when (status) {
            HealthConnectClient.SDK_AVAILABLE -> {
                client = HealthConnectClient.getOrCreate(this)
                append("Health Connect 可用。请点击“授权并读取24小时”。")
            }
            HealthConnectClient.SDK_UNAVAILABLE_PROVIDER_UPDATE_REQUIRED -> {
                append("Health Connect 需要安装或更新。请点击设置按钮，或到应用商店安装/更新 Health Connect。")
            }
            else -> {
                append("Health Connect 当前不可用。此手机系统可能不支持，或服务被禁用。")
            }
        }
    }

    private fun requestPermissionThenRead() {
        val healthClient = client
        if (healthClient == null) {
            append("Health Connect client 不可用，无法读取。")
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
                permissionLauncher.launch(requiredPermissions)
            }
        }
    }

    private fun readHealthData() {
        val healthClient = client ?: return
        lifecycleScope.launch {
            heartRateProbe.readLast24Hours(healthClient).forEach(::append)
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
                append("SleepSessionRecord 读取失败：${error.javaClass.simpleName}: ${error.message}")
            }
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
        Toast.makeText(this, "结果已复制", Toast.LENGTH_SHORT).show()
    }

}
