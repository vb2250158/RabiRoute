package com.rabi.link.recording

import android.content.Context
import android.net.Uri
import android.os.Handler
import android.os.Looper
import android.view.View
import android.widget.*
import androidx.media3.common.MediaItem
import androidx.media3.common.Player
import androidx.media3.common.PlaybackException
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.ui.PlayerView
import com.rabi.link.RabiMobileUi
import java.io.File
import java.util.Locale
import java.util.concurrent.Executors

/** One player owns picture, sound and scrubbing. Audio-only records display their measured waveform. */
@androidx.annotation.OptIn(androidx.media3.common.util.UnstableApi::class)
class RecordingPlaybackPanel(private val context: Context, files: List<File>, video: Boolean, initialPosition: Long = 0, private val initialState: State = State(), private val onShare: () -> Unit = {}, private val onPosition: (Long) -> Unit = {}) {
    data class State(val playing: Boolean = false, val controlsVisible: Boolean = false, val speed: Float = 1f)
    fun state() = State(player.playWhenReady,overlay.visibility == View.VISIBLE,player.playbackParameters.speed)
    val view = FrameLayout(context)
    private fun dp(value: Int) = (context.resources.displayMetrics.density * value).toInt()
    private val main = Handler(Looper.getMainLooper())
    private val worker = Executors.newSingleThreadExecutor()
    private val player = ExoPlayer.Builder(context).build()
    private val picture = if(video) PlayerView(context).apply {
        useController = false; this.player = this@RecordingPlaybackPanel.player
        visibility = View.GONE
    } else null
    private val waveform = if(!video) AudioWaveformView(context) else null
    private val time = TextView(context).apply { text = "正在读取媒体…"; setTextColor(android.graphics.Color.WHITE); textSize = 11f; gravity = android.view.Gravity.CENTER_VERTICAL; setPadding(dp(10),0,dp(10),0); setBackgroundColor(0x99000000.toInt()); maxLines = 1 }
    private val play = control("播放").apply { isEnabled = false }
    private fun control(title: String) = Button(context).apply { text = title; textSize = 12f; minWidth = 0; minimumWidth = 0; minHeight = 0; minimumHeight = 0; setPadding(0,0,0,0); setTextColor(android.graphics.Color.WHITE); setBackgroundColor(android.graphics.Color.TRANSPARENT) }
    private val overlay = LinearLayout(context).apply { orientation = LinearLayout.VERTICAL; setBackgroundColor(0xCC192122.toInt()) }
    private val hideControls = Runnable { if(player.isPlaying) setControls(false) }
    var onControlsVisibilityChanged: (Boolean) -> Unit = {}
    fun holdControls() { main.removeCallbacks(hideControls) }
    fun setControls(shown: Boolean) {
        overlay.visibility = if(shown) View.VISIBLE else View.GONE
        onControlsVisibilityChanged(shown)
        time.visibility = if(shown) View.VISIBLE else View.GONE
        main.removeCallbacks(hideControls)
        if(shown && player.isPlaying && !(context.getSystemService(Context.ACCESSIBILITY_SERVICE) as android.view.accessibility.AccessibilityManager).isTouchExplorationEnabled) main.postDelayed(hideControls,3500)
    }
    private var durations = emptyList<Long>()
    private var pendingPosition = initialPosition
    private var closed = false
    private val tick = object : Runnable {
        override fun run() {
            if(closed) return
            if(durations.isNotEmpty()) {
                val position = durations.take(player.currentMediaItemIndex.coerceAtLeast(0)).sum() + player.currentPosition
                time.text = "${clock(position)} / ${clock(durations.sum())}"
                waveform?.progress = position.toFloat() / durations.sum().coerceAtLeast(1)
                waveform?.state = if(player.isPlaying) "正在播放录音" else "录音回看"
                onPosition(position)
            }
            play.text = if(player.isPlaying) "暂停" else "播放"
            main.postDelayed(this, 250)
        }
    }
    init {
        val pictureFrame = FrameLayout(context).apply { setBackgroundColor(android.graphics.Color.rgb(25,29,34)) }
        val noPicture = TextView(context).apply { text = "无画面"; gravity = android.view.Gravity.CENTER; setTextColor(android.graphics.Color.LTGRAY) }
        pictureFrame.addView(noPicture, FrameLayout.LayoutParams(-1,-1))
        waveform?.let { pictureFrame.addView(it, FrameLayout.LayoutParams(-1,-1).apply { bottomMargin = dp(64) }) }
        picture?.let { pictureFrame.addView(it, FrameLayout.LayoutParams(-1,-1)) }
        view.addView(pictureFrame, FrameLayout.LayoutParams(-1,-1))
        // A transparent tap target sits above both video and waveform, below interactive controls.
        view.addView(View(context).apply { contentDescription = "显示或隐藏播放控制"; setOnClickListener { setControls(this@RecordingPlaybackPanel.overlay.visibility != View.VISIBLE) } },FrameLayout.LayoutParams(-1,-1))
        view.addView(time,FrameLayout.LayoutParams(-1,dp(24),android.view.Gravity.BOTTOM).apply { bottomMargin = dp(112) })
        val controls = LinearLayout(context).apply { setBackgroundColor(0xCC192122.toInt()) }
        fun action(title: String, run: () -> Unit) = control(title).apply { setOnClickListener { run(); setControls(true) } }
        controls.addView(action("−3秒") { seekBy(-3000) }, LinearLayout.LayoutParams(0,-1,1f))
        controls.addView(play, LinearLayout.LayoutParams(0,-1,1f))
        controls.addView(action("+3秒") { seekBy(3000) }, LinearLayout.LayoutParams(0,-1,1f))
        controls.addView(action("1×") {
            val rate = if(player.playbackParameters.speed < 1.5f) 1.5f else if(player.playbackParameters.speed < 2f) 2f else 1f
            player.setPlaybackSpeed(rate)
            (controls.getChildAt(3) as Button).text = "${rate}×"
        }, LinearLayout.LayoutParams(0,-1,1f))
        controls.addView(action("⋯") {
            PopupMenu(context,controls.getChildAt(4)).apply {
                menu.add("分享原始记录")
                main.removeCallbacks(hideControls)
                setOnDismissListener { setControls(true) }
                setOnMenuItemClickListener { onShare(); true }
                show()
            }
        }.apply { contentDescription = "记录操作" },LinearLayout.LayoutParams(0,-1,1f))
        overlay.addView(controls,LinearLayout.LayoutParams(-1,dp(48)))
        view.addView(overlay,FrameLayout.LayoutParams(-1,dp(48),android.view.Gravity.BOTTOM).apply { bottomMargin = dp(64) })
        play.setOnClickListener {
            if(player.isPlaying) player.pause() else {
                if(player.playbackState == Player.STATE_ENDED) seekTo(0)
                player.play()
            }
            setControls(true)
        }
        setControls(initialState.controlsVisible) // Seeking across records preserves the existing UI and playback intent.
        player.setPlaybackSpeed(initialState.speed)
        player.playWhenReady = initialState.playing
        (controls.getChildAt(3) as Button).text = "${initialState.speed}×"
        player.addListener(object : Player.Listener {
            override fun onIsPlayingChanged(isPlaying: Boolean) { setControls(overlay.visibility == View.VISIBLE) }
            override fun onTracksChanged(tracks: androidx.media3.common.Tracks) {
                picture?.visibility = if(tracks.isTypeSupported(androidx.media3.common.C.TRACK_TYPE_VIDEO)) View.VISIBLE else View.GONE
            }
            override fun onPlayerError(error: PlaybackException) { time.text = "播放失败，原文件保留"; picture?.visibility = View.GONE }
        })
        worker.execute {
            val result = runCatching {
                require(files.isNotEmpty()) { "没有可播放文件" }
                val lengths = files.map { RecordedMedia.duration(it) }
                val playable = files.map { RecordedMedia.playbackFile(context,it) }
                val levels = if(!video) runCatching { AudioLevels.wave(playable.first()) }.getOrNull() else null
                Triple(lengths,playable,levels)
            }
            main.post {
                if(closed) return@post
                result.onSuccess {
                    durations = it.first
                    it.third?.let { levels -> waveform?.setLevels(levels) }
                    player.setMediaItems(it.second.map { file -> MediaItem.fromUri(Uri.fromFile(file)) }); player.prepare(); seekTo(pendingPosition)
                    play.isEnabled = true; main.post(tick)
                }.onFailure { time.text = it.message ?: "媒体读取失败" }
            }
        }
    }
    private fun seekBy(delta: Long) {
        if(durations.isEmpty()) return
        seekTo(durations.take(player.currentMediaItemIndex.coerceAtLeast(0)).sum() + player.currentPosition + delta)
    }
    fun pause() { player.pause() }
    fun seekTo(position: Long) {
        pendingPosition = position
        if(durations.isEmpty()) return
        val target = PlaybackPosition.locate(durations, position)
        player.seekTo(target.index, target.offsetMs)
    }
    fun close() { if(closed) return; closed = true; main.removeCallbacksAndMessages(null); picture?.player = null; player.release(); worker.shutdown() }
    private fun clock(value: Long): String = String.format(Locale.ROOT, "%02d:%02d:%02d", value / 3600000, value / 60000 % 60, value / 1000 % 60)
}
