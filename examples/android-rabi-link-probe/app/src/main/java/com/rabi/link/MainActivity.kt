package com.rabi.link

import android.app.Activity
import android.content.Context
import android.content.Intent
import android.graphics.Color
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.PowerManager
import android.provider.Settings
import android.text.InputType
import android.text.method.ScrollingMovementMethod
import android.view.Gravity
import android.view.View
import android.widget.AdapterView
import android.widget.ArrayAdapter
import android.widget.Button
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.Spinner
import android.widget.TextView
import android.widget.Toast
import com.rabi.link.modules.rabiroute.RabiLinkRelayBridgeService
import com.rabiroute.sdk.RabiInstance
import com.rabiroute.sdk.RabiRouteInfo
import com.rabiroute.sdk.RabiRouteSdk
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

class MainActivity : Activity() {
    private val sdk = RabiRouteSdk()
    private val managers = mutableListOf<RabiInstance>()
    private val routes = mutableListOf<RabiRouteInfo>()
    private val logLines = StringBuilder()
    private var selectedInstance: RabiInstance? = null

    private lateinit var statusView: TextView
    private lateinit var managerSpinner: Spinner
    private lateinit var managerAdapter: ArrayAdapter<String>
    private lateinit var routeSpinner: Spinner
    private lateinit var routeAdapter: ArrayAdapter<String>
    private lateinit var relayBaseInput: EditText
    private lateinit var relayTokenInput: EditText
    private lateinit var callbackView: TextView
    private lateinit var bridgeStateView: TextView
    private lateinit var logView: TextView

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        buildUi()
        restoreRelayFields()
        refreshStatus("等待扫描")
        appendLog("RabiLink 已启动。先扫描 RabiRoute，再选择 Route。")
    }

    private fun buildUi() {
        val content = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(18), dp(18), dp(18), dp(18))
            setBackgroundColor(Color.rgb(246, 247, 249))
        }
        addHeader(content)
        statusView = statusPanel()
        content.addView(statusView, fullWidth(0, 0, 0, 14))
        addManagerCard(content)
        addBridgeCard(content)
        addToolsCard(content)

        val scroll = ScrollView(this)
        scroll.addView(content)

        val root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setBackgroundColor(Color.rgb(246, 247, 249))
        }
        root.addView(scroll, LinearLayout.LayoutParams(-1, 0, 1f))
        addFixedLog(root)
        setContentView(root)
    }

    private fun addHeader(content: LinearLayout) {
        content.addView(TextView(this).apply {
            text = "RabiLink"
            textSize = 26f
            typeface = Typeface.DEFAULT_BOLD
            setTextColor(Color.rgb(20, 25, 32))
        }, LinearLayout.LayoutParams(-1, -2))
        content.addView(TextView(this).apply {
            text = "连接 Rokid 眼镜、手机常驻桥、RabiRoute 和 Codex"
            textSize = 13f
            setTextColor(Color.rgb(88, 94, 104))
            setPadding(0, dp(4), 0, dp(12))
        }, LinearLayout.LayoutParams(-1, -2))
    }

    private fun addManagerCard(content: LinearLayout) {
        val card = card()
        card.addView(cardTitle("1. 选择 RabiRoute"))
        card.addView(cardText("先从局域网扫描 RabiRoute Manager。扫到后会显示电脑名、Rabi 名字和 IP，再选择要投递到 Codex 的 Route。"))

        managerAdapter = ArrayAdapter(this, android.R.layout.simple_spinner_item, mutableListOf("尚未扫描到 RabiRoute"))
        managerAdapter.setDropDownViewResource(android.R.layout.simple_spinner_dropdown_item)
        managerSpinner = Spinner(this).apply {
            adapter = managerAdapter
            onItemSelectedListener = object : AdapterView.OnItemSelectedListener {
                override fun onItemSelected(parent: AdapterView<*>?, view: View?, position: Int, id: Long) {
                    managers.getOrNull(position)?.let { selectManager(it, readRoutes = false) }
                }
                override fun onNothingSelected(parent: AdapterView<*>?) = Unit
            }
        }
        card.addView(label("RabiRoute"))
        card.addView(managerSpinner, fullWidth(0, 0, 0, 8))

        routeAdapter = ArrayAdapter(this, android.R.layout.simple_spinner_item, mutableListOf("先读取 Route"))
        routeAdapter.setDropDownViewResource(android.R.layout.simple_spinner_dropdown_item)
        routeSpinner = Spinner(this).apply {
            adapter = routeAdapter
            onItemSelectedListener = object : AdapterView.OnItemSelectedListener {
                override fun onItemSelected(parent: AdapterView<*>?, view: View?, position: Int, id: Long) {
                    refreshStatus("已选择 Route")
                }
                override fun onNothingSelected(parent: AdapterView<*>?) = Unit
            }
        }
        card.addView(label("Route"))
        card.addView(routeSpinner, fullWidth(0, 0, 0, 10))

        val row = row()
        row.addView(primaryButton("扫描") { scanManagers() }, LinearLayout.LayoutParams(0, -2, 1f))
        row.addView(space(), LinearLayout.LayoutParams(dp(8), 1))
        row.addView(secondaryButton("刷新 Route") { readRoutes() }, LinearLayout.LayoutParams(0, -2, 1f))
        card.addView(row)
        content.addView(card, fullWidth(0, 0, 0, 12))
    }

    private fun addBridgeCard(content: LinearLayout) {
        val card = card()
        card.addView(cardTitle("2. 启动手机桥"))
        card.addView(cardText("手机会作为后台常驻桥：从 Relay 接收眼镜任务，转交给电脑 RabiRoute，再把 Codex 回复写回 Relay。"))
        callbackView = cardText("RabiLink 回调：未选择 RabiRoute")
        card.addView(callbackView)

        relayBaseInput = input("Relay 地址")
        relayTokenInput = input("Relay Token").apply {
            inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_PASSWORD
        }
        card.addView(label("公网 Relay"))
        card.addView(relayBaseInput, fullWidth(0, 0, 0, 6))
        card.addView(label("Token"))
        card.addView(relayTokenInput, fullWidth(0, 0, 0, 8))

        bridgeStateView = cardText("状态：未启动")
        card.addView(bridgeStateView)

        val row = row()
        row.addView(primaryButton("启动常驻桥") { startBridge() }, LinearLayout.LayoutParams(0, -2, 1f))
        row.addView(space(), LinearLayout.LayoutParams(dp(8), 1))
        row.addView(secondaryButton("停止") { stopBridge() }, LinearLayout.LayoutParams(0, -2, 1f))
        card.addView(row, fullWidth(0, 6, 0, 6))
        card.addView(secondaryButton("电池常驻设置") { openBatteryOptimizationSettings() })
        content.addView(card, fullWidth(0, 0, 0, 12))
    }

    private fun addToolsCard(content: LinearLayout) {
        val card = card()
        card.addView(cardTitle("3. 测试与诊断"))
        card.addView(cardText("设备接口探针先放在这里。正式使用时只需要前两张卡。"))
        card.addView(secondaryButton("打开接口测试中心") {
            startActivity(Intent(this, TestCenterActivity::class.java))
        })
        content.addView(card, fullWidth(0, 0, 0, 12))
    }

    private fun scanManagers() {
        appendLog("正在扫描局域网 RabiRoute...")
        refreshStatus("扫描中")
        runAsync(
            work = { sdk.scanLan(this) },
            success = { found ->
                managers.clear()
                managers.addAll(found)
                managerAdapter.clear()
                if (found.isEmpty()) {
                    managerAdapter.add("没有扫描到 RabiRoute")
                    selectedInstance = null
                    callbackView.text = "RabiLink 回调：未选择 RabiRoute"
                    updateRoutes(emptyList())
                    appendLog("没有扫描到 RabiRoute。确认手机和电脑同一 Wi-Fi，Manager 对局域网开放。")
                    refreshStatus("未发现 RabiRoute")
                } else {
                    managerAdapter.addAll(found.map { managerLabel(it) })
                    managerSpinner.setSelection(0)
                    selectManager(found.first(), readRoutes = true)
                    appendLog("扫描到 ${found.size} 个 RabiRoute。")
                }
                managerAdapter.notifyDataSetChanged()
            }
        )
    }

    private fun selectManager(instance: RabiInstance, readRoutes: Boolean) {
        selectedInstance = instance
        callbackView.text = "RabiLink 回调：http://${instance.host}:8794/rabilink"
        refreshStatus("已选择 ${instance.name}")
        if (readRoutes) readRoutes()
    }

    private fun readRoutes() {
        val instance = selectedInstance ?: return toast("请先扫描并选择 RabiRoute")
        appendLog("正在读取 Route 列表...")
        runAsync(
            work = { sdk.getRoutes(instance) },
            success = { result ->
                updateRoutes(result)
                appendLog("读取到 ${result.size} 条 Route。")
                refreshStatus("Route 已刷新")
            }
        )
    }

    private fun updateRoutes(items: List<RabiRouteInfo>) {
        routes.clear()
        routes.addAll(items)
        routeAdapter.clear()
        if (items.isEmpty()) {
            routeAdapter.add("先读取 Route")
        } else {
            routeAdapter.addAll(items.map { routeLabel(it) })
        }
        routeAdapter.notifyDataSetChanged()
        if (items.isNotEmpty()) routeSpinner.setSelection(0)
    }

    private fun startBridge() {
        val instance = selectedInstance ?: return toast("请先选择 RabiRoute")
        val route = selectedRoute() ?: return toast("请先选择 Route")
        val relayBaseUrl = relayBaseInput.text.toString().trim()
        val token = relayTokenInput.text.toString().trim()
        val callbackUrl = "http://${instance.host}:8794/rabilink"
        if (relayBaseUrl.isBlank() || token.isBlank()) return toast("请填写 Relay 地址和 Token")

        saveBridgeConfig(instance, route.id, callbackUrl, relayBaseUrl, token, enabled = true)
        val intent = bridgeIntent(instance, route.id, callbackUrl, relayBaseUrl, token)
        if (Build.VERSION.SDK_INT >= 26) startForegroundService(intent) else startService(intent)
        bridgeStateView.text = "状态：常驻桥已启动"
        appendLog("常驻桥已启动：${routeDisplayName(route)} -> ${instance.host}")
        refreshStatus("手机桥运行中")
    }

    private fun stopBridge() {
        getSharedPreferences(RabiLinkRelayBridgeService.PREFS_NAME, Context.MODE_PRIVATE)
            .edit()
            .putBoolean(RabiLinkRelayBridgeService.PREF_ENABLED, false)
            .apply()
        startService(Intent(this, RabiLinkRelayBridgeService::class.java).setAction(RabiLinkRelayBridgeService.ACTION_STOP))
        bridgeStateView.text = "状态：已停止"
        appendLog("常驻桥已停止。")
        refreshStatus("手机桥已停止")
    }

    private fun bridgeIntent(instance: RabiInstance, routeId: String, callbackUrl: String, relayBaseUrl: String, token: String): Intent =
        Intent(this, RabiLinkRelayBridgeService::class.java).apply {
            putExtra(RabiLinkRelayBridgeService.EXTRA_RELAY_BASE_URL, relayBaseUrl)
            putExtra(RabiLinkRelayBridgeService.EXTRA_TOKEN, token)
            putExtra(RabiLinkRelayBridgeService.EXTRA_ROUTE_ID, routeId)
            putExtra(RabiLinkRelayBridgeService.EXTRA_CALLBACK_URL, callbackUrl)
            putExtra(RabiLinkRelayBridgeService.EXTRA_MANAGER_BASE_URL, instance.baseUrl)
            putExtra(RabiLinkRelayBridgeService.EXTRA_INSTANCE_GUID, instance.guid)
            putExtra(RabiLinkRelayBridgeService.EXTRA_INSTANCE_NAME, instance.name)
            putExtra(RabiLinkRelayBridgeService.EXTRA_COMPUTER_NAME, instance.computerName)
            putExtra(RabiLinkRelayBridgeService.EXTRA_DEVICE_TYPE, instance.deviceType)
        }

    private fun saveBridgeConfig(instance: RabiInstance, routeId: String, callbackUrl: String, relayBaseUrl: String, token: String, enabled: Boolean) {
        getSharedPreferences(RabiLinkRelayBridgeService.PREFS_NAME, Context.MODE_PRIVATE)
            .edit()
            .putBoolean(RabiLinkRelayBridgeService.PREF_ENABLED, enabled)
            .putString(RabiLinkRelayBridgeService.EXTRA_RELAY_BASE_URL, relayBaseUrl)
            .putString(RabiLinkRelayBridgeService.EXTRA_TOKEN, token)
            .putString(RabiLinkRelayBridgeService.EXTRA_ROUTE_ID, routeId)
            .putString(RabiLinkRelayBridgeService.EXTRA_CALLBACK_URL, callbackUrl)
            .putString(RabiLinkRelayBridgeService.EXTRA_MANAGER_BASE_URL, instance.baseUrl)
            .putString(RabiLinkRelayBridgeService.EXTRA_INSTANCE_GUID, instance.guid)
            .putString(RabiLinkRelayBridgeService.EXTRA_INSTANCE_NAME, instance.name)
            .putString(RabiLinkRelayBridgeService.EXTRA_COMPUTER_NAME, instance.computerName)
            .putString(RabiLinkRelayBridgeService.EXTRA_DEVICE_TYPE, instance.deviceType)
            .apply()
    }

    private fun restoreRelayFields() {
        val prefs = getSharedPreferences(RabiLinkRelayBridgeService.PREFS_NAME, Context.MODE_PRIVATE)
        relayBaseInput.setText(prefs.getString(RabiLinkRelayBridgeService.EXTRA_RELAY_BASE_URL, "https://rabi.example.com"))
        relayTokenInput.setText(prefs.getString(RabiLinkRelayBridgeService.EXTRA_TOKEN, ""))
        bridgeStateView.text = if (prefs.getBoolean(RabiLinkRelayBridgeService.PREF_ENABLED, false)) {
            "状态：已保存为后台常驻"
        } else {
            "状态：未启动"
        }
    }

    private fun openBatteryOptimizationSettings() {
        try {
            if (Build.VERSION.SDK_INT >= 23) {
                val powerManager = getSystemService(PowerManager::class.java)
                if (powerManager?.isIgnoringBatteryOptimizations(packageName) != true) {
                    startActivity(Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS).apply {
                        data = Uri.parse("package:$packageName")
                    })
                    return
                }
            }
            startActivity(Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS).apply {
                data = Uri.parse("package:$packageName")
            })
        } catch (_: Throwable) {
            startActivity(Intent(Settings.ACTION_SETTINGS))
        }
    }

    private fun selectedRoute(): RabiRouteInfo? = routes.getOrNull(routeSpinner.selectedItemPosition)
    private fun managerLabel(instance: RabiInstance): String = "${instance.name} · ${instance.host}"
    private fun routeLabel(route: RabiRouteInfo): String = "${routeDisplayName(route)} · ${if (route.enabled) "启用" else "停用"}"
    private fun routeDisplayName(route: RabiRouteInfo): String =
        route.configName.ifBlank { routeRuntimeConfigName(route.id).ifBlank { route.name.ifBlank { route.id } } }

    private fun routeRuntimeConfigName(routeId: String): String {
        val parts = routeId.split("__")
        return if (parts.size > 1) parts.drop(1).joinToString("__") else routeId
    }

    private fun refreshStatus(extra: String = "") {
        val instance = selectedInstance
        val route = selectedRoute()
        statusView.text = buildString {
            appendLine("当前连接")
            appendLine("RabiRoute：${instance?.name ?: "未选择"}")
            appendLine("电脑：${instance?.computerName ?: "未选择"}")
            appendLine("IP：${instance?.host ?: "未选择"}")
            appendLine("Route：${route?.let { routeDisplayName(it) } ?: "未选择"}")
            if (extra.isNotBlank()) appendLine(extra)
        }.trimEnd()
    }

    private fun addFixedLog(root: LinearLayout) {
        val panel = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(14), dp(10), dp(14), dp(10))
            background = panelBackground(Color.WHITE, Color.rgb(217, 222, 230), 0f)
        }
        panel.addView(TextView(this).apply {
            text = "日志"
            textSize = 13f
            typeface = Typeface.DEFAULT_BOLD
            setTextColor(Color.rgb(34, 40, 48))
        }, LinearLayout.LayoutParams(-1, -2))
        logView = TextView(this).apply {
            textSize = 11f
            setTextColor(Color.rgb(54, 60, 70))
            movementMethod = ScrollingMovementMethod()
            minLines = 4
            maxLines = 6
        }
        panel.addView(logView, LinearLayout.LayoutParams(-1, dp(92)))
        root.addView(panel, LinearLayout.LayoutParams(-1, -2))
    }

    private fun appendLog(message: String) {
        val time = SimpleDateFormat("HH:mm:ss", Locale.US).format(Date())
        logLines.append("[$time] $message\n")
        logView.text = logLines.toString().takeLast(2500)
        val scrollAmount = logView.layout?.let { it.getLineTop(logView.lineCount) - logView.height } ?: 0
        if (scrollAmount > 0) logView.scrollTo(0, scrollAmount)
    }

    private fun <T> runAsync(work: () -> T, success: (T) -> Unit) {
        Thread {
            try {
                val result = work()
                runOnUiThread { success(result) }
            } catch (error: Throwable) {
                runOnUiThread {
                    appendLog("失败：${error.message ?: error.javaClass.simpleName}")
                    refreshStatus("操作失败")
                }
            }
        }.start()
    }

    private fun card(): LinearLayout = LinearLayout(this).apply {
        orientation = LinearLayout.VERTICAL
        setPadding(dp(14), dp(12), dp(14), dp(12))
        background = panelBackground(Color.WHITE, Color.rgb(218, 222, 228), dp(8).toFloat())
    }

    private fun statusPanel(): TextView = TextView(this).apply {
        textSize = 13f
        setTextColor(Color.rgb(31, 38, 48))
        setPadding(dp(14), dp(12), dp(14), dp(12))
        background = panelBackground(Color.rgb(236, 244, 255), Color.rgb(174, 199, 237), dp(8).toFloat())
    }

    private fun cardTitle(value: String): TextView = TextView(this).apply {
        text = value
        textSize = 17f
        typeface = Typeface.DEFAULT_BOLD
        setTextColor(Color.rgb(24, 30, 38))
    }

    private fun cardText(value: String): TextView = TextView(this).apply {
        text = value
        textSize = 12f
        setTextColor(Color.rgb(80, 87, 98))
        setPadding(0, dp(6), 0, dp(8))
    }

    private fun label(value: String): TextView = TextView(this).apply {
        text = value
        textSize = 12f
        typeface = Typeface.DEFAULT_BOLD
        setTextColor(Color.rgb(62, 70, 82))
        setPadding(0, dp(4), 0, dp(3))
    }

    private fun input(hint: String): EditText = EditText(this).apply {
        this.hint = hint
        textSize = 13f
        setSingleLine(true)
        setPadding(dp(10), 0, dp(10), 0)
        background = panelBackground(Color.WHITE, Color.rgb(205, 211, 220), dp(6).toFloat())
    }

    private fun primaryButton(value: String, action: () -> Unit): Button = Button(this).apply {
        text = value
        isAllCaps = false
        setTextColor(Color.WHITE)
        background = panelBackground(Color.rgb(36, 95, 235), Color.rgb(36, 95, 235), dp(8).toFloat())
        setOnClickListener { action() }
    }

    private fun secondaryButton(value: String, action: () -> Unit): Button = Button(this).apply {
        text = value
        isAllCaps = false
        setTextColor(Color.rgb(38, 48, 68))
        background = panelBackground(Color.rgb(239, 242, 247), Color.rgb(213, 218, 226), dp(8).toFloat())
        setOnClickListener { action() }
    }

    private fun row(): LinearLayout = LinearLayout(this).apply {
        orientation = LinearLayout.HORIZONTAL
        gravity = Gravity.CENTER_VERTICAL
    }

    private fun space(): View = View(this)

    private fun fullWidth(left: Int, top: Int, right: Int, bottom: Int): LinearLayout.LayoutParams =
        LinearLayout.LayoutParams(-1, -2).apply {
            setMargins(dp(left), dp(top), dp(right), dp(bottom))
        }

    private fun panelBackground(color: Int, stroke: Int, radius: Float): GradientDrawable =
        GradientDrawable().apply {
            setColor(color)
            setStroke(dp(1), stroke)
            cornerRadius = radius
        }

    private fun toast(message: String) {
        Toast.makeText(this, message, Toast.LENGTH_SHORT).show()
        appendLog(message)
    }

    private fun dp(value: Int): Int = (value * resources.displayMetrics.density + 0.5f).toInt()
}
