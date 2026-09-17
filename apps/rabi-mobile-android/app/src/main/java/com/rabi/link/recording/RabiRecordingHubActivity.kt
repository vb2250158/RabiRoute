package com.rabi.link.recording

import android.Manifest
import android.app.Activity
import android.app.AlertDialog
import android.content.*
import android.content.pm.PackageManager
import android.graphics.Typeface
import android.os.*
import android.view.View
import android.widget.*
import androidx.core.content.ContextCompat
import androidx.core.content.FileProvider
import com.rabi.link.*
import com.rabi.link.modules.rokid.RabiLiveRecordingController
import com.rabi.link.modules.rokid.RokidProbeActivity
import com.rabi.link.modules.wearable.WearableHealthSettingsActivity
import java.text.SimpleDateFormat
import java.util.*

/** A view of the unified recording owner, never an owner of capture hardware or queues. */
@androidx.annotation.OptIn(androidx.media3.common.util.UnstableApi::class)
class RabiRecordingHubActivity : Activity() {
    private val main = Handler(Looper.getMainLooper())
    private var page = "records"
    private var active = false
    private val statusTick = object : Runnable {
        override fun run() { if(active) { refreshRuntime(); main.postDelayed(this,1000) } }
    }
    private lateinit var body: LinearLayout
    private var status: TextView? = null
    private var recordingToggle: Switch? = null
    private var updatingToggle = false
    private var reviewPanel: RecordingReviewPanel? = null
    private var live: RabiLiveRecordingController? = null
    private val videoChanged: () -> Unit = { main.post { if (active) refreshRuntime() } }
    private val receiver = object : BroadcastReceiver() {
        override fun onReceive(context: Context?, intent: Intent?) { refreshRuntime() }
    }
    // Old home launches and missing extras land on the single recording timeline.
    private fun resolvePage(value: String?) = if(value in listOf("records", "devices")) value!! else "records"
    private fun settings() = AllDayRecordingSettings.load(this)
    private fun runtime() = getSharedPreferences("rabi_conversation_runtime", MODE_PRIVATE)
    override fun onCreate(saved: Bundle?) {
        super.onCreate(saved)
        page = resolvePage(saved?.getString("page") ?: intent.getStringExtra("page"))
        // Historical launch extras navigate only. They never grant consent to start capture.
        render()
    }
    override fun onNewIntent(value: Intent?) {
        super.onNewIntent(value); setIntent(value)
        page = resolvePage(value?.getStringExtra("page")); render()
    }
    override fun onSaveInstanceState(out: Bundle) { out.putString("page", page); super.onSaveInstanceState(out) }
    override fun onStart() {
        super.onStart(); active = true; main.postDelayed(statusTick,1000)
        ContextCompat.registerReceiver(this, receiver, IntentFilter("com.rabi.link.conversation.RUNTIME_UPDATED"), ContextCompat.RECEIVER_NOT_EXPORTED)
        if(page == "devices" || (page == "records" && reviewPanel == null)) render() else refreshRuntime()
    }
    override fun onStop() {
        active = false; main.removeCallbacks(statusTick); unregisterReceiver(receiver)
        live?.unlisten(videoChanged); live = null; reviewPanel?.close(); reviewPanel = null; super.onStop()
    }
    override fun onDestroy() { main.removeCallbacksAndMessages(null); super.onDestroy() }
    override fun onBackPressed() {
        if (page != "records") { page = "records"; render() } else super.onBackPressed()
    }
    private fun dp(value: Int) = (value * resources.displayMetrics.density).toInt()
    private fun label(text: String, size: Float = 15f) = TextView(this).apply {
        this.text = text; textSize = size; setTextColor(RabiMobileUi.primary); setPadding(0, dp(6), 0, dp(6))
    }
    private fun button(text: String, click: () -> Unit) = RabiMobileUi.secondary(this, text, click)
    private fun section(title: String): LinearLayout = LinearLayout(this).apply {
        orientation = LinearLayout.VERTICAL; setPadding(dp(16), dp(12), dp(16), dp(12)); background = RabiMobileUi.panel(this@RabiRecordingHubActivity, RabiMobileUi.surface)
        dividerDrawable = android.graphics.drawable.GradientDrawable().apply { setColor(android.graphics.Color.TRANSPARENT); setSize(1, dp(8)) }
        showDividers = LinearLayout.SHOW_DIVIDER_MIDDLE
        layoutParams = LinearLayout.LayoutParams(-1, -2).apply { bottomMargin = dp(12) }
        addView(label(title, 20f).apply { typeface = Typeface.DEFAULT_BOLD })
    }.also { body.addView(it) }
    private fun render() {
        reviewPanel?.close(); reviewPanel = null; status = null; recordingToggle = null
        val frame = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; setBackgroundColor(RabiMobileUi.background) }
        val header = LinearLayout(this).apply { gravity = android.view.Gravity.CENTER_VERTICAL; setPadding(dp(16),dp(2),dp(8),dp(2)) }
        if(page == "devices") header.addView(label("记录设备",20f),LinearLayout.LayoutParams(0,-2,1f))
        else header.addView(android.view.View(this),LinearLayout.LayoutParams(0,0,1f))
        if(page == "records") {
            recordingToggle = Switch(this).apply {
                text = if(settings().running) "记录中" else "开始记录"; textSize = 14f
                minHeight = dp(48); setPadding(dp(8),0,dp(12),0); setTextColor(RabiMobileUi.primary)
                isChecked = settings().running; contentDescription = "开始或暂停记录"
                setOnCheckedChangeListener { _, checked ->
                    if(!updatingToggle) {
                        if(checked) startRecording() else serviceAction { RabiConversationService.pauseRecording(this@RabiRecordingHubActivity) }
                        refreshRuntime()
                    }
                }
            }.also { header.addView(it) }
            header.addView(RabiMobileUi.compactAction(this,"☰") { page = "devices"; render() }.apply { contentDescription = "记录设备"; setBackgroundColor(android.graphics.Color.TRANSPARENT); stateListAnimator = null },LinearLayout.LayoutParams(dp(48),dp(48)))
        }
        val deviceToolbar = LinearLayout(this).apply {
            gravity = android.view.Gravity.CENTER_VERTICAL
            setPadding(dp(16),0,dp(16),dp(12))
        }
        if(page == "devices") {
            header.addView(android.widget.ImageButton(this).apply {
                setImageResource(com.rabi.link.R.drawable.ic_recording_close)
                imageTintList = android.content.res.ColorStateList.valueOf(RabiMobileUi.primary)
                setBackgroundColor(android.graphics.Color.TRANSPARENT)
                setPadding(dp(12),dp(12),dp(12),dp(12))
                contentDescription = "关闭设备页，返回记录"
                setOnClickListener { page = "records"; render() }
            },LinearLayout.LayoutParams(dp(48),dp(48)))
            deviceToolbar.addView(button("⚙  记录设置") { showEventSplitSettings() }.apply { textSize = 14f },LinearLayout.LayoutParams(0,dp(48),1f).apply { marginEnd = dp(8) })
            deviceToolbar.addView(button("＋  添加设备") {
                AlertDialog.Builder(this).setTitle("添加设备").setItems(arrayOf("眼镜","手表 / 手环")) { _, index ->
                    when(index) {
                        0 -> if(settings().running) toast("请先关闭记录开关，再连接眼镜") else startActivity(Intent(this,RokidProbeActivity::class.java))
                        1 -> startActivity(Intent(this,WearableHealthSettingsActivity::class.java))
                    }
                }.show()
            }.apply { textSize = 13f; contentDescription = "添加设备" },LinearLayout.LayoutParams(0,dp(48),1f).apply { marginEnd = dp(8) })
            deviceToolbar.addView(button("RabiLink") {
                startActivity(Intent(this,MainActivity::class.java).putExtra("open_settings",true).putExtra("relay_settings",true))
            }.apply { textSize = 13f; contentDescription = "配置 RabiLink" },LinearLayout.LayoutParams(0,dp(48),1f).apply { marginEnd = dp(8) })
            deviceToolbar.addView(button("ASR 设置") { AsrSettingsDialog.show(this) }.apply { textSize = 13f },LinearLayout.LayoutParams(0,dp(48),1f))
        }
        if(page == "devices") frame.addView(header)
        if(page == "devices") {
            frame.addView(deviceToolbar)
            frame.addView(button("存储管理") { RecordingStorageDialog.show(this) },LinearLayout.LayoutParams(-1,dp(48)).apply {
                marginStart = dp(16); marginEnd = dp(16); bottomMargin = dp(12)
            })
        }
        body = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; setPadding(dp(16), 0, dp(16), dp(12)) }
        if(page == "records") {
            header.setBackgroundColor(android.graphics.Color.TRANSPARENT)
            reviewPanel = RecordingReviewPanel(this, ::share).also { it.attachHeader(header); frame.addView(it.view, LinearLayout.LayoutParams(-1,0,1f)) }
        } else {
            frame.addView(ScrollView(this).apply { addView(body) }, LinearLayout.LayoutParams(-1, 0, 1f))
            renderDevices()
        }
        val nav = RabiMobileUi.bottomNavigation(this, "records") { key ->
            if (key == "messages") startActivity(Intent(this, MainActivity::class.java).putExtra("open_messages", true))
            else if (key != page) { page = key; render() }
        }
        frame.addView(nav); setContentView(frame); refreshRuntime()
    }
    private fun serviceAction(action: () -> Unit) {
        runCatching(action).onFailure { toast("操作未完成：${it.message ?: "系统未允许启动服务"}") }
        refreshRuntime()
    }
    private var computerRequestPending = false
    private fun chooseRelayComputer() {
        val relay = RabiLinkRelaySettings.load(this)
        if(!relay.configured) {
            toast("请先通过工具栏配置 RabiLink")
            return
        }
        computerRequest("正在读取电脑列表…") {
            val state = com.rabiroute.sdk.RabiRouteSdk().getMobileState(relay.baseUrl,relay.token)
            main.post {
                if(!active || isFinishing || isDestroyed) return@post
                if(state.workers.isEmpty()) { toast("RabiLink 上暂无电脑"); return@post }
                AlertDialog.Builder(this).setTitle("切换电脑")
                    .setItems(state.workers.map { "${it.name} · ${if(it.online) "在线" else "离线"}${if(it.id == state.selectedWorker?.id) " · 当前" else ""}" }.toTypedArray()) { _, index ->
                        val pc = state.workers[index]
                        computerRequest("正在切换电脑…") {
                            val current = RabiLinkRelaySettings.load(this)
                            check(current.baseUrl == relay.baseUrl && current.token == relay.token)
                            val confirmed = com.rabiroute.sdk.RabiRouteSdk().selectMobileRabiPc(relay.baseUrl,relay.token,pc.id)
                            check(confirmed.selectedWorker?.id == pc.id)
                            TargetWorkerIdentity.save(this,relay.baseUrl,relay.token,pc.id)
                            RabiLinkRelaySettings.rememberComputer(this,pc.name,pc.id,relay.baseUrl,relay.token)
                            main.post {
                                if(!isFinishing && !isDestroyed) {
                                    RabiConversationService.start(this)
                                    if(page == "devices") render()
                                    toast("已切换到 ${pc.name}")
                                }
                            }
                        }
                    }.setNegativeButton("取消",null).show()
            }
        }
    }
    private fun computerRequest(message: String, operation: () -> Unit) {
        if(computerRequestPending) return
        computerRequestPending = true
        toast(message)
        Thread {
            val result = runCatching(operation)
            main.post {
                computerRequestPending = false
                if(!isFinishing && !isDestroyed && result.isFailure) toast("RabiLink 请求失败，请检查连接后重试")
            }
        }.start()
    }
    private fun transitionPending(): Boolean = runtime().getString("allDayStatus", "").orEmpty().let { it.contains("正在停止") || it.contains("正在保存") }
    private fun startRecording() {
        if(transitionPending()) { toast("正在保存上一段，请完成后再开始"); return }
        val value = settings()
        val required = mutableListOf<String>()
        if(value.mode == "audio") required.add(Manifest.permission.RECORD_AUDIO)
        if(value.mode == "audio" || value.mode == "video") {
            required.add(Manifest.permission.BLUETOOTH_CONNECT)
            required.add(Manifest.permission.BLUETOOTH_SCAN)
        }
        val missing = required.filter { checkSelfPermission(it) != PackageManager.PERMISSION_GRANTED }
        if(missing.isNotEmpty()) { requestPermissions(missing.toTypedArray(), 9044); return }
        if(Build.VERSION.SDK_INT >= 33 && !notificationPermissionChecked && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            notificationPermissionChecked = true
            requestPermissions(arrayOf(Manifest.permission.POST_NOTIFICATIONS), 9045); return
        }
        serviceAction { RabiConversationService.startRecording(this) }
    }
    private var notificationPermissionChecked = false
    override fun onRequestPermissionsResult(code: Int, permissions: Array<out String>, grants: IntArray) {
        super.onRequestPermissionsResult(code, permissions, grants)
        if(code == 9044) {
            if(grants.isNotEmpty() && grants.all { it == PackageManager.PERMISSION_GRANTED }) startRecording()
            else if(settings().mode == "audio" && checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED) {
                toast("眼镜权限未授予，先使用手机录音")
                serviceAction { RabiConversationService.startRecording(this) }
            } else toast("录音权限未授予，未开始采集")
        } else if(code == 9045) {
            if(grants.firstOrNull() != PackageManager.PERMISSION_GRANTED) toast("通知未获授权，系统可能隐藏通知栏入口；可在应用内暂停记录")
            startRecording() // Notification denial alone does not prohibit an Android foreground service.
        }
    }
    private fun refreshRuntime() {
        if(!active) return
        if(settings().running && !RabiConversationService.recordingOwnerAvailable()) {
            settings().withRunning(false,System.currentTimeMillis()).save(this)
            runtime().edit().putString("allDayStatus","录音已中断，请重新开启记录")
                .putLong("captureLastReceivedAt",0).putBoolean("captureHasSignal",false).apply()
        }
        reviewPanel?.refreshLive()
        val current = RabiConversationService.currentVideo()
        if(current !== live) { live?.unlisten(videoChanged); live = current; current?.listen(videoChanged) }
        val value = settings(); val data = runtime()
        updatingToggle = true
        recordingToggle?.isChecked = value.running
        val recentAudio = System.currentTimeMillis()-data.getLong("captureLastReceivedAt",0) < 5000
        recordingToggle?.text = if(value.running) { if(value.mode == "audio" && !recentAudio) "等待声音" else "记录中" } else "开始记录"
        recordingToggle?.isEnabled = !transitionPending()
        updatingToggle = false
        val actualStatus = data.getString("allDayStatus", "").orEmpty()
        status?.text = if((actualStatus.contains("失败") || actualStatus.contains("中断"))) actualStatus else if(value.running) actualStatus.ifBlank { "正在开始记录…" } else "记录已暂停"
    }
    private fun showStreamGuide() {
        val panel = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; setPadding(dp(18), dp(12), dp(18), dp(12)) }
        panel.addView(label("1. 眼镜与手机连接同一 Wi-Fi 或手机热点。\n2. 在记录页开启记录。\n3. 在乐奇原生直播填写以下地址和密钥并开播。\n4. 返回记录页确认真实画面。"))
        val current = RabiConversationService.currentVideo()
        if(current == null) panel.addView(label("尚未建立视频接收连接。"))
        else {
            current.urls().forEach { url -> panel.addView(button("复制推流地址") { copy(url) }) }
            panel.addView(button("复制推流密钥") { copy(current.streamKey) })
        }
        panel.addView(label("Rabi 暂停会停止手机接收；乐奇原生相机仍需在乐奇结束直播。自动安装／开播未验收，不自动启用。", 13f))
        AlertDialog.Builder(this).setTitle("眼镜开播").setView(panel).setPositiveButton("完成", null).show()
    }
    private fun share(entry: RecordingStore.Entry) {
        runCatching {
            check(entry.files.isNotEmpty()) { "没有可分享文件" }
            val uris = ArrayList(entry.files.map { FileProvider.getUriForFile(this, "$packageName.files", it) })
            val send = Intent(if(uris.size == 1) Intent.ACTION_SEND else Intent.ACTION_SEND_MULTIPLE).apply {
                type = if(entry.kind == "video") "video/mp4" else "audio/wav"
                if(uris.size == 1) putExtra(Intent.EXTRA_STREAM, uris.first()) else putParcelableArrayListExtra(Intent.EXTRA_STREAM, uris)
                addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
                clipData = ClipData.newUri(contentResolver, "原始记录", uris.first()).apply { uris.drop(1).forEach { addItem(ClipData.Item(it)) } }
            }
            startActivity(Intent.createChooser(send, "分享原始记录"))
        }.onFailure { toast(it.message ?: "无法分享，原文件保留") }
    }
    private fun renderDevices() {
        val value = settings()
        val data = runtime()
        val authorized = !getSharedPreferences("rokid_probe",MODE_PRIVATE).getString("rokid_token", "").isNullOrBlank()
        val audioSource = if(value.running) data.getString("actualAudioSource", "") else ""
        val healthAt = data.getLong("healthLastReceivedAt",0)
        fun card(kind: String, title: String, subtitle: String, open: () -> Unit): View = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL; setPadding(dp(16),dp(16),dp(16),dp(14))
            background = RabiMobileUi.panel(this@RabiRecordingHubActivity,RabiMobileUi.surface,RabiMobileUi.surface,22)
            isClickable = true; isFocusable = true; contentDescription = "$title，$subtitle，打开管理"
            setOnClickListener { open() }
            val top = LinearLayout(this@RabiRecordingHubActivity).apply { gravity = android.view.Gravity.CENTER_VERTICAL }
            top.addView(DeviceGlyphView(this@RabiRecordingHubActivity,kind),LinearLayout.LayoutParams(dp(40),dp(40)))
            top.addView(label("›",24f).apply { gravity = android.view.Gravity.END; setTextColor(RabiMobileUi.muted) },LinearLayout.LayoutParams(0,-2,1f))
            addView(top)
            addView(View(this@RabiRecordingHubActivity),LinearLayout.LayoutParams(1,0,1f))
            addView(label(title,17f).apply { typeface = Typeface.DEFAULT_BOLD; setPadding(0,0,0,dp(3)) })
            addView(label(subtitle,12f).apply { setTextColor(RabiMobileUi.muted); setPadding(0,0,0,0); maxLines = 2 })
        }
        val cards = mutableListOf(
            card("phone","手机",if(audioSource == "mobile") "正在收音" else "本机 · 自动参与录音") {
                AlertDialog.Builder(this).setTitle("手机").setMessage("手机会在眼镜没有供声时自动录音。开始和暂停使用记录页顶部的总开关。")
                    .setPositiveButton("完成",null).show()
            },
            card("glasses","眼镜",when { audioSource == "glasses" -> "正在收音"; RabiConversationService.currentVideo()?.receiving == true -> "正在接收画面"; authorized -> "已授权 · 暂无音视频"; else -> "待连接" }) {
                AlertDialog.Builder(this).setTitle("眼镜").setItems(if(RabiConversationService.currentVideo() != null) arrayOf("连接与授权","视频开播步骤") else arrayOf("连接与授权")) { _, index ->
                    if(index == 1) showStreamGuide()
                    else if(settings().running) toast("请先关闭顶部记录开关，再管理眼镜连接")
                    else startActivity(Intent(this,RokidProbeActivity::class.java))
                }.show()
            },
            card("watch","手表 / 手环",if(healthAt > 0) "最近同步 ${date(healthAt)}" else "尚未收到健康数据") { startActivity(Intent(this,WearableHealthSettingsActivity::class.java)) }

        )
        val selectedComputer = RabiLinkRelaySettings.computers(this).firstOrNull { RabiLinkRelaySettings.isActive(this,it) }
        cards.add(card("computer","电脑",selectedComputer?.name?.let { "$it · 点击切换" } ?: "点击选择 RabiLink 电脑") { chooseRelayComputer() })
        cards.chunked(2).forEach { pair ->
            body.addView(LinearLayout(this).apply {
                pair.forEachIndexed { index, tile -> addView(tile,LinearLayout.LayoutParams(0,dp(158),1f).apply { if(index == 0) marginEnd = dp(10) }) }
                if(pair.size == 1) addView(View(this@RabiRecordingHubActivity),LinearLayout.LayoutParams(0,dp(158),1f))
            },LinearLayout.LayoutParams(-1,-2).apply { bottomMargin = dp(10) })
        }
    }
    private fun helpIcon(action: () -> Unit) = ImageButton(this).apply {
        setImageResource(R.drawable.ic_recording_help)
        imageTintList = android.content.res.ColorStateList.valueOf(RabiMobileUi.muted)
        setBackgroundColor(android.graphics.Color.TRANSPARENT)
        setPadding(dp(14),dp(14),dp(14),dp(14))
        setOnClickListener { action() }
    }
    private fun showEventSplitSettings() {
        val policy = EventSplitSettings.load(this)
        val panel = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; setPadding(dp(20),dp(4),dp(20),dp(8)); setBackgroundColor(RabiMobileUi.surface) }
        fun slider(title: String, minimum: Int, maximum: Int, step: Int, initial: Int, unit: String, hint: String, fractional: Boolean = false): SeekBar {
            val heading = LinearLayout(this).apply { gravity = android.view.Gravity.CENTER_VERTICAL }
            heading.addView(label(title,14f),LinearLayout.LayoutParams(0,-2,1f))
            val current = label("",14f).apply { setTextColor(RabiMobileUi.secondary) }
            heading.addView(current)
            val range = if(fractional) "0.001–0.300" else "$minimum–$maximum $unit"
            val explanation = label("$hint。范围 $range。保存后分段参数从下一段生效。",12f).apply {
                setTextColor(RabiMobileUi.muted); visibility = View.GONE
            }
            heading.addView(helpIcon {
                explanation.visibility = if(explanation.visibility == View.GONE) View.VISIBLE else View.GONE
            }.apply { contentDescription = "${title}说明" },LinearLayout.LayoutParams(dp(48),dp(48)))
            panel.addView(heading)
            panel.addView(explanation)
            val track = SeekBar(this).apply {
                max = (maximum-minimum)/step
                progress = (initial-minimum)/step
                minimumHeight = dp(48)
                progressTintList = android.content.res.ColorStateList.valueOf(RabiMobileUi.secondary)
                thumbTintList = android.content.res.ColorStateList.valueOf(RabiMobileUi.secondary)
                fun updateValue(value: Int) {
                    current.text = if(fractional) String.format(Locale.ROOT,"%.3f",(minimum+value*step)/1000.0) else "${minimum+value*step} $unit"
                    contentDescription = "$title，${current.text}"
                }
                updateValue(progress)
                setOnSeekBarChangeListener(object: SeekBar.OnSeekBarChangeListener {
                    override fun onProgressChanged(bar: SeekBar?, value: Int, fromUser: Boolean) { updateValue(value) }
                    override fun onStartTrackingTouch(bar: SeekBar?) { }
                    override fun onStopTrackingTouch(bar: SeekBar?) { }
                })
            }
            panel.addView(track,LinearLayout.LayoutParams(-1,dp(48)))
            return track
        }
        val threshold = slider("声音阈值",1,300,1,Math.round(policy.signalThreshold*1000).toInt(),"","越低越容易判为有效声音；参考线同步显示",true)
        val silence = slider("静音收尾",200,3000,50,policy.silenceMs,"毫秒","连续静音多久后拆分事件")
        val maximum = slider("最长语音",3,120,1,policy.maxMs/1000,"秒","达到上限时自动拆分，录音继续")
        val thresholdLine = Switch(this).apply {
            text = "显示转写参考线"
            isChecked = EventSplitSettings.showTranscribeLine(this@RabiRecordingHubActivity)
            minHeight = dp(48); textSize = 14f; setTextColor(RabiMobileUi.text)
            thumbTintList = android.content.res.ColorStateList(arrayOf(intArrayOf(android.R.attr.state_checked),intArrayOf()),intArrayOf(RabiMobileUi.secondary,RabiMobileUi.muted))
        }
        val lineHelp = label("参考线标出当前声音阈值；达到时音柱变绿，不表示已完成转写。隐藏不影响录音与分段。",12f).apply { visibility = View.GONE; setTextColor(RabiMobileUi.muted) }
        panel.addView(LinearLayout(this).apply {
            gravity = android.view.Gravity.CENTER_VERTICAL
            addView(thresholdLine,LinearLayout.LayoutParams(0,-2,1f))
            addView(helpIcon { lineHelp.visibility = if(lineHelp.visibility == View.GONE) View.VISIBLE else View.GONE }.apply { contentDescription = "参考线说明" },LinearLayout.LayoutParams(dp(48),dp(48)))
        })
        panel.addView(lineHelp)
        val dialog = AlertDialog.Builder(this).setTitle("记录设置").setView(ScrollView(this).apply { addView(panel) })
            .setPositiveButton("保存",null).setNegativeButton("取消",null)
            .setNeutralButton("恢复默认",null).create()
        dialog.setOnShowListener {
            listOf(AlertDialog.BUTTON_POSITIVE,AlertDialog.BUTTON_NEGATIVE,AlertDialog.BUTTON_NEUTRAL).forEach { dialog.getButton(it).setTextColor(RabiMobileUi.secondary) }
            dialog.getButton(AlertDialog.BUTTON_NEUTRAL).setOnClickListener { threshold.progress = 14; silence.progress = 6; maximum.progress = 57; thresholdLine.isChecked = true }
            dialog.getButton(AlertDialog.BUTTON_POSITIVE).setOnClickListener {
                EventSplitSettings.save(this,200+silence.progress*50,(3+maximum.progress)*1000,threshold.progress+1)
                EventSplitSettings.saveTranscribeLine(this,thresholdLine.isChecked)
                toast("已保存，拆分参数从下一段生效"); dialog.dismiss()
            }
        }
        dialog.show()
    }
    private fun copy(value: String) { getSystemService(ClipboardManager::class.java).setPrimaryClip(ClipData.newPlainText("眼镜开播参数", value)); toast("已复制") }
    private fun toast(value: String) = Toast.makeText(this, value, Toast.LENGTH_SHORT).show()
    private fun date(value: Long) = if(value <= 0) "时间未知" else SimpleDateFormat("MM月dd日 HH:mm:ss", Locale.CHINA).format(Date(value))
}
