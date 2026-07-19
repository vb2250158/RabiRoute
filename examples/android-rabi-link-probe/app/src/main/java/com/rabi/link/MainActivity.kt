package com.rabi.link

import android.app.Activity
import android.content.Intent
import android.graphics.Color
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.text.InputType
import android.view.Gravity
import android.view.View
import android.widget.*
import androidx.core.content.FileProvider
import java.io.File
import com.rabiroute.sdk.RabiLinkPc
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
    private val pcs = mutableListOf<RabiLinkPc>()
    private lateinit var relayUrl: EditText
    private lateinit var relayToken: EditText
    private lateinit var pcSpinner: Spinner
    private lateinit var pcAdapter: ArrayAdapter<String>
    private lateinit var status: TextView
    private lateinit var connectButton: Button
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
        if (saved.baseUrl.isNotBlank()) relayUrl.setText(saved.baseUrl)
        if (saved.token.isNotBlank()) relayToken.setText(saved.token)
        loadConversationSettings(); refreshStatus("等待连接")
    }

    private fun showChat() {
        showingSettings = false
        val root = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; setBackgroundColor(Color.rgb(248, 249, 251)) }
        val top = row().apply { setPadding(dp(14), dp(8), dp(10), dp(8)); setBackgroundColor(Color.WHITE) }
        top.addView(TextView(this).apply { text = "Rabi 移动端"; textSize = 21f; typeface = Typeface.DEFAULT_BOLD; setTextColor(Color.rgb(25, 29, 36)) }, LinearLayout.LayoutParams(0, -2, 1f))
        routeButton = secondary("人格：加载中") { chooseRoute() }
        top.addView(routeButton)
        modeButton = secondary("配置助手") { toggleChatMode() }
        top.addView(modeButton)
        top.addView(secondary("设置") { showSettings() })
        root.addView(top)
        chatMessages = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; setPadding(dp(12), dp(12), dp(12), dp(18)) }
        chatScroll = ScrollView(this).apply { addView(chatMessages) }
        root.addView(chatScroll, LinearLayout.LayoutParams(-1, 0, 1f))
        val bottom = row().apply { setPadding(dp(8), dp(6), dp(8), dp(8)); setBackgroundColor(Color.WHITE) }
        bottom.addView(secondary("＋") { pickPhoneMedia() })
        composer = input("给 Rabi 发消息").apply { setSingleLine(false); maxLines = 4 }
        bottom.addView(composer, LinearLayout.LayoutParams(0, -2, 1f).apply { setMargins(dp(6), 0, dp(6), 0) })
        bottom.addView(primary("发送") { sendComposer() })
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
        composer?.hint = if (configurationMode) "描述要查看或修改的 Rabi PC 配置" else "给 Rabi 发消息"
        toast(if (configurationMode) "配置动作仍由 Rabi PC 安全门确认" else "已返回普通会话")
    }

    private fun renderChat() {
        val host = chatMessages ?: return; host.removeAllViews()
        val selectedRoute = RabiConversationTarget.load(this)
        val messages = RabiChatStore(this).list().filter { it.routeProfileId.isBlank() || selectedRoute.isBlank() || it.routeProfileId == selectedRoute }
        if (messages.isEmpty()) host.addView(note("会话已经准备好。可以输入文字、持续说话，或发送图片、视频、音频和任意文件。"))
        messages.forEach { message ->
            val mine = message.role == "user"
            val body = when (message.kind) {
                "voice" -> "🎙 语音转写\n${message.text}"
                "tts" -> "🔊 ${message.text}"
                "image" -> "🖼 图片 · ${message.fileName}"
                "video" -> "🎬 视频 · ${message.fileName}"
                "audio-file" -> "🎵 音频文件 · ${message.fileName}"
                "file" -> "📎 文件 · ${message.fileName}"
                "configuration" -> "⚙ 配置请求\n${message.text}"
                else -> message.text
            }
            val routeName = availableRoutes.firstOrNull { it.id == message.routeProfileId }?.name ?: message.routeProfileId
            val label = if (!mine && routeName.isNotBlank()) "$routeName\n$body" else body
            val bubble = TextView(this).apply { text = label; textSize = 15f; setTextColor(if (mine) Color.WHITE else Color.rgb(31, 36, 44)); setPadding(dp(12), dp(9), dp(12), dp(9)); background = panel(if (mine) Color.rgb(36, 95, 235) else Color.WHITE, if (mine) Color.rgb(36, 95, 235) else Color.rgb(219, 223, 230), 14) }
            if (message.localPath.isNotBlank()) bubble.setOnClickListener { openAttachment(message) }
            host.addView(bubble, LinearLayout.LayoutParams(-2, -2).apply { gravity = if (mine) Gravity.END else Gravity.START; setMargins(if (mine) dp(36) else 0, dp(4), if (mine) 0 else dp(36), dp(4)) })
        }
        chatScroll?.post { chatScroll?.fullScroll(View.FOCUS_DOWN) }
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
            setPadding(dp(18), dp(18), dp(18), dp(24))
            setBackgroundColor(Color.rgb(246, 247, 249))
        }
        content.addView(TextView(this).apply {
            text = "Rabi 移动设备消息端"
            textSize = 26f
            typeface = Typeface.DEFAULT_BOLD
            setTextColor(Color.rgb(20, 25, 32))
        })
        content.addView(TextView(this).apply {
            text = "手机负责眼镜连接、媒体中转与本地设置；Rabi PC 负责 ASR、TTS、Agent 和配置。"
            textSize = 13f
            setTextColor(Color.rgb(88, 94, 104))
            setPadding(0, dp(4), 0, dp(12))
        })
        status = TextView(this).apply {
            textSize = 13f
            setTextColor(Color.rgb(31, 38, 48))
            setPadding(dp(14), dp(12), dp(14), dp(12))
            background = panel(Color.rgb(236, 244, 255), Color.rgb(174, 199, 237), 8)
        }
        content.addView(status, full(0, 0, 0, 14))
        content.addView(conversationRuntimeCard(), full(0, 0, 0, 12))
        content.addView(serverCard(), full(0, 0, 0, 12))
        content.addView(conversationCard(), full(0, 0, 0, 12))
        content.addView(wearableCard(), full(0, 0, 0, 12))
        content.addView(glassesCard(), full(0, 0, 0, 12))
        content.addView(mediaCard(), full(0, 0, 0, 12))
        content.addView(toolsCard(), full(0, 0, 0, 12))
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
        addView(title("1. RabiLink 与 Rabi PC"))
        addView(note("RabiLink 登录是全局设置。这里选择默认处理消息的 Rabi PC；该 PC 可同时发布多个路由人格，聊天顶部按人格切换会话。"))
        relayUrl = input("https://relay.example.com")
        relayToken = input("RabiLink 应用 token").apply { inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_PASSWORD }
        addView(label("服务器 URL")); addView(relayUrl, full(0, 0, 0, 8))
        addView(label("应用 token")); addView(relayToken, full(0, 0, 0, 8))
        pcAdapter = ArrayAdapter(this@MainActivity, android.R.layout.simple_spinner_item, mutableListOf("尚未连接"))
        pcAdapter.setDropDownViewResource(android.R.layout.simple_spinner_dropdown_item)
        pcSpinner = Spinner(this@MainActivity).apply {
            adapter = pcAdapter
            onItemSelectedListener = object : android.widget.AdapterView.OnItemSelectedListener {
                override fun onItemSelected(parent: android.widget.AdapterView<*>?, view: View?, position: Int, id: Long) { selectedPc = pcs.getOrNull(position); refreshStatus("已选择目标 PC") }
                override fun onNothingSelected(parent: android.widget.AdapterView<*>?) = Unit
            }
        }
        addView(label("处理眼镜消息的 Rabi PC")); addView(pcSpinner, full(0, 0, 0, 10))
        val row = row()
        connectButton = primary("连接 / 刷新") { connectRelay() }
        row.addView(connectButton, LinearLayout.LayoutParams(0, -2, 1f)); row.addView(space(), LinearLayout.LayoutParams(dp(8), 1))
        row.addView(secondary("设为默认 PC") { bindPc() }, LinearLayout.LayoutParams(0, -2, 1f))
        addView(row)
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
        continuousListening = Switch(this@MainActivity).apply { text = "配置完成后自动持续聆听" }
        glassesEnabled = Switch(this@MainActivity).apply { text = "连接后使用眼镜麦克风、扬声器和触摸板" }
        autoPlayAgentVoice = Switch(this@MainActivity).apply { text = "收到 Agent TTS 后立即播放" }
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
            toast("需要麦克风权限才能使用手机持续会话")
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

    private fun connectRelay() {
        val url = relayBaseUrl(); val token = relayToken.text.toString().trim()
        if (token.isBlank()) return toast("请填写应用 token")
        setBusy(true); refreshStatus("连接服务器中")
        runAsync({ sdk.getMobileState(url, token) }, { state ->
            RabiLinkRelaySettings.save(this, url, token); RokidDeviceStatusSyncService.start(this)
            pcs.clear(); pcs.addAll(state.workers); pcAdapter.clear()
            if (pcs.isEmpty()) pcAdapter.add("没有在线 Rabi PC") else pcAdapter.addAll(pcs.map { "${it.name} · ${if (it.online) "在线" else "离线"}" })
            pcAdapter.notifyDataSetChanged(); selectedPc = state.selectedWorker ?: pcs.firstOrNull()
            selectedPc?.let { pc -> pcSpinner.setSelection(pcs.indexOfFirst { it.id == pc.id }.coerceAtLeast(0)) }
            refreshStatus("Relay 已连接")
        }) { setBusy(false) }
    }

    private fun bindPc() {
        val pc = selectedPc ?: return toast("请先选择 Rabi PC")
        val token = relayToken.text.toString().trim(); if (token.isBlank()) return toast("请先连接服务器")
        setBusy(true)
        runAsync({ sdk.selectMobileRabiPc(relayBaseUrl(), token, pc.id) }, { state -> selectedPc = state.selectedWorker ?: pc; refreshStatus("默认 PC：${selectedPc?.name}") }) { setBusy(false) }
    }

    private fun openRokid(command: String) {
        val config = RabiLinkRelaySettings.load(this)
        if (!config.configured) return toast("请先连接 RabiLink 服务器")
        startActivity(Intent(this, RokidProbeActivity::class.java).apply { if (command.isNotBlank()) putExtra("rokid_probe_command", command) })
    }

    private fun openRemoteConfig() {
        val url = relayBaseUrl()
        if (url.isBlank()) return toast("请先填写服务器 URL")
        startActivity(Intent(Intent.ACTION_VIEW, android.net.Uri.parse("$url/manage")))
    }

    private fun refreshStatus(message: String) { if (!::status.isInitialized) return; status.text = "Relay：${if (RabiLinkRelaySettings.load(this).configured) "已配置" else "未配置"}\nRabi PC：${selectedPc?.name ?: "未选择"}\n眼镜后端：${if (busy) "处理中" else message}" }
    private fun relayBaseUrl() = relayUrl.text.toString().trim().trimEnd('/')
    private fun setBusy(value: Boolean) { busy = value; connectButton.isEnabled = !value; connectButton.text = if (value) "处理中..." else "连接 / 刷新" }
    private fun <T> runAsync(
        work: () -> T,
        success: (T) -> Unit,
        complete: () -> Unit = {},
        error: (Throwable) -> Unit = { toast(it.message ?: it.javaClass.simpleName) },
    ) { Thread { try { val result = work(); runOnUiThread { success(result); complete() } } catch (cause: Throwable) { runOnUiThread { error(cause); complete() } } }.start() }
    private fun toast(text: String) = Toast.makeText(this, text, Toast.LENGTH_SHORT).show()

    private fun card() = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; setPadding(dp(14), dp(12), dp(14), dp(12)); background = panel(Color.WHITE, Color.rgb(218, 222, 228), 8) }
    private fun title(text: String) = TextView(this).apply { this.text = text; textSize = 17f; typeface = Typeface.DEFAULT_BOLD; setTextColor(Color.rgb(24, 30, 38)) }
    private fun note(text: String) = TextView(this).apply { this.text = text; textSize = 12f; setTextColor(Color.rgb(80, 87, 98)); setPadding(0, dp(6), 0, dp(8)) }
    private fun runtimeLine(text: String) = TextView(this).apply { this.text = text; textSize = 14f; setTextColor(Color.rgb(31, 38, 48)); maxLines = 2; ellipsize = android.text.TextUtils.TruncateAt.END }
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
}
