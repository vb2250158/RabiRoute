package com.rabi.link

import android.app.Activity
import android.content.Intent
import android.graphics.Color
import android.graphics.Typeface
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.text.InputType
import android.view.inputmethod.EditorInfo
import android.view.Gravity
import android.view.View
import android.widget.*
import androidx.core.content.FileProvider
import java.io.File
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import com.rabiroute.sdk.RabiLinkPc
import com.rabiroute.sdk.RabiInstance
import com.rabiroute.sdk.RabiRouteInfo
import com.rabiroute.sdk.RabiRouteSdk
import com.rabi.link.modules.rokid.RokidDeviceStatusSyncService
import com.rabi.link.modules.rokid.RokidProbeActivity
import com.rabi.link.modules.wearable.WearableHealthSettingsActivity

/** Phone companion: glasses backend and Relay transport, not a duplicate Rabi PC configuration UI. */
class MainActivity : Activity() {
    private val requestPhoneAudio = 9031
    private val requestPhoneMedia = 9032
    private val requestNotifications = 9033
    private val sdk = RabiRouteSdk()
    private val discoverySdk = RabiRouteSdk(timeoutMs = 160)
    private val pcs = mutableListOf<RabiLinkPc>()
    private val discoveredManagers = mutableListOf<RabiInstance>()
    private lateinit var relayUrl: EditText
    private lateinit var relayToken: EditText
    private lateinit var relayUrlHelp: TextView
    private lateinit var relayTokenHelp: TextView
    private lateinit var pcHelp: TextView
    private lateinit var pcSpinner: Spinner
    private lateinit var pcAdapter: ArrayAdapter<String>
    private lateinit var status: TextView
    private lateinit var connectButton: Button
    private lateinit var discoveredPcAction: Button
    private lateinit var advancedSettings: LinearLayout
    private lateinit var runtimeStatus: TextView
    private lateinit var runtimeTranscript: TextView
    private lateinit var runtimeReply: TextView
    private val runtimeHandler = Handler(Looper.getMainLooper())
    private val runtimeTick = object : Runnable {
        override fun run() { refreshConversationRuntime(); refreshChatIfChanged(); runtimeHandler.postDelayed(this, 1000) }
    }
    private lateinit var continuousListening: Switch
    private lateinit var glassesEnabled: Switch
    private lateinit var autoPlayAgentVoice: Switch
    private lateinit var asrModel: EditText
    private lateinit var asrLanguage: EditText
    private lateinit var ttsModel: EditText
    private lateinit var ttsVoice: EditText
    private lateinit var vadThreshold: EditText
    private lateinit var silenceMs: EditText
    private var selectedPc: RabiLinkPc? = null
    private var busy = false
    private var showingSettings = false
    private var chatMessages: LinearLayout? = null
    private var chatScroll: ScrollView? = null
    private var composer: EditText? = null
    private var routeButton: Button? = null
    private var availableRoutes: List<RabiRouteInfo> = emptyList()
    private var routeLoadFailed = false
    private var configurationMode = false
    private var modeButton: Button? = null
    private var modeBanner: TextView? = null
    private var lastChatRuntimeAt = 0L

    override fun onCreate(state: Bundle?) {
        super.onCreate(state)
        selectRouteFromIntent(intent)
        val saved = RabiLinkRelaySettings.load(this)
        showingSettings = !saved.configured || intent.getBooleanExtra("open_settings", false)
        if (showingSettings) showSettings(saved) else showChat()
        if (saved.configured && saved.statusSyncEnabled) RokidDeviceStatusSyncService.start(this)
        val conversation = RabiConversationSettings.load(this)
        if (saved.configured && conversation.continuousListening
            && (conversation.glassesEnabled || checkSelfPermission(android.Manifest.permission.RECORD_AUDIO) == android.content.pm.PackageManager.PERMISSION_GRANTED)) {
            RabiConversationService.start(this)
        }
        if (android.os.Build.VERSION.SDK_INT >= 33 && checkSelfPermission(android.Manifest.permission.POST_NOTIFICATIONS) != android.content.pm.PackageManager.PERMISSION_GRANTED) {
            requestPermissions(arrayOf(android.Manifest.permission.POST_NOTIFICATIONS), requestNotifications)
        }
    }

    override fun onNewIntent(intent: Intent?) {
        super.onNewIntent(intent)
        setIntent(intent)
        if (selectRouteFromIntent(intent) && !showingSettings) {
            renderChat()
            loadRouteTargets()
        }
    }

    private fun selectRouteFromIntent(intent: Intent?): Boolean {
        val routeProfileId = intent?.getStringExtra("route_profile_id")?.trim().orEmpty()
        if (routeProfileId.isBlank()) return false
        RabiConversationTarget.save(this, routeProfileId)
        return true
    }

    private fun showSettings(saved: RabiLinkRelayConfig = RabiLinkRelaySettings.load(this)) {
        showingSettings = true; setContentView(buildUi())
        if (saved.baseUrl.isNotBlank()) {
            relayUrl.setText(saved.baseUrl)
            setUrlHelp("已填入上次验证过的服务器地址。App 会自动重新检查它是否可用。", RabiGuidanceTone.SUCCESS)
        }
        if (saved.token.isNotBlank()) {
            relayToken.setText(saved.token)
            setTokenHelp("已安全保存登录码。这里不会显示明文，也不会把它写入日志。", RabiGuidanceTone.SUCCESS)
        }
        loadConversationSettings()
        autoPrepareSetup(saved)
    }

