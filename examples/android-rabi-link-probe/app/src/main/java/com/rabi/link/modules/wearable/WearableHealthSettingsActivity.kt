package com.rabi.link.modules.wearable

import android.app.Activity
import android.app.AlertDialog
import android.content.Intent
import android.graphics.Color
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.os.Bundle
import android.text.InputType
import android.view.Gravity
import android.view.View
import android.widget.Button
import android.widget.EditText
import android.widget.ArrayAdapter
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.Spinner
import android.widget.Switch
import android.widget.TextView
import android.widget.Toast
import com.rabi.link.modules.xiaomi.HealthConnectActivity
import com.rabiroute.sdk.RabiWearableHealthPolicy
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter

class WearableHealthSettingsActivity : Activity() {
    private lateinit var enabled: Switch
    private lateinit var collectorMode: Spinner
    private lateinit var deviceId: EditText
    private lateinit var deviceName: EditText
    private lateinit var deviceKind: EditText
    private lateinit var authKey: EditText
    private lateinit var intervalMinutes: EditText
    private lateinit var lookbackHours: EditText
    private lateinit var highBpm: EditText
    private lateinit var lowBpm: EditText
    private lateinit var cooldownMinutes: EditText
    private lateinit var sleepAlert: Switch
    private lateinit var status: TextView

    override fun onCreate(state: Bundle?) {
        super.onCreate(state)
        setContentView(buildUi())
        load()
    }

    override fun onResume() {
        super.onResume()
        if (::status.isInitialized) refreshStatus()
    }

