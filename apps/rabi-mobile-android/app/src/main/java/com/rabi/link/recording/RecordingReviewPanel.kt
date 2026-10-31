package com.rabi.link.recording

import android.app.DatePickerDialog
import android.content.Context
import android.graphics.Color
import android.graphics.Bitmap
import android.graphics.drawable.GradientDrawable
import android.media.MediaMetadataRetriever
import android.net.Uri
import android.os.Handler
import android.os.Looper
import android.view.Gravity
import android.view.View
import android.widget.*
import androidx.media3.common.C
import androidx.media3.common.MediaItem
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.exoplayer.rtsp.RtspMediaSource
import androidx.media3.ui.PlayerView
import com.rabi.link.RabiConversationService
import com.rabi.link.RabiMobileUi
import com.rabi.link.location.LocationRepository
import com.rabi.link.location.LocationSettings
import com.rabi.link.location.LocationSettingsActivity
import com.rabi.link.location.SavedLocation
import org.json.JSONObject
import java.io.File
import java.text.SimpleDateFormat
import java.util.Calendar
import java.util.Date
import java.util.Locale
import java.util.concurrent.Executors

/** A read model of saved media. Scrubbing never starts or changes capture. */
@androidx.annotation.OptIn(androidx.media3.common.util.UnstableApi::class)
class RecordingReviewPanel(private val context: Context, private val share: (RecordingStore.Entry) -> Unit) {
    private var archiveView = RecordingArchiveSession.load(context) != null
    private var archiveAccess: RecordingArchiveReviewAccess? = null
    private var archiveCursor: String? = null
    private var archiveQuery: RecordingArchiveRepository.Query? = null
    private var archivePending = emptyList<Item>()
    private val archiveNext = RabiMobileUi.compactAction(context, "下一页（早→晚）") { loadArchive(true) }.apply { visibility = View.GONE }