    private fun showChat() {
        showingSettings = false
        configurationMode = false
        val root = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; setBackgroundColor(Color.rgb(244, 249, 251)) }
        val top = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; setPadding(dp(14), dp(10), dp(10), dp(10)); setBackgroundColor(Color.WHITE) }
        val appBar = row()
        appBar.addView(LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            addView(TextView(this@MainActivity).apply { text = "Rabi"; textSize = 22f; typeface = Typeface.DEFAULT_BOLD; setTextColor(Color.rgb(16, 42, 67)) })
            addView(TextView(this@MainActivity).apply { text = "Rabi 移动端"; textSize = 11f; setTextColor(Color.rgb(104, 119, 132)) })
        }, LinearLayout.LayoutParams(0, -2, 1f))
        appBar.addView(secondary("设置") { showSettings() }.apply { contentDescription = "打开设置" })
        top.addView(appBar)
        val contextBar = row().apply { setPadding(0, dp(8), 0, 0) }
        routeButton = secondary("人格：加载中") { chooseRoute() }
        contextBar.addView(routeButton, LinearLayout.LayoutParams(0, -2, 1f))
        contextBar.addView(space(), LinearLayout.LayoutParams(dp(8), 1))
        modeButton = secondary("配置助手") { toggleChatMode() }
        contextBar.addView(modeButton)
        top.addView(contextBar)
        root.addView(top)
        modeBanner = TextView(this).apply {
            text = "配置助手模式 · 修改动作仍由 Rabi PC 安全门确认"
            textSize = 12f
            setTextColor(Color.rgb(138, 77, 8))
            setPadding(dp(14), dp(9), dp(14), dp(9))
            setBackgroundColor(Color.rgb(255, 248, 235))
            visibility = View.GONE
        }
        root.addView(modeBanner)
        chatMessages = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; setPadding(dp(12), dp(8), dp(12), dp(18)) }
        chatScroll = ScrollView(this).apply { addView(chatMessages) }
        root.addView(chatScroll, LinearLayout.LayoutParams(-1, 0, 1f))
        val bottom = row().apply { setPadding(dp(8), dp(8), dp(8), dp(10)); setBackgroundColor(Color.WHITE); gravity = Gravity.BOTTOM }
        bottom.addView(secondary("＋") { pickPhoneMedia() }.apply {
            contentDescription = "添加图片、音频或文件"
            minWidth = dp(48); minimumWidth = dp(48); minHeight = dp(48); minimumHeight = dp(48)
        }, LinearLayout.LayoutParams(dp(48), dp(48)))
        composer = input("给 Rabi 发消息").apply {
            setSingleLine(false)
            minLines = 1
            maxLines = 5
            gravity = Gravity.TOP or Gravity.START
            setPadding(dp(14), dp(10), dp(14), dp(10))
            inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_FLAG_CAP_SENTENCES or InputType.TYPE_TEXT_FLAG_MULTI_LINE
            imeOptions = EditorInfo.IME_ACTION_SEND
            setOnEditorActionListener { _, actionId, event ->
                val sendAction = actionId == EditorInfo.IME_ACTION_SEND
                    || (event?.keyCode == android.view.KeyEvent.KEYCODE_ENTER && event.action == android.view.KeyEvent.ACTION_DOWN && !event.isShiftPressed)
                if (sendAction) sendComposer()
                sendAction
            }
        }
        bottom.addView(composer, LinearLayout.LayoutParams(0, -2, 1f).apply { setMargins(dp(6), 0, dp(6), 0) })
        bottom.addView(primary("↑") { sendComposer() }.apply {
            contentDescription = "发送消息"
            textSize = 21f
            minWidth = dp(48); minimumWidth = dp(48); minHeight = dp(48); minimumHeight = dp(48)
        }, LinearLayout.LayoutParams(dp(48), dp(48)))
        root.addView(bottom); setContentView(root); renderChat(); loadRouteTargets()
    }

    private fun loadRouteTargets() {
        val relay = RabiLinkRelaySettings.load(this); if (!relay.configured) return
        runAsync({ sdk.getMobileRoutes(relay.baseUrl, relay.token, "") }, { routes ->
            routeLoadFailed = false
            availableRoutes = routes.filter { it.enabled }
            var selected = RabiConversationTarget.load(this)
            if (selected.isBlank() && availableRoutes.isNotEmpty()) { selected = availableRoutes.first().id; RabiConversationTarget.save(this, selected) }
            routeButton?.text = "人格：${availableRoutes.firstOrNull { it.id == selected }?.name ?: "未配置"}"
        }, error = { error ->
            routeLoadFailed = true
            routeButton?.text = "登录失效"
            val unauthorized = error.message.orEmpty().contains("unauthorized", ignoreCase = true)
                || error.message.orEmpty().contains("401")
            toast(if (unauthorized) "RabiLink 登录已失效，请进入设置重新登录" else "无法加载人格：${error.message ?: "连接失败"}")
        })
    }

    private fun chooseRoute() {
        if (routeLoadFailed) {
            toast("请重新连接 RabiLink")
            showSettings()
            return
        }
        if (availableRoutes.isEmpty()) return toast("Rabi PC 尚未发布可用路由人格")
        val anchor = routeButton ?: return
        PopupMenu(this, anchor).apply {
            availableRoutes.forEachIndexed { index, route -> menu.add(0, index, index, route.name) }
            setOnMenuItemClickListener { item ->
                val route = availableRoutes[item.itemId]; RabiConversationTarget.save(this@MainActivity, route.id)
                routeButton?.text = "人格：${route.name}"; renderChat(); true
            }
            show()
        }
    }

    private fun sendComposer() {
        val text = composer?.text?.toString()?.trim().orEmpty(); if (text.isBlank()) return
        if (configurationMode) RabiConversationService.sendConfigurationRequest(this, text) else RabiConversationService.sendText(this, text)
        composer?.text?.clear(); runtimeHandler.postDelayed({ renderChat() }, 150)
    }

    private fun toggleChatMode() {
        configurationMode = !configurationMode
        modeButton?.text = if (configurationMode) "返回对话" else "配置助手"
        modeBanner?.visibility = if (configurationMode) View.VISIBLE else View.GONE
        composer?.hint = if (configurationMode) "描述要查看或修改的 Rabi PC 配置" else "给 Rabi 发消息"
        toast(if (configurationMode) "配置动作仍由 Rabi PC 安全门确认" else "已返回普通会话")
    }

    private fun renderChat() {
        val host = chatMessages ?: return; host.removeAllViews()
        val selectedRoute = RabiConversationTarget.load(this)
        val messages = RabiChatStore(this).list().filter { it.routeProfileId.isBlank() || selectedRoute.isBlank() || it.routeProfileId == selectedRoute }
        if (messages.isEmpty()) host.addView(LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            gravity = Gravity.CENTER
            setPadding(dp(24), dp(64), dp(24), dp(24))
            addView(TextView(this@MainActivity).apply { text = "开始和 Rabi 对话"; textSize = 18f; typeface = Typeface.DEFAULT_BOLD; setTextColor(Color.rgb(16, 42, 67)); gravity = Gravity.CENTER })
            addView(TextView(this@MainActivity).apply { text = "发送文字、语音或文件，消息会可靠地交给当前人格。"; textSize = 13f; setTextColor(Color.rgb(104, 119, 132)); gravity = Gravity.CENTER; setPadding(0, dp(8), 0, 0) })
        })
        var previousDay = ""
        messages.forEach { message ->
            val mine = message.role == "user"
            val day = formatMessageDay(message.createdAt)
            if (day.isNotBlank() && day != previousDay) {
                host.addView(TextView(this).apply {
                    text = day
                    textSize = 11f
                    typeface = Typeface.DEFAULT_BOLD
                    setTextColor(Color.rgb(113, 130, 145))
                    gravity = Gravity.CENTER
                    setPadding(0, dp(12), 0, dp(6))
                })
                previousDay = day
            }
            val routeName = availableRoutes.firstOrNull { it.id == message.routeProfileId }?.name ?: message.routeProfileId
            val sender = if (mine) "你" else routeName.ifBlank { "Rabi" }
            val messageTime = formatMessageTime(message.createdAt)
            val group = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; gravity = if (mine) Gravity.END else Gravity.START }
            group.addView(TextView(this).apply {
                text = if (messageTime.isBlank()) sender else "$sender · $messageTime"
                textSize = 11f
                typeface = Typeface.DEFAULT_BOLD
                setTextColor(if (mine) RabiMobileUi.muted else RabiMobileUi.secondary)
                setPadding(dp(4), 0, dp(4), dp(4))
            })
            val bubble = LinearLayout(this).apply {
                orientation = LinearLayout.VERTICAL
                setPadding(dp(13), dp(10), dp(13), dp(10))
                background = panel(if (mine) RabiMobileUi.primary else Color.WHITE, if (mine) RabiMobileUi.primary else RabiMobileUi.border, 14)
                minimumWidth = dp(72)
            }
            val kindLabel = messageKindLabel(message.kind)
            if (kindLabel.isNotBlank()) bubble.addView(TextView(this).apply {
                text = kindLabel
                textSize = 11f
                typeface = Typeface.DEFAULT_BOLD
                setTextColor(if (mine) Color.rgb(190, 232, 234) else RabiMobileUi.secondary)
                setPadding(0, 0, 0, if (message.text.isBlank()) 0 else dp(5))
            })
            if (message.text.isNotBlank()) bubble.addView(TextView(this).apply {
                text = message.text
                textSize = 15f
                setTextColor(if (mine) Color.WHITE else Color.rgb(31, 45, 58))
                setLineSpacing(0f, 1.08f)
            })
            if (message.fileName.isNotBlank()) bubble.addView(TextView(this).apply {
                text = message.fileName
                textSize = 13f
                typeface = Typeface.DEFAULT_BOLD
                setTextColor(if (mine) Color.WHITE else RabiMobileUi.primary)
                setPadding(0, if (message.text.isBlank()) dp(2) else dp(8), 0, 0)
            })
            if (message.localPath.isNotBlank()) {
                bubble.isClickable = true
                bubble.contentDescription = "打开附件 ${message.fileName}"
                bubble.setOnClickListener { openAttachment(message) }
            }
            group.addView(bubble, LinearLayout.LayoutParams(-2, -2))
            host.addView(group, LinearLayout.LayoutParams(-1, -2).apply { setMargins(if (mine) dp(42) else 0, dp(5), if (mine) 0 else dp(42), dp(5)) })
        }
        chatScroll?.post { chatScroll?.fullScroll(View.FOCUS_DOWN) }
    }

    private fun formatMessageDay(createdAt: Long): String = if (createdAt <= 0) "" else SimpleDateFormat("yyyy-MM-dd", Locale.getDefault()).format(Date(createdAt))
    private fun formatMessageTime(createdAt: Long): String = if (createdAt <= 0) "" else SimpleDateFormat("HH:mm", Locale.getDefault()).format(Date(createdAt))
    private fun messageKindLabel(kind: String): String = when (kind) {
        "voice" -> "语音转写"
        "tts" -> "语音回复"
        "image" -> "图片"
        "video" -> "视频"
        "audio-file" -> "音频文件"
        "file" -> "文件"
        "configuration" -> "配置请求"
        else -> ""
    }

    private fun refreshChatIfChanged() {
        if (chatMessages == null) return
        val updatedAt = getSharedPreferences("rabi_conversation_runtime", MODE_PRIVATE).getLong("updatedAt", 0)
        if (updatedAt > lastChatRuntimeAt) { lastChatRuntimeAt = updatedAt; renderChat() }
    }

    private fun openAttachment(message: RabiChatStore.Message) {
        try {
            val uri = if (message.localPath.startsWith("content://")) android.net.Uri.parse(message.localPath)
                else FileProvider.getUriForFile(this, "$packageName.files", File(message.localPath))
            startActivity(Intent(Intent.ACTION_VIEW).setDataAndType(uri, message.contentType.ifBlank { "application/octet-stream" })
                .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION))
        } catch (error: Throwable) { toast("没有可打开该文件的应用：${error.message ?: "未知错误"}") }
    }

    private fun buildUi(): View {
        val content = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(16), dp(16), dp(16), dp(28))
            setBackgroundColor(RabiMobileUi.background)
        }
        content.addView(RabiMobileUi.hero(
            this,
            "连接你的 Rabi",
            "App 会先自动检查；只有安全凭证、系统权限或外部设备限制无法代办时，才请你操作。",
        ), full(0, 0, 0, 12))
        status = RabiMobileUi.guidance(this, RabiSetupGuidance(
            "正在检查当前环境",
            "App 正在读取已保存连接并寻找同一网络的 Rabi PC。",
            "请稍候，不需要先填写所有高级参数。",
        ))
        content.addView(status, full(0, 0, 0, 12))
        content.addView(serverCard(), full(0, 0, 0, 12))
        content.addView(conversationRuntimeCard(), full(0, 0, 0, 12))
        content.addView(wearableCard(), full(0, 0, 0, 12))
        content.addView(glassesCard(), full(0, 0, 0, 12))
        content.addView(mediaCard(), full(0, 0, 0, 12))
        lateinit var advancedToggle: Button
        advancedToggle = secondary("显示高级设置") {
            val visible = advancedSettings.visibility != View.VISIBLE
            advancedSettings.visibility = if (visible) View.VISIBLE else View.GONE
            advancedToggle.text = if (visible) "收起高级设置" else "显示高级设置"
        }
        content.addView(advancedToggle, full(0, 0, 0, 12))
        advancedSettings = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            visibility = View.GONE
            addView(conversationCard(), full(0, 0, 0, 12))
            addView(toolsCard(), full(0, 0, 0, 12))
        }
        content.addView(advancedSettings)
        return ScrollView(this).apply { addView(content) }
    }

    override fun onResume() { super.onResume(); runtimeHandler.removeCallbacks(runtimeTick); runtimeHandler.post(runtimeTick); renderChat() }
    override fun onPause() { runtimeHandler.removeCallbacks(runtimeTick); super.onPause() }

    private fun conversationRuntimeCard(): View = card().apply {
        addView(title("持续会话"))
        runtimeStatus = note("尚未启动")
        runtimeTranscript = runtimeLine("你：等待语音")
        runtimeReply = runtimeLine("Rabi：等待回复")
        addView(runtimeStatus)
        addView(runtimeTranscript, full(0, 2, 0, 2))
        addView(runtimeReply, full(0, 2, 0, 8))
        val actions = row()
        actions.addView(primary("开始 / 应用") { startConversation() }, LinearLayout.LayoutParams(0, -2, 1f))
        actions.addView(space(), LinearLayout.LayoutParams(dp(6), 1))
        actions.addView(secondary("提示 Agent") { RabiConversationService.requestReview(this@MainActivity) }, LinearLayout.LayoutParams(0, -2, 1f))
        actions.addView(space(), LinearLayout.LayoutParams(dp(6), 1))
        actions.addView(secondary("停止") { RabiConversationService.stop(this@MainActivity) }, LinearLayout.LayoutParams(0, -2, 1f))
        addView(actions)
    }

    private fun refreshConversationRuntime() {
        if (!::runtimeStatus.isInitialized) return
        val values = getSharedPreferences("rabi_conversation_runtime", MODE_PRIVATE)
        runtimeStatus.text = values.getString("status", "尚未启动")
        runtimeTranscript.text = "你：${values.getString("transcript", "等待语音")}"
        runtimeReply.text = "Rabi：${values.getString("reply", "等待回复")}"
    }

    private fun serverCard(): View = card().apply {
        addView(title("1. 安全连接"))
        addView(note("按顺序完成下面三项。App 能识别的会直接填好；需要你确认的内容，就在对应输入框下面告诉你去哪里拿。"))
        relayUrl = input("例如：http://192.168.1.10:8794/rabilink")
        relayToken = input("从 Rabi PC 复制的移动端登录码").apply { inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_PASSWORD }
        relayUrlHelp = RabiMobileUi.fieldHelp(this@MainActivity, "这里填手机能访问的 RabiLink 地址。通常不用手填，App 找到电脑后会自动写入。")
        relayTokenHelp = RabiMobileUi.fieldHelp(this@MainActivity, "这里粘贴 Rabi PC“RabiLink / 移动端”页面显示的登录码；它是安全凭证，所以不能静默读取。")
        addView(label("① RabiLink 服务器地址")); addView(relayUrl); addView(relayUrlHelp)
        addView(label("② 移动端登录码")); addView(relayToken); addView(relayTokenHelp)
        discoveredPcAction = secondary("打开 Rabi PC 获取登录码") { openDiscoveredManager() }.apply { visibility = View.GONE }
        addView(discoveredPcAction, full(0, 0, 0, 8))
        pcAdapter = ArrayAdapter(this@MainActivity, android.R.layout.simple_spinner_item, mutableListOf("尚未连接"))
        pcAdapter.setDropDownViewResource(android.R.layout.simple_spinner_dropdown_item)
        pcSpinner = RabiMobileUi.spinner(this@MainActivity, Spinner(this@MainActivity).apply {
            adapter = pcAdapter
            onItemSelectedListener = object : android.widget.AdapterView.OnItemSelectedListener {
                override fun onItemSelected(parent: android.widget.AdapterView<*>?, view: View?, position: Int, id: Long) { selectedPc = pcs.getOrNull(position); refreshStatus("已选择目标 PC") }
                override fun onNothingSelected(parent: android.widget.AdapterView<*>?) = Unit
            }
        })
        pcHelp = RabiMobileUi.fieldHelp(this@MainActivity, "③ 登录成功后，这里会列出在线电脑；只有一台时 App 会自动选择。")
        addView(label("③ 处理消息的 Rabi PC")); addView(pcSpinner); addView(pcHelp)
        connectButton = primary("连接 Rabi") { connectRelay() }
        addView(connectButton, full(0, 0, 0, 8))
        val actions = row()
        actions.addView(secondary("自动检测") { scanLocalRabi() }, LinearLayout.LayoutParams(0, -2, 1f))
        actions.addView(space(), LinearLayout.LayoutParams(dp(8), 1))
        actions.addView(secondary("使用所选 PC") { bindPc() }, LinearLayout.LayoutParams(0, -2, 1f))
        addView(actions)
    }

    private fun glassesCard(): View = card().apply {
        addView(title("4. 可选眼镜交互"))
        addView(note("手机可以独立持续会话。开启眼镜后，输入、播放、HUD 和触摸板交互切到眼镜，但仍复用同一个手机后端。"))
        addView(primary("打开眼镜后端") { openRokid("connect_glass_app") }, full(0, 0, 0, 8))
        val row = row()
        row.addView(secondary("安装眼镜 App") { openRokid("install_glass_asr") }, LinearLayout.LayoutParams(0, -2, 1f)); row.addView(space(), LinearLayout.LayoutParams(dp(8), 1))
        row.addView(secondary("启动眼镜 App") { openRokid("start_glass_asr") }, LinearLayout.LayoutParams(0, -2, 1f))
        addView(row)
    }

    private fun mediaCard(): View = card().apply {
        addView(title("5. 照片与视频消息"))
        addView(note("照片和短视频作为可靠附件慢传：手机暂存、压缩、排队、重试，再交给 Rabi PC。当前不把公网链路描述成直播。"))
        val actions = row()
        actions.addView(primary("手机选择照片 / 视频") { pickPhoneMedia() }, LinearLayout.LayoutParams(0, -2, 1f))
        actions.addView(space(), LinearLayout.LayoutParams(dp(8), 1))
        actions.addView(secondary("打开眼镜拍照桥") { openRokid("") }, LinearLayout.LayoutParams(0, -2, 1f))
        addView(actions)
    }

    private fun toolsCard(): View = card().apply {
        addView(title("6. 管理与诊断"))
        addView(note("Rabi PC 配置请使用 RabiLink 服务器里的远程 WebGUI。设备探针保留在高级入口。"))
        val row = row()
        row.addView(secondary("打开远程配置") { openRemoteConfig() }, LinearLayout.LayoutParams(0, -2, 1f)); row.addView(space(), LinearLayout.LayoutParams(dp(8), 1))
        row.addView(secondary("接口测试中心") { startActivity(Intent(this@MainActivity, TestCenterActivity::class.java)) }, LinearLayout.LayoutParams(0, -2, 1f))
        addView(row)
    }

    private fun wearableCard(): View = card().apply {
        addView(title("3. 智能手表 / 手环"))
        addView(note("配置小米密钥、Health Connect 持续采集、心率阈值和睡眠状态告警。健康数据会送到所选 Rabi PC 的“智能手表/手环”消息端。"))
        addView(primary("配置健康消息端") {
            startActivity(Intent(this@MainActivity, WearableHealthSettingsActivity::class.java))
        })
    }

    private fun conversationCard(): View = card().apply {
        addView(title("2. 持续会话与语音模型"))
        addView(note("这些设置同时用于手机独立模式和眼镜模式。ASR/TTS 在所选 Rabi PC 执行，手机负责持续录音、VAD 分段、cursor 和恢复。"))
        continuousListening = RabiMobileUi.styleSwitch(this@MainActivity, Switch(this@MainActivity).apply { text = "配置完成后自动持续聆听" })
        glassesEnabled = RabiMobileUi.styleSwitch(this@MainActivity, Switch(this@MainActivity).apply { text = "连接后使用眼镜麦克风、扬声器和触摸板" })
        autoPlayAgentVoice = RabiMobileUi.styleSwitch(this@MainActivity, Switch(this@MainActivity).apply { text = "收到 Agent TTS 后立即播放" })
        addView(continuousListening)
        addView(glassesEnabled)
        addView(autoPlayAgentVoice)
        asrModel = input("faster-whisper/small")
        asrLanguage = input("zh")
        ttsModel = input("local-tts/gpt-sovits")
        ttsVoice = input("Rabi")
        vadThreshold = numberInput("650")
        silenceMs = numberInput("900")
        addView(label("Rabi PC ASR 模型")); addView(asrModel, full(0, 0, 0, 6))
        addView(label("识别语言")); addView(asrLanguage, full(0, 0, 0, 6))
        addView(label("Rabi PC TTS 模型")); addView(ttsModel, full(0, 0, 0, 6))
        addView(label("人格 / 声线")); addView(ttsVoice, full(0, 0, 0, 6))
        val vadRow = row()
        vadRow.addView(LinearLayout(this@MainActivity).apply {
            orientation = LinearLayout.VERTICAL
            addView(label("VAD 阈值")); addView(vadThreshold)
        }, LinearLayout.LayoutParams(0, -2, 1f))
        vadRow.addView(space(), LinearLayout.LayoutParams(dp(8), 1))
        vadRow.addView(LinearLayout(this@MainActivity).apply {
            orientation = LinearLayout.VERTICAL
            addView(label("静音切句 ms")); addView(silenceMs)
        }, LinearLayout.LayoutParams(0, -2, 1f))
        addView(vadRow, full(0, 0, 0, 8))
        addView(primary("保存并开始持续会话") { startConversation() }, full(0, 0, 0, 8))
        val actions = row()
        actions.addView(secondary("立即提示 Agent") { RabiConversationService.requestReview(this@MainActivity) }, LinearLayout.LayoutParams(0, -2, 1f))
        actions.addView(space(), LinearLayout.LayoutParams(dp(8), 1))
        actions.addView(secondary("停止持续会话") { RabiConversationService.stop(this@MainActivity) }, LinearLayout.LayoutParams(0, -2, 1f))
        addView(actions)
        addView(secondary("重试失败的 ASR / TTS 消息") { RabiConversationService.retryFailed(this@MainActivity) }, full(0, 8, 0, 0))
    }

    private fun loadConversationSettings() {
        val value = RabiConversationSettings.load(this)
        continuousListening.isChecked = value.continuousListening
        glassesEnabled.isChecked = value.glassesEnabled
        autoPlayAgentVoice.isChecked = value.autoPlayAgentVoice
        asrModel.setText(value.asrModel)
        asrLanguage.setText(value.asrLanguage)
        ttsModel.setText(value.ttsModel)
        ttsVoice.setText(value.ttsVoice)
        vadThreshold.setText(value.vadThreshold.toString())
        silenceMs.setText(value.silenceMs.toString())
    }

    private fun saveConversationSettings() {
        RabiConversationSettings(
            continuousListening.isChecked,
            glassesEnabled.isChecked,
            autoPlayAgentVoice.isChecked,
            asrModel.text.toString(),
            asrLanguage.text.toString(),
            ttsModel.text.toString(),
            ttsVoice.text.toString(),
            vadThreshold.text.toString().toIntOrNull() ?: 650,
            silenceMs.text.toString().toIntOrNull() ?: 900
        ).save(this)
        toast("持续会话设置已保存")
    }

    private fun startConversation() {
        saveConversationSettings()
        val relay = RabiLinkRelaySettings.load(this)
        if (!relay.configured) return toast("请先连接 RabiLink 服务器")
        val settings = RabiConversationSettings.load(this)
        if (!settings.glassesEnabled && checkSelfPermission(android.Manifest.permission.RECORD_AUDIO) != android.content.pm.PackageManager.PERMISSION_GRANTED) {
            requestPermissions(arrayOf(android.Manifest.permission.RECORD_AUDIO), requestPhoneAudio)
            return
        }
        RabiConversationService.start(this)
        if (settings.glassesEnabled && getSharedPreferences("rokid_probe", MODE_PRIVATE).getString("rokid_token", "").isNullOrBlank()) {
            openRokid("connect_glass_app")
        }
    }

    override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<out String>, grantResults: IntArray) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        if (requestCode == requestPhoneAudio && grantResults.firstOrNull() == android.content.pm.PackageManager.PERMISSION_GRANTED) {
            RabiConversationService.start(this)
        } else if (requestCode == requestPhoneAudio) {
            showGuidance(RabiSetupGuidance(
                "麦克风权限未开启",
                "手机持续会话需要由 Android 明确授权录音；App 不能绕过系统替你打开。",
                "在系统权限页允许麦克风，或改用已连接眼镜的麦克风。",
                RabiGuidanceTone.WARNING,
            ))
        }
    }

    private fun pickPhoneMedia() {
        startActivityForResult(Intent(Intent.ACTION_OPEN_DOCUMENT).apply {
            addCategory(Intent.CATEGORY_OPENABLE)
            type = "*/*"
        }, requestPhoneMedia)
    }

    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        super.onActivityResult(requestCode, resultCode, data)
        if (requestCode != requestPhoneMedia || resultCode != RESULT_OK) return
        val uri = data?.data ?: return
        try { contentResolver.takePersistableUriPermission(uri, Intent.FLAG_GRANT_READ_URI_PERMISSION) } catch (_: Throwable) { }
        RabiConversationService.enqueueMedia(this, uri, contentResolver.getType(uri) ?: "application/octet-stream")
        if (!showingSettings) runtimeHandler.postDelayed({ renderChat() }, 300)
    }

    private fun autoPrepareSetup(saved: RabiLinkRelayConfig) {
        if (saved.configured) {
            showGuidance(RabiSetupGuidance(
                "已找到上次的连接",
                "App 正在自动验证登录状态和在线 Rabi PC。",
                "验证通过后，只有一个在线 PC 时会自动选择。",
            ))
            connectRelay()
        } else {
            scanLocalRabi()
        }
    }

    private fun scanLocalRabi() {
        if (busy) return
        setBusy(true)
        showGuidance(RabiSetupGuidance(
            "正在自动寻找 Rabi PC",
            "正在扫描同一 Wi-Fi；找到后会把地址直接填进第一个输入框。",
            "请稍候。",
        ))
        runAsync({ discoverySdk.scanLan(applicationContext) }, { instances ->
            discoveredManagers.clear()
            discoveredManagers.addAll(instances)
            val first = instances.firstOrNull()
            if (first == null) {
                discoveredPcAction.visibility = View.GONE
                if (relayUrl.text.toString().trim().isBlank()) {
                    setUrlHelp(
                        "没有自动找到电脑。请确认手机与 Rabi PC 在同一 Wi-Fi；也可手填 http://电脑局域网IP:8794/rabilink。",
                        RabiGuidanceTone.WARNING,
                    )
                }
                if (relayToken.text.toString().trim().isBlank()) {
                    setTokenHelp(
                        "登录码要在 Rabi PC 的“RabiLink / 移动端”页面复制；App 不会猜测或生成安全凭证。",
                        RabiGuidanceTone.WARNING,
                    )
                } else {
                    setTokenHelp("登录码已经填写，连接时会安全验证。", RabiGuidanceTone.INFO)
                }
                showGuidance(RabiSetupGuidance("还差连接信息", "请按输入框下方的提示完成标橙项目。", "" , RabiGuidanceTone.WARNING))
            } else {
                discoveredPcAction.visibility = View.VISIBLE
                val pcName = first.name.ifBlank { first.computerName.ifBlank { "Rabi PC" } }
                val inferredUrl = "http://${first.host}:8794/rabilink"
                if (relayUrl.text.toString().trim().isBlank()) {
                    relayUrl.setText(inferredUrl)
                    setUrlHelp("已从 $pcName 自动检测并填入：$inferredUrl", RabiGuidanceTone.SUCCESS)
                } else {
                    setUrlHelp("已保留你填写的地址；同时检测到 $pcName 可用地址 $inferredUrl。", RabiGuidanceTone.INFO)
                }
                if (relayToken.text.toString().trim().isBlank()) {
                    setTokenHelp(
                        "还差这一项：点下面“打开 $pcName 获取登录码”，在 RabiLink / 移动端页面复制后粘贴到这里。",
                        RabiGuidanceTone.WARNING,
                    )
                }
                discoveredPcAction.text = "打开 $pcName 获取登录码"
                showGuidance(RabiSetupGuidance(
                    "已找到 ${instances.size} 台 Rabi PC，服务器地址已填好",
                    if (relayToken.text.toString().isBlank()) "现在只需完成标橙的“移动端登录码”。" else "连接信息已经齐全。",
                    if (relayToken.text.toString().isBlank()) "按第二个输入框下方的提示获取登录码。" else "点“连接 Rabi”。",
                    RabiGuidanceTone.SUCCESS,
                ))
            }
        }, complete = { setBusy(false) }, error = { error ->
            setUrlHelp(
                "自动检测失败：${error.message ?: "Android 无法完成局域网扫描"}。可手填 http://电脑局域网IP:8794/rabilink。",
                RabiGuidanceTone.ERROR,
            )
            showGuidance(RabiSetupGuidance("自动检测没有完成", "请按服务器地址输入框下方的提示处理。", "", RabiGuidanceTone.WARNING))
        })
    }

    private fun openDiscoveredManager() {
        val instance = discoveredManagers.firstOrNull()
        if (instance == null) {
            showGuidance(RabiSetupGuidance(
                "没有可打开的 Rabi PC",
                "本轮扫描没有保留可用地址。",
                "确认手机和电脑在同一 Wi-Fi 后重新检测。",
                RabiGuidanceTone.WARNING,
            ))
            return
        }
        startActivity(Intent(Intent.ACTION_VIEW, android.net.Uri.parse(instance.baseUrl)))
    }

    private fun connectRelay() {
        val url = relayBaseUrl(); val token = relayToken.text.toString().trim()
        if (url.isBlank() || token.isBlank()) {
            if (url.isBlank()) setUrlHelp(
                "这里必须填服务器地址。先点“自动检测”；仍找不到时填 http://电脑局域网IP:8794/rabilink。",
                RabiGuidanceTone.ERROR,
            )
            if (token.isBlank()) setTokenHelp(
                "这里必须粘贴移动端登录码。请在 Rabi PC 的“RabiLink / 移动端”页面复制；这是安全凭证，App 不能替你生成。",
                RabiGuidanceTone.ERROR,
            )
            showGuidance(RabiSetupGuidance("连接信息还没填完整", "请完成标红输入框；每项下面都有获取方法。", "", RabiGuidanceTone.WARNING))
            if (url.isBlank() && discoveredManagers.isEmpty()) scanLocalRabi()
            return
        }
        setUrlHelp("正在验证这个服务器地址是否可由手机访问。", RabiGuidanceTone.INFO)
        setTokenHelp("正在安全验证登录码；不会把明文写入日志。", RabiGuidanceTone.INFO)
        setBusy(true)
        showGuidance(RabiSetupGuidance(
            "正在验证连接",
            "App 正在检查服务器、登录码和可用 Rabi PC。",
            "请稍候，不需要重复点击。",
        ))
        runAsync({
            val initial = sdk.getMobileState(url, token)
            val onlyOnlinePc = initial.workers.filter { it.online }.singleOrNull()
            if (initial.selectedWorker == null && onlyOnlinePc != null) {
                sdk.selectMobileRabiPc(url, token, onlyOnlinePc.id)
            } else initial
        }, { state ->
            RabiLinkRelaySettings.save(this, url, token); RokidDeviceStatusSyncService.start(this)
            setUrlHelp("服务器地址验证通过，已保存到本机。", RabiGuidanceTone.SUCCESS)
            setTokenHelp("登录码验证通过，已安全保存到本机。", RabiGuidanceTone.SUCCESS)
            pcs.clear(); pcs.addAll(state.workers); pcAdapter.clear()
            if (pcs.isEmpty()) pcAdapter.add("没有在线 Rabi PC") else pcAdapter.addAll(pcs.map { "${it.name} · ${if (it.online) "在线" else "离线"}" })
            pcAdapter.notifyDataSetChanged(); selectedPc = state.selectedWorker ?: pcs.firstOrNull()
            selectedPc?.let { pc -> pcSpinner.setSelection(pcs.indexOfFirst { it.id == pc.id }.coerceAtLeast(0)) }
            if (pcs.isEmpty()) {
                setPcHelp("登录已经成功，但服务器当前没有在线 Rabi PC。请在电脑启动 RabiRoute 的 RabiLink worker。", RabiGuidanceTone.WARNING)
                showGuidance(RabiSetupGuidance(
                    "RabiLink 已登录，但没有在线 PC",
                    "服务器接受了登录码，当前却没有 Rabi PC worker 在线。",
                    "在电脑启动 RabiRoute 并启用 RabiLink Relay worker，然后点“连接 Rabi”刷新。",
                    RabiGuidanceTone.WARNING,
                ))
            } else {
                val pc = selectedPc
                setPcHelp(
                    if (state.workers.size == 1) "已自动选择唯一在线电脑：${pc?.name ?: "Rabi PC"}。" else "已选择 ${pc?.name ?: "Rabi PC"}；点下拉框可以切换。",
                    RabiGuidanceTone.SUCCESS,
                )
                showGuidance(RabiSetupGuidance(
                    "连接完成",
                    "已登录 RabiLink，${pc?.name ?: "Rabi PC"} ${if (pc?.online == true) "在线" else "当前离线"}。",
                    if (state.workers.size == 1) "App 已自动选择唯一的 PC，可以开始使用。" else "如需切换电脑，选择后点“使用所选 PC”。",
                    RabiGuidanceTone.SUCCESS,
                ))
            }
        }, complete = { setBusy(false) }, error = { error -> showConnectionError(error) })
    }

    private fun bindPc() {
        val pc = selectedPc ?: return run {
            setPcHelp("这里还没有电脑可选。先完成前两个输入框并点“连接 Rabi”。", RabiGuidanceTone.ERROR)
            showGuidance(RabiSetupGuidance("还没有可选的 Rabi PC", "请看第三项下方的提示。", "", RabiGuidanceTone.WARNING))
        }
        val token = relayToken.text.toString().trim()
        if (token.isBlank()) {
            setTokenHelp("先在这里粘贴移动端登录码，再选择电脑。", RabiGuidanceTone.ERROR)
            return
        }
        setBusy(true)
        runAsync({ sdk.selectMobileRabiPc(relayBaseUrl(), token, pc.id) }, { state ->
            selectedPc = state.selectedWorker ?: pc
            setPcHelp("后续手机、手表和眼镜消息会交给 ${selectedPc?.name ?: "这台 Rabi PC"}。", RabiGuidanceTone.SUCCESS)
            showGuidance(RabiSetupGuidance(
                "已切换到 ${selectedPc?.name}",
                "后续手机、手表和眼镜消息会默认交给这台 Rabi PC。",
                "现在可以返回会话或继续配置设备。",
                RabiGuidanceTone.SUCCESS,
            ))
        }, complete = { setBusy(false) }, error = { error -> showConnectionError(error) })
    }

    private fun openRokid(command: String) {
        val config = RabiLinkRelaySettings.load(this)
        if (!config.configured) return showGuidance(RabiSetupGuide.missingConnection(config.baseUrl.isBlank(), config.token.isBlank(), discoveredManagers.size))
        startActivity(Intent(this, RokidProbeActivity::class.java).apply { if (command.isNotBlank()) putExtra("rokid_probe_command", command) })
    }

    private fun openRemoteConfig() {
        val url = relayBaseUrl()
        if (url.isBlank()) return showGuidance(RabiSetupGuide.missingConnection(true, relayToken.text.toString().trim().isBlank(), discoveredManagers.size))
        startActivity(Intent(Intent.ACTION_VIEW, android.net.Uri.parse("$url/manage")))
    }

    private fun refreshStatus(message: String) {
        if (!::status.isInitialized || busy) return
        val saved = RabiLinkRelaySettings.load(this)
        if (saved.configured && selectedPc != null) {
            showGuidance(RabiSetupGuidance(
                "连接已就绪",
                "RabiLink 已登录，当前使用 ${selectedPc?.name}。",
                message,
                RabiGuidanceTone.SUCCESS,
            ))
        }
    }
    private fun showGuidance(value: RabiSetupGuidance) {
        if (!::status.isInitialized) return
        val styled = RabiMobileUi.guidance(this, value)
        status.text = styled.text
        status.setTextColor(styled.currentTextColor)
        status.background = styled.background
    }

    private fun setUrlHelp(message: String, tone: RabiGuidanceTone) {
        if (!::relayUrlHelp.isInitialized || !::relayUrl.isInitialized) return
        RabiMobileUi.styleFieldHelp(this, relayUrlHelp, message, tone)
        RabiMobileUi.styleInputState(this, relayUrl, tone)
    }

    private fun setTokenHelp(message: String, tone: RabiGuidanceTone) {
        if (!::relayTokenHelp.isInitialized || !::relayToken.isInitialized) return
        RabiMobileUi.styleFieldHelp(this, relayTokenHelp, message, tone)
        RabiMobileUi.styleInputState(this, relayToken, tone)
    }

    private fun setPcHelp(message: String, tone: RabiGuidanceTone) {
        if (!::pcHelp.isInitialized) return
        RabiMobileUi.styleFieldHelp(this, pcHelp, message, tone)
    }

    private fun showConnectionError(error: Throwable) {
        val guidance = RabiSetupGuide.connectionError(error)
        val raw = error.message.orEmpty().lowercase()
        val fieldMessage = listOf(guidance.reason, guidance.action).filter { it.isNotBlank() }.joinToString(" ")
        when {
            "401" in raw || "403" in raw || "unauthorized" in raw || "forbidden" in raw ->
                setTokenHelp(fieldMessage, RabiGuidanceTone.ERROR)
            "unknownhost" in raw || "resolve host" in raw || "timeout" in raw || "timed out" in raw ||
                "cleartext" in raw || "refused" in raw || "failed to connect" in raw || "unreachable" in raw ->
                setUrlHelp(fieldMessage, RabiGuidanceTone.ERROR)
            else -> {
                setUrlHelp("服务器或网络没有完成验证，请核对地址后重试。", RabiGuidanceTone.WARNING)
                setTokenHelp("如果地址无误，请重新从 Rabi PC 复制移动端登录码。", RabiGuidanceTone.WARNING)
            }
        }
        showGuidance(RabiSetupGuidance(guidance.title, "请查看对应输入框下方的修复提示。", "", guidance.tone))
    }

    private fun relayBaseUrl() = relayUrl.text.toString().trim().trimEnd('/')
    private fun setBusy(value: Boolean) {
        busy = value
        if (::connectButton.isInitialized) {
            connectButton.isEnabled = !value
            connectButton.text = if (value) "正在检查…" else "连接 Rabi"
        }
    }
    private fun <T> runAsync(
        work: () -> T,
        success: (T) -> Unit,
        complete: () -> Unit = {},
        error: (Throwable) -> Unit = { toast(it.message ?: it.javaClass.simpleName) },
    ) { Thread { try { val result = work(); runOnUiThread { success(result); complete() } } catch (cause: Throwable) { runOnUiThread { error(cause); complete() } } }.start() }
    private fun toast(text: String) = Toast.makeText(this, text, Toast.LENGTH_SHORT).show()

    private fun card() = RabiMobileUi.card(this)
    private fun title(text: String) = RabiMobileUi.title(this, text)
    private fun note(text: String) = RabiMobileUi.note(this, text)
    private fun runtimeLine(text: String) = TextView(this).apply { this.text = text; textSize = 14f; setTextColor(RabiMobileUi.text); maxLines = 2; ellipsize = android.text.TextUtils.TruncateAt.END }
    private fun label(text: String) = RabiMobileUi.label(this, text)
    private fun input(hint: String) = RabiMobileUi.input(this, hint)
    private fun numberInput(hint: String) = input(hint).apply { inputType = InputType.TYPE_CLASS_NUMBER }
    private fun primary(text: String, action: () -> Unit) = RabiMobileUi.primary(this, text, action)
    private fun secondary(text: String, action: () -> Unit) = RabiMobileUi.secondary(this, text, action)
    private fun row() = LinearLayout(this).apply { orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER_VERTICAL }
    private fun space() = View(this)
    private fun full(l: Int, t: Int, r: Int, b: Int) = LinearLayout.LayoutParams(-1, -2).apply { setMargins(dp(l), dp(t), dp(r), dp(b)) }
    private fun panel(color: Int, stroke: Int, radius: Int) = RabiMobileUi.panel(this, color, stroke, radius)
    private fun dp(value: Int) = RabiMobileUi.dp(this, value)
}