    private fun buildUi(): View {
        val content = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(16), dp(20), dp(16), dp(30))
            setBackgroundColor(Color.rgb(246, 248, 252))
        }
        content.addView(TextView(this).apply {
            text = "智能手表 / 手环消息端"
            textSize = 25f
            typeface = Typeface.DEFAULT_BOLD
            setTextColor(Color.rgb(20, 27, 38))
        })
        content.addView(note("持续采集心率和睡眠，经过 RabiLink 送到所选 Rabi PC；RabiRoute 保存健康时间线，阈值命中时才投递 Agent。"), full(0, 6, 0, 14))
        status = TextView(this).apply {
            setTextColor(Color.rgb(35, 78, 145))
            setPadding(dp(12), dp(10), dp(12), dp(10))
            background = panel(Color.rgb(234, 242, 255), Color.rgb(186, 207, 240), 8)
        }
        content.addView(status, full(0, 0, 0, 12))
        content.addView(deviceCard(), full(0, 0, 0, 12))
        content.addView(policyCard(), full(0, 0, 0, 12))
        content.addView(actionsCard(), full(0, 0, 0, 12))
        return ScrollView(this).apply { addView(content) }
    }

    private fun deviceCard(): View = card().apply {
        addView(title("设备与采集"))
        addView(note("可选择 Health Connect，或由已配对的 Rabi PC 通过 ADB Companion 读取小米运动健康。密钥按 AstroBox 风格在手机端配置并用 Android Keystore 加密保存；不会上传或写进日志。"))
        enabled = Switch(this@WearableHealthSettingsActivity).apply { text = "启用持续健康记录" }
        addView(enabled)
        collectorMode = Spinner(this@WearableHealthSettingsActivity).apply {
            adapter = ArrayAdapter(
                this@WearableHealthSettingsActivity,
                android.R.layout.simple_spinner_dropdown_item,
                listOf("Health Connect", "小米运动健康（PC ADB Companion）")
            )
        }
        addView(label("采集来源")); addView(collectorMode, full(0, 0, 0, 6))
        deviceName = input("Xiaomi Smart Band 10 Pro")
        deviceId = input("mi-band-10-pro")
        deviceKind = input("band")
        authKey = input("32 位十六进制密钥").apply {
            inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_PASSWORD
        }
        addView(label("设备名称")); addView(deviceName, full(0, 0, 0, 6))
        addView(label("稳定设备 ID")); addView(deviceId, full(0, 0, 0, 6))
        addView(label("设备类别（watch / band）")); addView(deviceKind, full(0, 0, 0, 6))
        addView(label("小米 auth key（留空表示保留现有密钥）")); addView(authKey, full(0, 0, 0, 6))
        val timing = row()
        intervalMinutes = numberInput("5")
        lookbackHours = numberInput("24")
        timing.addView(fieldColumn("轮询间隔（分钟）", intervalMinutes), LinearLayout.LayoutParams(0, -2, 1f))
        timing.addView(space(), LinearLayout.LayoutParams(dp(8), 1))
        timing.addView(fieldColumn("回看窗口（小时）", lookbackHours), LinearLayout.LayoutParams(0, -2, 1f))
        addView(timing)
        addView(secondary("打开 Health Connect 授权") {
            startActivity(Intent(this@WearableHealthSettingsActivity, HealthConnectActivity::class.java))
        }, full(0, 10, 0, 0))
    }

    private fun policyCard(): View = card().apply {
        addView(title("告警规则"))
        addView(note("默认只在心率越过阈值后提示 Agent，并按冷却时间去重；普通采样只记录，不会每次打扰 Agent。"))
        highBpm = numberInput("120")
        lowBpm = numberInput("0")
        cooldownMinutes = numberInput("15")
        val thresholds = row()
        thresholds.addView(fieldColumn("过高阈值 bpm", highBpm), LinearLayout.LayoutParams(0, -2, 1f))
        thresholds.addView(space(), LinearLayout.LayoutParams(dp(8), 1))
        thresholds.addView(fieldColumn("过低阈值 bpm（0 关闭）", lowBpm), LinearLayout.LayoutParams(0, -2, 1f))
        addView(thresholds)
        addView(label("告警冷却（分钟）")); addView(cooldownMinutes, full(0, 0, 0, 4))
        sleepAlert = Switch(this@WearableHealthSettingsActivity).apply { text = "睡着 / 醒来变化时提示 Agent" }
        addView(sleepAlert)
    }

    private fun actionsCard(): View = card().apply {
        addView(title("保存与同步"))
        addView(note("请先回首页连接 Relay 并选择 Rabi PC，再在该 PC 的 Route 中添加“智能手表/手环”消息端。密钥只保存在本机。"))
        addView(primary("保存设置") { save(startAfterSave = enabled.isChecked) }, full(0, 0, 0, 8))
        val actions = row()
        actions.addView(secondary("立即同步") { syncNow() }, LinearLayout.LayoutParams(0, -2, 1f))
        actions.addView(space(), LinearLayout.LayoutParams(dp(8), 1))
        actions.addView(secondary("停止同步") { disableAndStop() }, LinearLayout.LayoutParams(0, -2, 1f))
        addView(actions)
        addView(secondary("清除本机小米密钥") { confirmClearKey() }, full(0, 8, 0, 0))
    }

    private fun load() {
        val value = WearableHealthSettings.load(this)
        enabled.isChecked = value.enabled
        collectorMode.setSelection(if (value.collectorMode == WearableHealthCollectorMode.XIAOMI_ADB_COMPANION) 1 else 0)
        deviceId.setText(value.sourceDeviceId)
        deviceName.setText(value.sourceDeviceName)
        deviceKind.setText(value.sourceDeviceKind)
        authKey.hint = if (value.hasAuthKey) "已安全保存（重新输入可替换）" else "32 位十六进制密钥"
        intervalMinutes.setText(value.pollIntervalMinutes.toString())
        lookbackHours.setText(value.lookbackHours.toString())
        highBpm.setText(value.policy.heartRateHighBpm.toString())
        lowBpm.setText(value.policy.heartRateLowBpm.toString())
        cooldownMinutes.setText(value.policy.heartRateAlertCooldownMinutes.toString())
        sleepAlert.isChecked = value.policy.sleepStateAlertEnabled
        refreshStatus()
    }

    private fun save(startAfterSave: Boolean) {
        runCatching {
            val policy = RabiWearableHealthPolicy(
                enabled = true,
                heartRateHighBpm = highBpm.text.toString().toIntOrNull() ?: 120,
                heartRateLowBpm = lowBpm.text.toString().toIntOrNull() ?: 0,
                heartRateAlertCooldownMinutes = cooldownMinutes.text.toString().toIntOrNull() ?: 15,
                sleepStateAlertEnabled = sleepAlert.isChecked
            )
            val config = WearableHealthConfig(
                enabled = enabled.isChecked,
                collectorMode = if (collectorMode.selectedItemPosition == 1) {
                    WearableHealthCollectorMode.XIAOMI_ADB_COMPANION
                } else {
                    WearableHealthCollectorMode.HEALTH_CONNECT
                },
                sourceDeviceId = deviceId.text.toString().trim().ifBlank { "unknown-wearable" },
                sourceDeviceName = deviceName.text.toString().trim(),
                sourceDeviceKind = deviceKind.text.toString().trim().lowercase().ifBlank { "wearable" },
                pollIntervalMinutes = intervalMinutes.text.toString().toIntOrNull() ?: 5,
                lookbackHours = lookbackHours.text.toString().toIntOrNull() ?: 24,
                policy = policy,
                hasAuthKey = WearableHealthSettings.load(this).hasAuthKey
            )
            WearableHealthSettings.save(this, config, authKey.text.toString().trim().ifBlank { null })
            authKey.setText("")
            if (startAfterSave && config.enabled) {
                WearableHealthSyncService.start(this)
            } else if (!config.enabled || config.collectorMode == WearableHealthCollectorMode.XIAOMI_ADB_COMPANION) {
                WearableHealthSyncService.stop(this)
            }
            toast("智能手表/手环设置已保存")
            load()
        }.onFailure { toast(it.message ?: "保存失败") }
    }

    private fun syncNow() {
        save(startAfterSave = false)
        val config = WearableHealthSettings.load(this)
        if (config.collectorMode == WearableHealthCollectorMode.XIAOMI_ADB_COMPANION) {
            WearableHealthSettings.saveLastStatus(this, "已请求同步；Rabi PC Companion 会在下一轮读取。")
            refreshStatus()
            toast("等待 Rabi PC ADB Companion 同步")
        } else {
            WearableHealthSyncService.syncNow(this)
        }
    }

    private fun disableAndStop() {
        enabled.isChecked = false
        save(startAfterSave = false)
        WearableHealthSyncService.stop(this)
    }

    private fun confirmClearKey() {
        AlertDialog.Builder(this)
            .setTitle("清除小米密钥？")
            .setMessage("这只会清除 RabiLink 手机端加密保存的密钥；不会解绑手环，也不会删除已记录的健康历史。")
            .setNegativeButton("取消", null)
            .setPositiveButton("清除") { _, _ ->
                WearableHealthSettings.clearAuthKey(this)
                authKey.setText("")
                load()
                toast("本机小米密钥已清除")
            }
            .show()
    }

    private fun refreshStatus() {
        val value = WearableHealthSettings.load(this)
        val (last, at) = WearableHealthSettings.lastStatus(this)
        val time = if (at > 0) DateTimeFormatter.ofPattern("MM-dd HH:mm:ss").withZone(ZoneId.systemDefault()).format(Instant.ofEpochMilli(at)) else "-"
        val source = if (value.collectorMode == WearableHealthCollectorMode.XIAOMI_ADB_COMPANION) "小米 ADB Companion" else "Health Connect"
        status.text = "持续记录：${if (value.enabled) "已启用" else "未启用"}\n采集来源：$source\n小米密钥：${if (value.hasAuthKey) "已安全保存" else "未配置"}\n最近同步：$time · $last"
    }

    private fun fieldColumn(text: String, field: EditText) = LinearLayout(this).apply {
        orientation = LinearLayout.VERTICAL
        addView(label(text)); addView(field)
    }
    private fun card() = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; setPadding(dp(14), dp(12), dp(14), dp(12)); background = panel(Color.WHITE, Color.rgb(218, 222, 228), 8) }
    private fun title(text: String) = TextView(this).apply { this.text = text; textSize = 17f; typeface = Typeface.DEFAULT_BOLD; setTextColor(Color.rgb(24, 30, 38)) }
    private fun note(text: String) = TextView(this).apply { this.text = text; textSize = 12f; setTextColor(Color.rgb(80, 87, 98)); setPadding(0, dp(6), 0, dp(8)) }
    private fun label(text: String) = TextView(this).apply { this.text = text; textSize = 12f; typeface = Typeface.DEFAULT_BOLD; setTextColor(Color.rgb(62, 70, 82)); setPadding(0, dp(4), 0, dp(3)) }
    private fun input(hint: String) = EditText(this).apply { this.hint = hint; textSize = 13f; setSingleLine(true); setPadding(dp(10), 0, dp(10), 0); background = panel(Color.WHITE, Color.rgb(205, 211, 220), 6) }
    private fun numberInput(hint: String) = input(hint).apply { inputType = InputType.TYPE_CLASS_NUMBER }
    private fun primary(text: String, action: () -> Unit) = Button(this).apply { this.text = text; isAllCaps = false; setTextColor(Color.WHITE); background = panel(Color.rgb(36, 95, 235), Color.rgb(36, 95, 235), 8); setOnClickListener { action() } }
    private fun secondary(text: String, action: () -> Unit) = Button(this).apply { this.text = text; isAllCaps = false; setTextColor(Color.rgb(38, 48, 68)); background = panel(Color.rgb(239, 242, 247), Color.rgb(213, 218, 226), 8); setOnClickListener { action() } }
    private fun row() = LinearLayout(this).apply { orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER_VERTICAL }
    private fun space() = View(this)
    private fun full(l: Int, t: Int, r: Int, b: Int) = LinearLayout.LayoutParams(-1, -2).apply { setMargins(dp(l), dp(t), dp(r), dp(b)) }
    private fun panel(color: Int, stroke: Int, radius: Int) = GradientDrawable().apply { setColor(color); setStroke(dp(1), stroke); cornerRadius = dp(radius).toFloat() }
    private fun dp(value: Int) = (value * resources.displayMetrics.density + 0.5f).toInt()
    private fun toast(text: String) = Toast.makeText(this, text, Toast.LENGTH_SHORT).show()
}
