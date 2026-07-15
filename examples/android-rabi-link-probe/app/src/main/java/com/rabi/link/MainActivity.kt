package com.rabi.link

import android.app.Activity
import android.content.Context
import android.content.Intent
import android.graphics.Color
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.os.Bundle
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
import com.rabiroute.sdk.RabiAgentBinding
import com.rabiroute.sdk.RabiInstance
import com.rabiroute.sdk.RabiLinkPc
import com.rabiroute.sdk.RabiRouteInfo
import com.rabiroute.sdk.RabiRouteSdk
import com.rabi.link.modules.rokid.RokidDeviceStatusSyncService
import org.json.JSONArray
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

class MainActivity : Activity() {
    private val sdk = RabiRouteSdk()
    private val managers = mutableListOf<RabiInstance>()
    private val pcs = mutableListOf<RabiLinkPc>()
    private val routes = mutableListOf<RabiRouteInfo>()
    private val cwdOptions = mutableListOf<String>()
    private val threadOptions = mutableListOf<String>()
    private val logLines = StringBuilder()
    private var selectedInstance: RabiInstance? = null
    private var selectedPc: RabiLinkPc? = null

    private lateinit var statusView: TextView
    private lateinit var relayUrlInput: EditText
    private lateinit var relayTokenInput: EditText
    private lateinit var pcSpinner: Spinner
    private lateinit var pcAdapter: ArrayAdapter<String>
    private lateinit var managerSpinner: Spinner
    private lateinit var managerAdapter: ArrayAdapter<String>
    private lateinit var routeSpinner: Spinner
    private lateinit var routeAdapter: ArrayAdapter<String>
    private lateinit var cwdSpinner: Spinner
    private lateinit var cwdAdapter: ArrayAdapter<String>
    private lateinit var threadSpinner: Spinner
    private lateinit var threadAdapter: ArrayAdapter<String>
    private lateinit var connectServerButton: Button
    private lateinit var bindPcButton: Button
    private lateinit var scanButton: Button
    private lateinit var refreshRouteButton: Button
    private lateinit var loadAgentOptionsButton: Button
    private lateinit var saveAgentBindingButton: Button
    private lateinit var callbackView: TextView
    private lateinit var logView: TextView
    private var scanningManagers = false
    private var serverBusy = false

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        buildUi()
        refreshStatus("等待扫描")
        appendLog("RabiLink 手机伴侣已启动。AIUI 网络由官方手机链路代理，Agent 与上下文仍由 PC RabiRoute 管理。")
        if (RabiLinkRelaySettings.load(this).let { it.configured && it.statusSyncEnabled }) {
            RokidDeviceStatusSyncService.start(this)
        }
    }

    override fun onResume() {
        super.onResume()
    }

    override fun onPause() {
        super.onPause()
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
        addServerCard(content)
        addRouteCard(content)
        addAgentBindingCard(content)
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
            text = "RabiLink 手机伴侣"
            textSize = 26f
            typeface = Typeface.DEFAULT_BOLD
            setTextColor(Color.rgb(20, 25, 32))
        }, LinearLayout.LayoutParams(-1, -2))
        content.addView(TextView(this).apply {
            text = "连接便携设备、RabiRoute、Relay 和 Agent"
            textSize = 13f
            setTextColor(Color.rgb(88, 94, 104))
            setPadding(0, dp(4), 0, dp(12))
        }, LinearLayout.LayoutParams(-1, -2))
    }

    private fun addServerCard(content: LinearLayout) {
        val card = card()
        card.addView(cardTitle("1. 连接 RabiLink 服务器"))
        card.addView(cardText("手机保存服务器地址和应用 token，负责网络、眼镜状态和便携设备接入；Agent、会话账本、配置真源与动作安全门仍在 PC RabiRoute。"))

        val savedRelay = RabiLinkRelaySettings.load(this)
        relayUrlInput = input("https://rabi.example.com").apply {
            if (savedRelay.baseUrl.isNotBlank()) setText(savedRelay.baseUrl)
        }
        relayTokenInput = input("粘贴 RabiLink 应用 token").apply {
            if (savedRelay.token.isNotBlank()) setText(savedRelay.token)
        }
        card.addView(label("服务器 URL"))
        card.addView(relayUrlInput, fullWidth(0, 0, 0, 8))
        card.addView(label("应用 token"))
        card.addView(relayTokenInput, fullWidth(0, 0, 0, 8))

        pcAdapter = ArrayAdapter(this, android.R.layout.simple_spinner_item, mutableListOf("尚未连接服务器"))
        pcAdapter.setDropDownViewResource(android.R.layout.simple_spinner_dropdown_item)
        pcSpinner = Spinner(this).apply {
            adapter = pcAdapter
            onItemSelectedListener = object : AdapterView.OnItemSelectedListener {
                override fun onItemSelected(parent: AdapterView<*>?, view: View?, position: Int, id: Long) {
                    pcs.getOrNull(position)?.let { selectServerPc(it) }
                }
                override fun onNothingSelected(parent: AdapterView<*>?) = Unit
            }
        }
        card.addView(label("PC Rabi"))
        card.addView(pcSpinner, fullWidth(0, 0, 0, 10))

        val row = row()
        connectServerButton = primaryButton("连接服务器") { connectServer() }
        row.addView(connectServerButton, LinearLayout.LayoutParams(0, -2, 1f))
        row.addView(space(), LinearLayout.LayoutParams(dp(8), 1))
        bindPcButton = secondaryButton("绑定此 PC") { bindSelectedPc() }
        row.addView(bindPcButton, LinearLayout.LayoutParams(0, -2, 1f))
        card.addView(row)
        content.addView(card, fullWidth(0, 0, 0, 12))
    }

    private fun addRouteCard(content: LinearLayout) {
        val card = card()
        card.addView(cardTitle("2. 选择 Route"))
        card.addView(cardText("读取当前 token 绑定的 PC Rabi 配置，选择要接到 Codex 的 route。"))

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
        refreshRouteButton = primaryButton("读取服务器 Route") { readServerRoutes() }
        row.addView(refreshRouteButton, LinearLayout.LayoutParams(0, -2, 1f))
        row.addView(space(), LinearLayout.LayoutParams(dp(8), 1))
        scanButton = secondaryButton("局域网扫描备用") { scanManagers() }
        row.addView(scanButton, LinearLayout.LayoutParams(0, -2, 1f))
        card.addView(row)
        content.addView(card, fullWidth(0, 0, 0, 12))
    }

    private fun addAgentBindingCard(content: LinearLayout) {
        val card = card()
        card.addView(cardTitle("3. Codex 绑定"))
        card.addView(cardText("选择工作空间和 Codex 会话后保存，会直接写回所选 PC Rabi 的 Route 配置。"))
        callbackView = cardText("当前绑定：未读取")
        card.addView(callbackView)

        cwdAdapter = ArrayAdapter(this, android.R.layout.simple_spinner_item, mutableListOf("先读取选项"))
        cwdAdapter.setDropDownViewResource(android.R.layout.simple_spinner_dropdown_item)
        cwdSpinner = Spinner(this).apply { adapter = cwdAdapter }
        threadAdapter = ArrayAdapter(this, android.R.layout.simple_spinner_item, mutableListOf("先读取选项"))
        threadAdapter.setDropDownViewResource(android.R.layout.simple_spinner_dropdown_item)
        threadSpinner = Spinner(this).apply { adapter = threadAdapter }
        card.addView(label("Codex 工作空间"))
        card.addView(cwdSpinner, fullWidth(0, 0, 0, 8))
        card.addView(label("Codex 会话"))
        card.addView(threadSpinner, fullWidth(0, 0, 0, 10))

        val row = row()
        loadAgentOptionsButton = secondaryButton("读取选项") { loadServerAgentOptions() }
        row.addView(loadAgentOptionsButton, LinearLayout.LayoutParams(0, -2, 1f))
        row.addView(space(), LinearLayout.LayoutParams(dp(8), 1))
        saveAgentBindingButton = primaryButton("保存绑定") { saveServerAgentBinding() }
        row.addView(saveAgentBindingButton, LinearLayout.LayoutParams(0, -2, 1f))
        card.addView(row)
        content.addView(card, fullWidth(0, 0, 0, 12))
    }

    private fun addToolsCard(content: LinearLayout) {
        val card = card()
        card.addView(cardTitle("4. 测试与诊断"))
        card.addView(cardText("设备接口探针先放在这里。正式使用时只需要前三张卡。"))
        card.addView(secondaryButton("打开接口测试中心") {
            startActivity(Intent(this, TestCenterActivity::class.java))
        })
        content.addView(card, fullWidth(0, 0, 0, 12))
    }

    private fun relayBaseUrl(): String = relayUrlInput.text.toString().trim().ifBlank { "https://rabi.example.com" }.trimEnd('/')
    private fun relayToken(): String = relayTokenInput.text.toString().trim()

    private fun requireServerToken(): String? {
        val token = relayToken()
        if (token.isBlank()) {
            toast("请先粘贴应用 token")
            return null
        }
        return token
    }

    private fun connectServer() {
        val token = requireServerToken() ?: return
        setServerBusy(true)
        appendLog("正在连接 RabiLink 服务器...")
        refreshStatus("连接服务器中")
        runAsync(
            work = { sdk.getMobileState(relayBaseUrl(), token) },
            success = { state ->
                RabiLinkRelaySettings.save(this, relayBaseUrl(), token)
                RokidDeviceStatusSyncService.start(this)
                updateServerState(state)
                appendLog("服务器已连接：${state.appName.ifBlank { state.appId }}，${state.workers.size} 台 PC Rabi。")
                refreshStatus("服务器已连接")
            },
            complete = { setServerBusy(false) }
        )
    }

    private fun updateServerState(state: com.rabiroute.sdk.RabiLinkMobileState) {
        pcs.clear()
        pcs.addAll(state.workers)
        pcAdapter.clear()
        if (pcs.isEmpty()) {
            pcAdapter.add("没有 PC Rabi 连接此 token")
            selectedPc = null
        } else {
            pcAdapter.addAll(pcs.map { pcLabel(it) })
            val selectedIndex = pcs.indexOfFirst { pc ->
                pc.id == state.selectedWorker?.id || pc.guid == state.selectedWorker?.guid || pc.id == state.selectedTargetDeviceId || pc.guid == state.selectedTargetDeviceId
            }.let { if (it >= 0) it else 0 }
            pcSpinner.setSelection(selectedIndex)
            selectedPc = pcs[selectedIndex]
        }
        pcAdapter.notifyDataSetChanged()
        callbackView.text = "当前绑定：${state.selectedWorker?.let { pcLabel(it) } ?: "未选择 PC Rabi"}"
    }

    private fun selectServerPc(pc: RabiLinkPc) {
        val changed = selectedPc?.id != pc.id && selectedPc?.guid != pc.guid
        selectedPc = pc
        if (changed) {
            updateRoutes(emptyList())
            clearAgentOptions()
        }
        refreshStatus("已选择 PC Rabi")
    }

    private fun bindSelectedPc() {
        val token = requireServerToken() ?: return
        val pc = selectedPc ?: return toast("请先选择 PC Rabi")
        setServerBusy(true)
        appendLog("正在把应用 token 绑定到 ${pc.name}...")
        runAsync(
            work = { sdk.selectMobileRabiPc(relayBaseUrl(), token, pc.id) },
            success = { state ->
                updateServerState(state)
                appendLog("已绑定 PC Rabi：${state.selectedWorker?.name ?: pc.name}")
                readServerRoutes()
            },
            complete = { setServerBusy(false) }
        )
    }

    private fun readServerRoutes() {
        val token = requireServerToken() ?: return
        val pc = selectedPc ?: return toast("请先连接服务器并选择 PC Rabi")
        setServerBusy(true)
        appendLog("正在读取 ${pc.name} 的 Route 列表...")
        runAsync(
            work = { sdk.getMobileRoutes(relayBaseUrl(), token, pc.id) },
            success = { result ->
                updateRoutes(result)
                appendLog("读取到 ${result.size} 条 Route。")
                refreshStatus("Route 已刷新")
            },
            complete = { setServerBusy(false) }
        )
    }

    private fun loadServerAgentOptions() {
        val token = requireServerToken() ?: return
        val pc = selectedPc ?: return toast("请先选择 PC Rabi")
        val route = selectedRoute() ?: return toast("请先选择 Route")
        setServerBusy(true)
        appendLog("正在读取 Codex 工作空间和会话选项...")
        runAsync(
            work = { sdk.getMobileAgentOptions(relayBaseUrl(), token, route.id, pc.id) },
            success = { data ->
                updateAgentOptions(route, data)
                appendLog("Codex 选项已刷新。")
                refreshStatus("Codex 选项已刷新")
            },
            complete = { setServerBusy(false) }
        )
    }

    private fun saveServerAgentBinding() {
        val token = requireServerToken() ?: return
        val pc = selectedPc ?: return toast("请先选择 PC Rabi")
        val route = selectedRoute() ?: return toast("请先选择 Route")
        val cwd = cwdOptions.getOrNull(cwdSpinner.selectedItemPosition).orEmpty()
        val thread = threadOptions.getOrNull(threadSpinner.selectedItemPosition).orEmpty()
        setServerBusy(true)
        appendLog("正在保存 ${routeDisplayName(route)} 的 Codex 绑定...")
        val binding = RabiAgentBinding(agentAdapter = "codex", codexCwd = cwd, codexThreadName = thread)
        runAsync(
            work = { sdk.setMobileAgentBinding(relayBaseUrl(), token, route.id, binding, pc.id) },
            success = {
                appendLog("已保存 Codex 绑定：${cwd.ifBlank { "默认工作目录" }} / ${thread.ifBlank { "默认会话" }}")
                readServerRoutes()
            },
            complete = { setServerBusy(false) }
        )
    }

    private fun updateAgentOptions(route: RabiRouteInfo, data: org.json.JSONObject) {
        val routeJson = data.optJSONObject("route")
        val cwdValues = LinkedHashSet<String>()
        cwdValues.add(routeJson?.optString("codexCwd").orEmpty().ifBlank { route.codexCwd })
        cwdValues.addAll(data.optJSONArray("cwdOptions").toStringList())
        cwdValues.remove("")
        cwdOptions.clear()
        cwdOptions.addAll(cwdValues.ifEmpty { linkedSetOf("") })
        cwdAdapter.clear()
        cwdAdapter.addAll(cwdOptions.map { it.ifBlank { "默认工作目录" } })
        cwdAdapter.notifyDataSetChanged()

        val threadValues = LinkedHashSet<String>()
        threadValues.add(routeJson?.optString("codexThreadName").orEmpty().ifBlank { route.codexThreadName })
        threadValues.addAll(data.optJSONArray("threadNames").toStringList())
        threadValues.remove("")
        threadOptions.clear()
        threadOptions.addAll(threadValues.ifEmpty { linkedSetOf("") })
        threadAdapter.clear()
        threadAdapter.addAll(threadOptions.map { it.ifBlank { "默认会话" } })
        threadAdapter.notifyDataSetChanged()
        callbackView.text = "当前绑定：${routeDisplayName(route)} / ${routeJson?.optString("codexCwd").orEmpty().ifBlank { route.codexCwd.ifBlank { "默认工作目录" } }} / ${routeJson?.optString("codexThreadName").orEmpty().ifBlank { route.codexThreadName.ifBlank { "默认会话" } }}"
    }

    private fun clearAgentOptions() {
        cwdOptions.clear()
        threadOptions.clear()
        cwdAdapter.clear()
        cwdAdapter.add("先读取选项")
        cwdAdapter.notifyDataSetChanged()
        threadAdapter.clear()
        threadAdapter.add("先读取选项")
        threadAdapter.notifyDataSetChanged()
        callbackView.text = "当前绑定：未读取"
    }

    private fun scanManagers() {
        if (scanningManagers) return
        setScanningManagers(true)
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
            },
            complete = { setScanningManagers(false) }
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

    private fun setScanningManagers(scanning: Boolean) {
        scanningManagers = scanning
        refreshInteractionState()
    }

    private fun setServerBusy(busy: Boolean) {
        serverBusy = busy
        refreshInteractionState()
    }

    private fun refreshInteractionState() {
        val canUseDiscovery = !scanningManagers && !serverBusy
        val canUseServer = !serverBusy
        relayUrlInput.isEnabled = canUseServer
        relayTokenInput.isEnabled = canUseServer
        pcSpinner.isEnabled = canUseServer
        connectServerButton.isEnabled = canUseServer
        bindPcButton.isEnabled = canUseServer
        managerSpinner.isEnabled = canUseDiscovery
        routeSpinner.isEnabled = canUseDiscovery
        scanButton.isEnabled = canUseDiscovery
        scanButton.text = when {
            scanningManagers -> "扫描中..."
            else -> "局域网扫描备用"
        }
        refreshRouteButton.isEnabled = canUseDiscovery
        loadAgentOptionsButton.isEnabled = canUseServer
        saveAgentBindingButton.isEnabled = canUseServer
        connectServerButton.text = if (serverBusy) "处理中..." else "连接服务器"
        applyEnabledAlpha(relayUrlInput)
        applyEnabledAlpha(relayTokenInput)
        applyEnabledAlpha(pcSpinner)
        applyEnabledAlpha(connectServerButton)
        applyEnabledAlpha(bindPcButton)
        applyEnabledAlpha(managerSpinner)
        applyEnabledAlpha(routeSpinner)
        applyEnabledAlpha(scanButton)
        applyEnabledAlpha(refreshRouteButton)
        applyEnabledAlpha(loadAgentOptionsButton)
        applyEnabledAlpha(saveAgentBindingButton)
    }

    private fun selectedRoute(): RabiRouteInfo? = routes.getOrNull(routeSpinner.selectedItemPosition)
    private fun managerLabel(instance: RabiInstance): String = "${instance.name} · ${instance.host}"
    private fun pcLabel(pc: RabiLinkPc): String = "${pc.name} · ${if (pc.online) "在线" else "离线"} · ${pc.guid.ifBlank { pc.id }}"
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
            appendLine("服务器：${if (::relayUrlInput.isInitialized) relayBaseUrl() else "未填写"}")
            appendLine("PC Rabi：${selectedPc?.name ?: instance?.name ?: "未选择"}")
            appendLine("电脑：${selectedPc?.guid ?: instance?.computerName ?: "未选择"}")
            appendLine("IP：${instance?.host ?: "服务器转发"}")
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

    private fun appendLog(message: String, includeTime: Boolean = true) {
        val time = SimpleDateFormat("HH:mm:ss", Locale.US).format(Date())
        logLines.append(if (includeTime) "[$time] $message\n" else "$message\n")
        logView.text = logLines.toString().takeLast(2500)
        val scrollAmount = logView.layout?.let { it.getLineTop(logView.lineCount) - logView.height } ?: 0
        if (scrollAmount > 0) logView.scrollTo(0, scrollAmount)
    }

    private fun <T> runAsync(work: () -> T, success: (T) -> Unit, complete: () -> Unit = {}) {
        Thread {
            try {
                val result = work()
                runOnUiThread {
                    success(result)
                    complete()
                }
            } catch (error: Throwable) {
                runOnUiThread {
                    appendLog("失败：${error.message ?: error.javaClass.simpleName}")
                    refreshStatus("操作失败")
                    complete()
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

    private fun applyEnabledAlpha(view: View) {
        view.alpha = if (view.isEnabled) 1f else 0.45f
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

    private fun JSONArray?.toStringList(): List<String> {
        if (this == null) return emptyList()
        return (0 until length()).map { optString(it) }.filter { it.isNotBlank() }
    }
}
