package com.rabi.link.recording

import android.app.DatePickerDialog
import android.content.Context
import android.graphics.Color
import android.graphics.drawable.GradientDrawable
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
    private var archiveView = false
    private var archiveAccess: RecordingArchiveReviewAccess? = null
    private var archiveCursor: String? = null
    private var archiveQuery: RecordingArchiveRepository.Query? = null
    private var archivePending = emptyList<Item>()
    private var archiveStatus: RecordingArchiveRepository.Status? = null
    private val archiveNext = RabiMobileUi.compactAction(context, "下一页（早→晚）") { loadArchive(archiveStatus != RecordingArchiveRepository.Status.OFFLINE_CACHED) }.apply { visibility = View.GONE }

    private data class Item(val entry: RecordingStore.Entry, val captureId: String, val spans: List<ReviewTimeline.Span>, val audio: Boolean, val parentCaptureId: String = "", val associatedIds: Set<String> = setOf(captureId), val eventTranscript: org.json.JSONObject? = null, val asrState: String = "", val archiveRow: RecordingArchiveRepository.Row? = null, val location: SavedLocation? = null, val policy: String = "")
    val view: LinearLayout = RecordingHistoryLayout(context).apply { orientation = LinearLayout.VERTICAL }
    private val main = Handler(Looper.getMainLooper())
    private val worker = Executors.newSingleThreadExecutor()
    // The main pane is live-only. Historical media belongs to a dialog, never to this layout.
    private val preview = FrameLayout(context)
    private var liveCaption: TextView? = null
    private var liveLocationKey = ""
    private var collapseAnimation: android.animation.ValueAnimator? = null
    private val filterButton = RabiMobileUi.compactAction(context,"筛选") {}
    private val pageLoading = ProgressBar(context).apply { visibility = View.GONE }
    private val skeleton = RecordingLoadingView(context).apply { visibility = View.GONE; contentDescription = "正在加载记录" }
    private val emptyLabel = label("正在读取记录…",15f).apply { gravity = Gravity.CENTER }
    private val emptyAction = RabiMobileUi.compactAction(context,"清除筛选") {}
    private val configureArchive = RabiMobileUi.compactAction(context,"前往配置") {
        val activity = context as? android.app.Activity ?: (context as? android.content.ContextWrapper)?.baseContext as? android.app.Activity
        activity?.let { RecordingArchiveSettingsPanel.show(it) }
    }.apply { visibility = View.GONE }
    private val localHistoryAction = RabiMobileUi.compactAction(context,"查看本机记录") { archiveView = false; applyFilters() }.apply { visibility = View.GONE }
    private var failedOlder: Boolean? = null
    private var failedArchiveNext = false
    private var queryFailed = false
    private var recordDialog: android.app.AlertDialog? = null
    private var playbackPreview: FrameLayout? = null
    private val captureCard = LinearLayout(context).apply {
        orientation = LinearLayout.VERTICAL
        background = RabiMobileUi.panel(context,RabiMobileUi.surface,Color.TRANSPARENT,14)
        clipToOutline = true
    }
    private val previewStage = FrameLayout(context).apply {
        contentDescription = "实时记录预览"
        layoutParams = LinearLayout.LayoutParams(-1,dp(124))
    }
    private var controlsVisible = true
    private fun showControls(shown: Boolean) {
        controlsVisible = shown
        if(player?.state()?.controlsVisible != shown) player?.setControls(shown)
    }
    private fun enterHistory() {
        live = false; listDriving = true
        collapseAnimation?.removeAllListeners(); collapseAnimation?.cancel(); collapseAnimation = null
        reviewColumn.visibility = View.GONE
        releaseLivePreview()
    }
    private fun showRecordDialog(item: Item) {
        if(recordDialog?.isShowing == true) return
        val body = LinearLayout(context).apply {
            orientation = LinearLayout.VERTICAL; setPadding(dp(8),dp(8),dp(8),dp(8))
        }
        val heading = LinearLayout(context).apply { gravity = Gravity.CENTER_VERTICAL }
        val kind = if(item.location != null) "位置" else if(item.entry.kind == "video") "录像" else "录音"
        heading.addView(label("${clock(item.entry.started)} · $kind",18f).apply { typeface = android.graphics.Typeface.DEFAULT_BOLD },LinearLayout.LayoutParams(0,dp(48),1f))
        heading.addView(RabiMobileUi.iconAction(context,com.rabi.link.R.drawable.ic_ui_close,"关闭记录预览") { recordDialog?.dismiss() },LinearLayout.LayoutParams(dp(48),dp(48)))
        body.addView(heading)
        if(item.location == null) {
            val seconds = item.spans.sumOf { it.duration }/1000
            body.addView(label("${if(seconds > 0) "${seconds}秒" else "时长待读取"} · ${if(item.entry.source == "glasses") "眼镜" else "手机"}",13f).apply { setTextColor(RabiMobileUi.muted) })
        }
        playbackPreview = FrameLayout(context).also { frame ->
            frame.contentDescription = "历史记录弹窗预览"
            body.addView(frame,LinearLayout.LayoutParams(-1,if(item.location != null) dp(160) else if(item.entry.kind == "video") dp(228) else dp(188)))
        }
        val transcript = item.eventTranscript?.optString("text").orEmpty().trim()
        val bookmarks = markers.filter { it.recordId in item.associatedIds || it.recordId == item.entry.id }
        if(transcript.isNotBlank() || bookmarks.isNotEmpty()) body.addView(ScrollView(context).apply {
            contentDescription = "记录转写原文"
            addView(LinearLayout(context).apply {
                orientation = LinearLayout.VERTICAL
                if(transcript.isNotBlank()) {
                    addView(label("转写原文",14f).apply { typeface = android.graphics.Typeface.DEFAULT_BOLD })
                    addView(label(transcript,16f).apply { setTextIsSelectable(true) })
                }
                bookmarks.forEach { marker -> addView(RabiMobileUi.compactAction(context,"标记 · ${clock(marker.at)}") {
                    ReviewTimeline.mediaAt(item.spans,marker.at)?.let { player?.seekTo(it) }
                }) }
            })
        },LinearLayout.LayoutParams(-1,dp(144)))
        else if(item.audio) body.addView(label(recordingTranscriptStatus(item.policy,item.asrState,item.eventTranscript != null,transcript),14f).apply { setTextColor(RabiMobileUi.muted) })
        val dialog = android.app.AlertDialog.Builder(context).setView(body).create()
        recordDialog = dialog
        dialog.setOnDismissListener {
            if(recordDialog === dialog) {
                recordDialog = null; selection++; loadingSelection = false
                releasePlayback(); playbackPreview = null; playbackState = RecordingPlaybackPanel.State()
                if(!closed) renderRows()
            }
        }
        dialog.show()
        dialog.window?.setBackgroundDrawable(RabiMobileUi.panel(context,RabiMobileUi.surface,Color.TRANSPARENT,18))
        dialog.window?.setLayout((context.resources.displayMetrics.widthPixels*0.92f).toInt(),-2)
    }
    private fun playbackFailure(item: Item,message: String) {
        playbackPreview?.apply {
            removeAllViews()
            addView(LinearLayout(context).apply {
                orientation = LinearLayout.VERTICAL; gravity = Gravity.CENTER
                addView(label(message,14f).apply { gravity = Gravity.CENTER; setTextColor(RabiMobileUi.error) })
                addView(RabiMobileUi.compactAction(context,"重试") { retryPlayback(item) })
            },FrameLayout.LayoutParams(-1,-1))
        }
    }
    private fun retryPlayback(item: Item) {
        selected = null; loadingSelection = false; releasePlayback()
        open(item,ReviewTimeline.timeFor(item.spans,replayOffset) ?: item.entry.started,playbackState.playing)
    }
    private val dayButton = RabiMobileUi.compactAction(context, "选择日期") {}
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
    private var pendingHistoryScroll = 0
    private var historyScrollQueued = false
    private val afterHistoryLayout = object : android.view.ViewTreeObserver.OnGlobalLayoutListener {
        override fun onGlobalLayout() {
            if(view.viewTreeObserver.isAlive) view.viewTreeObserver.removeOnGlobalLayoutListener(this)
            historyScrollQueued = false
            val distance = pendingHistoryScroll; pendingHistoryScroll = 0
            if(!closed && listDriving) scroll.scrollListBy(distance)
        }
    }
    private var displayedItems = emptyList<Item>()
    private var sourceFilter = 0
    private var typeFilter = 0
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
    private var reloadPending = false
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
    private var replayOffset = 0L
    private var loadingSelection = false
    private var playbackState = RecordingPlaybackPanel.State()
    private var livePlayer: ExoPlayer? = null
    private var liveUrl = ""
    private var liveWaveform: AudioWaveformView? = null
    private var idleMessage = ""
    private val cards = mutableMapOf<String, View>()
    private val liveTick = object : Runnable {
        override fun run() { if(closed) return; refreshLive(); main.postDelayed(this,1000) }
    }
    init {
        previewStage.addView(preview,FrameLayout.LayoutParams(-1,-1))
        captureCard.addView(previewStage,LinearLayout.LayoutParams(-1,dp(124)))
        reviewColumn.addView(captureCard)
        val navigation = LinearLayout(context).apply {
            gravity = Gravity.CENTER_VERTICAL; setPadding(dp(6),0,dp(6),0)
        }
        dayButton.textSize = 14f
        dayButton.gravity = Gravity.START or Gravity.CENTER_VERTICAL
        dayButton.contentDescription = "选择记录日期"
        dayButton.maxLines = 1
        dayButton.ellipsize = android.text.TextUtils.TruncateAt.END
        val calendar = RabiMobileUi.icon(context,com.rabi.link.R.drawable.ic_ui_calendar,RabiMobileUi.secondary).drawable.apply { setBounds(0,0,dp(18),dp(18)) }
        dayButton.setCompoundDrawables(calendar,null,null,null); dayButton.compoundDrawablePadding = dp(4)
        navigation.addView(dayButton,LinearLayout.LayoutParams(0,dp(48),1f))
        filterButton.textSize = 13f
        filterButton.maxLines = 1; filterButton.maxWidth = dp(150); filterButton.ellipsize = android.text.TextUtils.TruncateAt.END
        filterButton.setOnClickListener { showFilters(filterButton) }
        navigation.addView(filterButton,LinearLayout.LayoutParams(-2,dp(48)))
        navigation.addView(RabiMobileUi.compactAction(context,"返回实时") { enterLive() }.apply {
            contentDescription = "返回实时"
            setTextColor(RabiMobileUi.secondary)
            background = android.graphics.drawable.RippleDrawable(android.content.res.ColorStateList.valueOf(RabiMobileUi.accentBorder),android.graphics.drawable.InsetDrawable(RabiMobileUi.panel(context,RabiMobileUi.surface,RabiMobileUi.accentBorder,16),0,dp(6),0,dp(6)),null)
        },LinearLayout.LayoutParams(-2,dp(48)))
        navigation.addView(RabiMobileUi.iconAction(context,com.rabi.link.R.drawable.ic_ui_refresh,"刷新记录和转写") { load() },LinearLayout.LayoutParams(dp(44),dp(48)))
        eventColumn.addView(navigation)
        eventColumn.addView(listStatus)
        listStatus.setOnClickListener {
            if(archiveView) loadArchive(if(queryFailed) failedArchiveNext else false)
            else load(if(queryFailed) failedOlder else null)
        }
        val listFrame = FrameLayout(context)
        val empty = LinearLayout(context).apply {
            orientation = LinearLayout.VERTICAL; gravity = Gravity.CENTER; setPadding(dp(20),dp(20),dp(20),dp(20))
            addView(skeleton,LinearLayout.LayoutParams(-1,dp(240)))
            addView(emptyLabel,LinearLayout.LayoutParams(-1,-2))
            addView(configureArchive,LinearLayout.LayoutParams(-2,dp(48)))
            addView(emptyAction,LinearLayout.LayoutParams(-2,dp(48)))
            addView(localHistoryAction,LinearLayout.LayoutParams(-2,dp(48)))
        }
        emptyAction.setOnClickListener {
            when {
                queryFailed -> if(archiveView) loadArchive(failedArchiveNext) else load(failedOlder)
                archiveView && archiveStatus in setOf(RecordingArchiveRepository.Status.UNKNOWN_OFFLINE,RecordingArchiveRepository.Status.STALE) -> loadArchive(false)
                archiveView -> { archiveView = false; applyFilters() }
                else -> { typeFilter = 0; sourceFilter = 0; applyFilters() }
            }
        }
        scroll.adapter = rowAdapter
        listFrame.addView(scroll,FrameLayout.LayoutParams(-1,-1))
        listFrame.addView(empty,FrameLayout.LayoutParams(-1,-1))
        scroll.emptyView = empty
        eventColumn.addView(listFrame,LinearLayout.LayoutParams(-1,0,1f))
        eventColumn.addView(pageLoading,LinearLayout.LayoutParams(dp(24),dp(24)).apply { gravity = Gravity.CENTER; topMargin = dp(4) })
        eventColumn.addView(archiveNext)
        view.orientation = LinearLayout.VERTICAL
        view.setPadding(dp(12),dp(4),dp(12),dp(4))
        view.addView(reviewColumn,LinearLayout.LayoutParams(-1,-2).apply { bottomMargin = dp(6) })
        view.addView(eventColumn,LinearLayout.LayoutParams(-1,0,1f))
        scroll.setOnScrollListener(object : AbsListView.OnScrollListener {
            override fun onScrollStateChanged(list: AbsListView,state: Int) {
                if(state == AbsListView.OnScrollListener.SCROLL_STATE_TOUCH_SCROLL) listDriving = true
            }
            override fun onScroll(list: AbsListView,first: Int,count: Int,total: Int) {
                if(programmaticScroll || !listDriving || archiveView || queryFailed || total == 0 || count == 0) return
                if(first+count >= total-2) load(true)
                else if(first <= 1 && items.size >= 1000) load(false)
            }
        })
        dayButton.setOnClickListener {
            val date = Calendar.getInstance().apply { timeInMillis = day }
            DatePickerDialog(context,{ _,year,month,dateOfMonth ->
                val chosen = Calendar.getInstance().apply { set(year,month,dateOfMonth,0,0,0); set(Calendar.MILLISECOND,0) }.timeInMillis
                day = chosen; cursor = chosen; enterHistory(); recordDialog?.dismiss(); selected = null
                applyFilters()
            },date.get(Calendar.YEAR),date.get(Calendar.MONTH),date.get(Calendar.DAY_OF_MONTH)).apply {
                datePicker.maxDate = System.currentTimeMillis()
            }.show()
        }
        (view as RecordingHistoryLayout).apply {
            canStartHistoryGesture = { x,y ->
                val origin = IntArray(2); scroll.getLocationOnScreen(origin)
                scroll.isShown && x >= origin[0] && x < origin[0]+scroll.width && y >= origin[1] && y < origin[1]+scroll.height
            }
            shouldCollapseLive = { reviewColumn.visibility == View.VISIBLE }
            historyAtTop = { !scroll.canScrollVertically(-1) }
            canExpandLive = { !live && !archiveView && day == midnight(System.currentTimeMillis()) && reachedNewer && !loading && !queryFailed }
            expandBy = { amount ->
                collapseAnimation?.removeAllListeners(); collapseAnimation?.cancel(); collapseAnimation = null
                val height = if(reviewColumn.visibility == View.VISIBLE) previewStage.layoutParams.height else 0
                reviewColumn.visibility = View.VISIBLE
                previewStage.layoutParams = previewStage.layoutParams.apply { this.height = (height+amount).toInt().coerceIn(0,dp(124)) }
            }
            finishExpansion = {
                if(previewStage.layoutParams.height >= dp(32)) enterLive() else enterHistory()
            }
            collapseBy = { amount ->
                live = false; listDriving = true
                val height = previewStage.layoutParams.height.coerceAtLeast(0)
                val consumed = minOf(amount,height.toFloat())
                previewStage.layoutParams = previewStage.layoutParams.apply { this.height = (height-consumed).toInt().coerceAtLeast(0) }
                if(height-consumed <= 0) enterHistory()
                amount-consumed
            }
            finishCollapse = {
                if(reviewColumn.visibility == View.VISIBLE) {
                    collapseAnimation = android.animation.ValueAnimator.ofInt(previewStage.height,0).apply {
                        duration = 130
                        addUpdateListener { previewStage.layoutParams = previewStage.layoutParams.apply { height = it.animatedValue as Int } }
                        addListener(object : android.animation.AnimatorListenerAdapter() {
                            override fun onAnimationEnd(animation: android.animation.Animator) { enterHistory() }
                        }); start()
                    }
                }
            }
            scrollHistoryBy = { dy ->
                val distance = -dy.toInt()
                if(historyScrollQueued || view.isLayoutRequested || scroll.isLayoutRequested) {
                    pendingHistoryScroll += distance
                    if(!historyScrollQueued) {
                        historyScrollQueued = true
                        view.viewTreeObserver.addOnGlobalLayoutListener(afterHistoryLayout)
                    }
                } else scroll.scrollListBy(distance)
            }
        }
        lastDataSignal = dataSignal()
        updateRange(); showEmpty("正在读取采集状态"); main.post { if(!closed) load() }; refreshLive(); main.postDelayed(liveTick,1000)
    }
    private fun showFilters(anchor: View) {
        var draftScope = archiveView
        var draftType = typeFilter
        var draftSource = sourceFilter
        val body = LinearLayout(context).apply {
            orientation = LinearLayout.VERTICAL; setPadding(dp(12),dp(12),dp(12),dp(12))
            background = RabiMobileUi.panel(context,RabiMobileUi.surface,RabiMobileUi.border,16)
        }
        fun choices(title: String,values: List<String>,selected: Int,change: (Int)->Unit) {
            body.addView(label(title,13f))
            val group = RadioGroup(context).apply { orientation = RadioGroup.HORIZONTAL }
            values.forEachIndexed { index,text ->
                group.addView(RadioButton(context).apply { id = View.generateViewId(); this.text = text; textSize = 12f; minWidth = 0; isChecked = index == selected
                    buttonDrawable = null; gravity = Gravity.CENTER; setPadding(0,0,0,0)
                    background = RabiMobileUi.panel(context,if(isChecked) RabiMobileUi.accentSurface else RabiMobileUi.surface,if(isChecked) RabiMobileUi.accentBorder else RabiMobileUi.border,14)
                    setTextColor(if(isChecked) RabiMobileUi.secondary else RabiMobileUi.text)
                    setOnClickListener {
                        change(index)
                        for(i in 0 until group.childCount) (group.getChildAt(i) as RadioButton).apply {
                            background = RabiMobileUi.panel(context,if(isChecked) RabiMobileUi.accentSurface else RabiMobileUi.surface,if(isChecked) RabiMobileUi.accentBorder else RabiMobileUi.border,14)
                            setTextColor(if(isChecked) RabiMobileUi.secondary else RabiMobileUi.text)
                        }
                    }
                },RadioGroup.LayoutParams(0,dp(44),1f).apply { marginEnd = dp(4) })
            }
            body.addView(group)
        }
        choices("范围",listOf("本机记录","电脑归档"),if(draftScope) 1 else 0) { draftScope = it == 1 }
        choices("类型",listOf("全部","录音","录像","位置"),draftType) { draftType = it }
        choices("来源",listOf("全部","手机","眼镜"),draftSource) { draftSource = it }
        val popup = PopupWindow(body,minOf(context.resources.displayMetrics.widthPixels-dp(24),dp(360)),-2,true).apply {
            elevation = dp(12).toFloat(); setBackgroundDrawable(android.graphics.drawable.ColorDrawable(Color.TRANSPARENT)); isOutsideTouchable = true
        }
        val actions = LinearLayout(context)
        actions.addView(RabiMobileUi.compactAction(context,"重置") {
            archiveView = false; typeFilter = 0; sourceFilter = 0; popup.dismiss(); enterHistory(); applyFilters()
        },LinearLayout.LayoutParams(0,dp(48),1f))
        actions.addView(RabiMobileUi.primary(context,"应用") {
            archiveView = draftScope; typeFilter = draftType; sourceFilter = draftSource
            popup.dismiss(); enterHistory(); applyFilters()
        }.apply { minHeight = dp(48); minimumHeight = dp(48) },LinearLayout.LayoutParams(0,dp(48),1f))
        body.addView(actions); popup.showAsDropDown(anchor,0,0,Gravity.END)
    }
    private fun applyFilters() {
        recordDialog?.dismiss(); selected = null; selection++; releasePlayback()
        revision++; items = emptyList(); archivePending = emptyList(); archiveCursor = null; archiveQuery = null; archiveAccess = null
        archiveStatus = null
        reachedOlder = false; reachedNewer = false; queryFailed = false
        filterButton.text = (if(archiveView) "电脑归档" else "筛选") + when(typeFilter) { 1 -> " · 录音"; 2 -> " · 录像"; 3 -> " · 位置"; else -> "" } + when(sourceFilter) { 1 -> " · 手机"; 2 -> " · 眼镜"; else -> "" }
        updateRange(); renderRows()
        if(loading) reloadPending = true else load()
    }
    private fun dp(value: Int) = (context.resources.displayMetrics.density * value).toInt()
    private fun label(text: String, size: Float = 14f) = TextView(context).apply {
        this.text = text; textSize = size; setTextColor(RabiMobileUi.primary); setPadding(dp(12),dp(5),dp(12),dp(5))
    }
    private fun midnight(time: Long) = Calendar.getInstance().apply { timeInMillis = time; set(Calendar.HOUR_OF_DAY,0); set(Calendar.MINUTE,0); set(Calendar.SECOND,0); set(Calendar.MILLISECOND,0) }.timeInMillis
    private fun updateRange() { dayButton.text = SimpleDateFormat("M月d日",Locale.CHINA).format(Date(day)) }
    private fun clock(time: Long) = SimpleDateFormat("HH:mm:ss",Locale.CHINA).format(Date(time))
    private fun releasePlayback() { player?.let { playbackState = it.state(); it.close() }; player = null; playbackPreview?.removeAllViews() }
    private fun releaseLivePreview() { livePlayer?.release(); livePlayer = null; liveUrl = ""; liveWaveform = null; idleMessage = ""; preview.removeAllViews(); liveCaption = null; liveLocationKey = "" }
    private fun showPlaybackEmpty(message: String) {
        playbackPreview?.apply {
            removeAllViews()
            addView(label(message,15f).apply { gravity = Gravity.CENTER; setTextColor(RabiMobileUi.muted) },FrameLayout.LayoutParams(-1,-1))
        }
    }
    private fun showEmpty(message: String) {
        liveWaveform = null
        preview.removeAllViews()
        preview.addView(label(message, 18f).apply { gravity = Gravity.CENTER; setTextColor(RabiMobileUi.muted); setBackgroundColor(RabiMobileUi.surface) },FrameLayout.LayoutParams(-1,-1))
    }
    private fun showLiveAudioIdle(message: String) { showEmpty(message); idleMessage = message }
    private fun enterLive() {
        listDriving = false; dragging = false; live = true; cursor = System.currentTimeMillis(); selected = null; selection++
        collapseAnimation?.removeAllListeners(); collapseAnimation?.cancel(); collapseAnimation = null
        previewStage.layoutParams = previewStage.layoutParams.apply { height = dp(124) }
        day = midnight(cursor)
        recordDialog?.dismiss(); releasePlayback(); releaseLivePreview(); reviewColumn.visibility = View.VISIBLE; playbackState = RecordingPlaybackPanel.State(); updateRange(); scroll.setSelection(0); load(); refreshLive()
    }
    /** Called only while visible, from the owner's runtime events; history playback is not reset. */
    fun refreshLive() {
        if(closed || dragging) return
        val runtime = context.getSharedPreferences("rabi_conversation_runtime",Context.MODE_PRIVATE)
        val recording = AllDayRecordingSettings.load(context)
        if(reviewColumn.visibility != View.VISIBLE) { refreshChangedData(); return }
        if(live) {
            cursor = System.currentTimeMillis()
            val today = midnight(cursor)
            if(today != day) { day = today; load() }
            updateRange()
        }
        val last = runtime.getLong("captureLastReceivedAt",0)
        val recent = AllDayRecordingSettings.load(context).running && System.currentTimeMillis() - last < 5000
        val video = RabiConversationService.currentVideo()
        val url = if(video?.receiving == true) video.previewUrl else ""
        if(recording.mode == "health") {
            val lastHealth = runtime.getLong("healthLastReceivedAt",0)
            val message = if(lastHealth > 0) "最近健康数据 · ${clock(lastHealth)}" else "尚未收到健康数据"
            if(idleMessage != message) {
                releaseLivePreview(); showEmpty(message); idleMessage = message
                preview.addView(RabiMobileUi.compactAction(context,"健康设备") {
                    context.startActivity(android.content.Intent(context,com.rabi.link.modules.wearable.WearableHealthSettingsActivity::class.java))
                },FrameLayout.LayoutParams(-2,dp(44),Gravity.BOTTOM or Gravity.CENTER_HORIZONTAL))
            }
            refreshChangedData(); return
        }
        if(recording.mode == "video" && url.isBlank()) {
            val message = if(recording.running) "等待接收眼镜画面" else "采集已暂停"
            if(idleMessage != message) { releaseLivePreview(); showEmpty(message); idleMessage = message }
            refreshChangedData(); return
        }
        if(recording.mode == "location") {
            val key = "${runtime.getLong("locationLastReceivedAt",0)}:${LocationRepository.revision()}"
            if(key != liveLocationKey) {
                releaseLivePreview()
                liveLocationKey = key
                showEmpty(runtime.getString("locationStatus","等待定位").orEmpty())
                worker.execute {
                    val sample = runCatching { LocationRepository(context).use { it.recent(0,Long.MAX_VALUE,1).firstOrNull() } }
                    main.post {
                        if(!closed && live && reviewColumn.visibility == View.VISIBLE && liveLocationKey == key && AllDayRecordingSettings.load(context).mode == "location") {
                            sample.onSuccess { point -> showEmpty(point?.let { "最近位置 · ${clock(it.point.time)}\n${it.address.ifBlank { "地点名称未查询" }}\n精度约 ${it.point.accuracy.toInt()} 米" } ?: "等待第一个位置") }
                                .onFailure { showEmpty("位置读取失败，请查看位置设置") }
                        }
                    }
                }
            }
            refreshChangedData(); return
        }
        if(url.isBlank()) {
            if(livePlayer != null) releaseLivePreview()
            if(recent) {
                if(liveWaveform == null) {
                    idleMessage = ""; preview.removeAllViews()
                    liveWaveform = AudioWaveformView(context,true,compact = true).also { preview.addView(it,FrameLayout.LayoutParams(-1,-1)) }
                    liveCaption = label("",12f).apply { setTextColor(RabiMobileUi.secondary) }.also { preview.addView(it,FrameLayout.LayoutParams(-2,dp(30),Gravity.TOP or Gravity.START)) }
                }
                liveWaveform?.state = if(runtime.getBoolean("captureHasSignal",false)) "正在收音" else "收到静音"
                liveCaption?.text = "${liveWaveform?.state} · ${if(runtime.getString("actualAudioSource","") == "glasses") "眼镜" else "手机"}"
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
            releaseLivePreview(); liveUrl = url
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
    private fun matchesFilter(item: Item) = (sourceFilter == 0 || (sourceFilter == 2) == (item.entry.source == "glasses")) &&
        when(typeFilter) { 1 -> item.audio; 2 -> item.entry.kind == "video"; 3 -> item.location != null; else -> true }
    private fun load(older: Boolean? = null) {
        // Recover the capture writer before competing with it for tens of thousands of historical files.
        if(!archiveView && RabiConversationService.recoveringRecording()) { loadAfterRecovery = true; listStatus.text = "正在恢复记录…"; return }
        if(archiveView) {
            if(!RecordingArchiveReviewAccess.useRemoteHistory(archiveView,RecordingArchiveSession.load(context) != null)) {
                listStatus.text = "尚未配置电脑归档 · 全部本机记录仍可切换查看"
                configureArchive.visibility = View.VISIBLE
                archiveNext.visibility = View.GONE; emptyLabel.text = listStatus.text; emptyAction.text = "查看本机记录"; emptyAction.visibility = View.VISIBLE; return
            }
            if(typeFilter == 2 || typeFilter == 3) {
                items = emptyList(); renderRows(); archiveNext.visibility = View.GONE
                listStatus.text = "电脑归档仅提供录音 · 录像和位置请切换本机记录"; emptyLabel.text = listStatus.text; emptyAction.text = "查看本机记录"; emptyAction.visibility = View.VISIBLE; return
            }
            if(older == null) loadArchive(false)
            return
        }
        archiveAccess = null; archiveNext.visibility = View.GONE

        if(closed || (older == true && reachedOlder) || (older == false && reachedNewer)) return
        if(older != null && loading) return
        val boundary = if(older == null) null else if(older) displayedItems.lastOrNull() else displayedItems.firstOrNull()
        val bounds = RecordingDay.at(day)
        val requestedDay = day
        val boundaryTime = boundary?.entry?.started ?: if(older == false) bounds.start else bounds.until
        val boundaryId = boundary?.entry?.id ?: if(older == false) "" else "\uffff"
        val requestedFilter = sourceFilter
        val requestedType = typeFilter
        if(older == null) { reachedOlder = false; reachedNewer = false }
        if(loading) { reloadPending = true; return }
        val requestedRange = bounds.start..(bounds.until-1)
        failedOlder = older; queryFailed = false; emptyLabel.text = "正在读取记录…"; emptyAction.visibility = View.GONE; pageLoading.visibility = View.VISIBLE
        skeleton.visibility = if(items.isEmpty()) View.VISIBLE else View.GONE
        loading = true; lastLoad = System.currentTimeMillis(); val version = ++revision
        worker.execute {
            val result = runCatching {
                val store = RecordingStore(context)
                val video = (if(requestedType == 1 || requestedType == 3) emptyList() else store.page(boundaryTime,boundaryId,older != false,requestedFilter,true,bounds.start,bounds.until)).filter { it.kind == "video" && it.state != "recording" && it.files.isNotEmpty() }.flatMap { entry ->
                    if(entry.state == "legacy") entry.files.map { file -> entry.copy(id=file.name,files=listOf(file),started=file.lastModified(),state="legacy-part") } else listOf(entry)
                }.map { entry ->
                    val duration = entry.files.sumOf { file ->
                        val key = "${file.absolutePath}:${file.lastModified()}:${file.length()}"
                        durations[key] ?: runCatching { RecordingResourceCache.duration(context,file) }.getOrDefault(0L).also { if(it > 0) durations[key] = it }
                    }
                    Item(entry, runCatching { store.captureId(entry.id) }.getOrDefault(entry.id), listOf(ReviewTimeline.Span(entry.started,duration)),false)
                }
                val audio = if(requestedType == 2 || requestedType == 3) org.json.JSONArray() else RabiAudioRecordRepository.page(context,boundaryTime,boundaryId,older != false,requestedFilter,bounds.start,bounds.until)
                val sound = (0 until audio.length()).map { index ->
                    val row = audio.getJSONObject(index); val id = row.getString("captureId")
                    val spans = row.getJSONArray("playbackSpans")
                    Item(RecordingStore.Entry(row.getString("id"),"audio",row.optString("source"),row.optLong("startedAt"),row.optLong("endedAt"),"saved_segments",context.cacheDir,emptyList(),"录音事件"),
                        id,(0 until spans.length()).map { spans.getJSONObject(it).let { value -> ReviewTimeline.Span(value.getLong("startedAt"),value.getLong("durationMs"),value.getLong("offsetMs")) } },true,row.optString("parentCaptureId"),eventTranscript=row.optJSONObject("transcript"),asrState=row.optString("asrState"),policy=row.optString("processingPolicy"))
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
                loading = false; pageLoading.visibility = View.GONE
                if(closed) return@post
                if(version != revision) { if(reloadPending) { reloadPending = false; load() }; return@post }
                result.onSuccess { (savedMarkers, records) ->
                    markers = savedMarkers
                    if(requestedDay != day || requestedFilter != sourceFilter || requestedType != typeFilter) return@onSuccess
                    val matchingRecords = records.filter { bounds.contains(it.entry.started) }
                    if(older == null) {
                        val fresh = matchingRecords.take(100)
                        items = if(listDriving && items.isNotEmpty()) (items+fresh).associateBy { it.entry.id }.values
                            .sortedWith(compareByDescending<Item> { it.entry.started }.thenByDescending { it.entry.id }).take(1000) else fresh
                        reachedOlder = items.size <= 100 && matchingRecords.size <= 100
                        reachedNewer = true
                    }
                    else {
                        val ordered = matchingRecords.sortedWith(compareBy<Item> { it.entry.started }.thenBy { it.entry.id }).let { if(older) it.asReversed() else it }
                        val page = ordered.take(100)
                        val merged = (items + page).associateBy { it.entry.id }.values.sortedWith(compareByDescending<Item> { it.entry.started }.thenByDescending { it.entry.id })
                        items = if(older) merged.takeLast(1000) else merged.take(1000)
                        if(older) { reachedOlder = ordered.size <= 100; if(merged.size > 1000) reachedNewer = false }
                        else { reachedNewer = ordered.size <= 100; if(merged.size > 1000) reachedOlder = false }
                    }
                    listStatus.text = if(items.isEmpty()) "此时间范围暂无已保存记录" else "" + if(older == true && reachedOlder) " · 已到最早记录" else if(older == false && reachedNewer) " · 已到最新记录" else ""
                    renderRows()

                }.onFailure { queryFailed = true; listStatus.text = "记录读取失败 · 点击重试"; renderRows() }
                if(reloadPending) { reloadPending = false; main.postDelayed({ if(!closed) load() },1000) }
            }
        }
    }
    private fun loadArchive(next: Boolean) {
        if(closed || loading || next && archiveCursor == null) return
        loading = true; failedArchiveNext = next; queryFailed = false; pageLoading.visibility = View.VISIBLE; emptyAction.visibility = View.GONE; emptyLabel.text = "正在读取电脑归档…"
        skeleton.visibility = if(items.isEmpty()) View.VISIBLE else View.GONE
        val version = ++revision
        val requestedSource = sourceFilter
        val requestedType = typeFilter
        val pageCursor = if(next) archiveCursor else null
        val bounds = RecordingDay.at(day)
        val query = if(next) requireNotNull(archiveQuery) else RecordingArchiveRepository.Query(31, bounds.start, bounds.until-1,
            when(requestedSource) { 1 -> "phone"; 2 -> "glasses"; else -> null })
        if(!next) archiveQuery = query
        worker.execute {
            val result = runCatching {
                val access = requireNotNull(RecordingArchiveReviewAccess.load(context))
                access to access.repository.page(query,pageCursor)
            }
            main.post {
                loading = false; pageLoading.visibility = View.GONE
                if(closed) return@post
                if(version != revision) { if(reloadPending) { reloadPending = false; load() }; return@post }
                result.onSuccess { (access,page) ->
                    if(requestedSource != sourceFilter || requestedType != typeFilter) { load(); return@onSuccess }
                    archiveAccess = access
                    archiveStatus = page.status
                    archiveCursor = page.remoteCursor
                    fun item(row: RecordingArchiveRepository.Row): Item = Item(
                        RecordingStore.Entry(row.recordId,"audio",row.source,row.startedAt,row.endedAt,"archive",context.cacheDir,emptyList(),"电脑归档录音"),
                        row.captureId,listOf(ReviewTimeline.Span(row.startedAt,row.totalBytes*1000/32000)),true,
                        eventTranscript=if(row.asrState == "completed" || row.text.isNotEmpty()) JSONObject().put("text",row.text) else null,
                        asrState=row.asrState,archiveRow=row,policy=row.processingPolicy)
                    archivePending = if(!next) page.localPendingOverlay.map(::item) else emptyList()
                    items = archivePending + page.remoteItems.map(::item)
                    if(page.status == RecordingArchiveRepository.Status.STALE) { items = emptyList(); archivePending = emptyList(); archiveCursor = null }
                    listStatus.text = when(page.status) {
                        RecordingArchiveRepository.Status.STALE -> "目录已更新 · 点击刷新重新读取"
                        RecordingArchiveRepository.Status.UNKNOWN_OFFLINE -> "电脑不可达 · 此页历史未知（并非没有录音）"
                        RecordingArchiveRepository.Status.OFFLINE_CACHED -> "离线目录 · 上次同步 ${clock(page.lastSyncedAt)}"
                        else -> "电脑归档 ${page.remoteItems.size} 条 · 本页早→晚"
                    } + (if(!access.pendingAvailable) " · 待上传索引暂不可用" else if(next) " · 待上传预览见首页" else " · 待上传预览 ${archivePending.size} 条（仅最多32条索引，非完整列表）") + if(page.pendingTruncated) " · 预览已截断" else ""
                    archiveNext.visibility = if(page.status in setOf(RecordingArchiveRepository.Status.READY,RecordingArchiveRepository.Status.OFFLINE_CACHED)) View.VISIBLE else View.GONE
                    archiveNext.text = if(page.status == RecordingArchiveRepository.Status.OFFLINE_CACHED) "重新连接" else "下一页（早→晚）"
                    archiveNext.isEnabled = page.status == RecordingArchiveRepository.Status.OFFLINE_CACHED || archiveCursor != null
                    renderRows()
                }.onFailure { queryFailed = true; listStatus.text = "电脑历史读取失败 · 点击重试"; renderRows() }
                if(reloadPending) { reloadPending = false; load() }
            }
        }
    }
    private fun renderRows() {
        configureArchive.visibility = if(archiveView && RecordingArchiveSession.load(context) == null && !loading) View.VISIBLE else View.GONE
        localHistoryAction.visibility = if(archiveView && archiveStatus == RecordingArchiveRepository.Status.UNKNOWN_OFFLINE && !loading) View.VISIBLE else View.GONE
        skeleton.visibility = if(loading && items.isEmpty()) View.VISIBLE else View.GONE
        val anchor = displayedItems.getOrNull(scroll.firstVisiblePosition)?.entry?.id
        val offset = scroll.getChildAt(0)?.top ?: 0
        displayedItems = items.filter(::matchesFilter)
        emptyLabel.text = when {
            queryFailed -> "记录读取失败"
            loading -> "正在读取记录…"
            archiveView && listStatus.text.isNotBlank() -> listStatus.text
            typeFilter != 0 || sourceFilter != 0 -> "没有符合条件的记录"
            else -> "这一天暂无已保存记录"
        }
        emptyAction.text = when { queryFailed || archiveView && archiveStatus == RecordingArchiveRepository.Status.UNKNOWN_OFFLINE -> "重试"; archiveView && archiveStatus == RecordingArchiveRepository.Status.STALE -> "刷新目录"; archiveView -> "查看本机记录"; else -> "清除筛选" }
        emptyAction.visibility = if(!loading && (queryFailed || archiveView || typeFilter != 0 || sourceFilter != 0)) View.VISIBLE else View.GONE
        scroll.background = if(displayedItems.isEmpty()) null else RabiMobileUi.panel(context,RabiMobileUi.surface,Color.TRANSPARENT,14)
        cards.clear()
        programmaticScroll = true
        rowAdapter.notifyDataSetChanged()
        val restored = RecordingListPosition.restore(displayedItems.map { it.entry.id },anchor,selected?.entry?.id,listDriving)
        val index = if(restored >= 0) restored else if(!listDriving) displayedItems.indexOfFirst { ReviewTimeline.mediaAt(it.spans,cursor) != null } else -1
        if(index >= 0) scroll.setSelectionFromTop(index, if(listDriving) offset else 0)
        scroll.post { programmaticScroll = false; selected?.let { highlight(it.entry.id) } }
    }
    private fun bindCard(item: Item, recycled: View?): View {
            val entry = item.entry
            val card = (recycled as? LinearLayout ?: LinearLayout(context)).apply {
                (tag as? String)?.let { cards.remove(it) }; tag = entry.id; removeAllViews()
                orientation = LinearLayout.VERTICAL; gravity = Gravity.CENTER_VERTICAL; minimumHeight = dp(64); setPadding(dp(12),dp(10),dp(10),dp(10))
                background = GradientDrawable().apply { setColor(RabiMobileUi.surface); cornerRadius = dp(16).toFloat() }
                layoutParams = AbsListView.LayoutParams(-1,-2)
                foreground = android.graphics.drawable.RippleDrawable(android.content.res.ColorStateList.valueOf(RabiMobileUi.accentBorder),null,RabiMobileUi.panel(context,Color.WHITE,Color.WHITE,16))
                isClickable = true; setOnClickListener { listDriving = true; dragging = false; open(item,entry.started); renderRows() }
            }
            cards[entry.id] = card
            val heading = LinearLayout(context).apply { gravity = Gravity.CENTER_VERTICAL }
            heading.addView(FrameLayout(context).apply {
                background = RabiMobileUi.panel(context,RabiMobileUi.accentSurface,Color.TRANSPARENT,24)
                addView(RabiMobileUi.icon(context,when(entry.kind) { "video" -> com.rabi.link.R.drawable.ic_ui_video; "location" -> com.rabi.link.R.drawable.ic_ui_pin; else -> com.rabi.link.R.drawable.ic_ui_mic },RabiMobileUi.secondary),FrameLayout.LayoutParams(dp(28),dp(28),Gravity.CENTER))
            },LinearLayout.LayoutParams(dp(36),dp(36)).apply { marginEnd = dp(10) })
            val seconds = item.spans.sumOf { it.duration } / 1000
            val duration = if(seconds <= 0) "时长待读取" else if(seconds >= 60) "${seconds/60}分${seconds%60}秒" else "${seconds}秒"
            heading.addView(LinearLayout(context).apply {
                orientation = LinearLayout.VERTICAL
                val kind = when(entry.kind) { "video" -> "录像"; "location" -> "位置"; else -> "录音" }
                addView(label("${SimpleDateFormat("HH:mm:ss",Locale.CHINA).format(Date(entry.started))} · $kind",15f).apply { typeface = android.graphics.Typeface.DEFAULT_BOLD; setPadding(0,0,0,dp(3)) })
                addView(label(item.location?.let { "${it.address.ifBlank { "地点名称未查询" }} · 精度约 ${it.point.accuracy.toInt()} 米" } ?: "$duration · ${if(entry.source == "glasses") "眼镜" else "手机"}",13f).apply { maxLines = 2; ellipsize = android.text.TextUtils.TruncateAt.END; setTextColor(RabiMobileUi.muted); setPadding(0,0,0,0) })
            },LinearLayout.LayoutParams(0,-2,1f))
            val playing = selected?.entry?.id == entry.id && player?.state()?.playing == true
            val cachedMetadataOnly = item.archiveRow?.archived == true && archiveStatus == RecordingArchiveRepository.Status.OFFLINE_CACHED
            heading.addView(RabiMobileUi.iconAction(context,if(item.location != null || cachedMetadataOnly) com.rabi.link.R.drawable.ic_ui_chevron else if(playing) com.rabi.link.R.drawable.ic_ui_pause else com.rabi.link.R.drawable.ic_ui_play,if(playing) "暂停 ${clock(entry.started)} 的记录" else "回看 ${clock(entry.started)} 的记录") {
                listDriving = true; dragging = false
                if(playing) player?.setPlaying(false) else open(item,entry.started,item.location == null && !cachedMetadataOnly)
                renderRows()
            }.apply {
                imageTintList = android.content.res.ColorStateList.valueOf(RabiMobileUi.secondary)
                setPadding(dp(14),dp(14),dp(14),dp(14))
                background = android.graphics.drawable.RippleDrawable(android.content.res.ColorStateList.valueOf(RabiMobileUi.accentBorder),
                    android.graphics.drawable.InsetDrawable(RabiMobileUi.panel(context,RabiMobileUi.accentSurface,Color.TRANSPARENT,24),dp(6)),null)
            },LinearLayout.LayoutParams(dp(48),dp(48)))
            card.addView(heading)
            val transcript = item.eventTranscript?.optString("text").orEmpty().trim()
            if(transcript.isNotBlank()) card.addView(label(transcript,14f).apply {
                maxLines = 2; ellipsize = android.text.TextUtils.TruncateAt.END; setPadding(dp(46),dp(4),0,0)
            })
            if(item.audio && transcript.isBlank()) card.addView(label(recordingTranscriptStatus(item.policy,item.asrState,item.eventTranscript != null,transcript),12f).apply {
                setTextColor(RabiMobileUi.muted); setPadding(dp(46),dp(3),0,0)
            })
            if(archiveView && item.entry.id == displayedItems.firstOrNull { it.archiveRow?.archived == false }?.entry?.id) card.addView(label("待上传预览 · 非全部记录",12f),0)
            if(archiveView && item.entry.id == displayedItems.firstOrNull { it.archiveRow?.archived == true }?.entry?.id) card.addView(label("电脑归档 · 本页早→晚",12f),0)
            if(item.archiveRow?.uploadState in setOf("blocked_missing_media","blocked")) {
                card.addView(label("归档受阻 · 记录已保留",12f).apply { setTextColor(RabiMobileUi.warning) })
            } else if(item.asrState in setOf("blocked","failed","ambiguous")) {
                card.addView(label("转写待核对 · 原音频已保留",12f).apply { setTextColor(RabiMobileUi.warning) })
            }
        return card
    }
    private fun open(item: Item, at: Long, play: Boolean = false) {
        if(item.archiveRow?.uploadState == "blocked_missing_media") {
            Toast.makeText(context,"本地音频不完整，记录保留等待核对",Toast.LENGTH_SHORT).show(); return
        }
        enterHistory()
        showRecordDialog(item)
        showControls(true)
        val time = at
        val offset = ReviewTimeline.mediaAt(item.spans,time) ?: 0L
        replayOffset = offset
        cursor = time
        if(play) playbackState = playbackState.copy(playing=true)
        if(selected?.entry?.id == item.entry.id && player != null) { player?.seekTo(offset); if(play) player?.setPlaying(true); return }
        if(selected?.entry?.id == item.entry.id && loadingSelection) return
        selected = item; val ticket = ++selection; releasePlayback(); showPlaybackEmpty("正在缓冲…"); highlight(item.entry.id)
        loadingSelection = true
        if(play) playbackState = playbackState.copy(playing=true)
        item.location?.let {
            loadingSelection = false
            showPlaybackEmpty(locationDescription(it))
            return
        }
        if(item.archiveRow?.archived == true) { openArchive(item,ticket,offset); return }
        mediaWorker.execute {
            val result = runCatching { if(item.audio) RabiConversationService.pinLocalEvents(listOf(item.entry.id)).use { item.entry.copy(files=listOf(RabiAudioRecordRepository.exportCaptureWave(context,item.entry.id))) } else item.entry.copy(files=item.entry.files.map { RecordingResourceCache.materialize(context,it) }) }
            main.post {
                if(closed || ticket != selection || live) return@post
                loadingSelection = false
                result.onSuccess { entry ->
                    playbackPreview?.removeAllViews()
                    player = RecordingPlaybackPanel(context,entry.files,entry.kind == "video",ReviewTimeline.mediaAt(item.spans,cursor) ?: offset, playbackState.copy(controlsVisible=controlsVisible), { share(entry) }) { mediaPosition ->
                        replayOffset = mediaPosition
                    }.also {
                        it.onRetry = { retryPlayback(item) }
                        it.onControlsVisibilityChanged = ::showControls
                        it.onPlaybackChanged = { if(!closed && selected?.entry?.id == entry.id) renderRows() }
                        playbackPreview?.addView(it.view,FrameLayout.LayoutParams(-1,-1))
                    }
                }.onFailure {
                    playbackFailure(item,it.message ?: "媒体不可用"); renderRows()
                }
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
                loadingSelection = false
                result.onSuccess { source ->
                    playbackPreview?.removeAllViews()
                    player = RecordingPlaybackPanel(context,emptyList(),false,offset,playbackState.copy(controlsVisible=controlsVisible),
                        { Toast.makeText(context,"远端原件保留在电脑，分享需显式导出",Toast.LENGTH_SHORT).show() },source,row.totalBytes*1000/32000) { mediaPosition ->
                        replayOffset = mediaPosition
                    }.also {
                        it.onRetry = { retryPlayback(item) }
                        it.onControlsVisibilityChanged = ::showControls
                        it.onPlaybackChanged = { if(!closed && selected?.entry?.id == item.entry.id) renderRows() }
                        playbackPreview?.addView(it.view,FrameLayout.LayoutParams(-1,-1))
                    }
                }.onFailure {
                    playbackFailure(item,"电脑录音暂不可播放，请检查连接后重试"); renderRows()
                }
            }
        }
    }
    private fun highlight(id: String?) { cards.forEach { (key, card) -> card.background = com.rabi.link.RabiMobileUi.panel(context,if(key == id) RabiMobileUi.accentSurface else RabiMobileUi.surface,if(key == id) RabiMobileUi.accentBorder else Color.TRANSPARENT,if(key == id) 12 else 0) } }
    fun close() { if(view.viewTreeObserver.isAlive) view.viewTreeObserver.removeOnGlobalLayoutListener(afterHistoryLayout); collapseAnimation?.removeAllListeners(); collapseAnimation?.cancel(); closed = true; revision++; selection++; recordDialog?.dismiss(); releasePlayback(); releaseLivePreview(); main.removeCallbacksAndMessages(null); worker.shutdown(); mediaWorker.shutdown() }
}
