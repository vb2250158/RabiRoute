package com.rabi.link.modules.rabiroute

import android.app.Activity
import android.content.ClipData
import android.content.ClipboardManager
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
import android.util.Log
import android.view.Gravity
import android.view.View
import android.widget.Button
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.ArrayAdapter
import android.widget.AdapterView
import android.widget.Spinner
import android.widget.TextView
import android.widget.Toast
import com.rabiroute.sdk.RabiAgentBinding
import com.rabiroute.sdk.RabiInstance
import com.rabiroute.sdk.RabiRouteInfo
import com.rabiroute.sdk.RabiRouteSdk
import org.json.JSONObject
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

class RabiRouteSdkProbeActivity : Activity() {
    private val sdk = RabiRouteSdk()
    private val report = StringBuilder()
    private val discoveredManagers = mutableListOf<RabiInstance>()
    private val discoveredRoutes = mutableListOf<RabiRouteInfo>()
    private val cwdOptionValues = mutableListOf("")
    private val threadOptionValues = mutableListOf("")
    private var selectedInstance: RabiInstance? = null
    private lateinit var dashboardView: TextView
    private lateinit var output: TextView
    private lateinit var advancedPanel: View
    private lateinit var advancedToggle: Button
    private lateinit var managerSelector: Spinner
    private lateinit var managerAdapter: ArrayAdapter<String>
    private lateinit var routeSelector: Spinner
    private lateinit var routeAdapter: ArrayAdapter<String>
    private lateinit var cwdSelector: Spinner
    private lateinit var cwdAdapter: ArrayAdapter<String>
    private lateinit var threadSelector: Spinner
    private lateinit var threadAdapter: ArrayAdapter<String>
    private lateinit var baseUrlInput: EditText
    private lateinit var callbackUrlInput: EditText
    private lateinit var relayBaseUrlInput: EditText
    private lateinit var relayTokenInput: EditText
    @Volatile private var relayBridgeRunning = false
    private var relayBridgeThread: Thread? = null

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        buildUi()
        val autoProbe = intent.getBooleanExtra("autoProbe", false)
        saveProbeStatus("created autoProbe=$autoProbe")
        intent.getStringExtra("baseUrl")?.takeIf { it.isNotBlank() }?.let {
            baseUrlInput.setText(it)
        }
        append("RabiRoute / RabiLink 测试台已启动。")
        append("先扫描局域网 RabiRoute；扫到后自动推导 Manager 和 RabiLink URL。")
        maybeResumeRelayBridge()
        if (autoProbe) {
            baseUrlInput.post { runFullProbeFromBaseUrl() }
        }
    }

    override fun onDestroy() {
        relayBridgeRunning = false
        relayBridgeThread?.interrupt()
        super.onDestroy()
    }

    private fun buildUi() {
        val content = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(18), dp(16), dp(18), dp(18))
            setBackgroundColor(Color.rgb(246, 247, 249))
        }

        addHeader(content)
        dashboardView = addDashboard(content)

        baseUrlInput = plainInput("RabiRoute Manager URL，默认 USB 反向端口")
        baseUrlInput.setText("http://127.0.0.1:8790")
        callbackUrlInput = plainInput("RabiLink 回调 URL，默认 USB 反向端口")
        callbackUrlInput.setText("http://127.0.0.1:8794/rabilink")
        relayBaseUrlInput = plainInput("公网 RabiLink Relay URL")
        relayBaseUrlInput.setText("https://rabi.example.com")
        relayTokenInput = plainInput("公网 Relay Token")
        relayTokenInput.setText("")
        val managerSelectorPanel = managerSelectorPanel()
        val routeBindingPanel = routeBindingPanel()
        val relayBridgePanel = relayBridgePanel()

        addSectionTitle(content, "测试矩阵")
        addCapabilityBlockWithExtra(
            content,
            "01 局域网 RabiRoute 发现",
            "先扫描局域网里的 RabiRoute Manager；扫到后自动拿到电脑 IP。",
            "用途：这是整个手机测试页的前提。拿到 Manager IP 后，页面会自动推导 Manager URL 和 RabiLink 回调 URL。",
            "前置：电脑端 Manager 允许局域网访问；手机和电脑在同一 Wi-Fi；Windows 防火墙放行 8790。",
            "证据：identity、guid、computer、version，以及自动生成的 http://电脑IP:8794/rabilink。",
            managerSelectorPanel,
            button("扫描并自动配置") { scanRabiRoutes() },
            button("读取当前 Manager") { readIdentityFromBaseUrl() },
            button("读取 Route 列表") { readRoutesAndOptions() },
            button("完整只读探测") { runFullProbeFromBaseUrl() }
        )
        addCapabilityBlock(
            content,
            "02 RabiLink 回调端",
            "用第一张卡片选中的 RabiRoute 测试 /rabilink 探活和真实消息投递。",
            "用途：这是 Rokid/手机语音到 Codex 的主链路；选定 RabiRoute 后，先探活，再发送一条测试消息。",
            "前置：RabiLink 适配器已启动；局域网测试需电脑防火墙放行 8794；USB 临时测试可用默认 127.0.0.1。",
            "证据：GET /rabilink 返回 ready；POST /rabilink 返回 accepted 和 messageId，并在 RabiRoute/Codex 侧产生事件。",
            button("1. 探活当前 RabiLink") { probeCallbackUrl() },
            button("2. 投递测试消息") { deliverRabiLinkTestMessage() }
        )
        addCapabilityBlockWithExtra(
            content,
            "03 公网 Relay 手机桥",
            "手机作为低延迟桥：从公网 relay 长轮询取眼镜任务，转交本机 RabiRoute/Codex，再把回包写回 relay。",
            "用途：这是 Rokid 智能体真正连到 Codex 的关键桥。启动后，Rizon 后台或眼镜里的 RabiLink 请求会被手机取走处理。",
            "前置：第一张卡片已经选中 RabiRoute 和 Route；手机能访问公网 relay，也能访问电脑的 RabiLink 回调端。",
            "证据：日志会显示 claim task、投递到本机 messageId、append 回公网 relay 的回复。",
            relayBridgePanel,
            button("启动极速桥") { startRelayBridge() },
            button("停止桥") { stopRelayBridge() },
            button("只取一次公网任务") { claimRelayOnce() },
            button("电池常驻设置") { openBatteryOptimizationSettings() }
        )
        addCapabilityBlockWithExtra(
            content,
            "04 Route / Codex 绑定",
            "读取路由后，把某条 Route 绑定到 Codex 工作目录和线程名。",
            "用途：这是手机端管理能力，不是眼镜必须项；后面要做手机集成管理时再常用。",
            "前置：已经选中一个 Manager；绑定参数只属于这张卡片。",
            "证据：路由列表、可选 Agent、PATCH 后返回的绑定 JSON。",
            routeBindingPanel,
            button("刷新 Codex 候选") { refreshSelectedRouteOptions() },
            button("设置 Codex 绑定") { setBinding() }
        )

        advancedToggle = button("显示高级参数") { toggleAdvancedPanel() }
        content.addView(advancedToggle, fullWidthWithMargins(0, 2, 0, 8))
        advancedPanel = advancedPanel()
        advancedPanel.visibility = View.GONE
        content.addView(advancedPanel, fullWidthWithMargins(0, 0, 0, 12))

        val page = ScrollView(this)
        page.addView(content)

        val root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setBackgroundColor(Color.rgb(246, 247, 249))
        }
        root.addView(page, LinearLayout.LayoutParams(-1, 0, 1f))
        addFixedLogPanel(root)
        setContentView(root)
        refreshDashboard()
    }

    private fun addHeader(content: LinearLayout) {
        content.addView(TextView(this).apply {
            text = "RabiRoute / RabiLink 测试台"
            textSize = 23f
            typeface = Typeface.DEFAULT_BOLD
            setTextColor(Color.rgb(24, 28, 34))
        }, LinearLayout.LayoutParams(-1, -2))
        content.addView(TextView(this).apply {
            text = "按“回调端、管理端、绑定管理”三层验证，常用测试不用先填表。"
            textSize = 13f
            setTextColor(Color.rgb(86, 92, 102))
            setPadding(0, dp(4), 0, dp(12))
        }, LinearLayout.LayoutParams(-1, -2))
    }

    private fun addDashboard(content: LinearLayout): TextView {
        val dashboard = TextView(this).apply {
            textSize = 13f
            setTextColor(Color.rgb(35, 42, 52))
            setPadding(dp(14), dp(12), dp(14), dp(12))
            background = panelBackground(Color.rgb(236, 244, 255), Color.rgb(180, 204, 240))
        }
        content.addView(dashboard, fullWidthWithMargins(0, 0, 0, 14))
        return dashboard
    }

    private fun addSectionTitle(content: LinearLayout, text: String) {
        content.addView(TextView(this).apply {
            this.text = text
            textSize = 15f
            typeface = Typeface.DEFAULT_BOLD
            setTextColor(Color.rgb(42, 47, 55))
            setPadding(0, dp(8), 0, dp(8))
        }, LinearLayout.LayoutParams(-1, -2))
    }

    private fun addCapabilityBlock(
        content: LinearLayout,
        title: String,
        summary: String,
        useCase: String,
        prerequisite: String,
        evidence: String,
        vararg actions: Button
    ) {
        addCapabilityBlockWithExtra(content, title, summary, useCase, prerequisite, evidence, null, *actions)
    }

    private fun addCapabilityBlockWithExtra(
        content: LinearLayout,
        title: String,
        summary: String,
        useCase: String,
        prerequisite: String,
        evidence: String,
        extraContent: View?,
        vararg actions: Button
    ) {
        val block = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(14), dp(12), dp(14), dp(12))
            background = panelBackground(Color.WHITE, Color.rgb(218, 222, 228))
        }
        block.addView(TextView(this).apply {
            text = title
            textSize = 16f
            typeface = Typeface.DEFAULT_BOLD
            setTextColor(Color.rgb(22, 28, 36))
        }, LinearLayout.LayoutParams(-1, -2))
        block.addView(text(summary, 13, Color.rgb(70, 77, 88)).apply {
            setPadding(0, dp(4), 0, dp(6))
        }, LinearLayout.LayoutParams(-1, -2))
        block.addView(text(useCase, 12, Color.rgb(58, 76, 102)), LinearLayout.LayoutParams(-1, -2))
        block.addView(text(prerequisite, 12, Color.rgb(92, 98, 108)), LinearLayout.LayoutParams(-1, -2))
        block.addView(text(evidence, 12, Color.rgb(92, 98, 108)).apply {
            setPadding(0, 0, 0, dp(8))
        }, LinearLayout.LayoutParams(-1, -2))
        if (extraContent != null) {
            block.addView(extraContent, fullWidthWithMargins(0, 0, 0, 8))
        }
        for (action in actions) {
            block.addView(action, fullWidthWithMargins(0, 0, 0, 6))
        }
        content.addView(block, fullWidthWithMargins(0, 0, 0, 12))
    }

    private fun managerSelectorPanel(): View =
        LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(0, dp(8), 0, dp(6))
            addView(text("已发现 RabiRoute", 12, Color.rgb(72, 78, 88)), fullWidthWithMargins(0, 0, 0, 4))
            managerAdapter = ArrayAdapter(
                this@RabiRouteSdkProbeActivity,
                android.R.layout.simple_spinner_item,
                mutableListOf("尚未扫描到 RabiRoute")
            ).also {
                it.setDropDownViewResource(android.R.layout.simple_spinner_dropdown_item)
            }
            managerSelector = Spinner(this@RabiRouteSdkProbeActivity).apply {
                adapter = managerAdapter
                onItemSelectedListener = object : AdapterView.OnItemSelectedListener {
                    override fun onItemSelected(parent: AdapterView<*>?, view: View?, position: Int, id: Long) {
                        discoveredManagers.getOrNull(position)?.let { selectManager(it) }
                    }

                    override fun onNothingSelected(parent: AdapterView<*>?) = Unit
                }
            }
            addView(managerSelector, fullWidthWithMargins(0, 0, 0, 4))
            addView(text("选择一个 RabiRoute 后，下面所有测试都使用它的 IP、名称和路由信息。", 12, Color.rgb(92, 98, 108)), fullWidthWithMargins(0, 0, 0, 8))

            addView(text("当前 Route", 12, Color.rgb(72, 78, 88)), fullWidthWithMargins(0, 0, 0, 4))
            routeAdapter = ArrayAdapter(
                this@RabiRouteSdkProbeActivity,
                android.R.layout.simple_spinner_item,
                mutableListOf("先读取 Route 列表")
            ).also { it.setDropDownViewResource(android.R.layout.simple_spinner_dropdown_item) }
            routeSelector = Spinner(this@RabiRouteSdkProbeActivity).apply {
                adapter = routeAdapter
                onItemSelectedListener = object : AdapterView.OnItemSelectedListener {
                    override fun onItemSelected(parent: AdapterView<*>?, view: View?, position: Int, id: Long) {
                        discoveredRoutes.getOrNull(position)?.let { loadOptionsForRoute(it.id) }
                    }

                    override fun onNothingSelected(parent: AdapterView<*>?) = Unit
                }
            }
            addView(routeSelector, fullWidthWithMargins(0, 0, 0, 4))
            addView(text("Route 也是全局上下文；后面的 RabiLink、Codex 绑定和测试动作都以这里选中的 Route 为准。", 12, Color.rgb(92, 98, 108)), LinearLayout.LayoutParams(-1, -2))
        }

    private fun routeBindingPanel(): View =
        LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(0, dp(8), 0, dp(6))
            addView(text("Codex 绑定参数", 12, Color.rgb(72, 78, 88)), fullWidthWithMargins(0, 0, 0, 4))
            addView(text("这里不再选择 Route，只配置第一张卡片当前 Route 的 Codex 绑定。", 12, Color.rgb(92, 98, 108)), fullWidthWithMargins(0, 0, 0, 6))

            cwdAdapter = ArrayAdapter(
                this@RabiRouteSdkProbeActivity,
                android.R.layout.simple_spinner_item,
                mutableListOf("留空 = RabiRoute 根目录")
            ).also { it.setDropDownViewResource(android.R.layout.simple_spinner_dropdown_item) }
            cwdSelector = Spinner(this@RabiRouteSdkProbeActivity).apply { adapter = cwdAdapter }
            addView(text("Codex 工作目录", 12, Color.rgb(72, 78, 88)), fullWidthWithMargins(0, 4, 0, 3))
            addView(cwdSelector, fullWidthWithMargins(0, 0, 0, 6))

            threadAdapter = ArrayAdapter(
                this@RabiRouteSdkProbeActivity,
                android.R.layout.simple_spinner_item,
                mutableListOf("留空 = 按路由名自动创建")
            ).also { it.setDropDownViewResource(android.R.layout.simple_spinner_dropdown_item) }
            threadSelector = Spinner(this@RabiRouteSdkProbeActivity).apply { adapter = threadAdapter }
            addView(text("Codex 会话线程", 12, Color.rgb(72, 78, 88)), fullWidthWithMargins(0, 4, 0, 3))
            addView(threadSelector, fullWidthWithMargins(0, 0, 0, 0))
        }

    private fun relayBridgePanel(): View =
        LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(0, dp(8), 0, dp(6))
            addView(text("公网 Relay", 12, Color.rgb(72, 78, 88)), fullWidthWithMargins(0, 0, 0, 3))
            addView(relayBaseUrlInput, fullWidthWithMargins(0, 0, 0, 6))
            addView(text("Token", 12, Color.rgb(72, 78, 88)), fullWidthWithMargins(0, 0, 0, 3))
            addView(relayTokenInput, fullWidthWithMargins(0, 0, 0, 6))
            addView(text("启动后保持本页打开。低延迟模式使用 30 秒长轮询，服务器一有任务就立即返回。", 12, Color.rgb(92, 98, 108)), LinearLayout.LayoutParams(-1, -2))
        }

    private fun advancedPanel(): View =
        LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(14), dp(12), dp(14), dp(12))
            background = panelBackground(Color.WHITE, Color.rgb(218, 222, 228))
            addView(text("高级参数", 16, Color.rgb(22, 28, 36)).apply {
                typeface = Typeface.DEFAULT_BOLD
            }, LinearLayout.LayoutParams(-1, -2))
            addView(text("这里只放全局连接兜底参数；Codex 绑定参数在自己的卡片里。", 12, Color.rgb(92, 98, 108)), fullWidthWithMargins(0, 4, 0, 8))
            addLabeledInput(this, "Manager URL", baseUrlInput)
            addLabeledInput(this, "RabiLink 回调 URL", callbackUrlInput)
            addLabeledInput(this, "公网 Relay URL", relayBaseUrlInput)
            addLabeledInput(this, "公网 Relay Token", relayTokenInput)
        }

    private fun addLabeledInput(root: LinearLayout, label: String, input: EditText) {
        root.addView(text(label, 12, Color.rgb(72, 78, 88)), fullWidthWithMargins(0, 4, 0, 3))
        root.addView(input, fullWidthWithMargins(0, 0, 0, 6))
    }

    private fun addFixedLogPanel(root: LinearLayout) {
        val panel = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(12), dp(10), dp(12), dp(12))
            background = panelBackground(Color.WHITE, Color.rgb(198, 204, 214))
        }
        val header = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
        }
        header.addView(TextView(this).apply {
            text = "固定日志"
            textSize = 14f
            typeface = Typeface.DEFAULT_BOLD
            setTextColor(Color.rgb(32, 38, 46))
        }, LinearLayout.LayoutParams(0, -2, 1f))
        header.addView(button("复制") { copyReport() }, LinearLayout.LayoutParams(dp(96), -2))
        panel.addView(header, LinearLayout.LayoutParams(-1, -2))

        output = TextView(this).apply {
            textSize = 11f
            setTextColor(Color.rgb(36, 39, 44))
            setPadding(dp(10), dp(8), dp(10), dp(8))
            movementMethod = ScrollingMovementMethod()
            background = panelBackground(Color.rgb(247, 248, 250), Color.rgb(224, 228, 234))
        }
        val logScroll = ScrollView(this)
        logScroll.addView(output)
        panel.addView(logScroll, LinearLayout.LayoutParams(-1, 0, 1f))
        root.addView(panel, LinearLayout.LayoutParams(-1, dp(260)))
    }

    private fun toggleAdvancedPanel() {
        val visible = advancedPanel.visibility != View.VISIBLE
        advancedPanel.visibility = if (visible) View.VISIBLE else View.GONE
        advancedToggle.text = if (visible) "隐藏高级参数" else "显示高级参数"
    }

    private fun updateDiscoveredManagers(instances: List<RabiInstance>) {
        discoveredManagers.clear()
        discoveredManagers.addAll(instances)
        managerAdapter.clear()
        if (instances.isEmpty()) {
            managerAdapter.add("尚未扫描到 RabiRoute")
        } else {
            managerAdapter.addAll(instances.map { managerLabel(it) })
        }
        managerAdapter.notifyDataSetChanged()
        if (instances.isNotEmpty()) {
            managerSelector.setSelection(0)
            selectManager(instances.first())
        } else {
            selectedInstance = null
            refreshDashboard("未发现可选 RabiRoute")
        }
    }

    private fun addOrSelectManager(instance: RabiInstance) {
        val existingIndex = discoveredManagers.indexOfFirst { it.guid == instance.guid }
        if (existingIndex >= 0) {
            discoveredManagers[existingIndex] = instance
        } else {
            discoveredManagers.add(instance)
        }
        managerAdapter.clear()
        managerAdapter.addAll(discoveredManagers.map { managerLabel(it) })
        managerAdapter.notifyDataSetChanged()
        val index = discoveredManagers.indexOfFirst { it.guid == instance.guid }.coerceAtLeast(0)
        managerSelector.setSelection(index)
        selectManager(discoveredManagers[index])
    }

    private fun selectManager(instance: RabiInstance) {
        selectedInstance = instance
        baseUrlInput.setText(instance.baseUrl)
        callbackUrlInput.setText("http://${instance.host}:8794/rabilink")
        updateRoutes(emptyList())
        refreshDashboard("已选择 ${instance.host}")
    }

    private fun managerLabel(instance: RabiInstance): String =
        "${instance.name}  ${instance.host}"

    private fun updateRoutes(routes: List<RabiRouteInfo>, selectedRouteId: String? = null) {
        discoveredRoutes.clear()
        discoveredRoutes.addAll(routes)
        routeAdapter.clear()
        if (routes.isEmpty()) {
            routeAdapter.add("先读取路由")
        } else {
            routeAdapter.addAll(routes.map { routeLabel(it) })
        }
        routeAdapter.notifyDataSetChanged()
        if (routes.isEmpty()) {
            updateBindingOptions(null)
            refreshDashboard("未读取路由")
            return
        }
        val targetIndex = routes.indexOfFirst { it.id == selectedRouteId }.takeIf { it >= 0 } ?: 0
        routeSelector.setSelection(targetIndex)
        loadOptionsForRoute(routes[targetIndex].id)
    }

    private fun routeLabel(route: RabiRouteInfo): String =
        "${routeDisplayName(route)}  ${if (route.running) "运行中" else "未运行"}"

    private fun routeDisplayName(route: RabiRouteInfo): String =
        route.configName.ifBlank { routeRuntimeConfigName(route.id).ifBlank { route.id } }

    private fun routeRuntimeConfigName(routeId: String): String {
        val parts = routeId.split("__")
        return if (parts.size > 1) parts.drop(1).joinToString("__") else routeId
    }

    private fun selectedRouteId(): String =
        discoveredRoutes.getOrNull(routeSelector.selectedItemPosition)?.id.orEmpty()

    private fun selectedRouteDisplayName(): String =
        discoveredRoutes.getOrNull(routeSelector.selectedItemPosition)?.let { routeDisplayName(it) }.orEmpty()

    private fun selectedCwd(): String =
        cwdOptionValues.getOrNull(cwdSelector.selectedItemPosition).orEmpty()

    private fun selectedThreadName(): String =
        threadOptionValues.getOrNull(threadSelector.selectedItemPosition).orEmpty()

    private fun loadOptionsForRoute(routeId: String) {
        val instance = selectedInstance ?: return
        if (routeId.isBlank()) return
        append("正在加载 Route 的 Codex 候选：$routeId")
        runAsync {
            val options = sdk.getAgentOptions(instance, routeId)
            runOnUiThread { updateBindingOptions(options) }
            refreshDashboard("selectedRoute=$routeId")
            "Route 候选已加载：\n${options.toString(2)}"
        }
    }

    private fun refreshSelectedRouteOptions() {
        val routeId = selectedRouteId()
        if (routeId.isBlank()) {
            append("请先在第一张卡片读取并选择 Route。")
            return
        }
        loadOptionsForRoute(routeId)
    }

    private fun updateBindingOptions(options: JSONObject?) {
        val route = options?.optJSONObject("route")
        val currentCwd = route?.optString("codexCwd").orEmpty()
        val currentThread = route?.optString("codexThreadName").orEmpty()
        val cwdOptions = listOf("") + jsonStringList(options, "cwdOptions").filter { it.isNotBlank() }.distinct()
        val threadOptions = listOf("") + jsonStringList(options, "threadNames").filter { it.isNotBlank() }.distinct()

        cwdOptionValues.clear()
        cwdOptionValues.addAll(cwdOptions)
        cwdAdapter.clear()
        cwdAdapter.addAll(cwdOptions.map { if (it.isBlank()) "留空 = RabiRoute 根目录" else it })
        cwdAdapter.notifyDataSetChanged()
        cwdSelector.setSelection(cwdOptions.indexOf(currentCwd).takeIf { it >= 0 } ?: 0)

        threadOptionValues.clear()
        threadOptionValues.addAll(threadOptions)
        threadAdapter.clear()
        threadAdapter.addAll(threadOptions.map { if (it.isBlank()) "留空 = 按路由名自动创建" else it })
        threadAdapter.notifyDataSetChanged()
        threadSelector.setSelection(threadOptions.indexOf(currentThread).takeIf { it >= 0 } ?: 0)
    }

    private fun jsonStringList(json: JSONObject?, key: String): List<String> {
        val array = json?.optJSONArray(key) ?: return emptyList()
        return (0 until array.length()).mapNotNull { index ->
            array.optString(index).trim().takeIf { it.isNotBlank() }
        }
    }

    private fun plainInput(hint: String): EditText =
        EditText(this).apply {
            this.hint = hint
            setSingleLine(true)
            textSize = 13f
            setTextColor(Color.rgb(32, 38, 46))
            setHintTextColor(Color.rgb(120, 128, 140))
            inputType = InputType.TYPE_CLASS_TEXT
            background = panelBackground(Color.rgb(247, 248, 250), Color.rgb(204, 211, 220))
            setPadding(dp(10), dp(8), dp(10), dp(8))
        }

    private fun button(text: String, action: () -> Unit): Button =
        Button(this).apply {
            this.text = text
            isAllCaps = false
            gravity = Gravity.CENTER
            setOnClickListener { action() }
        }

    private fun probeCallbackUrl() {
        val instance = selectedInstance ?: return append("请先在第一张卡片选择 RabiRoute。")
        callbackUrlInput.setText("http://${instance.host}:8794/rabilink")
        val url = callbackUrlInput.text.toString().trim()
        if (url.isBlank()) return append("请先在高级参数填写 RabiLink 回调 URL。")
        append("正在探活 $url ...")
        runAsync {
            val endpoint = sdk.probeRabiLinkCallback(url)
            buildString {
                appendLine("RabiLink 回调探活：")
                appendLine("- ${endpoint.url}")
                appendLine("  ok=${endpoint.ok} status=${endpoint.status}")
                if (!endpoint.error.isNullOrBlank()) appendLine("  error=${endpoint.error}")
            }
        }
    }

    private fun deliverRabiLinkTestMessage() {
        val instance = selectedInstance ?: return append("请先在第一张卡片选择 RabiRoute。")
        val routeId = selectedRouteId()
        if (routeId.isBlank()) return append("请先在第一张卡片读取并选择 Route。")
        val url = "http://${instance.host}:8794/rabilink"
        callbackUrlInput.setText(url)
        append("正在做 RabiLink 双向投递测试：手机 -> RabiRoute/Codex -> RabiLink 回包队列 ...")
        runAsync {
            val result = sdk.runRabiLinkBidirectionalSmoke(instance, routeId, url)
            val replies = result.repliesJson.optJSONArray("replies")
            val latestReply = replies
                ?.let { array -> (array.length() - 1).takeIf { it >= 0 }?.let { array.optJSONObject(it) } }
            buildString {
                appendLine("RabiLink 双向投递测试：")
                appendLine("1. 手机 -> RabiRoute/Codex")
                appendLine("   url=${result.inbound.url}")
                appendLine("   ok=${result.inbound.ok} status=${result.inbound.status}")
                appendLine("   messageId=${result.inbound.messageId.ifBlank { "-" }}")
                appendLine("2. Codex/RabiRoute -> RabiLink")
                appendLine("   ok=${result.outboundJson.optBoolean("ok")} status=${result.outboundJson.optString("status", "-")}")
                appendLine("   reason=${result.outboundJson.optString("reason", "-")}")
                appendLine("3. 手机读取 RabiLink 回包队列")
                appendLine("   route=${result.repliesJson.optJSONObject("route")?.optString("configName", routeId) ?: routeId}")
                appendLine("   replies=${replies?.length() ?: 0}")
                appendLine("   latest=${latestReply?.optString("text") ?: "-"}")
                appendLine()
                appendLine("原始回包：")
                appendLine(result.outboundJson.toString(2))
                appendLine("回包队列：")
                appendLine(result.repliesJson.toString(2))
            }
        }
    }

    private fun claimRelayOnce() {
        val relayBaseUrl = relayBaseUrlInput.text.toString().trim()
        val token = relayTokenInput.text.toString().trim()
        if (relayBaseUrl.isBlank() || token.isBlank()) return append("请先填写公网 Relay URL 和 Token。")
        append("正在从公网 Relay 取一次任务，最长等待 30 秒 ...")
        runAsync {
            val tasks = sdk.claimRabiLinkRelayTasks(relayBaseUrl, token, deviceId(), waitMs = 30000, limit = 1)
            if (tasks.isEmpty()) {
                "公网 Relay 暂无任务。"
            } else {
                buildString {
                    appendLine("取到 ${tasks.size} 个公网任务：")
                    for (task in tasks) {
                        appendLine("- ${task.id}")
                        appendLine("  text=${task.text}")
                    }
                }
            }
        }
    }

    private fun startRelayBridge() {
        if (relayBridgeRunning) return append("公网 Relay 桥已经在运行。")
        val instance = selectedInstance ?: return append("请先在第一张卡片选择 RabiRoute。")
        val routeId = selectedRouteId()
        if (routeId.isBlank()) return append("请先在第一张卡片读取并选择 Route。")
        val relayBaseUrl = relayBaseUrlInput.text.toString().trim()
        val token = relayTokenInput.text.toString().trim()
        if (relayBaseUrl.isBlank() || token.isBlank()) return append("请先填写公网 Relay URL 和 Token。")
        val callbackUrl = "http://${instance.host}:8794/rabilink"
        callbackUrlInput.setText(callbackUrl)
        relayBridgeRunning = true
        saveRelayBridgeConfig(relayBaseUrl, token, instance, routeId, callbackUrl, enabled = true)
        startRelayBridgeService(relayBaseUrl, token, instance, routeId, callbackUrl)
        append("公网 Relay 常驻桥已启动：relay=$relayBaseUrl route=$routeId callback=$callbackUrl")
        append("状态栏会出现常驻通知；熄屏后仍由 Android 前台服务继续长轮询。")
    }

    private fun stopRelayBridge() {
        relayBridgeRunning = false
        relayBridgeThread?.interrupt()
        getSharedPreferences(RabiLinkRelayBridgeService.PREFS_NAME, Context.MODE_PRIVATE)
            .edit()
            .putBoolean(RabiLinkRelayBridgeService.PREF_ENABLED, false)
            .apply()
        val intent = Intent(this, RabiLinkRelayBridgeService::class.java)
            .setAction(RabiLinkRelayBridgeService.ACTION_STOP)
        startService(intent)
        append("正在停止公网 Relay 常驻桥 ...")
    }

    private fun saveRelayBridgeConfig(
        relayBaseUrl: String,
        token: String,
        instance: RabiInstance,
        routeId: String,
        callbackUrl: String,
        enabled: Boolean
    ) {
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

    private fun startRelayBridgeService(
        relayBaseUrl: String,
        token: String,
        instance: RabiInstance,
        routeId: String,
        callbackUrl: String
    ) {
        val intent = Intent(this, RabiLinkRelayBridgeService::class.java).apply {
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
        if (Build.VERSION.SDK_INT >= 26) {
            startForegroundService(intent)
        } else {
            startService(intent)
        }
    }

    private fun maybeResumeRelayBridge() {
        val prefs = getSharedPreferences(RabiLinkRelayBridgeService.PREFS_NAME, Context.MODE_PRIVATE)
        if (!prefs.getBoolean(RabiLinkRelayBridgeService.PREF_ENABLED, false)) return
        val baseUrl = prefs.getString(RabiLinkRelayBridgeService.EXTRA_MANAGER_BASE_URL, "").orEmpty()
        val guid = prefs.getString(RabiLinkRelayBridgeService.EXTRA_INSTANCE_GUID, "").orEmpty()
        val routeId = prefs.getString(RabiLinkRelayBridgeService.EXTRA_ROUTE_ID, "").orEmpty()
        val relayBaseUrl = prefs.getString(RabiLinkRelayBridgeService.EXTRA_RELAY_BASE_URL, "").orEmpty()
        val token = prefs.getString(RabiLinkRelayBridgeService.EXTRA_TOKEN, "").orEmpty()
        val callbackUrl = prefs.getString(RabiLinkRelayBridgeService.EXTRA_CALLBACK_URL, "").orEmpty()
        if (baseUrl.isBlank() || guid.isBlank() || routeId.isBlank() || relayBaseUrl.isBlank() || token.isBlank() || callbackUrl.isBlank()) return
        val instance = RabiInstance(
            guid = guid,
            name = prefs.getString(RabiLinkRelayBridgeService.EXTRA_INSTANCE_NAME, "RabiRoute") ?: "RabiRoute",
            computerName = prefs.getString(RabiLinkRelayBridgeService.EXTRA_COMPUTER_NAME, "") ?: "",
            deviceType = prefs.getString(RabiLinkRelayBridgeService.EXTRA_DEVICE_TYPE, "") ?: "",
            baseUrl = baseUrl.trimEnd('/'),
            host = Uri.parse(baseUrl).host.orEmpty(),
            port = Uri.parse(baseUrl).port.takeIf { it > 0 } ?: 8790,
            version = null
        )
        selectedInstance = instance
        startRelayBridgeService(relayBaseUrl, token, instance, routeId, callbackUrl)
        append("已恢复后台 RabiLink Relay 常驻桥。")
    }

    private fun openBatteryOptimizationSettings() {
        try {
            if (Build.VERSION.SDK_INT >= 23) {
                val powerManager = getSystemService(PowerManager::class.java)
                if (powerManager?.isIgnoringBatteryOptimizations(packageName) != true) {
                    startActivity(Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS).apply {
                        data = Uri.parse("package:$packageName")
                    })
                    append("请允许 Rabi Link 忽略电池优化，这样后台桥不会被系统清掉。")
                    return
                }
            }
            startActivity(Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS).apply {
                data = Uri.parse("package:$packageName")
            })
            append("已打开应用设置；建议开启自启动、锁定后台、允许通知。")
        } catch (error: Throwable) {
            append("无法打开电池设置：${error.message ?: error}")
        }
    }

    private fun handleRelayTask(
        relayBaseUrl: String,
        token: String,
        instance: RabiInstance,
        routeId: String,
        callbackUrl: String,
        taskId: String,
        text: String
    ) {
        appendFromBackground("取到公网任务：$taskId")
        val baselineReplies = sdk.getRabiLinkReplies(instance, routeId, 1)
        var afterReplyId = lastReplyId(baselineReplies)
        val inbound = sdk.deliverRabiLinkMessage(callbackUrl, text, routeId)
        appendFromBackground("已投递到本机 RabiRoute：messageId=${inbound.messageId} ok=${inbound.ok}")
        if (!inbound.ok || inbound.messageId.isBlank()) {
            sdk.finishRabiLinkRelayTask(relayBaseUrl, token, taskId, "手机桥投递到 RabiRoute 失败。", ok = false)
            return
        }

        var appendedCount = 0
        val startedAt = System.currentTimeMillis()
        var lastAppendAt = 0L
        while (relayBridgeRunning && System.currentTimeMillis() - startedAt < 60000) {
            val repliesJson = sdk.getRabiLinkReplies(instance, routeId, 50, afterReplyId)
            val replies = repliesJson.optJSONArray("replies")
            if (replies != null) {
                for (index in 0 until replies.length()) {
                    val reply = replies.optJSONObject(index) ?: continue
                    val replyId = reply.optString("id")
                    if (replyId.isNotBlank()) afterReplyId = replyId
                    if (reply.optString("messageId") != inbound.messageId) continue
                    val replyText = reply.optString("text")
                    if (replyText.isBlank()) continue
                    sdk.appendRabiLinkRelayMessage(relayBaseUrl, token, taskId, replyText, final = false)
                    appendedCount += 1
                    lastAppendAt = System.currentTimeMillis()
                    appendFromBackground("已写回公网 Relay：$replyId")
                }
            }
            if (appendedCount > 0 && System.currentTimeMillis() - lastAppendAt > 2500) {
                sdk.finishRabiLinkRelayTask(relayBaseUrl, token, taskId, ok = true)
                appendFromBackground("公网任务完成：$taskId replies=$appendedCount")
                return
            }
            sleepQuietly(350)
        }

        if (appendedCount > 0) {
            sdk.finishRabiLinkRelayTask(relayBaseUrl, token, taskId, ok = true)
            appendFromBackground("公网任务超时结束：$taskId replies=$appendedCount")
        } else {
            sdk.finishRabiLinkRelayTask(relayBaseUrl, token, taskId, "电脑端暂时没有返回回复。", ok = false)
            appendFromBackground("公网任务无回包：$taskId")
        }
    }

    private fun readIdentityFromBaseUrl() {
        val baseUrl = baseUrlInput.text.toString().trim()
        if (baseUrl.isBlank()) return append("请先在高级参数填写 RabiRoute Manager URL。")
        append("正在读取 $baseUrl ...")
        runAsync {
            val instance = sdk.readIdentity(baseUrl)
            runOnUiThread { addOrSelectManager(instance) }
            buildString {
                appendLine("已连接 RabiRoute：")
                appendLine("- ${instance.name} ${instance.baseUrl}")
                appendLine("  guid=${instance.guid}")
                appendLine("  computer=${instance.computerName}")
                appendLine("  type=${instance.deviceType}")
                appendLine("  version=${instance.version ?: "-"}")
            }
        }
    }

    private fun runFullProbeFromBaseUrl() {
        val baseUrl = baseUrlInput.text.toString().trim()
        if (baseUrl.isBlank()) return append("请先在高级参数填写 RabiRoute Manager URL。")
        append("正在完整探测 $baseUrl ...")
        runAsync {
            saveProbeStatus("full-probe:start baseUrl=$baseUrl")
            val instance = sdk.readIdentity(baseUrl)
            saveProbeStatus("full-probe:identity guid=${instance.guid} name=${instance.name}")
            runOnUiThread { addOrSelectManager(instance) }
            val routes = sdk.getRoutes(instance)
            saveProbeStatus("full-probe:routes count=${routes.size}")
            val firstRoute = routes.firstOrNull()
            val options = firstRoute?.let { sdk.getAgentOptions(instance, it.id) }
            runOnUiThread {
                updateRoutes(routes, firstRoute?.id)
                updateBindingOptions(options)
            }
            saveProbeStatus("full-probe:options route=${firstRoute?.id ?: "-"} loaded=${options != null}")
            refreshDashboard("routes=${routes.size}")
            buildString {
                appendLine("完整探测成功：")
                appendLine("- ${instance.name} ${instance.baseUrl}")
                appendLine("  guid=${instance.guid}")
                appendLine("  computer=${instance.computerName}")
                appendLine("  type=${instance.deviceType}")
                appendLine("  version=${instance.version ?: "-"}")
                appendLine("  routes=${routes.size}")
                if (firstRoute != null) {
                    appendLine("  firstRoute=${routeDisplayName(firstRoute)}")
                    appendLine("  firstRouteId=${firstRoute.id}")
                    appendLine("  firstRouteAgent=${firstRoute.agentAdapters.joinToString(",")}")
                    appendLine("  firstRouteCwd=${firstRoute.codexCwd.ifBlank { "<root>" }}")
                    appendLine("  firstRouteThread=${firstRoute.codexThreadName.ifBlank { "<auto>" }}")
                    appendLine("  optionsLoaded=${options != null}")
                }
            }
        }
    }

    private fun scanRabiRoutes() {
        append("正在扫描局域网 RabiRoute Manager；扫到后会自动推导 RabiLink 回调 URL...")
        runAsync {
            val instances = sdk.scanLan(this)
            val selected = instances.firstOrNull()
            runOnUiThread { updateDiscoveredManagers(instances) }
            val callbacks = selected
                ?.let { listOf(sdk.probeRabiLinkCallback("http://${it.host}:8794")) }
                ?: sdk.scanRabiLinkCallbacks(this)
            callbacks.firstOrNull { it.ok }?.let { endpoint ->
                runOnUiThread { callbackUrlInput.setText(endpoint.url) }
            }
            refreshDashboard("manager=${instances.size} callbackProbe=${callbacks.size}")
            buildString {
                appendLine("发现 ${instances.size} 个 RabiRoute manager：")
                for (item in instances) {
                    appendLine("- ${item.name} ${item.baseUrl}")
                    appendLine("  guid=${item.guid} computer=${item.computerName} type=${item.deviceType} version=${item.version ?: "-"}")
                    appendLine("  推导 RabiLink=${"http://${item.host}:8794/rabilink"}")
                }
                if (instances.isEmpty()) {
                    appendLine("- 未发现 manager；这个页面的正确前提是先让 Manager 能被局域网访问。")
                    appendLine("- 如果只开了 127.0.0.1:8790，手机局域网扫不到；USB 临时测试才用 adb reverse。")
                }
                appendLine()
                appendLine("按 RabiRoute IP 探测 RabiLink 回调端：")
                for (item in callbacks) {
                    appendLine("- ${item.url} ok=${item.ok} status=${item.status}")
                }
                if (callbacks.isEmpty()) {
                    appendLine("- 未发现 /rabilink 探活；常见原因是电脑防火墙未放行 TCP 8794，或 RabiLink route 未启动。")
                    appendLine("- USB 调试时可先执行 adb reverse tcp:8794 tcp:8794，然后用默认回调 URL。")
                } else if (callbacks.none { it.ok }) {
                    appendLine("- Manager 扫到了，但 /rabilink 没通；多数是 TCP 8794 防火墙或 RabiLink route 未启动。")
                }
            }
        }
    }

    private fun scanRabiLinkCallbacks() {
        append("正在扫描 RabiLink 回调端...")
        runAsync {
            val callbacks = sdk.scanRabiLinkCallbacks(this)
            callbacks.firstOrNull { it.ok }?.let {
                runOnUiThread { callbackUrlInput.setText(it.url) }
            }
            refreshDashboard("callbacks=${callbacks.size}")
            buildString {
                appendLine("发现 ${callbacks.size} 个 RabiLink 回调端：")
                for (item in callbacks) {
                    appendLine("- ${item.url} status=${item.status}")
                }
                if (callbacks.isEmpty()) {
                    appendLine("没有发现可访问的 /rabilink 探活。")
                    appendLine("如果电脑能 ping 通但这里是 0 个，多半是 Windows 防火墙挡了 TCP 8794。")
                    appendLine("USB 调试可用 adb reverse tcp:8794 tcp:8794，再用默认回调 URL。")
                }
            }
        }
    }

    private fun readRoutesAndOptions() {
        val instance = selectedInstance ?: return append("请先读取或扫描一个 RabiRoute Manager。")
        val selectedRouteBefore = selectedRouteId()
        append("正在读取路由...")
        runAsync {
            val routes = sdk.getRoutes(instance)
            val route = routes.firstOrNull { it.id == selectedRouteBefore } ?: routes.firstOrNull()
            val options = route?.let { sdk.getAgentOptions(instance, it.id) }
            runOnUiThread {
                updateRoutes(routes, route?.id)
                updateBindingOptions(options)
            }
            refreshDashboard("routes=${routes.size} selectedRoute=${route?.id ?: "-"}")
            buildString {
                appendLine("路由 ${routes.size} 条：")
                for (item in routes) {
                    appendLine("- ${routeDisplayName(item)} enabled=${item.enabled} running=${item.running}")
                    appendLine("  id=${item.id} name=${item.name.ifBlank { "-" }} routeName=${item.routeName.ifBlank { "-" }}")
                    appendLine("  agent=${item.agentAdapters.joinToString(",")} cwd=${item.codexCwd.ifBlank { "<root>" }} thread=${item.codexThreadName.ifBlank { "<auto>" }}")
                }
                appendLine()
                appendLine("当前路由 Agent 选项：")
                appendLine(options?.toString(2) ?: "无路由")
            }
        }
    }

    private fun setBinding() {
        val instance = selectedInstance ?: return append("请先读取或扫描一个 RabiRoute Manager。")
        val routeId = selectedRouteId()
        if (routeId.isBlank()) return append("请先读取路由，并在 Route 下拉框里选择一条。")
        val codexCwd = selectedCwd()
        val codexThreadName = selectedThreadName()
        append("正在设置 $routeId ...")
        runAsync {
            val result = sdk.setAgentBinding(
                instance,
                routeId,
                RabiAgentBinding(
                    agentAdapter = "codex",
                    codexCwd = codexCwd,
                    codexThreadName = codexThreadName
                )
            )
            "设置完成：\n${result.toString(2)}"
        }
    }

    private fun runAsync(action: () -> String) {
        Thread {
            val text = runCatching(action).fold(
                onSuccess = { result ->
                    saveProbeStatus("success ${result.take(180)}")
                    Log.i("RabiRouteSdkProbe", result.take(1000))
                    result
                },
                onFailure = { error ->
                    saveProbeStatus("failure ${error.message ?: error}")
                    Log.e("RabiRouteSdkProbe", "Probe failed", error)
                    "失败：${error.message ?: error}"
                }
            )
            runOnUiThread { append(text) }
        }.start()
    }

    private fun refreshDashboard(extra: String = "") {
        runOnUiThread {
            val instance = selectedInstance
            dashboardView.text = buildString {
                appendLine("当前状态")
                appendLine("Rabi：${instance?.name ?: "未选择"}")
                appendLine("电脑：${instance?.computerName ?: "未选择"}")
                appendLine("类型：${instance?.deviceType ?: "未选择"}")
                appendLine("IP：${instance?.host ?: "未选择"}")
                appendLine("Manager：${instance?.baseUrl ?: baseUrlInput.text}")
                appendLine("RabiLink：${callbackUrlInput.text}")
                appendLine("Route：${selectedRouteDisplayName().ifBlank { "未选择" }}")
                if (extra.isNotBlank()) appendLine(extra)
            }.trimEnd()
        }
    }

    private fun append(message: String) {
        val time = SimpleDateFormat("HH:mm:ss", Locale.US).format(Date())
        val line = "[$time] $message\n"
        report.append(line)
        output.append(line)
        val scrollAmount = output.layout?.let { it.getLineTop(output.lineCount) - output.height } ?: 0
        if (scrollAmount > 0) output.scrollTo(0, scrollAmount)
    }

    private fun appendFromBackground(message: String) {
        runOnUiThread { append(message) }
    }

    private fun lastReplyId(repliesJson: JSONObject): String {
        val replies = repliesJson.optJSONArray("replies") ?: return ""
        return replies.optJSONObject(replies.length() - 1)?.optString("id").orEmpty()
    }

    private fun sleepQuietly(ms: Long) {
        try {
            Thread.sleep(ms)
        } catch (_: InterruptedException) {
            Thread.currentThread().interrupt()
        }
    }

    private fun deviceId(): String =
        "rabilink-phone-${Build.MANUFACTURER}-${Build.MODEL}".replace(Regex("\\s+"), "-")

    private fun copyReport() {
        val clipboard = getSystemService(Context.CLIPBOARD_SERVICE) as? ClipboardManager
        clipboard?.setPrimaryClip(ClipData.newPlainText("RabiRoute / RabiLink 测试日志", report.toString()))
        Toast.makeText(this, "日志已复制", Toast.LENGTH_SHORT).show()
    }

    private fun saveProbeStatus(text: String) {
        Log.i("RabiRouteSdkProbe", text)
        getSharedPreferences("rabi_probe", MODE_PRIVATE)
            .edit()
            .putString("lastStatus", text)
            .putLong("updatedAt", System.currentTimeMillis())
            .apply()
    }

    private fun text(value: String, size: Int, color: Int): TextView =
        TextView(this).apply {
            text = value
            textSize = size.toFloat()
            setTextColor(color)
        }

    private fun fullWidthWithMargins(left: Int, top: Int, right: Int, bottom: Int): LinearLayout.LayoutParams =
        LinearLayout.LayoutParams(-1, -2).apply {
            setMargins(dp(left), dp(top), dp(right), dp(bottom))
        }

    private fun panelBackground(color: Int, stroke: Int): GradientDrawable =
        GradientDrawable().apply {
            setColor(color)
            setStroke(1, stroke)
            cornerRadius = dp(8).toFloat()
        }

    private fun dp(value: Int): Int =
        (value * resources.displayMetrics.density + 0.5f).toInt()
}
