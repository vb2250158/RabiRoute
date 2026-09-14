package com.rabi.link.recording

import android.Manifest
import android.app.Activity
import android.app.AlertDialog
import android.content.*
import android.content.pm.PackageManager
import android.graphics.Typeface
import android.net.Uri
import android.os.*
import android.view.View
import android.widget.*
import androidx.core.content.ContextCompat
import androidx.core.content.FileProvider
import androidx.media3.common.C
import androidx.media3.common.MediaItem
import androidx.media3.common.Player
import androidx.media3.common.PlaybackException
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.exoplayer.rtsp.RtspMediaSource
import androidx.media3.ui.PlayerView
import com.rabi.link.*
import com.rabi.link.modules.rokid.RabiLiveRecordingController
import com.rabi.link.modules.rokid.RokidProbeActivity
import com.rabi.link.modules.wearable.WearableHealthSettingsActivity
import org.json.JSONObject
import java.io.File
import java.text.SimpleDateFormat
import java.util.*
import java.util.concurrent.Executors

/** A view of the unified recording owner, never an owner of capture hardware or queues. */
@androidx.annotation.OptIn(androidx.media3.common.util.UnstableApi::class)
class RabiRecordingHubActivity : Activity() {
    private val main = Handler(Looper.getMainLooper())
    private val worker = Executors.newSingleThreadExecutor()
    private var page = "home"
    private var active = false
    private var generation = 0
    private lateinit var body: LinearLayout
    private var status: TextView? = null
    private var evidence: TextView? = null
    private var action: Button? = null
    private var preview: PlayerView? = null
    private var previewMessage: TextView? = null
    private var player: ExoPlayer? = null
    private var playing = ""
    private var detail: RecordingStore.Entry? = null
    private var live: RabiLiveRecordingController? = null
    private val videoChanged: () -> Unit = { main.post { if (active) refreshRuntime() } }
    private val receiver = object : BroadcastReceiver() {
        override fun onReceive(context: Context?, intent: Intent?) { refreshRuntime() }
    }
    private fun settings() = AllDayRecordingSettings.load(this)
    private fun runtime() = getSharedPreferences("rabi_conversation_runtime", MODE_PRIVATE)
    override fun onCreate(saved: Bundle?) {
        super.onCreate(saved)
        page = saved?.getString("page") ?: intent.getStringExtra("page") ?: "home"
        // Historical launch extras navigate only. They never grant consent to start capture.
        render()
    }
    override fun onNewIntent(value: Intent?) {
        super.onNewIntent(value); setIntent(value)
        page = value?.getStringExtra("page") ?: "home"; detail = null; render()
    }
    override fun onSaveInstanceState(out: Bundle) { out.putString("page", page); super.onSaveInstanceState(out) }
    override fun onStart() {
        super.onStart(); active = true
        ContextCompat.registerReceiver(this, receiver, IntentFilter("com.rabi.link.conversation.RUNTIME_UPDATED"), ContextCompat.RECEIVER_NOT_EXPORTED)
        if(page == "records" && detail == null) render() else refreshRuntime()
    }
    override fun onStop() {
        active = false; unregisterReceiver(receiver)
        live?.unlisten(videoChanged); live = null; releasePlayer(); super.onStop()
    }
    override fun onDestroy() { generation++; worker.shutdown(); main.removeCallbacksAndMessages(null); super.onDestroy() }
    override fun onBackPressed() {
        if (detail != null || page != "home") { detail = null; page = "home"; render() } else super.onBackPressed()
    }
    private fun dp(value: Int) = (value * resources.displayMetrics.density).toInt()
    private fun label(text: String, size: Float = 15f) = TextView(this).apply {
        this.text = text; textSize = size; setTextColor(RabiMobileUi.primary); setPadding(0, dp(6), 0, dp(6))
    }
    private fun button(text: String, click: () -> Unit) = Button(this).apply {
        this.text = text; isAllCaps = false; minHeight = dp(52); setTextColor(RabiMobileUi.primary)
        setOnClickListener { click() }
    }
    private fun section(title: String): LinearLayout = LinearLayout(this).apply {
        orientation = LinearLayout.VERTICAL; setPadding(dp(16), dp(12), dp(16), dp(12)); setBackgroundColor(RabiMobileUi.surface)
        layoutParams = LinearLayout.LayoutParams(-1, -2).apply { bottomMargin = dp(12) }
        addView(label(title, 20f).apply { typeface = Typeface.DEFAULT_BOLD })
    }.also { body.addView(it) }
    private fun render() {
        generation++; releasePlayer(); status = null; evidence = null; action = null; preview = null; previewMessage = null
        val frame = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; setBackgroundColor(RabiMobileUi.background) }
        frame.addView(label(if (detail != null) "回看记录" else when(page) { "records" -> "时间线"; "devices" -> "设备"; else -> "全天记录" }, 26f).apply { setPadding(dp(18), dp(18), dp(18), dp(12)) })
        body = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; setPadding(dp(16), 0, dp(16), dp(12)) }
        frame.addView(ScrollView(this).apply { addView(body) }, LinearLayout.LayoutParams(-1, 0, 1f))
        when { detail != null -> renderDetail(detail!!); page == "records" -> renderTimeline(); page == "devices" -> renderDevices(); else -> renderHome() }
        val nav = LinearLayout(this)
        listOf("home" to "记录", "records" to "时间线", "messages" to "消息", "devices" to "设备").forEach { (key, title) ->
            nav.addView(button(title) {
                if (key == "messages") startActivity(Intent(this, MainActivity::class.java).putExtra("open_messages", true))
                else { page = key; detail = null; render() }
            }.apply { isSelected = key == page; contentDescription = "$title${if (isSelected) "，已选择" else ""}" }, LinearLayout.LayoutParams(0, -2, 1f))
        }
        frame.addView(nav); setContentView(frame); refreshRuntime()
    }
    private fun renderHome() {
        val value = settings()
        section("一个开关，统一记录").apply {
            status = label("等待运行状态", 18f).also { addView(it) }
            evidence = label("").also { addView(it) }
            addView(label("模式：${modeName(value.mode)} · 来源：${sourceName(value.source)}\n健康参与：${if(value.healthEnabled || value.mode == "health") "已选择" else "关闭"}\n处理：${policyName(value.processingPolicy)} · 上传：${if(value.uploadEnabled) "允许" else "暂停"}\n记录目标：${value.routeProfileId.ifBlank { "未设置" }}"))
            action = button(if(value.running) "暂停全天记录" else "开始全天记录") {
                if(settings().running) serviceAction { RabiConversationService.pauseRecording(this@RabiRecordingHubActivity) } else startRecording()
            }.also { addView(it) }
            addView(button("标记此刻") {
                if(settings().running) serviceAction { RabiConversationService.markRecording(this@RabiRecordingHubActivity) } else toast("请先开始全天记录")
            })
            addView(button("记录设置") { showRecordingSettings() })
            addView(label("暂停与模式独立；切换聊天人格不会改变记录目标。停止采集不等于取消已保存内容的处理。", 13f))
        }
        if(value.mode == "video") section("眼镜音视频").apply {
            addPreview(this)
            addView(button("开播连接步骤") { showStreamGuide() })
            addView(label("视频中的音轨用于后续处理，不额外开启手机麦克风。开始接收不代表眼镜已经开播。", 13f))
        }
        section("可靠保存与处理").apply {
            addView(label("手机先保存，电脑按设置处理。断网不等于采集失败；全天运行时长不等于实际覆盖时长。", 14f))
            addView(button("查看时间线") { page = "records"; render() })
        }
    }
    private fun modeName(value: String) = when(value) { "video" -> "音视频"; "health" -> "仅健康"; else -> "音频" }
    private fun sourceName(value: String) = if(value == "glasses") "眼镜" else "手机"
    private fun policyName(value: String) = when(value) { "local_only" -> "仅本地保存"; "agent" -> "转写并交给人格"; else -> "自动转写" }
    private fun showRecordingSettings() {
        val previous = settings()
        if(previous.running || transitionPending()) { toast("请先暂停全天记录并等待保存完成，再更改设置"); return }
        val panel = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; setPadding(dp(18), dp(12), dp(18), dp(12)) }
        fun select(title: String, choices: List<String>, selected: Int): Spinner {
            panel.addView(label(title))
            return Spinner(this).apply {
                minimumHeight = dp(52)
                adapter = ArrayAdapter(this@RabiRecordingHubActivity, android.R.layout.simple_spinner_item, choices).also { it.setDropDownViewResource(android.R.layout.simple_spinner_dropdown_item) }
                setSelection(selected.coerceAtLeast(0)); panel.addView(this)
            }
        }
        fun toggle(title: String, checked: Boolean) = Switch(this).apply { text = title; minHeight = dp(52); isChecked = checked; panel.addView(this) }
        val modes = listOf("audio", "video", "health")
        val mode = select("记录模式", modes.map(::modeName), modes.indexOf(previous.mode))
        val sources = listOf("mobile", "glasses")
        val source = select("音频来源（音视频固定使用眼镜）", sources.map(::sourceName), sources.indexOf(previous.source))
        val health = toggle("同时接收健康数据", previous.healthEnabled)
        val policies = listOf("local_only", "transcribe", "agent")
        val policy = select("后续处理", policies.map(::policyName), policies.indexOf(previous.processingPolicy))
        val upload = toggle("允许上传（断网后排队，不改变采集模式）", previous.uploadEnabled)
        panel.addView(label("固定记录目标 Route ID（可留空，不跟随聊天窗口）"))
        panel.addView(label("未绑定电脑或目标时仍可本机记录，处理策略不会自动改变；这些记录不会在以后自动补绑或改投。", 13f))
        val route = EditText(this).apply { setSingleLine(true); minHeight = dp(52); setText(previous.routeProfileId); hint = "在电脑配置中获取 Route ID"; panel.addView(this) }
        val relay = RabiLinkRelaySettings.load(this)
        val routes = if(relay.configured) RabiRouteMetadataCache.load(this, relay) else emptyList()
        if(routes.isNotEmpty()) {
            panel.addView(button("从已缓存人格选择目标") {
                AlertDialog.Builder(this).setTitle("明确选择记录目标").setItems(routes.map { it.id }.toTypedArray()) { _, index -> route.setText(routes[index].id) }.show()
            })
        }
        panel.addView(label("启动记录需要明确点击开始；不承诺自动恢复麦克风。仅健康模式不打开音视频；健康数据需设备提供真实样本。暂停期间不补读。", 13f))
        val dialog = AlertDialog.Builder(this).setTitle("全天记录设置").setView(ScrollView(this).apply { addView(panel) }).setNegativeButton("取消", null).setPositiveButton("保存（不开始）", null).create()
        dialog.setOnShowListener { dialog.getButton(AlertDialog.BUTTON_POSITIVE).setOnClickListener {
            if(settings().running) { toast("记录已经运行，请先暂停"); return@setOnClickListener }
            val selectedPolicy = policies[policy.selectedItemPosition]
            val selectedMode = modes[mode.selectedItemPosition]
            runCatching { AllDayRecordingSettings(false, selectedMode, if(selectedMode == "video") "glasses" else sources[source.selectedItemPosition], selectedPolicy,
                route.text.toString(), health.isChecked || selectedMode == "health", upload.isChecked, false, previous.windowStartedAt).save(this) }
                .onSuccess {
                    dialog.dismiss()
                    serviceAction { RabiConversationService.start(this) } // Reload transport policy only, never capture.
                    render()
                }.onFailure { toast(it.message ?: "设置保存失败") }
        } }
        dialog.show()
    }
    private fun serviceAction(action: () -> Unit) {
        runCatching(action).onFailure { toast("操作未完成：${it.message ?: "系统未允许启动服务"}") }
        refreshRuntime()
    }
    private fun transitionPending(): Boolean = runtime().getString("allDayStatus", "").orEmpty().let { it.contains("正在停止") || it.contains("正在保存") }
    private fun startRecording() {
        if(transitionPending()) { toast("正在保存上一段，请完成后再开始"); return }
        val value = settings()
        val required = mutableListOf<String>()
        if(value.mode == "audio" && value.source == "mobile") required.add(Manifest.permission.RECORD_AUDIO)
        if((value.mode == "audio" && value.source == "glasses") || value.mode == "video") {
            required.add(Manifest.permission.BLUETOOTH_CONNECT)
            required.add(Manifest.permission.BLUETOOTH_SCAN)
        }
        val missing = required.filter { checkSelfPermission(it) != PackageManager.PERMISSION_GRANTED }
        if(missing.isNotEmpty()) { requestPermissions(missing.toTypedArray(), 9044); return }
        if(Build.VERSION.SDK_INT >= 33 && !notificationPermissionChecked && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            notificationPermissionChecked = true
            requestPermissions(arrayOf(Manifest.permission.POST_NOTIFICATIONS), 9045); return
        }
        if(value.routeProfileId.isBlank()) toast("未绑定处理目标：本机记录，已有记录不会自动补绑；处理策略保持不变")
        serviceAction { RabiConversationService.startRecording(this) }
    }
    private var notificationPermissionChecked = false
    override fun onRequestPermissionsResult(code: Int, permissions: Array<out String>, grants: IntArray) {
        super.onRequestPermissionsResult(code, permissions, grants)
        if(code == 9044) {
            if(grants.isNotEmpty() && grants.all { it == PackageManager.PERMISSION_GRANTED }) startRecording()
            else toast("当前来源所需权限未全部授予，未开始采集；可切换来源或在系统设置授权")
        } else if(code == 9045) {
            if(grants.firstOrNull() != PackageManager.PERMISSION_GRANTED) toast("通知未获授权，系统可能隐藏通知栏入口；可在应用内暂停记录")
            startRecording() // Notification denial alone does not prohibit an Android foreground service.
        }
    }
    private fun refreshRuntime() {
        if(!active) return
        val current = RabiConversationService.currentVideo()
        if(current !== live) { live?.unlisten(videoChanged); live = current; current?.listen(videoChanged) }
        val value = settings(); val data = runtime()
        val actualStatus = data.getString("allDayStatus", "").orEmpty()
        status?.text = "${if(value.running) "已请求运行" else "已暂停"} · ${actualStatus.ifBlank { if(value.running) "等待采集证据" else "尚未开始记录" }}"
        val last = data.getLong("captureLastReceivedAt", 0)
        val healthLast = data.getLong("healthLastReceivedAt", 0)
        val videoFirst = data.getLong("videoFirstReceivedAt", 0)
        evidence?.text = "以下为最后保存的接收证据，时间戳不表示设备当前在线或此刻仍在采集。\n最近声音接收证据：${if(last > 0) date(last) else "尚无证据"}\n视频首帧时间：${if(videoFirst > 0) date(videoFirst) else "尚无证据"}\n健康：${if(healthLast > 0) "最近数据 ${date(healthLast)}" else "尚无实际样本证据"}\n${data.getString("healthStatus", "未启用或等待设备")}\n${data.getString("video", "")}\n${data.getString("videoProcessing", "")}"
        action?.text = if(value.running) "暂停全天记录" else "开始全天记录"
        action?.isEnabled = !transitionPending()
        if(page == "home" && value.mode == "video" && detail == null) {
            if(live?.receiving == true) playLive(live!!.previewUrl)
            else if(playing.startsWith("rtsp:")) { releasePlayer(); previewMessage?.text = "等待眼镜画面" }
        }
    }
    private fun addPreview(parent: LinearLayout) {
        preview = PlayerView(this).apply { useController = detail != null }
        parent.addView(preview, LinearLayout.LayoutParams(-1, dp(220)))
        previewMessage = label("等待画面或选择播放", 13f).also { parent.addView(it) }
        parent.addView(button("全屏查看") {
            val view = preview ?: return@button
            val oldParent = view.parent as android.view.ViewGroup
            val index = oldParent.indexOfChild(view); val params = view.layoutParams; oldParent.removeView(view)
            val dialog = android.app.Dialog(this, android.R.style.Theme_Material_NoActionBar_Fullscreen)
            val full = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }
            full.addView(view, LinearLayout.LayoutParams(-1, 0, 1f)); full.addView(button("退出全屏") { dialog.dismiss() })
            dialog.setContentView(full); dialog.setOnDismissListener { full.removeView(view); if(!isDestroyed) oldParent.addView(view, index, params) }; dialog.show()
        })
    }
    private fun newPlayer() = ExoPlayer.Builder(this).build().also { value ->
        player = value; preview?.player = value
        value.addListener(object : Player.Listener {
            override fun onRenderedFirstFrame() { previewMessage?.text = if(playing.startsWith("rtsp:")) "实时画面 · 预览静音" else "本地回看 · 原声音" }
            override fun onPlayerError(error: PlaybackException) { previewMessage?.text = "播放失败；原始记录未删除，采集不受预览影响"; playing = "" }
        })
    }
    private fun playLive(uri: String) {
        if(!active || playing == uri || preview == null) return
        releasePlayer(); playing = uri
        newPlayer().apply {
            trackSelectionParameters = trackSelectionParameters.buildUpon().setTrackTypeDisabled(C.TRACK_TYPE_AUDIO, true).build()
            setMediaSource(RtspMediaSource.Factory().setForceUseRtpTcp(true).createMediaSource(MediaItem.fromUri(uri))); prepare(); playWhenReady = true
        }
    }
    private fun releasePlayer() { preview?.player = null; player?.release(); player = null; playing = "" }
    private fun showStreamGuide() {
        val panel = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; setPadding(dp(18), dp(12), dp(18), dp(12)) }
        panel.addView(label("1. 眼镜与手机连接同一 Wi-Fi 或手机热点。\n2. 记录设置选择音视频，再开始全天记录。\n3. 在乐奇原生直播填写以下地址和密钥并开播。\n4. 返回记录页确认真实画面。"))
        val current = RabiConversationService.currentVideo()
        if(current == null) panel.addView(label("尚未启动视频接收。请先选择音视频模式并开始。"))
        else {
            current.urls().forEach { url -> panel.addView(button("复制推流地址") { copy(url) }) }
            panel.addView(button("复制推流密钥") { copy(current.streamKey) })
        }
        panel.addView(label("Rabi 暂停会停止手机接收；乐奇原生相机仍需在乐奇结束直播。自动安装／开播未验收，不自动启用。", 13f))
        AlertDialog.Builder(this).setTitle("眼镜开播").setView(panel).setPositiveButton("完成", null).show()
    }
    private fun renderTimeline() {
        section("健康记录范围").addView(label("当前时间线展示媒体、转写和标记，尚不包含完整健康样本历史。健康采集状态在设备页查看；已同步健康历史由电脑统一保存，请在电脑端查看。", 13f))
        val projection = RecordingTranscriptProjection(this)
        val scope = runCatching { projection.scope() }
        val transcription = section("电脑转写 · 关联到原记录")
        val statusLine = label("读取本账号与电脑的缓存…", 13f).also { transcription.addView(it) }
        transcription.addView(button("从当前电脑刷新转写（最近24小时）") {
            val identity = scope.getOrNull()
            if(identity == null) toast(scope.exceptionOrNull()?.message ?: "请先配置电脑")
            else refreshTranscripts(projection, identity, statusLine)
        })
        transcription.addView(label("人工刷新，不轮询。仅按 captureId 关联；处理时间不代表采集时间。缺少关联 ID 不猜测归属。", 13f))
        val host = section("已保存记录"); host.addView(label("正在读取…")); val version = generation
        worker.execute {
            val history = runCatching { RecordingStore(this).list() }
            val audio = runCatching { RabiAudioRecordRepository.listCaptureRecords(this, 100) }
            val markers = runCatching { RecordingStore(this).listMarkers() }
            val cachedTranscripts = runCatching { scope.getOrNull()?.let { projection.cached(it) } }
            val texts = runCatching { RabiChatStore(this).list().filter { it.kind == "voice" && it.text.isNotBlank() }.takeLast(40) }
            main.post {
                if(isDestroyed || generation != version) return@post
                val identity = scope.getOrNull()
                val snapshot = if(identity != null && projection.isCurrent(identity)) cachedTranscripts.getOrNull() else null
                statusLine.text = when {
                    identity == null -> scope.exceptionOrNull()?.message ?: "尚未配置电脑"
                    !projection.isCurrent(identity) -> "账号或电脑已切换，请重新进入时间线"
                    cachedTranscripts.isFailure -> "缓存读取失败，原记录未更改"
                    snapshot == null -> "尚无本账号／电脑的转写缓存，请点击刷新"
                    else -> "缓存来源：电脑 ${identity.worker} · ${date(snapshot.fetchedAt)} 获取（非实时）\n缺少 captureId 的旧记录：${snapshot.unassigned} 条，未关联"
                }
                host.removeAllViews()
                host.addView(label("此刻标记", 20f))
                markers.onSuccess { list ->
                    if(list.isEmpty()) host.addView(label("暂无标记；记录页可标记此刻，不会触发 Agent。", 13f))
                    list.forEach { marker -> host.addView(label("${date(marker.at)} · 此刻标记\n关联记录：${marker.recordId.ifBlank { "未关联媒体记录" }}")) }
                }.onFailure { host.addView(label("标记读取失败，原文件保留：${it.message}")) }
                host.addView(label("全天记录 · 音频", 20f))
                audio.onSuccess { rows ->
                    if(rows.length() == 0) host.addView(label("暂无已封口音频分片；活动分片保存后才出现在这里。"))
                    for(index in 0 until rows.length()) {
                        val item = rows.getJSONObject(index)
                        addAudioRow(host, item)
                        addRecordTranscripts(host, item.optString("captureId", item.optString("id")), snapshot)
                    }
                }.onFailure { host.addView(label("音频索引读取失败，原队列未改动：${it.message}")) }
                host.addView(label("视频与历史本地文件", 20f))
                history.onSuccess { entries ->
                    if(entries.isEmpty()) host.addView(label("暂无视频或旧版本地文件。"))
                    entries.forEach { entry ->
                        val current = entry.id == live?.sessionId
                        host.addView(button("${entry.title.ifBlank { if(entry.kind == "video") "眼镜视频" else "历史本地录音" }} · ${date(entry.started)}\n${if(current) "正在记录" else if(entry.state == "legacy") "历史原始分段" else if(entry.state == "recording") "未正常结束，请检查文件" else entry.state}") {
                            if(current) toast("请先暂停再回看") else { detail = entry; render() }
                        })
                        addRecordTranscripts(host, entry.id, snapshot)
                    }
                }.onFailure { host.addView(label("历史索引读取失败，原文件保留。")) }
                host.addView(label("历史聊天中已接收的转写", 20f))
                host.addView(label("以下来自已有聊天记录，不代表新全天记录已经完成转写，也不改变原人格归属。", 13f))
                texts.onSuccess { list -> list.reversed().forEach { host.addView(label("${date(it.createdAt)}\n${it.text}")) } }
                    .onFailure { host.addView(label("历史转写读取失败。")) }
            }
        }
    }
    private var transcriptRefreshRunning = false
    private fun refreshTranscripts(projection: RecordingTranscriptProjection, scope: RecordingTranscriptProjection.Scope, statusLine: TextView) {
        if(transcriptRefreshRunning) { toast("转写刷新正在进行"); return }
        transcriptRefreshRunning = true
        statusLine.text = "正在向已验证电脑查询；已有缓存不是实时结果"
        val version = generation
        worker.execute {
            val result = runCatching { projection.refresh(scope) }
            main.post {
                transcriptRefreshRunning = false
                if(isDestroyed || generation != version) return@post
                result.onSuccess { render() }.onFailure {
                    statusLine.text = "刷新未完成：${it.message}\n下方保留此前缓存（非实时），不表示新记录没有转写。"
                }
            }
        }
    }
    private fun addRecordTranscripts(host: LinearLayout, captureId: String, snapshot: RecordingTranscriptProjection.Snapshot?) {
        if(captureId.isBlank() || snapshot == null) return
        snapshot.records.filter { it.captureId == captureId }.forEach { record ->
            host.addView(label("电脑转写（缓存） · 处理于 ${date(record.processedAt)}\n${record.text}", 14f))
        }
    }
    private fun addAudioRow(host: LinearLayout, item: JSONObject) {
        val id = item.optString("captureId", item.optString("id")); val bytes = item.optLong("bytes")
        val timeLabel = when(item.optString("timeBasis")) { "imported" -> "导入时间（原媒体时间未知）"; "media" -> "原媒体时间"; else -> "手机接收估计时间" }
        host.addView(label("$timeLabel ${date(item.optLong("startedAt"))} · ${sourceName(item.optString("source"))}\n已封口 ${item.optLong("durationMs") / 1000} 秒 · ${bytes / 1024} KiB\n分片确认 ${item.optInt("acknowledgedSegments")}/${item.optInt("segmentCount")} · ${policyName(item.optString("processingPolicy"))}\n固定目标：${item.optString("routeProfileId").ifBlank { "无" }}"))
        item.optString("parentCaptureId").takeIf { it.isNotBlank() }?.let { host.addView(label("来源媒体 captureId：$it（不是历史录像会话 ID）", 13f)) }
        host.addView(button("准备回放 / 导出这条记录") {
            val version = generation; toast("后台准备本条记录的 WAV，不导出整个队列")
            worker.execute {
                val result = runCatching { RabiAudioRecordRepository.exportCaptureWave(this, id) }
                main.post {
                    if(isDestroyed || generation != version) return@post
                    result.onSuccess { file ->
                        detail = RecordingStore.Entry(id, "audio", item.optString("source"), item.optLong("startedAt"), item.optLong("endedAt"), "saved_segments", file.parentFile!!, listOf(file), "已封口音频片段")
                        render()
                    }.onFailure { toast("导出失败，源分片保留：${it.message}") }
                }
            }
        })
    }
    private fun renderDetail(entry: RecordingStore.Entry) {
        section(entry.title.ifBlank { "原始记录" }).apply {
            addView(label(date(entry.started)))
            if(entry.state == "legacy") {
                addView(label("旧版本没有会话清单，保留原始分段，不根据时间猜测合并。"))
                entry.files.forEach { file -> addView(button("${date(file.lastModified())} · ${file.length()/1024} KiB") {
                    detail = entry.copy(id=file.name, state="saved", files=listOf(file)); render()
                }) }
            } else {
                addPreview(this)
                if(entry.state == "saved_segments") addView(label("只包含当前已封口且尚保留的音频分片；不代表整个会话已停止或已完成转写。", 13f))
                if(entry.files.size > 1) addView(label("${entry.files.size} 个原始分段，依次回放；分享不伪装成已合并文件。"))
                addView(button("播放 / 重新播放") { playFiles(entry) })
                addView(button("分享 / 导出原始文件") { share(entry) })
            }
            addView(button("返回时间线") { detail = null; page = "records"; render() })
        }
    }
    private fun playFiles(entry: RecordingStore.Entry) {
        if(entry.files.isEmpty()) { toast("没有可播放文件"); return }
        releasePlayer(); playing = entry.id
        newPlayer().apply { setMediaItems(entry.files.map { MediaItem.fromUri(Uri.fromFile(it)) }); prepare(); playWhenReady = true }
        preview?.useController = true
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
        section("手机").apply { addView(label("负责可靠保存和传输。音频模式可选择手机麦克风。")); addView(button("记录模式与来源") { page = "home"; render(); showRecordingSettings() }) }
        section("眼镜").apply {
            val authorized = !getSharedPreferences("rokid_probe", MODE_PRIVATE).getString("rokid_token", "").isNullOrBlank()
            addView(label("授权：${if(authorized) "已保存" else "未配置"}\n视频：${if(RabiConversationService.currentVideo()?.receiving == true) "正在接收真实画面" else "尚无当前接收证据"}\n授权成功不等于音视频已经连接。"))
            addView(button("连接与授权") { if(settings().running) toast("请先暂停记录，再进入设备诊断") else startActivity(Intent(this@RabiRecordingHubActivity, RokidProbeActivity::class.java)) })
            addView(button("视频开播步骤") { showStreamGuide() })
        }
        section("手表 / 手环").apply {
            addView(label("此页仅展示健康采集状态，不是完整健康历史。已同步的健康历史由电脑保存和管理，请在电脑端查看；手机待上传队列不代表完整历史。", 13f))
            val at = runtime().getLong("healthLastReceivedAt", 0)
            addView(label(if(at > 0) "最近样本：${date(at)}（不代表当前实时心率）" else "尚无实际健康样本证据"))
            addView(button("管理健康来源与权限") { startActivity(Intent(this@RabiRecordingHubActivity, WearableHealthSettingsActivity::class.java)) })
            addView(button("立即同步健康数据") {
                val value = settings()
                if(!value.running || !(value.healthEnabled || value.mode == "health")) toast("先在全天记录启用健康参与并开始") else serviceAction { RabiConversationService.syncHealth(this@RabiRecordingHubActivity) }
            })
        }
        section("高级本地媒体设置").apply {
            addView(label("仅调整本机接收与预览端口。修改后需重新复制推流地址；不改变电脑或 Relay 地址。", 13f))
            addView(button("设置本地接收端口") { showLocalMediaSettings() })
        }
        section("电脑与处理").apply { addView(label("电脑离线不影响本地保存。处理目标在记录设置明确选择，不随聊天切换。")); addView(button("连接 / TTS / 存储 / 诊断") { startActivity(Intent(this@RabiRecordingHubActivity, MainActivity::class.java).putExtra("open_settings", true)) }) }
    }
    private fun showLocalMediaSettings() {
        fun busy() = settings().running || transitionPending() || RabiConversationService.currentVideo()?.running == true
        if(busy()) { toast("请先暂停并等待媒体保存完成"); return }
        val current = runCatching { LocalMediaSettings.load(this) }.getOrElse { toast("本地端口配置无效：${it.message}"); return }
        val panel = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; setPadding(dp(18),dp(12),dp(18),dp(12)) }
        fun port(title: String, value: Int): EditText {
            panel.addView(label(title))
            return EditText(this).apply { inputType = android.text.InputType.TYPE_CLASS_NUMBER; minHeight = dp(52); setText(value.toString()); panel.addView(this) }
        }
        val rtmp = port("RTMP 接收端口",current.rtmpPort)
        val preview = port("本机预览端口",current.previewPort)
        panel.addView(label("范围 1024–65535，两个端口必须不同。预览仍只监听本机回环地址。",13f))
        val dialog = AlertDialog.Builder(this).setTitle("本地媒体端口").setView(panel).setNegativeButton("取消",null).setPositiveButton("保存",null).create()
        dialog.setOnShowListener { dialog.getButton(AlertDialog.BUTTON_POSITIVE).setOnClickListener {
            if(busy()) { toast("媒体尚未停止，未保存端口"); return@setOnClickListener }
            val receivePort = rtmp.text.toString().toIntOrNull()
            val previewPort = preview.text.toString().toIntOrNull()
            if(receivePort == null || !LocalMediaSettings.validPort(receivePort)) { rtmp.error = "请输入1024–65535"; return@setOnClickListener }
            if(previewPort == null || !LocalMediaSettings.validPort(previewPort) || receivePort == previewPort) { preview.error = "请输入1024–65535且与接收端口不同"; return@setOnClickListener }
            runCatching { LocalMediaSettings(receivePort,previewPort).save(this) }
                .onSuccess { dialog.dismiss(); toast("已保存；下次视频接收使用新端口，请重新复制地址") }
                .onFailure { toast("端口未保存：${it.message}") }
        } }
        dialog.show()
    }
    private fun copy(value: String) { getSystemService(ClipboardManager::class.java).setPrimaryClip(ClipData.newPlainText("眼镜开播参数", value)); toast("已复制") }
    private fun toast(value: String) = Toast.makeText(this, value, Toast.LENGTH_SHORT).show()
    private fun date(value: Long) = if(value <= 0) "时间未知" else SimpleDateFormat("MM月dd日 HH:mm:ss", Locale.CHINA).format(Date(value))
}
