package com.rabi.link.modules.wearable

import android.app.Activity
import android.app.AlertDialog
import android.content.Intent
import android.os.Bundle
import android.provider.Settings
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
import androidx.health.connect.client.HealthConnectClient
import com.rabi.link.RabiGuidanceTone
import com.rabi.link.RabiLinkRelaySettings
import com.rabi.link.RabiMobileUi
import com.rabi.link.RabiSetupGuidance
import com.rabi.link.MainActivity
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
    private lateinit var advancedSettings: LinearLayout
    private lateinit var scroll: ScrollView

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
            setPadding(dp(16), dp(16), dp(16), dp(30))
            setBackgroundColor(RabiMobileUi.background)
        }
        content.addView(RabiMobileUi.hero(
            this,
            "让 Rabi 读懂你的健康状态",
            "优先使用系统可用的 Health Connect；只有小米 ADB Companion 等特殊链路才需要额外密钥。",
        ), full(0, 0, 0, 12))
        status = RabiMobileUi.guidance(this, RabiSetupGuidance(
            "正在检查健康采集条件",
            "App 会检查 Rabi 连接、采集来源和系统能力。",
            "缺少权限或外部服务时，会在这里说明原因。",
        ))
        content.addView(status, full(0, 0, 0, 12))
        content.addView(deviceCard(), full(0, 0, 0, 12))
        content.addView(policyCard(), full(0, 0, 0, 12))
        content.addView(actionsCard(), full(0, 0, 0, 12))
        scroll = ScrollView(this).apply { addView(content) }
        return scroll
    }

    private fun deviceCard(): View = card().apply {
        addView(title("1. 选择采集方式"))
        addView(note("App 会使用推荐默认值。设备 ID、轮询窗口和阈值等工程参数已经收进高级设置，小白不需要逐项填写。"))
        enabled = RabiMobileUi.styleSwitch(this@WearableHealthSettingsActivity, Switch(this@WearableHealthSettingsActivity).apply { text = "持续记录心率与睡眠" })
        addView(enabled)
        collectorMode = RabiMobileUi.spinner(this@WearableHealthSettingsActivity, Spinner(this@WearableHealthSettingsActivity).apply {
            adapter = ArrayAdapter(
                this@WearableHealthSettingsActivity,
                android.R.layout.simple_spinner_dropdown_item,
                listOf("Health Connect", "小米运动健康（PC ADB Companion）")
            )
            onItemSelectedListener = object : android.widget.AdapterView.OnItemSelectedListener {
                override fun onItemSelected(parent: android.widget.AdapterView<*>?, view: View?, position: Int, id: Long) = refreshStatus()
                override fun onNothingSelected(parent: android.widget.AdapterView<*>?) = Unit
            }
        })
        addView(label("采集来源")); addView(collectorMode, full(0, 0, 0, 6))
        deviceName = input("留空时由 App 自动命名")
        deviceId = input("mi-band-10-pro")
        deviceKind = input("band")
        authKey = input("32 位十六进制密钥").apply {
            inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_PASSWORD
        }
        addView(label("设备名称（可选）")); addView(deviceName, full(0, 0, 0, 6))
        advancedSettings = LinearLayout(this@WearableHealthSettingsActivity).apply {
            orientation = LinearLayout.VERTICAL
            visibility = View.GONE
            addView(label("稳定设备 ID（留空自动生成）")); addView(deviceId, full(0, 0, 0, 6))
            addView(label("设备类别（watch / band）")); addView(deviceKind, full(0, 0, 0, 6))
            addView(label("小米 auth key（仅 ADB Companion 需要）")); addView(authKey, full(0, 0, 0, 6))
        }
        val timing = row()
        intervalMinutes = numberInput("5")
        lookbackHours = numberInput("24")
        timing.addView(fieldColumn("轮询间隔（分钟）", intervalMinutes), LinearLayout.LayoutParams(0, -2, 1f))
        timing.addView(space(), LinearLayout.LayoutParams(dp(8), 1))
        timing.addView(fieldColumn("回看窗口（小时）", lookbackHours), LinearLayout.LayoutParams(0, -2, 1f))
        advancedSettings.addView(timing)
        addView(advancedSettings)
        lateinit var advancedToggle: Button
        advancedToggle = secondary("显示高级设置") {
            val visible = advancedSettings.visibility != View.VISIBLE
            advancedSettings.visibility = if (visible) View.VISIBLE else View.GONE
            advancedToggle.text = if (visible) "收起高级设置" else "显示高级设置"
        }
        addView(advancedToggle, full(0, 8, 0, 0))
        addView(secondary("检查并授权 Health Connect") {
            startActivity(Intent(this@WearableHealthSettingsActivity, HealthConnectActivity::class.java))
        }, full(0, 8, 0, 0))
    }

    private fun policyCard(): View = card().apply {
        addView(title("2. 告警规则"))
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
        sleepAlert = RabiMobileUi.styleSwitch(this@WearableHealthSettingsActivity, Switch(this@WearableHealthSettingsActivity).apply { text = "睡着 / 醒来变化时提示 Agent" })
        addView(sleepAlert)
    }

    private fun actionsCard(): View = card().apply {
        addView(title("3. 完成设置"))
        addView(note("“保存并启用”会先检查所有前置条件。条件不满足时不会假装成功，而会告诉你缺什么和去哪里处理。"))
        addView(primary("保存并启用") {
            enabled.isChecked = true
            save(startAfterSave = true)
        }, full(0, 0, 0, 8))
        val actions = row()
        actions.addView(secondary("保存为草稿") {
            enabled.isChecked = false
            save(startAfterSave = false)
        }, LinearLayout.LayoutParams(0, -2, 1f))
        actions.addView(space(), LinearLayout.LayoutParams(dp(8), 1))
        actions.addView(secondary("立即同步") { syncNow() }, LinearLayout.LayoutParams(0, -2, 1f))
        addView(actions)
        val secondaryActions = row()
        secondaryActions.addView(secondary("返回首页检查连接") { returnToHome() }, LinearLayout.LayoutParams(0, -2, 1f))
        secondaryActions.addView(space(), LinearLayout.LayoutParams(dp(8), 1))
        secondaryActions.addView(secondary("停止同步") { disableAndStop() }, LinearLayout.LayoutParams(0, -2, 1f))
        addView(secondaryActions, full(0, 8, 0, 0))
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
            val problem = if (startAfterSave) activationProblem() else null
            val config = configFromForm(enabled = startAfterSave && problem == null)
            persist(config)
            authKey.setText("")
            enabled.isChecked = config.enabled
            if (config.enabled) {
                WearableHealthSyncService.start(this)
            } else {
                WearableHealthSyncService.stop(this)
            }
            if (problem != null) {
                showGuidance(RabiSetupGuidance(
                    "设置已保存，但还没有启用",
                    problem.reason,
                    problem.action,
                    RabiGuidanceTone.WARNING,
                ))
            } else if (config.enabled) {
                showGuidance(RabiSetupGuidance(
                    "健康同步已启用",
                    "App 已保存推荐参数，并启动 ${sourceName(config.collectorMode)}。",
                    if (config.collectorMode == WearableHealthCollectorMode.HEALTH_CONNECT) "首次使用请完成系统健康权限授权；同步结果会继续显示在这里。" else "保持手机与已配对的 Rabi PC Companion 可连接。",
                    RabiGuidanceTone.SUCCESS,
                ))
            } else {
                showGuidance(RabiSetupGuidance(
                    "草稿已保存",
                    "设备名称、阈值和高级参数已经保存在本机，但后台同步没有启动。",
                    "准备好后点“保存并启用”。",
                    RabiGuidanceTone.SUCCESS,
                ))
            }
        }.onFailure { showSaveFailure(it) }
    }

    private fun syncNow() {
        val problem = activationProblem()
        if (problem != null) return showGuidance(problem)
        runCatching {
            val config = configFromForm(enabled = true)
            persist(config)
            enabled.isChecked = true
            WearableHealthSyncService.syncNow(this)
            showGuidance(RabiSetupGuidance(
                "已发起同步",
                if (config.collectorMode == WearableHealthCollectorMode.XIAOMI_ADB_COMPANION) "Rabi PC Companion 会在下一轮读取已配对设备。" else "App 正在读取 Health Connect 并上报给 Rabi。",
                "稍候查看这里的同步结果；失败时会显示具体原因。",
            ))
            status.postDelayed({ refreshStatus() }, 1_500)
        }.onFailure { showSaveFailure(it) }
    }

    private fun disableAndStop() {
        enabled.isChecked = false
        save(startAfterSave = false)
        WearableHealthSyncService.stop(this)
        showGuidance(RabiSetupGuidance(
            "健康同步已停止",
            "后台采集服务已经关闭，已有设置和历史记录不会被删除。",
            "需要时点“保存并启用”即可恢复。",
            RabiGuidanceTone.SUCCESS,
        ))
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
                showGuidance(RabiSetupGuidance(
                    "本机小米密钥已清除",
                    "App 不再保存 ADB Companion 所需的设备密钥。",
                    "重新使用小米 Companion 时，需要再次输入 32 位密钥。",
                    RabiGuidanceTone.SUCCESS,
                ))
            }
            .show()
    }

    private fun refreshStatus() {
        val value = WearableHealthSettings.load(this)
        val (last, at) = WearableHealthSettings.lastStatus(this)
        val time = if (at > 0) DateTimeFormatter.ofPattern("MM-dd HH:mm:ss").withZone(ZoneId.systemDefault()).format(Instant.ofEpochMilli(at)) else "-"
        val problem = activationProblem(selectedMode())
        val failed = last.contains("失败") || last.contains("不可用") || last.contains("拒绝")
        when {
            value.enabled && failed -> showGuidance(RabiSetupGuidance(
                "最近一次健康同步失败",
                "$time · $last",
                problem?.action ?: "检查 Health Connect 权限和 Rabi 首页连接后，再点“立即同步”。",
                RabiGuidanceTone.ERROR,
            ))
            value.enabled -> showGuidance(RabiSetupGuidance(
                "健康同步正在工作",
                "来源：${sourceName(value.collectorMode)}；最近状态：$time · $last",
                "无需保持此页面打开，App 会按设置继续同步。",
                RabiGuidanceTone.SUCCESS,
            ))
            problem != null -> showGuidance(problem)
            else -> showGuidance(RabiSetupGuidance(
                "采集条件已准备好",
                "${sourceName(selectedMode())} 可用，RabiLink 首页也已保存连接。",
                "点“保存并启用”；设备 ID 和常用参数会自动生成。",
                RabiGuidanceTone.INFO,
            ))
        }
    }

    private fun returnToHome() {
        startActivity(Intent(this, MainActivity::class.java)
            .putExtra("open_settings", true)
            .addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP))
        finish()
    }

    private fun selectedMode(): WearableHealthCollectorMode =
        if (::collectorMode.isInitialized && collectorMode.selectedItemPosition == 1) {
            WearableHealthCollectorMode.XIAOMI_ADB_COMPANION
        } else {
            WearableHealthCollectorMode.HEALTH_CONNECT
        }

    private fun sourceName(mode: WearableHealthCollectorMode): String =
        if (mode == WearableHealthCollectorMode.XIAOMI_ADB_COMPANION) "小米 ADB Companion" else "Health Connect"

    private fun activationProblem(mode: WearableHealthCollectorMode = selectedMode()): RabiSetupGuidance? {
        val relay = RabiLinkRelaySettings.load(this)
        if (!relay.configured) return RabiSetupGuidance(
            "还不能启用健康同步",
            "手机首页尚未完成 RabiLink 服务器和移动端登录码验证；没有安全连接时，健康数据无处上报。",
            "点“返回首页检查连接”，连接完成后再回来启用。",
            RabiGuidanceTone.WARNING,
        )
        if (mode == WearableHealthCollectorMode.XIAOMI_ADB_COMPANION) {
            val hasKey = authKey.text.toString().trim().isNotBlank() || WearableHealthSettings.load(this).hasAuthKey
            if (!hasKey) return RabiSetupGuidance(
                "还缺小米设备密钥",
                "ADB Companion 读取小米手表/手环时需要配对密钥，Android 无法绕过设备安全机制自动生成。",
                "从已授权的 Companion 配对流程取得 32 位密钥，填入高级设置；不使用 Companion 时改选 Health Connect。",
                RabiGuidanceTone.WARNING,
            )
            return null
        }
        return when (HealthConnectClient.getSdkStatus(this)) {
            HealthConnectClient.SDK_AVAILABLE -> null
            HealthConnectClient.SDK_UNAVAILABLE_PROVIDER_UPDATE_REQUIRED -> RabiSetupGuidance(
                "Health Connect 需要安装或更新",
                "当前系统支持健康连接，但提供程序版本太旧或尚未安装。App 不能替你同意系统安装。",
                "点“检查并授权 Health Connect”，按系统页面完成安装或更新。",
                RabiGuidanceTone.WARNING,
            )
            else -> RabiSetupGuidance(
                "这台手机暂时不能使用 Health Connect",
                "系统没有提供可用的 Health Connect 服务，或服务已被停用。",
                "更新系统或启用 Health Connect；也可以改用已配置的小米 ADB Companion。",
                RabiGuidanceTone.WARNING,
            )
        }
    }

    private fun configFromForm(enabled: Boolean): WearableHealthConfig {
        val mode = selectedMode()
        val policy = RabiWearableHealthPolicy(
            enabled = true,
            heartRateHighBpm = (highBpm.text.toString().toIntOrNull() ?: 120).coerceIn(40, 240),
            heartRateLowBpm = (lowBpm.text.toString().toIntOrNull() ?: 0).coerceIn(0, 150),
            heartRateAlertCooldownMinutes = (cooldownMinutes.text.toString().toIntOrNull() ?: 15).coerceIn(1, 1440),
            sleepStateAlertEnabled = sleepAlert.isChecked,
        )
        return WearableHealthConfig(
            enabled = enabled,
            collectorMode = mode,
            sourceDeviceId = normalizedDeviceId(mode),
            sourceDeviceName = deviceName.text.toString().trim().ifBlank {
                if (mode == WearableHealthCollectorMode.HEALTH_CONNECT) "Android Health Connect" else "小米智能穿戴设备"
            },
            sourceDeviceKind = deviceKind.text.toString().trim().lowercase().ifBlank { "wearable" },
            pollIntervalMinutes = (intervalMinutes.text.toString().toIntOrNull() ?: 5).coerceIn(1, 1440),
            lookbackHours = (lookbackHours.text.toString().toIntOrNull() ?: 24).coerceIn(1, 168),
            policy = policy,
            hasAuthKey = WearableHealthSettings.load(this).hasAuthKey || authKey.text.toString().trim().isNotBlank(),
        )
    }

    private fun normalizedDeviceId(mode: WearableHealthCollectorMode): String {
        val typed = deviceId.text.toString().trim()
        if (typed.isNotBlank() && typed != "mi-band-10-pro") return typed
        val suffix = Settings.Secure.getString(contentResolver, Settings.Secure.ANDROID_ID)
            .orEmpty().takeLast(8).ifBlank { "phone" }
        return "${if (mode == WearableHealthCollectorMode.XIAOMI_ADB_COMPANION) "xiaomi" else "health-connect"}-$suffix"
    }

    private fun persist(config: WearableHealthConfig) {
        WearableHealthSettings.save(this, config, authKey.text.toString().trim().ifBlank { null })
        deviceId.setText(config.sourceDeviceId)
        if (deviceName.text.toString().isBlank()) deviceName.setText(config.sourceDeviceName)
        if (deviceKind.text.toString().isBlank()) deviceKind.setText(config.sourceDeviceKind)
    }

    private fun showSaveFailure(error: Throwable) {
        showGuidance(RabiSetupGuidance(
            "设置没有保存",
            error.message ?: "App 无法校验当前输入。",
            "按提示修正输入后重试；小米密钥必须是 32 位十六进制。",
            RabiGuidanceTone.ERROR,
        ))
    }

    private fun showGuidance(value: RabiSetupGuidance) {
        if (!::status.isInitialized) return
        val styled = RabiMobileUi.guidance(this, value)
        status.text = styled.text
        status.setTextColor(styled.currentTextColor)
        status.background = styled.background
        if (::scroll.isInitialized) status.post { scroll.smoothScrollTo(0, 0) }
    }

    private fun fieldColumn(text: String, field: EditText) = LinearLayout(this).apply {
        orientation = LinearLayout.VERTICAL
        addView(label(text)); addView(field)
    }
    private fun card() = RabiMobileUi.card(this)
    private fun title(text: String) = RabiMobileUi.title(this, text)
    private fun note(text: String) = RabiMobileUi.note(this, text)
    private fun label(text: String) = RabiMobileUi.label(this, text)
    private fun input(hint: String) = RabiMobileUi.input(this, hint)
    private fun numberInput(hint: String) = input(hint).apply { inputType = InputType.TYPE_CLASS_NUMBER }
    private fun primary(text: String, action: () -> Unit) = RabiMobileUi.primary(this, text, action)
    private fun secondary(text: String, action: () -> Unit) = RabiMobileUi.secondary(this, text, action)
    private fun row() = LinearLayout(this).apply { orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER_VERTICAL }
    private fun space() = View(this)
    private fun full(l: Int, t: Int, r: Int, b: Int) = LinearLayout.LayoutParams(-1, -2).apply { setMargins(dp(l), dp(t), dp(r), dp(b)) }
    private fun dp(value: Int) = RabiMobileUi.dp(this, value)
}
