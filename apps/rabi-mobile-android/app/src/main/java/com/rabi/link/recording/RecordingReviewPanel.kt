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
    private data class Item(val entry: RecordingStore.Entry, val captureId: String, val spans: List<ReviewTimeline.Span>, val audio: Boolean, val parentCaptureId: String = "", val associatedIds: Set<String> = setOf(captureId), val eventTranscript: org.json.JSONObject? = null, val asrState: String = "")
    val view = LinearLayout(context).apply { orientation = LinearLayout.VERTICAL }
    private val main = Handler(Looper.getMainLooper())
    private val worker = Executors.newSingleThreadExecutor()
    // Every preview state occupies the same bounds, so selecting an event never moves the ruler.
    private val preview = FrameLayout(context)
    private val previewStage = object : FrameLayout(context) {
        init { contentDescription = "记录预览" }
        override fun onMeasure(widthSpec: Int, heightSpec: Int) {
            val preferredHeight = View.MeasureSpec.getSize(widthSpec)*9/16
            val height = if(View.MeasureSpec.getMode(heightSpec) == View.MeasureSpec.UNSPECIFIED) preferredHeight
                else minOf(preferredHeight, View.MeasureSpec.getSize(heightSpec))
            super.onMeasure(widthSpec,View.MeasureSpec.makeMeasureSpec(height,View.MeasureSpec.EXACTLY))
        }
    }
    private var controlsVisible = false
    private var header: View? = null
    private val liveTap = View(context).apply {
        contentDescription = "显示或隐藏记录控制"; setOnClickListener { showControls(!controlsVisible) }
    }
    fun attachHeader(value: LinearLayout) {
        value.removeViewAt(0)
        value.addView(position,0,LinearLayout.LayoutParams(0,-1,1f))
        fun style(v: View) {
            if(v is TextView) { v.setTextColor(Color.WHITE); v.setShadowLayer(dp(2).toFloat(),0f,0f,Color.BLACK) }
            if(v is android.view.ViewGroup) for(i in 0 until v.childCount) style(v.getChildAt(i))
        }
        style(value)
        header = value; previewStage.addView(value,FrameLayout.LayoutParams(-1,dp(52),Gravity.TOP)); showControls(controlsVisible)
    }
    private fun showControls(shown: Boolean) {
        controlsVisible = shown
        ruler.visibility = View.VISIBLE
        header?.visibility = if(shown) View.VISIBLE else View.GONE
        position.visibility = if(shown) View.VISIBLE else View.GONE
        if(player?.state()?.controlsVisible != shown) player?.setControls(shown)
    }
    private val position = label("实时", 12f)
    private val dayButton = RabiMobileUi.compactAction(context, "选择日期") {}
    private val ruler = RecordingTimeRuler(context)
    private val reviewColumn = LinearLayout(context).apply { orientation = LinearLayout.VERTICAL }
    private val eventColumn = LinearLayout(context).apply { orientation = LinearLayout.VERTICAL }
    private val listStatus = label("正在读取记录…", 12f)
    private val scroll = ListView(context).apply { divider = null; dividerHeight = dp(10); setPadding(dp(12),0,dp(12),dp(12)); clipToPadding = false }
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
        position.gravity = Gravity.CENTER_VERTICAL
        position.maxLines = 2
        position.visibility = View.GONE
        reviewColumn.addView(previewStage,LinearLayout.LayoutParams(-1,-2))
        reviewColumn.addView(ruler,LinearLayout.LayoutParams(-1,dp(64)))
        val navigation = LinearLayout(context).apply {
            gravity = Gravity.CENTER_VERTICAL
            setPadding(dp(12), 0, dp(12), 0)
        }
        dayButton.textSize = 13f
        dayButton.setBackgroundColor(android.graphics.Color.TRANSPARENT)
        navigation.addView(dayButton, LinearLayout.LayoutParams(-2,dp(48)))
        navigation.addView(RabiMobileUi.compactAction(context, "‹") { adjacent(true) }.apply { contentDescription = "上一个事件" }, LinearLayout.LayoutParams(dp(48),dp(48)))
        navigation.addView(RabiMobileUi.compactAction(context, "›") { adjacent(false) }.apply { contentDescription = "下一个事件" }, LinearLayout.LayoutParams(dp(48),dp(48)))
        navigation.addView(RabiMobileUi.compactAction(context, "回到实时") { enterLive() },
            LinearLayout.LayoutParams(-2, dp(48)).apply { marginStart = dp(4) })
        navigation.addView(RabiMobileUi.compactAction(context, "刷新") { load() }.apply {
            contentDescription = "刷新记录和转写"
        }, LinearLayout.LayoutParams(-2, dp(48)).apply { marginStart = dp(4) })
        for(i in 1 until navigation.childCount) (navigation.getChildAt(i) as? TextView)?.apply {
            textSize = 13f; setBackgroundColor(android.graphics.Color.TRANSPARENT)
        }
        eventColumn.addView(HorizontalScrollView(context).apply { isHorizontalScrollBarEnabled = false; addView(navigation) })
        eventColumn.addView(Spinner(context).apply {
            adapter = ArrayAdapter(context,android.R.layout.simple_spinner_dropdown_item,listOf("全部类型","ASR 事件","录像"))
            contentDescription = "筛选事件类型"
            onItemSelectedListener = object : AdapterView.OnItemSelectedListener {
                override fun onNothingSelected(parent: AdapterView<*>?) = Unit
                override fun onItemSelected(parent: AdapterView<*>?, view: View?, position: Int, id: Long) { if(typeFilter != position) { typeFilter = position; renderRows(); load() } }
            }
        },LinearLayout.LayoutParams(-1,dp(48)))
        eventColumn.addView(Spinner(context).apply {
            adapter = ArrayAdapter(context,android.R.layout.simple_spinner_dropdown_item,listOf("全部来源","手机","眼镜"))
            contentDescription = "筛选记录来源"
            onItemSelectedListener = object : AdapterView.OnItemSelectedListener {
                override fun onNothingSelected(parent: AdapterView<*>?) = Unit
                override fun onItemSelected(parent: AdapterView<*>?, view: View?, position: Int, id: Long) { if(sourceFilter != position) { sourceFilter = position; renderRows(); load() } }
            }
        },LinearLayout.LayoutParams(-1,dp(48)))
        eventColumn.addView(listStatus)
        listStatus.setOnClickListener { listDriving = true; live = false; load(true) }
        scroll.adapter = rowAdapter
        eventColumn.addView(scroll, LinearLayout.LayoutParams(-1,0,1f))
        val wide = context.resources.configuration.screenWidthDp >= 700
        if(wide) previewStage.layoutParams = LinearLayout.LayoutParams(-1,0,1f)
        view.orientation = if(wide) LinearLayout.HORIZONTAL else LinearLayout.VERTICAL
        view.addView(reviewColumn, if(wide) LinearLayout.LayoutParams(0,-1,3f) else LinearLayout.LayoutParams(-1,-2))
        view.addView(eventColumn, if(wide) LinearLayout.LayoutParams(0,-1,2f) else LinearLayout.LayoutParams(-1,0,1f))
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
        updateRange(); showEmpty("实时 · 无画面"); load(); refreshLive(); main.postDelayed(liveTick,1000)
    }
    private fun dp(value: Int) = (context.resources.displayMetrics.density * value).toInt()
    private fun label(text: String, size: Float = 14f) = TextView(context).apply {
        this.text = text; textSize = size; setTextColor(RabiMobileUi.primary); setPadding(dp(12),dp(5),dp(12),dp(5))
    }
    private fun midnight(time: Long) = Calendar.getInstance().apply { timeInMillis = time; set(Calendar.HOUR_OF_DAY,0); set(Calendar.MINUTE,0); set(Calendar.SECOND,0); set(Calendar.MILLISECOND,0) }.timeInMillis
    private fun updateRange() { day = midnight(cursor); dayButton.text = SimpleDateFormat("M月d日",Locale.CHINA).format(Date(day)) }
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
    private fun releasePlayback() { player?.let { playbackState = it.state(); it.close() }; player = null; livePlayer?.release(); livePlayer = null; liveUrl = ""; liveWaveform = null; liveTap.visibility = View.VISIBLE; preview.removeAllViews() }
    private fun showEmpty(message: String) {
        liveWaveform = null
        preview.removeAllViews()
        preview.addView(label(message, 18f).apply { gravity = Gravity.CENTER; setTextColor(Color.LTGRAY); setBackgroundColor(Color.rgb(25,29,34)) },FrameLayout.LayoutParams(-1,-1))
    }
    private fun enterLive() {
        ruler.cancelGesture(); listDriving = false; dragging = false; live = true; cursor = System.currentTimeMillis(); selected = null; selection++
        releasePlayback(); playbackState = RecordingPlaybackPanel.State(); ruler.setPosition(cursor,true); updateRange(); load(); refreshLive()
    }
    /** Called only while visible, from the owner's runtime events; history playback is not reset. */
    fun refreshLive() {
        if(closed || dragging) return
        if(!live) {
            refreshChangedData()
            return
        }
        cursor = System.currentTimeMillis(); ruler.setPosition(cursor,true); updateRange()
        val runtime = context.getSharedPreferences("rabi_conversation_runtime",Context.MODE_PRIVATE)
        val last = runtime.getLong("captureLastReceivedAt",0)
        val recent = AllDayRecordingSettings.load(context).running && System.currentTimeMillis() - last < 5000
        position.text = "实时 · ${clock(System.currentTimeMillis())}"
        val video = RabiConversationService.currentVideo()
        val url = if(video?.receiving == true) video.previewUrl else ""
        if(url.isBlank()) {
            if(livePlayer != null) releasePlayback()
            if(recent) {
                if(liveWaveform == null) {
                    preview.removeAllViews()
                    liveWaveform = AudioWaveformView(context,true).also { preview.addView(it,FrameLayout.LayoutParams(-1,-1).apply { bottomMargin = dp(64) }) }
                }
                liveWaveform?.state = if(runtime.getBoolean("captureHasSignal",false)) "正在收音" else "收到静音"
            } else if(liveWaveform != null || preview.childCount == 0) showEmpty("无画面 · 等待声音")
        } else if(url != liveUrl) {
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
        val runtime = context.getSharedPreferences("rabi_conversation_runtime",Context.MODE_PRIVATE)
        val signal = "${runtime.getLong("captureLastReceivedAt",0)}:${runtime.getString("allDayStatus","")}:${File(context.filesDir,"rabi-conversation/audio-spool").lastModified()}"
        if(signal != lastDataSignal) reachedNewer = false
        if(!listDriving && signal != lastDataSignal && System.currentTimeMillis() - lastLoad >= 5000) { lastDataSignal = signal; load() }
    }
    private fun adjacent(older: Boolean) {
        if(loading || navigating || closed) return
        ruler.cancelGesture(); listDriving = false; dragging = false; live = false
        load(older,true)
    }
    private fun matchesFilter(item: Item) = (sourceFilter == 0 || (sourceFilter == 2) == (item.entry.source == "glasses")) && (typeFilter == 0 || (typeFilter == 1) == item.audio)
    private fun load(older: Boolean? = null, adjacent: Boolean = false) {
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
        loading = true; listStatus.text = if(items.isEmpty()) "正在读取记录…" else "正在更新…"; lastLoad = System.currentTimeMillis(); val version = ++revision
        worker.execute {
            val result = runCatching {
                val store = RecordingStore(context)
                val video = (if(requestedType == 1) emptyList() else if(older == null) store.list(requestedRange.first, requestedRange.last) else store.page(boundaryTime,boundaryId,older,requestedFilter,true)).filter { it.kind == "video" && it.state != "recording" && it.files.isNotEmpty() }.flatMap { entry ->
                    if(entry.state == "legacy") entry.files.map { file -> entry.copy(id=file.name,files=listOf(file),started=file.lastModified(),state="legacy-part") } else listOf(entry)
                }.map { entry ->
                    val duration = entry.files.sumOf { file ->
                        val key = "${file.absolutePath}:${file.lastModified()}:${file.length()}"
                        durations[key] ?: runCatching { RecordingResourceCache.duration(context,file) }.getOrDefault(0L).also { if(it > 0) durations[key] = it }
                    }
                    Item(entry, runCatching { store.captureId(entry.id) }.getOrDefault(entry.id), listOf(ReviewTimeline.Span(entry.started,duration)),false)
                }
                val audio = if(requestedType == 2) org.json.JSONArray() else if(older == null) RabiAudioRecordRepository.listAsrRecords(context,requestedRange.first,requestedRange.last) else RabiAudioRecordRepository.page(context,boundaryTime,boundaryId,older,requestedFilter,true)
                val sound = (0 until audio.length()).map { index ->
                    val row = audio.getJSONObject(index); val id = row.getString("captureId")
                    val spans = row.getJSONArray("playbackSpans")
                    Item(RecordingStore.Entry(row.getString("id"),"audio",row.optString("source"),row.optLong("startedAt"),row.optLong("endedAt"),"saved_segments",context.cacheDir,emptyList(),"ASR 事件"),
                        id,(0 until spans.length()).map { spans.getJSONObject(it).let { value -> ReviewTimeline.Span(value.getLong("startedAt"),value.getLong("durationMs"),value.getLong("offsetMs")) } },true,row.optString("parentCaptureId"),eventTranscript=row.optJSONObject("transcript"),asrState=row.optString("asrState"))
                }
                val combined = video.map { item -> item.copy(associatedIds = setOf(item.captureId) + sound.filter { it.parentCaptureId == item.captureId }.map { it.captureId }) }
                val savedMarkers = store.listMarkers()
                Pair(savedMarkers, (combined + sound).sortedByDescending { it.entry.started })
            }
            main.post {
                loading = false; navigating = false
                if(closed || version != revision) return@post
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
                    listStatus.text = if(items.isEmpty()) "此时间范围暂无已保存记录" else "${items.size} 条事件" + if(older == true && reachedOlder) " · 已到最早记录" else if(older == false && reachedNewer) " · 已到最新记录" else ""
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
    private fun renderRows() {
        val anchor = displayedItems.getOrNull(scroll.firstVisiblePosition)?.entry?.id
        val offset = scroll.getChildAt(0)?.top ?: 0
        displayedItems = items.filter(::matchesFilter)
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
                orientation = LinearLayout.VERTICAL; setPadding(dp(8),dp(8),dp(8),dp(8))
                background = GradientDrawable().apply { setColor(RabiMobileUi.surface); cornerRadius = dp(16).toFloat() }
                layoutParams = AbsListView.LayoutParams(-1,-2)
                isClickable = true; setOnClickListener { ruler.cancelGesture(); listDriving = false; dragging = false; open(item,entry.started); renderRows() }
            }
            cards[entry.id] = card
            val heading = LinearLayout(context)
            heading.addView(label("${clock(entry.started)} · ${if(entry.kind == "video") "录像" else "ASR 事件"} · ${if(entry.source == "glasses") "眼镜" else "手机"}",14f),LinearLayout.LayoutParams(0,-2,1f))
            if(entry.kind == "video") {
                val image = ImageView(context).apply { scaleType = ImageView.ScaleType.CENTER_CROP; contentDescription = "录像缩略图，点击回看" }
                heading.addView(image,LinearLayout.LayoutParams(dp(94),dp(65)))
                thumbnail(entry.files.first(),image)
            }
            card.addView(heading)
            item.eventTranscript?.let { receipt ->
                val text = receipt.optString("text").trim()
                if(text.isNotEmpty()) card.addView(label(text,17f))
                else card.addView(label("未识别到语音",12f))
            }
            if(item.eventTranscript == null) {
                val status = when(item.asrState) {
                    "processing" -> "转录中…"
                    "pending" -> "待转录"
                    "retry" -> "转录暂未完成 · 等待重试"
                    "local_only" -> "仅本地保存 · 未转录"
                    else -> ""
                }
                if(status.isNotBlank()) card.addView(label(status,13f).apply { setTextColor(RabiMobileUi.muted) })
            }
            card.addView(label("${item.spans.sumOf { it.duration } / 1000} 秒 · ${if(selected?.entry?.id == entry.id) "回看中" else "点击回看"}",12f).apply { setTextColor(RabiMobileUi.muted) })
            markers.filter { (it.recordId in item.associatedIds || it.recordId == entry.id) }.forEach { marker ->
                card.addView(Button(context).apply { text = "标记 · ${clock(marker.at)}"; setOnClickListener { jump(marker.at) } })
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
        live = false
        val time = at
        val offset = ReviewTimeline.mediaAt(item.spans,time) ?: 0L
        cursor = time; ruler.setPosition(time,false); updateRange(); ensureRange()
        position.text = "回看 · ${clock(time)}"
        if(selected?.entry?.id == item.entry.id && player != null) { player?.seekTo(offset); return }
        if(selected?.entry?.id == item.entry.id && player == null) return
        selected = item; val ticket = ++selection; releasePlayback(); showEmpty("正在缓冲…"); highlight(item.entry.id)
        mediaWorker.execute {
            val result = runCatching { if(item.audio) item.entry.copy(files=listOf(RabiAudioRecordRepository.exportCaptureWave(context,item.entry.id))) else item.entry.copy(files=item.entry.files.map { RecordingResourceCache.materialize(context,it) }) }
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
    private fun highlight(id: String?) { cards.forEach { (key, card) -> card.background = com.rabi.link.RabiMobileUi.panel(context,if(key == id) RabiMobileUi.accentSurface else RabiMobileUi.surface,if(key == id) RabiMobileUi.accentBorder else RabiMobileUi.border,16) } }
    fun close() { closed = true; revision++; selection++; releasePlayback(); main.removeCallbacksAndMessages(null); ruler.cancelGesture(); worker.shutdown(); mediaWorker.shutdown(); thumbnailWorker.shutdown(); images.evictAll() }
}
