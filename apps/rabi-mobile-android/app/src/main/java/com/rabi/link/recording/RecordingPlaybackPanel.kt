package com.rabi.link.recording

import android.content.Context
import android.net.Uri
import android.os.Handler
import android.os.Looper
import android.view.Gravity
import android.view.View
import android.widget.*
import androidx.media3.common.MediaItem
import androidx.media3.common.Player
import androidx.media3.common.PlaybackException
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.ui.PlayerView
import com.rabi.link.R
import com.rabi.link.RabiMobileUi
import java.io.File
import java.util.Locale
import java.util.concurrent.Executors

/** One player owns the media, playback intent and seek position. Capture is owned elsewhere. */
@androidx.annotation.OptIn(androidx.media3.common.util.UnstableApi::class)
class RecordingPlaybackPanel(private val context: Context, files: List<File>, private val video: Boolean,
    initialPosition: Long = 0, private val initialState: State = State(), private val onShare: () -> Unit = {},
    private val remoteSource: androidx.media3.exoplayer.source.MediaSource? = null, private val remoteDurationMs: Long = 0,
    private val onPosition: (Long) -> Unit = {}) {
    data class State(val playing: Boolean = false, val controlsVisible: Boolean = false, val speed: Float = 1f)
    private val main = Handler(Looper.getMainLooper())
    private val worker = Executors.newSingleThreadExecutor()
    private val player = ExoPlayer.Builder(context).build()
    val view = FrameLayout(context)
    private fun dp(value: Int) = RabiMobileUi.dp(context,value)
    private val picture = if(video) PlayerView(context).apply { useController = false; player = this@RecordingPlaybackPanel.player } else null
    private val waveform = if(!video) AudioWaveformView(context,compact = true) else null
    private val overlay = LinearLayout(context).apply {
        orientation = LinearLayout.VERTICAL; setPadding(dp(8),0,dp(8),0)
        setBackgroundColor(RabiMobileUi.surface)
    }
    private val status = TextView(context).apply {
        text = "正在读取媒体…"; textSize = 12f; setTextColor(RabiMobileUi.muted)
        gravity = Gravity.CENTER; maxLines = 2
    }
    private val elapsed = TextView(context).apply { text = "00:00"; textSize = 12f; setTextColor(RabiMobileUi.text) }
    private val total = TextView(context).apply { text = "--:--"; textSize = 12f; setTextColor(RabiMobileUi.text) }
    private val seek = SeekBar(context).apply {
        max = 10000; isEnabled = false; contentDescription = "历史回放进度"
        progressTintList = android.content.res.ColorStateList.valueOf(RabiMobileUi.secondary)
        thumbTintList = android.content.res.ColorStateList.valueOf(RabiMobileUi.secondary)
    }
    private val play = RabiMobileUi.iconAction(context,R.drawable.ic_ui_play,"播放历史记录") {}.apply { isEnabled = false }
    private val errorPanel = LinearLayout(context).apply {
        orientation = LinearLayout.VERTICAL; gravity = Gravity.CENTER; setPadding(dp(12),dp(8),dp(12),dp(8))
        setBackgroundColor(RabiMobileUi.surface); visibility = View.GONE
    }
    private val errorText = TextView(context).apply { textSize = 14f; setTextColor(RabiMobileUi.error); gravity = Gravity.CENTER; maxLines = 3 }
    private var durations = emptyList<Long>()
    private var pendingPosition = initialPosition
    private var closed = false
    private var seeking = false
    private var failed = false
    var onControlsVisibilityChanged: (Boolean) -> Unit = {}
    var onPlaybackChanged: () -> Unit = {}
    var onRetry: () -> Unit = { failed = false; errorPanel.visibility = View.GONE; player.prepare() }
    private fun replayRequested() = player.playWhenReady && player.playbackState != Player.STATE_ENDED
    fun state() = State(replayRequested(),overlay.visibility == View.VISIBLE,player.playbackParameters.speed)
    fun setPlaying(playing: Boolean) {
        if(playing) { if(player.playbackState == Player.STATE_ENDED) seekTo(0); player.play() } else player.pause()
        setControls(true)
    }
    private val hideControls = Runnable { if(video && player.isPlaying && !seeking && !failed) setControls(false) }
    fun holdControls() { main.removeCallbacks(hideControls) }
    fun setControls(shown: Boolean) {
        val visible = shown || !video || failed
        overlay.visibility = if(visible) View.VISIBLE else View.GONE
        onControlsVisibilityChanged(visible)
        holdControls()
        if(visible && video && player.isPlaying && !seeking && !(context.getSystemService(Context.ACCESSIBILITY_SERVICE) as android.view.accessibility.AccessibilityManager).isTouchExplorationEnabled)
            main.postDelayed(hideControls,3500)
    }
    private fun fail(message: String) {
        if(closed) return
        failed = true; holdControls(); play.isEnabled = false; seek.isEnabled = false
        errorText.text = "无法播放这条记录\n" + message
        errorPanel.visibility = View.VISIBLE; setControls(true)
    }
    private val tick = object : Runnable {
        override fun run() {
            if(closed) return
            if(!failed && durations.isNotEmpty()) {
                val position = durations.take(player.currentMediaItemIndex.coerceAtLeast(0)).sum()+player.currentPosition
                val length = durations.sum().coerceAtLeast(1)
                if(!seeking) { elapsed.text = clock(position); seek.progress = ((position.coerceIn(0,length)*10000)/length).toInt() }
                total.text = clock(length); waveform?.progress = position.toFloat()/length
                onPosition(position)
                status.text = when(player.playbackState) {
                    Player.STATE_BUFFERING -> "正在缓冲…"
                    Player.STATE_ENDED -> "播放结束"
                    Player.STATE_IDLE -> "正在准备…"
                    else -> if(player.isPlaying) "" else "已暂停"
                }
                play.setImageResource(if(replayRequested()) R.drawable.ic_ui_pause else R.drawable.ic_ui_play)
                play.contentDescription = if(replayRequested()) "暂停历史记录" else "播放历史记录"
            }
            main.postDelayed(this,250)
        }
    }
    init {
        view.setBackgroundColor(RabiMobileUi.accentSurface)
        waveform?.let { view.addView(it,FrameLayout.LayoutParams(-1,-1).apply { bottomMargin = dp(82) }) }
        picture?.let { view.addView(it,FrameLayout.LayoutParams(-1,-1)) }
        view.addView(View(context).apply {
            contentDescription = "显示或隐藏播放控制"
            setOnClickListener { setControls(this@RecordingPlaybackPanel.overlay.visibility != View.VISIBLE) }
        },FrameLayout.LayoutParams(-1,-1).apply { bottomMargin = dp(72) })
        overlay.addView(status,LinearLayout.LayoutParams(-1,dp(24)))
        val controls = LinearLayout(context).apply { gravity = Gravity.CENTER_VERTICAL }
        controls.addView(play,LinearLayout.LayoutParams(dp(44),dp(48)))
        controls.addView(elapsed)
        controls.addView(seek,LinearLayout.LayoutParams(0,dp(48),1f))
        controls.addView(total)
        val more = RabiMobileUi.iconAction(context,R.drawable.ic_ui_more,"回放更多操作") {}
        more.setOnClickListener {
            holdControls()
            PopupMenu(context,more).apply {
                menu.add("后退3秒"); menu.add("前进3秒"); menu.add("播放速度 ${player.playbackParameters.speed}×"); menu.add("分享原始记录")
                setOnMenuItemClickListener {
                    when {
                        it.title == "后退3秒" -> seekBy(-3000)
                        it.title == "前进3秒" -> seekBy(3000)
                        it.title.toString().startsWith("播放速度") -> player.setPlaybackSpeed(if(player.playbackParameters.speed < 1.5f) 1.5f else if(player.playbackParameters.speed < 2f) 2f else 1f)
                        else -> onShare()
                    }; true
                }
                setOnDismissListener { setControls(true) }; show()
            }
        }
        controls.addView(more,LinearLayout.LayoutParams(dp(36),dp(48)))
        overlay.addView(controls)
        view.addView(overlay,FrameLayout.LayoutParams(-1,-2,Gravity.BOTTOM))
        errorPanel.addView(errorText)
        errorPanel.addView(RabiMobileUi.compactAction(context,"重试") { onRetry() },LinearLayout.LayoutParams(-2,dp(48)))
        view.addView(errorPanel,FrameLayout.LayoutParams(-1,-1))
        play.setOnClickListener { setPlaying(!replayRequested()) }
        seek.setOnSeekBarChangeListener(object : SeekBar.OnSeekBarChangeListener {
            override fun onStartTrackingTouch(bar: SeekBar) { seeking = true; holdControls() }
            override fun onProgressChanged(bar: SeekBar,value: Int,user: Boolean) { if(user) elapsed.text = clock(durations.sum()*value/10000) }
            override fun onStopTrackingTouch(bar: SeekBar) { seekTo(durations.sum()*bar.progress/10000); seeking = false; setControls(true) }
        })
        player.setPlaybackSpeed(initialState.speed); player.playWhenReady = initialState.playing
        player.addListener(object : Player.Listener {
            override fun onIsPlayingChanged(playing: Boolean) { setControls(overlay.visibility == View.VISIBLE); onPlaybackChanged() }
            override fun onPlaybackStateChanged(state: Int) {
                if(!failed) { play.isEnabled = durations.isNotEmpty(); seek.isEnabled = durations.isNotEmpty() }
                if(state == Player.STATE_ENDED) setControls(true)
            }
            override fun onPlayerError(error: PlaybackException) {
                fail(when(error.errorCode) {
                    PlaybackException.ERROR_CODE_IO_FILE_NOT_FOUND -> "媒体文件不可用"
                    PlaybackException.ERROR_CODE_IO_NETWORK_CONNECTION_FAILED,PlaybackException.ERROR_CODE_IO_NETWORK_CONNECTION_TIMEOUT -> "无法读取远端媒体，请检查连接"
                    PlaybackException.ERROR_CODE_DECODING_FAILED,PlaybackException.ERROR_CODE_DECODER_INIT_FAILED -> "这条媒体暂时无法解码"
                    else -> "媒体播放失败，请重试"
                })
            }
        })
        setControls(true)
        if(remoteSource != null) {
            durations = listOf(remoteDurationMs.coerceAtLeast(1)); status.text = "电脑录音 · 按需读取"
            waveform?.visibility = View.GONE
            player.setMediaSource(remoteSource); player.prepare(); seekTo(pendingPosition); main.post(tick)
        } else worker.execute {
            val result = runCatching {
                require(files.isNotEmpty()) { "没有可播放文件" }
                val lengths = files.map { RecordedMedia.duration(it) }
                require(lengths.all { it > 0 }) { "媒体时长不可用" }
                val playable = files.map { RecordedMedia.playbackFile(context,it) }
                val levels = if(!video) runCatching { AudioLevels.wave(playable.first()) }.getOrNull() else null
                Triple(lengths,playable,levels)
            }
            main.post {
                if(closed) return@post
                result.onSuccess {
                    durations = it.first
                    if(it.third != null) waveform?.setLevels(it.third!!) else waveform?.visibility = View.GONE
                    player.setMediaItems(it.second.map { file -> MediaItem.fromUri(Uri.fromFile(file)) })
                    player.prepare(); seekTo(pendingPosition); main.post(tick)
                }.onFailure { fail(it.message ?: "媒体读取失败") }
            }
        }
    }
    private fun seekBy(delta: Long) = seekTo(durations.take(player.currentMediaItemIndex.coerceAtLeast(0)).sum()+player.currentPosition+delta)
    fun pause() { setPlaying(false) }
    fun seekTo(position: Long) {
        pendingPosition = position
        if(durations.isEmpty()) return
        val target = PlaybackPosition.locate(durations,position)
        player.seekTo(target.index,target.offsetMs)
    }
    fun close() { if(closed) return; closed = true; main.removeCallbacksAndMessages(null); picture?.player = null; player.release(); worker.shutdown() }
    private fun clock(value: Long): String {
        val seconds = value.coerceAtLeast(0)/1000
        return if(seconds >= 3600) String.format(Locale.ROOT,"%d:%02d:%02d",seconds/3600,seconds/60%60,seconds%60)
            else String.format(Locale.ROOT,"%02d:%02d",seconds/60,seconds%60)
    }
}