    private data class Item(val entry: RecordingStore.Entry, val captureId: String, val spans: List<ReviewTimeline.Span>, val audio: Boolean, val parentCaptureId: String = "", val associatedIds: Set<String> = setOf(captureId), val eventTranscript: org.json.JSONObject? = null, val asrState: String = "", val archiveRow: RecordingArchiveRepository.Row? = null, val location: SavedLocation? = null)
    val view = LinearLayout(context).apply { orientation = LinearLayout.VERTICAL }
    private val main = Handler(Looper.getMainLooper())
    private val worker = Executors.newSingleThreadExecutor()
    // Live audio uses compact bounds; review and video reserve room for playback controls.
    private val preview = FrameLayout(context)
    private var videoPreview = false
    private val captureCard = LinearLayout(context).apply {
        orientation = LinearLayout.VERTICAL
        background = RabiMobileUi.panel(context,RabiMobileUi.surface,Color.TRANSPARENT,14)
        clipToOutline = true
    }
    private val previewStage = object : FrameLayout(context) {
        init { contentDescription = "记录预览" }
        override fun onMeasure(widthSpec: Int, heightSpec: Int) {
            val preferredHeight = if(videoPreview || !live) View.MeasureSpec.getSize(widthSpec)*9/16 else dp(72)
            val height = if(View.MeasureSpec.getMode(heightSpec) == View.MeasureSpec.UNSPECIFIED) preferredHeight
                else minOf(preferredHeight, View.MeasureSpec.getSize(heightSpec))
            super.onMeasure(widthSpec,View.MeasureSpec.makeMeasureSpec(height,View.MeasureSpec.EXACTLY))
        }
    }
    private var controlsVisible = false
    private val liveTap = View(context).apply {
        contentDescription = "显示或隐藏记录控制"; setOnClickListener { showControls(!controlsVisible) }
    }
    fun attachHeader(value: LinearLayout) {
        captureCard.addView(value,0,LinearLayout.LayoutParams(-1,-2))
    }
    private fun showControls(shown: Boolean) {
        controlsVisible = shown
        if(player?.state()?.controlsVisible != shown) player?.setControls(shown)
    }
    private fun setVideoPreview(value: Boolean) {
        if(videoPreview == value) return
        videoPreview = value; previewStage.requestLayout()
    }
    private val position = label("--:--:--",16f).apply {
        typeface = android.graphics.Typeface.DEFAULT_BOLD; minimumHeight = dp(32)
        setTextColor(RabiMobileUi.text); setPadding(0,dp(4),0,dp(4))
    }
    private val locationStatus = label("",12f).apply {
        setPadding(dp(18),dp(4),dp(18),dp(4)); visibility = View.GONE
        contentDescription = "全天位置记录状态，点击设置"
        setOnClickListener { context.startActivity(android.content.Intent(context,LocationSettingsActivity::class.java)) }
    }
    private val dayButton = RabiMobileUi.compactAction(context, "选择日期") {}
    private val ruler = RecordingTimeRuler(context)
    private val reviewColumn = LinearLayout(context).apply { orientation = LinearLayout.VERTICAL }
    private val eventColumn = LinearLayout(context).apply { orientation = LinearLayout.VERTICAL }
    private val listStatus = label("",12f).apply {
        visibility = View.GONE
        addTextChangedListener(object : android.text.TextWatcher {
            override fun beforeTextChanged(s: CharSequence?, start: Int, count: Int, after: Int) = Unit
            override fun afterTextChanged(s: android.text.Editable?) = Unit
            override fun onTextChanged(s: CharSequence?, start: Int, before: Int, count: Int) { visibility = if(s.isNullOrBlank()) View.GONE else View.VISIBLE }
        })
    }
    private val scroll = ListView(context).apply {
        divider = android.graphics.drawable.InsetDrawable(android.graphics.drawable.ColorDrawable(RabiMobileUi.border),dp(16),0,dp(16),0)
        dividerHeight = 1; clipToPadding = false
        clipToOutline = true
    }
    private var displayedItems = emptyList<Item>()
    private var sourceFilter = 0
    private var typeFilter = 0
    private var navigating = false
    private var listDriving = false
    private var programmaticScroll = false
    private val rowAdapter = object : BaseAdapter() {
        override fun getCount() = displayedItems.size
        override fun getItem(position: Int) = displayedItems[position]
        override fun getItemId(position: Int) = position.toLong()
        override fun getView(position: Int, recycled: View?, parent: android.view.ViewGroup): View = bindCard(displayedItems[position], recycled)
    }
    private val durations = object : LinkedHashMap<String,Long>(128,0.75f,true) {
        override fun removeEldestEntry(eldest: MutableMap.MutableEntry<String,Long>?) = size > 2048
    }
    private var lastDataSignal = ""
    private var day = midnight(System.currentTimeMillis())
    private var cursor = System.currentTimeMillis()
    private var loadedRange = 0L..0L
    private var reloadPending = false
    private var lastRender = 0L
    private val mediaWorker = java.util.concurrent.ThreadPoolExecutor(1,1,0L,java.util.concurrent.TimeUnit.MILLISECONDS,
        java.util.concurrent.ArrayBlockingQueue<Runnable>(1),java.util.concurrent.ThreadPoolExecutor.DiscardOldestPolicy())
    private var live = true
    private var dragging = false
    private var closed = false
    private var loading = false
    private var loadAfterRecovery = false
    private var reachedOlder = false
    private var reachedNewer = false
    private var revision = 0
    private var selection = 0
    private var lastLoad = 0L
    private var items = emptyList<Item>()
    private var markers = emptyList<RecordingStore.Marker>()
    private var selected: Item? = null
    private var player: RecordingPlaybackPanel? = null
    private var playbackState = RecordingPlaybackPanel.State()
    private var livePlayer: ExoPlayer? = null
    private var liveUrl = ""
    private var liveWaveform: AudioWaveformView? = null
    private var idleMessage = ""
    private val images = android.util.LruCache<String, Bitmap>(24)
    private val cards = mutableMapOf<String, View>()
    private val thumbnailWorker = java.util.concurrent.ThreadPoolExecutor(1,1,0L,java.util.concurrent.TimeUnit.MILLISECONDS,
        java.util.concurrent.ArrayBlockingQueue<Runnable>(24),java.util.concurrent.ThreadPoolExecutor.DiscardOldestPolicy())
    private val liveTick = object : Runnable {
        override fun run() { if(closed) return; refreshLive(); main.postDelayed(this,1000) }
    }
    init {
        previewStage.addView(preview,FrameLayout.LayoutParams(-1,-1))
        previewStage.addView(liveTap,FrameLayout.LayoutParams(-1,-1))
        ruler.visibility = View.VISIBLE
        position.gravity = Gravity.CENTER
        position.maxLines = 2
        position.setTextColor(RabiMobileUi.text)
        captureCard.addView(previewStage,LinearLayout.LayoutParams(-1,-2))
        captureCard.addView(locationStatus,LinearLayout.LayoutParams(-1,-2))
        captureCard.addView(position,LinearLayout.LayoutParams(-1,-2))
        val timeline = LinearLayout(context).apply {
            orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER_VERTICAL
            setPadding(dp(12),0,dp(10),0)
            setBackgroundColor(RabiMobileUi.inputSurface)
            addView(ruler,LinearLayout.LayoutParams(0,dp(76),1f))
            addView(LinearLayout(context).apply {
                gravity = Gravity.CENTER; setPadding(dp(8),0,dp(8),0)
                isFocusable = true; contentDescription = "返回实时"
                background = android.graphics.drawable.RippleDrawable(android.content.res.ColorStateList.valueOf(RabiMobileUi.accentBorder),
                    android.graphics.drawable.InsetDrawable(RabiMobileUi.panel(context,RabiMobileUi.accentSurface,Color.TRANSPARENT,18),0,dp(6),0,dp(6)),null)
                addView(RabiMobileUi.icon(context,com.rabi.link.R.drawable.ic_ui_live,RabiMobileUi.secondary),LinearLayout.LayoutParams(dp(18),dp(18)))
                addView(TextView(context).apply {
                    text = "返回实时"; textSize = 14f; letterSpacing = 0f; setTextColor(RabiMobileUi.secondary)
                    importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_NO
                },LinearLayout.LayoutParams(-2,-2).apply { marginStart = dp(4) })
                accessibilityDelegate = object : View.AccessibilityDelegate() {
                    override fun onInitializeAccessibilityNodeInfo(host: View, info: android.view.accessibility.AccessibilityNodeInfo) {
                        super.onInitializeAccessibilityNodeInfo(host,info); info.className = Button::class.java.name
                    }
                }
                setOnClickListener { enterLive() }
            },LinearLayout.LayoutParams(dp(96),dp(48)).apply { marginStart = dp(6) })
        }
        captureCard.addView(timeline)
        reviewColumn.addView(captureCard)
        val navigation = LinearLayout(context).apply {
            gravity = Gravity.CENTER_VERTICAL
        }
        dayButton.textSize = if(context.resources.configuration.screenWidthDp < 380) 15f else 16f
        dayButton.gravity = Gravity.START or Gravity.CENTER_VERTICAL
        val calendarIcon = RabiMobileUi.icon(context, com.rabi.link.R.drawable.ic_ui_calendar).drawable.apply { setBounds(0,0,dp(24),dp(24)) }
        dayButton.setCompoundDrawables(calendarIcon,null,null,null)
        dayButton.compoundDrawablePadding = dp(6)
        navigation.addView(dayButton,LinearLayout.LayoutParams(0,dp(48),1f))
        navigation.addView(RabiMobileUi.iconAction(context,com.rabi.link.R.drawable.ic_ui_left,"上一个事件") { adjacent(true) },LinearLayout.LayoutParams(dp(64),dp(48)))
        navigation.addView(RabiMobileUi.iconAction(context,com.rabi.link.R.drawable.ic_ui_chevron,"下一个事件") { adjacent(false) },LinearLayout.LayoutParams(dp(64),dp(48)))
        navigation.addView(View(context),LinearLayout.LayoutParams(0,0,0.3f))
        navigation.addView(RabiMobileUi.iconAction(context,com.rabi.link.R.drawable.ic_ui_refresh,"刷新记录和转写") { load() },LinearLayout.LayoutParams(dp(48),dp(48)))
        val controls = LinearLayout(context).apply {
            orientation = LinearLayout.VERTICAL; setPadding(dp(8),dp(4),dp(8),dp(8))
            background = RabiMobileUi.panel(context,RabiMobileUi.surface,Color.TRANSPARENT,14)
        }
        controls.addView(navigation)
        val filters = LinearLayout(context).apply { gravity = Gravity.CENTER_VERTICAL }
        val scope = Spinner(context).apply {
            adapter = filterAdapter(listOf("本机记录","电脑归档"))
            contentDescription = "记录范围：本机记录或电脑归档"
            setSelection(if(archiveView) 1 else 0)
            onItemSelectedListener = object : AdapterView.OnItemSelectedListener {
                override fun onNothingSelected(parent: AdapterView<*>?) = Unit
                override fun onItemSelected(parent: AdapterView<*>?, view: View?, position: Int, id: Long) {
                    val remote = position == 1
                    if(remote == archiveView) return
                    archiveView = remote; revision++; selection++; selected = null; releasePlayback()
                    items = emptyList(); archivePending = emptyList(); archiveCursor = null; archiveQuery = null
                    archiveAccess = null; reachedOlder = false; reachedNewer = false
                    renderRows(); if(loading) reloadPending = true else load()
                }
            }
        }
        val types = Spinner(context).apply {
            adapter = filterAdapter(listOf("全部类型","录音事件","录像","位置"))
            contentDescription = "筛选事件类型"
            onItemSelectedListener = object : AdapterView.OnItemSelectedListener {
                override fun onNothingSelected(parent: AdapterView<*>?) = Unit
                override fun onItemSelected(parent: AdapterView<*>?, view: View?, position: Int, id: Long) { if(typeFilter != position) { typeFilter = position; renderRows(); load() } }
            }
        }
        val sources = Spinner(context).apply {
            adapter = filterAdapter(listOf("全部来源","手机","眼镜"))
            contentDescription = "筛选记录来源"
            onItemSelectedListener = object : AdapterView.OnItemSelectedListener {
                override fun onNothingSelected(parent: AdapterView<*>?) = Unit
                override fun onItemSelected(parent: AdapterView<*>?, view: View?, position: Int, id: Long) { if(sourceFilter != position) { sourceFilter = position; renderRows(); load() } }
            }
        }
        listOf(scope,types,sources).forEachIndexed { index, spinner ->
            filters.addView(filterControl(spinner),LinearLayout.LayoutParams(0,dp(48),1f).apply { if(index > 0) marginStart = dp(6) })
        }
        controls.addView(filters)
        eventColumn.addView(controls,LinearLayout.LayoutParams(-1,-2).apply { bottomMargin = dp(8) })
        eventColumn.addView(listStatus)
        eventColumn.addView(archiveNext)
        listStatus.setOnClickListener { listDriving = true; live = false; if(archiveAccess != null) load() else load(true) }
        scroll.adapter = rowAdapter
        eventColumn.addView(scroll,LinearLayout.LayoutParams(-1,0,1f))
        val wide = context.resources.configuration.screenWidthDp >= 600 || context.resources.configuration.orientation == android.content.res.Configuration.ORIENTATION_LANDSCAPE
        if(wide) {
            captureCard.layoutParams = LinearLayout.LayoutParams(-1,-1)
            previewStage.layoutParams = LinearLayout.LayoutParams(-1,0,1f)
        }
        view.orientation = if(wide) LinearLayout.HORIZONTAL else LinearLayout.VERTICAL
        view.setPadding(dp(10),dp(8),dp(10),dp(12))
        view.addView(reviewColumn,if(wide) LinearLayout.LayoutParams(0,-1,1f).apply { marginEnd = dp(12) } else LinearLayout.LayoutParams(-1,-2).apply { bottomMargin = dp(12) })
        view.addView(eventColumn,if(wide) LinearLayout.LayoutParams(0,-1,1f) else LinearLayout.LayoutParams(-1,0,1f))
        scroll.setOnScrollListener(object : AbsListView.OnScrollListener {
            override fun onScrollStateChanged(list: AbsListView, state: Int) {
                if(state == AbsListView.OnScrollListener.SCROLL_STATE_TOUCH_SCROLL) { listDriving = true; live = false; ruler.cancelGesture() }
                if(state == AbsListView.OnScrollListener.SCROLL_STATE_IDLE && listDriving) {
                    displayedItems.getOrNull(scroll.firstVisiblePosition)?.let { jump(it.entry.started) }
                }
            }
            override fun onScroll(list: AbsListView, first: Int, count: Int, total: Int) {
                if(programmaticScroll || !listDriving) return
                displayedItems.getOrNull(first)?.let { cursor = it.entry.started; ruler.setPosition(cursor,false); updateRange(); position.text = "回看 · ${clock(cursor)}" }
                if(total > 0 && count > 0) {
                    if(first + count >= total - 2) load(true)
                    else if(first <= 1) load(false)
                }
            }
        })
        dayButton.setOnClickListener {
            val date = Calendar.getInstance().apply { timeInMillis = day }
            DatePickerDialog(context, { _, year, month, dayOfMonth ->
                day = Calendar.getInstance().apply { set(year,month,dayOfMonth,0,0,0); set(Calendar.MILLISECOND,0) }.timeInMillis
                ruler.showDay(minOf(day + 12*60*60_000L,System.currentTimeMillis()))
                dragging = false; live = false
                jump(ruler.time); load(); renderRows()
            }, date.get(Calendar.YEAR),date.get(Calendar.MONTH),date.get(Calendar.DAY_OF_MONTH)).apply { datePicker.maxDate = System.currentTimeMillis() }.show()
        }
        ruler.onStart = { listDriving = false; dragging = true; live = false; player?.holdControls() }
        ruler.onMove = { time, finished ->
            cursor = time; updateRange(); position.text = "回看 · ${clock(time)}"
            ensureRange()
            if(finished) {
                dragging = false
                if(time >= System.currentTimeMillis()-1000) enterLive() else jump(time)
                renderRows()
            } else if(System.currentTimeMillis()-lastRender > 150) {
                lastRender = System.currentTimeMillis()
                highlightAt(time); renderRows()
            }
        }
        lastDataSignal = dataSignal()
        updateRange(); showEmpty("实时 · 无画面"); main.post { if(!closed) load() }; refreshLive(); main.postDelayed(liveTick,1000)
    }
    private fun filterAdapter(values: List<String>) = object : ArrayAdapter<String>(context,android.R.layout.simple_spinner_dropdown_item,values) {
        override fun getView(position: Int, recycled: View?, parent: android.view.ViewGroup): View =
            (super.getView(position,recycled,parent) as TextView).apply {
                textSize = 14f; setTextColor(RabiMobileUi.text); maxLines = 1
                ellipsize = android.text.TextUtils.TruncateAt.END
                setPadding(dp(10),0,dp(24),0); gravity = Gravity.CENTER_VERTICAL
            }
        override fun getDropDownView(position: Int, recycled: View?, parent: android.view.ViewGroup): View =
            (super.getDropDownView(position,recycled,parent) as TextView).apply {
                setTextColor(RabiMobileUi.text); setBackgroundColor(RabiMobileUi.surface); minimumHeight = dp(48)
            }
    }
    private fun filterControl(spinner: Spinner): View = FrameLayout(context).apply {
        background = RabiMobileUi.panel(context,RabiMobileUi.inputSurface,RabiMobileUi.border,8)
        spinner.setBackgroundColor(Color.TRANSPARENT)
        addView(spinner,FrameLayout.LayoutParams(-1,-1))
        addView(RabiMobileUi.icon(context,com.rabi.link.R.drawable.ic_ui_chevron,RabiMobileUi.muted).apply { rotation = 90f },
            FrameLayout.LayoutParams(dp(16),dp(16),Gravity.END or Gravity.CENTER_VERTICAL).apply { marginEnd = dp(6) })
    }
    private fun dp(value: Int) = (context.resources.displayMetrics.density * value).toInt()
    private fun label(text: String, size: Float = 14f) = TextView(context).apply {
        this.text = text; textSize = size; setTextColor(RabiMobileUi.primary); setPadding(dp(12),dp(5),dp(12),dp(5))
    }
    private fun midnight(time: Long) = Calendar.getInstance().apply { timeInMillis = time; set(Calendar.HOUR_OF_DAY,0); set(Calendar.MINUTE,0); set(Calendar.SECOND,0); set(Calendar.MILLISECOND,0) }.timeInMillis
    private fun updateRange() { position.visibility = View.VISIBLE; day = midnight(cursor); dayButton.text = SimpleDateFormat("M月d日",Locale.CHINA).format(Date(day)) }
    private fun ensureRange() {
        if(listDriving) return
        val range = ruler.visibleRange()
        if(range.first < loadedRange.first || range.last > loadedRange.last) load()
    }
    private fun highlightAt(time: Long) {
        val id = items.firstOrNull { ReviewTimeline.mediaAt(it.spans,time) != null }?.entry?.id
        highlight(id)
    }
    private fun clock(time: Long) = SimpleDateFormat("HH:mm:ss",Locale.CHINA).format(Date(time))
    private fun releasePlayback() { player?.let { playbackState = it.state(); it.close() }; player = null; livePlayer?.release(); livePlayer = null; liveUrl = ""; liveWaveform = null; idleMessage = ""; liveTap.visibility = View.VISIBLE; preview.removeAllViews() }
    private fun showEmpty(message: String) {
        liveWaveform = null
        preview.removeAllViews()
        preview.addView(label(message, 18f).apply { gravity = Gravity.CENTER; setTextColor(RabiMobileUi.muted); setBackgroundColor(RabiMobileUi.surface) },FrameLayout.LayoutParams(-1,-1))
    }
    private fun showLiveAudioIdle(message: String) {
        if(message.contains("空间不足") || message.contains("异常")) { showEmpty(message); idleMessage = message; return }
        liveWaveform = null; idleMessage = message; preview.removeAllViews()
        preview.addView(AudioWaveformView(context,compact = true).apply {
            contentDescription = message
        },FrameLayout.LayoutParams(-1,-1))
    }
    private fun enterLive() {
        ruler.cancelGesture(); listDriving = false; dragging = false; live = true; cursor = System.currentTimeMillis(); selected = null; selection++
        releasePlayback(); setVideoPreview(false); previewStage.requestLayout(); playbackState = RecordingPlaybackPanel.State(); ruler.setPosition(cursor,true); updateRange(); load(); refreshLive()
    }
    /** Called only while visible, from the owner's runtime events; history playback is not reset. */
    fun refreshLive() {
        if(closed || dragging) return
        val runtime = context.getSharedPreferences("rabi_conversation_runtime",Context.MODE_PRIVATE)
        val recording = AllDayRecordingSettings.load(context)
        locationStatus.visibility = if(LocationSettings(context).enabled || recording.mode == "location") View.VISIBLE else View.GONE
        locationStatus.text = "位置 · " + runtime.getString("locationStatus","等待开始") + "\n" + runtime.getString("locationSamplingStatus","")
        if(!live) {
            refreshChangedData()
            return
        }
        cursor = System.currentTimeMillis(); ruler.setPosition(cursor,true); updateRange()
        val last = runtime.getLong("captureLastReceivedAt",0)
        val recent = AllDayRecordingSettings.load(context).running && System.currentTimeMillis() - last < 5000
        position.text = "--:--:--"
        val video = RabiConversationService.currentVideo()
        val started = AllDayRecordingSettings.load(context).windowStartedAt
        if((recent || video?.receiving == true) && started > 0) {
            val seconds = ((System.currentTimeMillis()-started)/1000).coerceAtLeast(0)
            position.text = String.format(Locale.ROOT,"%02d:%02d:%02d",seconds/3600,seconds/60%60,seconds%60)
        }
        val url = if(video?.receiving == true) video.previewUrl else ""
        if(recording.mode == "location") {
            val message = runtime.getString("locationStatus","等待定位").orEmpty()
            if(livePlayer != null || liveWaveform != null || idleMessage != message) {
                releasePlayback(); setVideoPreview(false); showEmpty(message); idleMessage = message
            }
            val lastLocation = runtime.getLong("locationLastReceivedAt",0)
            position.text = if(lastLocation > 0) "最近位置 · ${clock(lastLocation)}" else "等待第一个位置"
            refreshChangedData(); return
        }
        if(url.isBlank()) {
            if(livePlayer != null) releasePlayback()
            setVideoPreview(false)
            if(recent) {
                if(liveWaveform == null) {
                    idleMessage = ""; preview.removeAllViews()
                    liveWaveform = AudioWaveformView(context,true,compact = true).also { preview.addView(it,FrameLayout.LayoutParams(-1,-1)) }
                }
                liveWaveform?.state = if(runtime.getBoolean("captureHasSignal",false)) "正在收音" else "收到静音"
            } else {
                val settings = AllDayRecordingSettings.load(context)
                val status = runtime.getString("allDayStatus", "").orEmpty()
                val message = when {
                    status.contains("storage_low") -> "手机空间不足 · 采集已暂停"
                    status.contains("失败") || status.contains("未能启动") -> "采集异常 · 请查看状态"
                    RabiConversationService.recoveringRecording() || settings.running -> "正在启动采集"
                    settings.autoResume -> "等待恢复采集"
                    else -> "采集已暂停"
                }
                if(liveWaveform != null || idleMessage != message) showLiveAudioIdle(message)
            }
        } else if(url != liveUrl) {
            setVideoPreview(true)
            releasePlayback(); liveUrl = url
            livePlayer = ExoPlayer.Builder(context).build().also { current ->
                preview.addView(PlayerView(context).apply { player = current; useController = false },FrameLayout.LayoutParams(-1,-1))
                current.volume = 0f
                current.setMediaSource(RtspMediaSource.Factory().setForceUseRtpTcp(true).createMediaSource(MediaItem.fromUri(url)))
                current.prepare(); current.play()
            }
        }
        refreshChangedData()
    }
    private fun refreshChangedData() {
        if(loadAfterRecovery && !RabiConversationService.recoveringRecording()) {
            loadAfterRecovery = false; load(); return
        }
        val signal = dataSignal()
        if(signal != lastDataSignal) reachedNewer = false
        if(!listDriving && signal != lastDataSignal && System.currentTimeMillis() - lastLoad >= 1000) { lastDataSignal = signal; load() }
    }
    private fun dataSignal() = if(archiveView) context.getSharedPreferences("recording_archive_session",Context.MODE_PRIVATE).getLong("catalogUpdatedAt",0).toString()
        else "${RabiAudioRecordRepository.revision(context)}:${RecordingStore.revision()}:${LocationRepository.revision()}"
    private fun adjacent(older: Boolean) {
        if(loading || navigating || closed) return
        ruler.cancelGesture(); listDriving = false; dragging = false; live = false
        load(older,true)
    }
    private fun matchesFilter(item: Item) = (sourceFilter == 0 || (sourceFilter == 2) == (item.entry.source == "glasses")) &&
        when(typeFilter) { 1 -> item.audio; 2 -> item.entry.kind == "video"; 3 -> item.location != null; else -> true }
    private fun load(older: Boolean? = null, adjacent: Boolean = false) {
        // Recover the capture writer before competing with it for tens of thousands of historical files.
        if(!archiveView && RabiConversationService.recoveringRecording()) { loadAfterRecovery = true; listStatus.text = "正在恢复记录…"; return }
        if(archiveView) {
            if(!RecordingArchiveReviewAccess.useRemoteHistory(archiveView,RecordingArchiveSession.load(context) != null)) {
                listStatus.text = "尚未配置电脑归档 · 全部本机记录仍可切换查看"
                archiveNext.visibility = View.GONE; return
            }
            if(typeFilter == 2 || typeFilter == 3) {
                items = emptyList(); renderRows(); archiveNext.visibility = View.GONE
                listStatus.text = "此处为电脑归档录音 · 录像和位置请切换本机记录"; return
            }
            if(older == null) loadArchive(false)
            return
        }
        archiveAccess = null; archiveNext.visibility = View.GONE

        if(closed || (!adjacent && ((older == true && reachedOlder) || (older == false && reachedNewer)))) return
        if(older != null && loading) return
        val boundary = if(adjacent) selected?.takeIf { matchesFilter(it) } else if(older == true) displayedItems.lastOrNull() else displayedItems.firstOrNull()
        val boundaryTime = boundary?.entry?.started ?: if(adjacent) cursor else System.currentTimeMillis()
        val boundaryId = boundary?.entry?.id ?: if(older == false) "" else "\uffff"
        val requestedFilter = sourceFilter
        val requestedType = typeFilter
        val selectedBefore = selected?.entry?.id
        navigating = adjacent
        if(older == null) { reachedOlder = false; reachedNewer = false }
        if(loading) { reloadPending = true; return }
        val visibleRange = ruler.visibleRange()
        val margin = maxOf(86_400_000L,ruler.window)
        val requestedRange = maxOf(0,visibleRange.first-margin)..(visibleRange.last+margin)
        loading = true; lastLoad = System.currentTimeMillis(); val version = ++revision
        worker.execute {
            val result = runCatching {
                val store = RecordingStore(context)
                val video = (if(requestedType == 1 || requestedType == 3) emptyList() else if(older == null) store.list(requestedRange.first, requestedRange.last) else store.page(boundaryTime,boundaryId,older,requestedFilter,true)).filter { it.kind == "video" && it.state != "recording" && it.files.isNotEmpty() }.flatMap { entry ->
                    if(entry.state == "legacy") entry.files.map { file -> entry.copy(id=file.name,files=listOf(file),started=file.lastModified(),state="legacy-part") } else listOf(entry)
                }.map { entry ->
                    val duration = entry.files.sumOf { file ->
                        val key = "${file.absolutePath}:${file.lastModified()}:${file.length()}"
                        durations[key] ?: runCatching { RecordingResourceCache.duration(context,file) }.getOrDefault(0L).also { if(it > 0) durations[key] = it }
                    }
                    Item(entry, runCatching { store.captureId(entry.id) }.getOrDefault(entry.id), listOf(ReviewTimeline.Span(entry.started,duration)),false)
                }
                val audio = if(requestedType == 2 || requestedType == 3) org.json.JSONArray() else if(older == null) RabiAudioRecordRepository.listCaptureRecords(context,requestedRange.first,requestedRange.last) else RabiAudioRecordRepository.page(context,boundaryTime,boundaryId,older,requestedFilter)
                val sound = (0 until audio.length()).map { index ->
                    val row = audio.getJSONObject(index); val id = row.getString("captureId")
                    val spans = row.getJSONArray("playbackSpans")
                    Item(RecordingStore.Entry(row.getString("id"),"audio",row.optString("source"),row.optLong("startedAt"),row.optLong("endedAt"),"saved_segments",context.cacheDir,emptyList(),"录音事件"),
                        id,(0 until spans.length()).map { spans.getJSONObject(it).let { value -> ReviewTimeline.Span(value.getLong("startedAt"),value.getLong("durationMs"),value.getLong("offsetMs")) } },true,row.optString("parentCaptureId"),eventTranscript=row.optJSONObject("transcript"),asrState=row.optString("asrState"))
                }
                val combined = video.map { item -> item.copy(associatedIds = setOf(item.captureId) + sound.filter { it.parentCaptureId == item.captureId }.map { it.captureId }) }
                val savedMarkers = store.listMarkers()
                val locations = if(requestedFilter == 2 || requestedType in 1..2) emptyList() else
                    LocationRecordingReader(context).read(requestedRange.first,requestedRange.last+1,boundaryTime,boundaryId,older).map {
                        Item(it.entry,it.entry.id,listOf(ReviewTimeline.Span(it.entry.started,1)),false,location=it.sample)
                    }
                Pair(savedMarkers, (combined + sound + locations).sortedWith(compareByDescending<Item> { it.entry.started }.thenByDescending { it.entry.id }))
            }
            main.post {
                loading = false; navigating = false
                if(closed) return@post
                if(version != revision) { if(reloadPending) { reloadPending = false; load() }; return@post }
                result.onSuccess { (savedMarkers, records) ->
                    markers = savedMarkers
                    if(requestedFilter != sourceFilter || requestedType != typeFilter || (adjacent && selectedBefore != selected?.entry?.id)) return@onSuccess
                    if(older == null) items = records.filter { item -> item.spans.any { TimelineRulerMath.overlaps(it.start,it.duration,requestedRange) } }
                    else {
                        val ordered = records.sortedWith(compareBy<Item> { it.entry.started }.thenBy { it.entry.id }).let { if(older) it.asReversed() else it }
                        val page = ordered.take(100)
                        val merged = (items + page).associateBy { it.entry.id }.values.sortedWith(compareByDescending<Item> { it.entry.started }.thenByDescending { it.entry.id })
                        items = if(older) merged.takeLast(1000) else merged.take(1000)
                        if(adjacent) { reachedOlder = false; reachedNewer = false }
                        else if(older) { reachedOlder = ordered.size <= 100; if(merged.size > 1000) reachedNewer = false }
                        else { reachedNewer = ordered.size <= 100; if(merged.size > 1000) reachedOlder = false }
                    }
                    loadedRange = requestedRange
                    ruler.setCoverage(items.filter(::matchesFilter).flatMap { item -> item.spans.map { RecordingTimeRuler.Coverage(it.start,it.duration,!item.audio) } })
                    listStatus.text = if(items.isEmpty()) "此时间范围暂无已保存记录" else "" + if(older == true && reachedOlder) " · 已到最早记录" else if(older == false && reachedNewer) " · 已到最新记录" else ""
                    renderRows()
                    if(displayedItems.isEmpty() && older == null) main.post { if(!closed) load(true) }
                    if(adjacent) {
                        val target = records.filter(::matchesFilter).sortedWith(compareBy<Item> { it.entry.started }.thenBy { it.entry.id }).let { if(older == true) it.lastOrNull() else it.firstOrNull() }
                        if(target == null) listStatus.text = if(older == true) "已到最早事件" else "已到最新事件"
                        else { open(target,target.entry.started); renderRows() }
                    } else if(!live && !dragging && selected == null) jump(cursor)
                }.onFailure { listStatus.text = "刷新失败，已保留当前记录 · 点击刷新重试" }
                if(reloadPending) { reloadPending = false; main.postDelayed({ if(!closed) load() },1000) }
            }
        }
    }
    private fun loadArchive(next: Boolean) {
        if(closed || loading || next && archiveCursor == null) return
        loading = true
        val version = ++revision
        val requestedSource = sourceFilter
        val requestedType = typeFilter
        val pageCursor = if(next) archiveCursor else null
        val range = ruler.visibleRange()
        val margin = maxOf(86_400_000L, ruler.window)
        val query = if(next) requireNotNull(archiveQuery) else RecordingArchiveRepository.Query(31, maxOf(0,range.first-margin), range.last+margin,
            when(requestedSource) { 1 -> "phone"; 2 -> "glasses"; else -> null })
        if(!next) archiveQuery = query
        worker.execute {
            val result = runCatching {
                val access = requireNotNull(RecordingArchiveReviewAccess.load(context))
                access to access.repository.page(query,pageCursor)
            }
            main.post {
                loading = false
                if(closed) return@post
                if(version != revision) { if(reloadPending) { reloadPending = false; load() }; return@post }
                result.onSuccess { (access,page) ->
                    if(requestedSource != sourceFilter || requestedType != typeFilter) { load(); return@onSuccess }
                    archiveAccess = access
                    archiveCursor = page.remoteCursor
                    fun item(row: RecordingArchiveRepository.Row): Item = Item(
                        RecordingStore.Entry(row.recordId,"audio",row.source,row.startedAt,row.endedAt,"archive",context.cacheDir,emptyList(),"电脑归档录音"),
                        row.captureId,listOf(ReviewTimeline.Span(row.startedAt,row.totalBytes*1000/32000)),true,
                        eventTranscript=if(row.asrState == "completed" || row.text.isNotEmpty()) JSONObject().put("text",row.text) else null,
                        asrState=row.asrState,archiveRow=row)
                    archivePending = if(!next) page.localPendingOverlay.map(::item) else emptyList()
                    items = archivePending + page.remoteItems.map(::item)
                    if(page.status == RecordingArchiveRepository.Status.STALE) { items = emptyList(); archivePending = emptyList(); archiveCursor = null }
                    loadedRange = maxOf(0,range.first-margin)..(range.last+margin)
                    listStatus.text = when(page.status) {
                        RecordingArchiveRepository.Status.STALE -> "目录已更新 · 点击刷新重新读取"
                        RecordingArchiveRepository.Status.UNKNOWN_OFFLINE -> "电脑不可达 · 此页历史未知（并非没有录音）"
                        RecordingArchiveRepository.Status.OFFLINE_CACHED -> "离线目录 · 上次同步 ${clock(page.lastSyncedAt)}"
                        else -> "电脑归档 ${page.remoteItems.size} 条 · 本页早→晚"
                    } + (if(!access.pendingAvailable) " · 待上传索引暂不可用" else if(next) " · 待上传预览见首页" else " · 待上传预览 ${archivePending.size} 条（仅最多32条索引，非完整列表）") + if(page.pendingTruncated) " · 预览已截断" else ""
                    archiveNext.visibility = View.VISIBLE; archiveNext.isEnabled = archiveCursor != null
                    renderRows()
                }.onFailure { listStatus.text = "电脑历史读取失败 · 保留当前列表，点击刷新重试" }
            }
        }
    }
    private fun renderRows() {
        val anchor = displayedItems.getOrNull(scroll.firstVisiblePosition)?.entry?.id
        val offset = scroll.getChildAt(0)?.top ?: 0
        displayedItems = items.filter(::matchesFilter)
        scroll.background = if(displayedItems.isEmpty()) null else RabiMobileUi.panel(context,RabiMobileUi.surface,Color.TRANSPARENT,14)
        ruler.setCoverage(displayedItems.flatMap { item -> item.spans.map { RecordingTimeRuler.Coverage(it.start,it.duration,!item.audio) } })
        cards.clear()
        programmaticScroll = true
        rowAdapter.notifyDataSetChanged()
        val restored = RecordingListPosition.restore(displayedItems.map { it.entry.id },anchor,selected?.entry?.id,listDriving)
        val index = if(restored >= 0) restored else if(!listDriving) displayedItems.indexOfFirst { ReviewTimeline.mediaAt(it.spans,cursor) != null } else -1
        if(index >= 0) scroll.setSelectionFromTop(index, if(listDriving) offset else 0)
        scroll.post { programmaticScroll = false; highlightAt(cursor) }
    }
    private fun bindCard(item: Item, recycled: View?): View {
            val entry = item.entry
            val card = (recycled as? LinearLayout ?: LinearLayout(context)).apply {
                (tag as? String)?.let { cards.remove(it) }; tag = entry.id; removeAllViews()
                orientation = LinearLayout.VERTICAL; gravity = Gravity.CENTER_VERTICAL; minimumHeight = dp(96); setPadding(dp(16),dp(14),dp(12),dp(14))
                background = GradientDrawable().apply { setColor(RabiMobileUi.surface); cornerRadius = dp(16).toFloat() }
                layoutParams = AbsListView.LayoutParams(-1,-2)
                foreground = android.graphics.drawable.RippleDrawable(android.content.res.ColorStateList.valueOf(RabiMobileUi.accentBorder),null,RabiMobileUi.panel(context,Color.WHITE,Color.WHITE,16))
                isClickable = true; setOnClickListener { ruler.cancelGesture(); listDriving = false; dragging = false; open(item,entry.started); renderRows() }
            }
            cards[entry.id] = card
            val heading = LinearLayout(context).apply { gravity = Gravity.CENTER_VERTICAL }
            heading.addView(FrameLayout(context).apply {
                background = RabiMobileUi.panel(context,RabiMobileUi.accentSurface,Color.TRANSPARENT,24)
                addView(RabiMobileUi.icon(context,when(entry.kind) { "video" -> com.rabi.link.R.drawable.ic_ui_video; "location" -> com.rabi.link.R.drawable.ic_ui_pin; else -> com.rabi.link.R.drawable.ic_ui_mic },RabiMobileUi.secondary),FrameLayout.LayoutParams(dp(28),dp(28),Gravity.CENTER))
            },LinearLayout.LayoutParams(dp(52),dp(52)).apply { marginEnd = dp(14) })
            val seconds = item.spans.sumOf { it.duration } / 1000
            val duration = if(seconds >= 60) "${seconds/60}分${seconds%60}秒" else "${seconds}秒"
            heading.addView(LinearLayout(context).apply {
                orientation = LinearLayout.VERTICAL
                addView(label(SimpleDateFormat("HH:mm",Locale.CHINA).format(Date(entry.started)),16f).apply { typeface = android.graphics.Typeface.DEFAULT_BOLD; setPadding(0,0,0,dp(4)) })
                addView(label(when(entry.kind) { "video" -> "录像"; "location" -> "位置记录"; else -> "语音记录" },15f).apply { setTextColor(RabiMobileUi.text); setPadding(0,0,0,dp(3)) })
                addView(label(item.location?.let { "精度约 ${it.point.accuracy.toInt()} 米 · 手机" } ?: "$duration · ${if(entry.source == "glasses") "眼镜" else "手机"}",13f).apply { setTextColor(RabiMobileUi.muted); setPadding(0,0,0,0) })
            },LinearLayout.LayoutParams(0,-2,1f))
            heading.addView(RabiMobileUi.iconAction(context,if(item.location != null) com.rabi.link.R.drawable.ic_ui_chevron else com.rabi.link.R.drawable.ic_ui_play,"回看 ${clock(entry.started)} 的记录") {
                ruler.cancelGesture(); listDriving = false; dragging = false; open(item,entry.started); renderRows()
            }.apply {
                imageTintList = android.content.res.ColorStateList.valueOf(RabiMobileUi.secondary)
                setPadding(dp(14),dp(14),dp(14),dp(14))
                background = android.graphics.drawable.RippleDrawable(android.content.res.ColorStateList.valueOf(RabiMobileUi.accentBorder),
                    android.graphics.drawable.InsetDrawable(RabiMobileUi.panel(context,RabiMobileUi.accentSurface,Color.TRANSPARENT,24),dp(6)),null)
            },LinearLayout.LayoutParams(dp(48),dp(48)))
            card.addView(heading)
            val expanded = selected?.entry?.id == entry.id
            if(expanded) {
                item.location?.let { card.addView(label(locationDescription(it),13f)) }
                if(entry.kind == "video" && entry.files.isNotEmpty()) {
                    val image = ImageView(context).apply { scaleType = ImageView.ScaleType.CENTER_CROP; contentDescription = "录像缩略图" }
                    card.addView(image,LinearLayout.LayoutParams(dp(112),dp(64)).apply { topMargin = dp(8); marginStart = dp(56) })
                    thumbnail(entry.files.first(),image)
                }
                item.archiveRow?.let { row -> card.addView(label(if(row.archived) "电脑已归档 · 按块播放" else when(row.uploadState) {
                    "blocked_missing_media" -> "归档受阻 · 本地音频不完整，暂不可播放"
                    "blocked" -> "归档受阻 · 请检查完整性或授权，记录已保留"
                    "retry_wait" -> "本地待上传 · 等待连接恢复"
                    else -> "本地待上传"
                },12f)) }
                item.eventTranscript?.let { receipt ->
                    val text = receipt.optString("text").trim()
                    if(text.isNotEmpty()) card.addView(label(text,17f))
                    else card.addView(label("未识别到语音",12f))
                }
                if(item.eventTranscript == null) {
                    val status = when(item.asrState) {
                        "processing", "running" -> "转录中…"
                        "pending", "queued" -> "待转录"
                        "blocked", "failed" -> "电脑转录暂不可用 · 原音频已保留"
                        "ambiguous" -> "转录结果待核对 · 不自动重转"
                        "unavailable" -> "转录状态暂不可用"
                        "retry" -> "转录暂未完成 · 等待重试"
                        "local_only" -> "仅本地保存 · 未转录"
                        else -> ""
                    }
                    if(status.isNotBlank()) card.addView(label(status,13f).apply { setTextColor(RabiMobileUi.muted) })
                }
                if(selected?.entry?.id == entry.id) card.addView(label("回看中",12f).apply { setTextColor(RabiMobileUi.secondary) })
                markers.filter { (it.recordId in item.associatedIds || it.recordId == entry.id) }.forEach { marker ->
                    card.addView(Button(context).apply { text = "标记 · ${clock(marker.at)}"; setOnClickListener { jump(marker.at) } })
                }
            }
            if(!expanded && item.archiveRow?.uploadState in setOf("blocked_missing_media","blocked")) {
                card.addView(label("归档受阻 · 记录已保留",12f).apply { setTextColor(RabiMobileUi.warning) })
            } else if(!expanded && item.asrState in setOf("blocked","failed","ambiguous")) {
                card.addView(label("转写待核对 · 原音频已保留",12f).apply { setTextColor(RabiMobileUi.warning) })
            }
        return card
    }
    private fun thumbnail(file: File, target: ImageView) {
        val key = file.absolutePath + file.lastModified()
        images.get(key)?.let { target.setImageBitmap(it); return }
        target.tag = key
        thumbnailWorker.execute {
            val bitmap = runCatching {
                val reader = MediaMetadataRetriever()
                try { reader.setDataSource(file.absolutePath); reader.getScaledFrameAtTime(0,MediaMetadataRetriever.OPTION_CLOSEST_SYNC,240,160) } finally { reader.release() }
            }.getOrNull()
            main.post { if(!closed && bitmap != null) { images.put(key,bitmap); if(target.tag == key) target.setImageBitmap(bitmap) } }
        }
    }
    private fun jump(time: Long) {
        live = false; cursor = time; ruler.setPosition(time,false); updateRange(); ensureRange()
        val item = displayedItems.firstOrNull { it.entry.kind == "video" && ReviewTimeline.mediaAt(it.spans,time) != null }
            ?: displayedItems.firstOrNull { ReviewTimeline.mediaAt(it.spans,time) != null }
        if(item == null) {
            selected = null; selection++; releasePlayback(); showEmpty("无画面 · 此时段没有事件")
            position.text = "回看 · ${clock(time)} · 记录空缺"; highlight(null)
        } else open(item,time)
    }
    private fun open(item: Item, at: Long) {
        if(item.archiveRow?.uploadState == "blocked_missing_media") {
            Toast.makeText(context,"本地音频不完整，记录保留等待核对",Toast.LENGTH_SHORT).show(); return
        }
        live = false
        setVideoPreview(item.entry.kind == "video"); previewStage.requestLayout()
        val time = at
        val offset = ReviewTimeline.mediaAt(item.spans,time) ?: 0L
        cursor = time; ruler.setPosition(time,false); updateRange(); ensureRange()
        position.text = "回看 · ${clock(time)}"
        if(selected?.entry?.id == item.entry.id && player != null) { player?.seekTo(offset); return }
        if(selected?.entry?.id == item.entry.id && player == null && item.location == null) return
        selected = item; val ticket = ++selection; releasePlayback(); showEmpty("正在缓冲…"); highlight(item.entry.id)
        item.location?.let {
            showEmpty(locationDescription(it)); liveTap.visibility = View.GONE
            position.text = "位置 · ${clock(it.point.time)}"
            return
        }
        if(item.archiveRow?.archived == true) { openArchive(item,ticket,offset); return }
        mediaWorker.execute {
            val result = runCatching { if(item.audio) RabiConversationService.pinLocalEvents(listOf(item.entry.id)).use { item.entry.copy(files=listOf(RabiAudioRecordRepository.exportCaptureWave(context,item.entry.id))) } else item.entry.copy(files=item.entry.files.map { RecordingResourceCache.materialize(context,it) }) }
            main.post {
                if(closed || ticket != selection || live) return@post
                result.onSuccess { entry ->
                    preview.removeAllViews()
                    player = RecordingPlaybackPanel(context,entry.files,entry.kind == "video",ReviewTimeline.mediaAt(item.spans,cursor) ?: offset, playbackState.copy(controlsVisible=controlsVisible), { share(entry) }) { mediaPosition ->
                        if(!dragging && !live && ticket == selection) {
                            ReviewTimeline.timeFor(item.spans,mediaPosition)?.let { wall ->
                                position.text = "回看 · ${clock(wall)}"
                                cursor = wall; ruler.setPosition(wall,false); updateRange(); ensureRange()
                                if(System.currentTimeMillis()-lastRender > 1000) { lastRender = System.currentTimeMillis(); highlightAt(cursor) }
                            }
                        }
                    }.also {
                        it.onControlsVisibilityChanged = ::showControls
                        liveTap.visibility = View.GONE
                        preview.addView(it.view,FrameLayout.LayoutParams(-1,-1))
                    }
                }.onFailure { showEmpty("回看失败，原文件保留"); position.text = it.message ?: "媒体不可用" }
            }
        }
    }
    private fun locationDescription(sample: SavedLocation): String =
        sample.address.ifBlank { "地点名称未查询" } + "\n" +
            String.format(Locale.ROOT,"%.6f, %.6f",sample.point.latitude,sample.point.longitude) +
            "\n精度约 ${sample.point.accuracy.toInt()} 米 · ${sample.point.provider}\n已保存在手机"
    private fun openArchive(item: Item, ticket: Int, offset: Long) {
        val access = archiveAccess ?: return
        val row = requireNotNull(item.archiveRow)
        mediaWorker.execute {
            val result = runCatching {
                val manifest = access.transport.getManifest(access.config.target,row.recordId)
                require(RecordingArchiveContract.recordingManifestHash(manifest) == row.manifestHash) { "归档清单校验失败" }
                val factory = ArchivePcmDataSource.Factory(RecordingArchiveReviewAccess.key(row)) {
                    ArchivePcmDataSource.Session(ArchivePcmReader(manifest) { hash, bytes -> access.transport.readPlaybackObject(access.config.target,hash,bytes) })
                }
                androidx.media3.exoplayer.source.ProgressiveMediaSource.Factory(factory)
                    .createMediaSource(MediaItem.fromUri(factory.uri()))
            }
            main.post {
                if(closed || ticket != selection || live) return@post
                result.onSuccess { source ->
                    preview.removeAllViews()
                    player = RecordingPlaybackPanel(context,emptyList(),false,offset,playbackState.copy(controlsVisible=controlsVisible),
                        { Toast.makeText(context,"远端原件保留在电脑，分享需显式导出",Toast.LENGTH_SHORT).show() },source,row.totalBytes*1000/32000) { mediaPosition ->
                        if(!dragging && !live && ticket == selection) ReviewTimeline.timeFor(item.spans,mediaPosition)?.let { wall ->
                            cursor = wall; ruler.setPosition(wall,false); position.text = "回看 · ${clock(wall)}"; updateRange()
                        }
                    }.also { it.onControlsVisibilityChanged = ::showControls; liveTap.visibility = View.GONE; preview.addView(it.view,FrameLayout.LayoutParams(-1,-1)) }
                }.onFailure { selected = null; showEmpty("远端录音暂不可播放 · 原件保留"); position.text = "请检查电脑连接后重试" }
            }
        }
    }
    private fun highlight(id: String?) { cards.forEach { (key, card) -> card.background = com.rabi.link.RabiMobileUi.panel(context,if(key == id) RabiMobileUi.accentSurface else RabiMobileUi.surface,if(key == id) RabiMobileUi.accentBorder else Color.TRANSPARENT,if(key == id) 12 else 0) } }
    fun close() { closed = true; revision++; selection++; releasePlayback(); main.removeCallbacksAndMessages(null); ruler.cancelGesture(); worker.shutdown(); mediaWorker.shutdown(); thumbnailWorker.shutdown(); images.evictAll() }
}
