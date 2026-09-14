package com.rabi.link.modules.rokid

import android.content.Context
import android.content.ContextWrapper
import android.os.FileObserver
import android.os.Handler
import android.os.Looper
import android.os.PowerManager
import com.rabi.link.recording.RecordingStore
import java.io.File
import java.net.Inet4Address
import java.net.NetworkInterface
import java.util.UUID
import java.util.concurrent.TimeUnit

/**
 * Local receiver owned by the single foreground coordinator. This is not a Service:
 * the caller owns permissions, foreground notification and capture exclusivity.
 * Public commands are serialized on the main looper. onStopped is emitted exactly
 * once per accepted start, after the child exits and the session manifest is saved.
 * close is terminal; it still completes asynchronous saving and onStopped.
 */
class RabiLiveRecordingController(
    context: Context,
    private val onChanged: () -> Unit,
    private val onStopped: () -> Unit
) : ContextWrapper(context.applicationContext), AutoCloseable {
    private val mediaSettings = com.rabi.link.recording.LocalMediaSettings.load(context)
    val previewUrl: String get() = "rtsp://127.0.0.1:${mediaSettings.previewPort}/rabi/$streamKey"
    private val main = Handler(Looper.getMainLooper())
    private var process: Process? = null
    var active = false; private set
    var saveSucceeded = false; private set
    private var stopping = false
    private var closed = false
    @Volatile private var forcedStop = false
    private var generation = 0L
    private var videoController: RabiGlassVideoController? = null
    private var observer: FileObserver? = null
    private var wake: PowerManager.WakeLock? = null
    private var delayedStart: Runnable? = null
    private val listeners = mutableSetOf<() -> Unit>()
    fun listen(listener: () -> Unit) = onMain { if (!closed) { listeners.add(listener); listener() } }
    fun unlisten(listener: () -> Unit) = onMain { listeners.remove(listener) }
    var running = false; private set
    var receiving = false; private set
    var receivedAt = 0L; private set
    var sessionId = ""; private set
    var status = "尚未启动接收"; private set
    val streamKey: String by lazy {
        val preferences = getSharedPreferences("rabi_live_recorder", Context.MODE_PRIVATE)
        preferences.getString("stream_key", null) ?: UUID.randomUUID().toString().replace("-", "").also {
            preferences.edit().putString("stream_key", it).commit()
        }
    }

    fun urls(): List<String> = try {
        NetworkInterface.getNetworkInterfaces().toList()
            .filter { it.isUp && !it.isLoopback && !it.name.startsWith("tun") && !it.name.startsWith("rmnet") }
            .flatMap { it.inetAddresses.toList() }
            .filter { it is Inet4Address && it.isSiteLocalAddress }
            .map { "rtmp://${it.hostAddress}:${mediaSettings.rtmpPort}/rabi" }.distinct()
    } catch (_: Exception) { emptyList() }

    private fun onMain(action: () -> Unit) {
        if (Looper.myLooper() == Looper.getMainLooper()) action() else main.post { action() }
    }
    private fun update(message: String) {
        status = message
        onChanged()
        listeners.toList().forEach { it() }
    }

    fun start(auto: Boolean) = startBound(auto, null)
    fun start(auto: Boolean, captureId: String, source: String, route: String, policy: String) = startBound(auto,
        org.json.JSONObject().put("captureId", captureId).put("source", source).put("route", route)
            .put("policy", policy).put("endpointRef", captureId))
    private fun startBound(auto: Boolean, binding: org.json.JSONObject?) = onMain {
        if (closed || active) return@onMain
        active = true; saveSucceeded = false; stopping = false; forcedStop = false; receivedAt = 0L; sessionId = ""
        val epoch = ++generation
        // Create the manifest and launch the receiver away from the UI thread.
        Thread({
            var id = ""
            try {
                val entry = RecordingStore(this).create("video", "glasses", binding)
                id = entry.id
                val directory = entry.directory
                check(directory.usableSpace >= RESERVE) { "space" }
                check(urls().isNotEmpty()) { "network" }
                val executable = File(applicationInfo.nativeLibraryDir, "libmediamtx.so")
                val config = File(filesDir, "rabi-live-recorder.yml")
                config.writeText(configuration(directory))
                // The main thread grants process launch only if this generation is live.
                main.post {
                    if (closed || stopping || generation != epoch) {
                        finishWithoutProcess(epoch, id, "已停止，录像保存在本机")
                    } else launch(epoch, id, directory, executable, config, auto)
                }
            } catch (error: Exception) {
                val reason = when (error.message) {
                    "space" -> "空间不足，未启动；已有录像保留"
                    "network" -> "请先开启手机热点或连接本地 Wi-Fi；不需要互联网"
                    else -> "本地接收器准备失败，已有文件保留"
                }
                main.post { finishWithoutProcess(epoch, id, reason) }
            }
        }, "rabi-video-prepare").start()
        update("正在准备本地接收")
    }

    private fun launch(epoch: Long, id: String, directory: File, executable: File, config: File, auto: Boolean) {
        sessionId = id
        try {
            // The shell writes its kernel start identity before exec; exec retains PID/starttime.
            // Recovery must prove this exact receiver exited, not merely that the App restarted.
            val proof = File(directory, "receiver-process.stat")
            val owned = ProcessBuilder("/system/bin/sh", "-c",
                "cat /proc/\u0024\u0024/stat > \"\u00243.partial\" && mv \"\u00243.partial\" \"\u00243\" && exec \"\u00241\" \"\u00242\"",
                "rabi-receiver", executable.absolutePath, config.absolutePath, proof.absolutePath)
                .directory(filesDir).redirectErrorStream(true).start()
            process = owned; running = true
            // Install the exit/save waiter before any optional resources can fail.
            watchProcess(epoch, id, owned)
            wake = (getSystemService(Context.POWER_SERVICE) as PowerManager)
                .newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "RabiLink:LocalRecording").apply { acquire() }
            val streamDirectory = File(directory, "rabi/$streamKey").apply { mkdirs() }
            observer = object : FileObserver(streamDirectory, MODIFY or CLOSE_WRITE or CREATE) {
                private var lastCheck = 0L
                override fun onEvent(event: Int, path: String?) {
                    val now = android.os.SystemClock.elapsedRealtime()
                    if (now - lastCheck < 5000) return
                    lastCheck = now
                    if (directory.usableSpace < RESERVE) main.post {
                        if (active && generation == epoch && !stopping) stopInternal("空间不足，正在停止并保存已有录像")
                    }
                }
            }.also { it.startWatching() }
            update("正在启动本地接收")
            if (auto && !closed && !stopping && active && generation == epoch) {
                val controller = RabiGlassVideoController(this, { urls().map { "$it/$streamKey" } }, { message ->
                    main.post { if (!closed && !stopping && generation == epoch && !receiving) update(message) }
                })
                videoController = controller
                delayedStart = Runnable {
                    if (!closed && !stopping && active && generation == epoch && videoController === controller) controller.start()
                }.also { main.postDelayed(it, 1000) }
            }
        } catch (_: Exception) {
            if (process != null) stopInternal("本地接收器启动失败，正在保存")
            else finishWithoutProcess(epoch, id, "本地接收器启动失败")
        }
    }

    private fun watchProcess(epoch: Long, id: String, owned: Process) {
        Thread({
            var failed = false
            try {
                owned.inputStream.bufferedReader().useLines { lines -> lines.forEach { line ->
                    if (line.contains("ERR")) failed = true
                    val publishing = line.contains("is publishing")
                    val segmentStopped = line.contains("recording") && line.contains("stopped")
                    val message = when {
                        line.contains("listener opened") -> "等待眼镜推流；无需互联网"
                        publishing -> "正在接收并录像（手机本地）"
                        segmentStopped -> "本段录像已保存，等待下一次推流"
                        line.contains("ERR") -> "接收器异常；请检查端口、空间及视频格式"
                        else -> null
                    }
                    if (message != null) main.post {
                        if (process === owned && generation == epoch && !stopping && !closed) {
                            if (publishing) { receiving = true; if (receivedAt == 0L) receivedAt = System.currentTimeMillis() }
                            if (segmentStopped) receiving = false
                            update(message)
                        }
                    }
                } }
                owned.waitFor() // Explicit SIGTERM may return a non-zero exit code.
            } catch (_: Exception) {
                failed = true; owned.destroy()
                if (!owned.waitFor(10, TimeUnit.SECONDS)) { owned.destroyForcibly(); owned.waitFor() }
            }
            val processFailed = failed
            main.post {
                if (process === owned && generation == epoch) {
                    process = null; running = false; receiving = false
                    releaseResources()
                    val normal = stopping && !forcedStop && !processFailed
                    // SIGTERM commonly exits non-zero even after successful finalization.
                    // An unexpected exit or forced timeout is never labelled saved.
                    saveAndComplete(epoch, id, if (normal) "saved" else "interrupted",
                        if (normal) "已停止，录像保存在本机" else "接收已结束，保留已写入录像")
                }
            }
        }, "rabi-video-receiver").start()
    }

    private fun finishWithoutProcess(epoch: Long, id: String, message: String) {
        if (!active || generation != epoch) return
        releaseResources()
        saveAndComplete(epoch, id, "interrupted", message)
    }
    private fun saveAndComplete(epoch: Long, id: String, result: String, message: String) {
        Thread({
            var saved = true
            if (id.isNotEmpty()) try {
                RecordingStore(this).finish(id, result)
                VideoAudioDerivation.enqueueFinalized(this, id)
            } catch (_: Exception) { saved = false }
            main.post {
                if (active && generation == epoch) {
                    saveSucceeded = saved && result == "saved"
                    active = false; running = false; receiving = false
                    sessionId = id // Retained until the next start for finalized-session consumers.
                    update(if (saved) message else "录像文件已保留，但记录清单保存失败")
                    onStopped()
                }
            }
        }, "rabi-video-finalize").start()
    }

    fun stop() = onMain { stopInternal("正在停止并保存录像") }
    private fun stopInternal(message: String) {
        if (!active || stopping) return
        stopping = true
        releaseResources()
        update(message)
        val owned = process ?: return // Preparation completion observes stopping and finalizes.
        owned.destroy() // SIGTERM gives MediaMTX time to finalize its current fragment.
        Thread({
            if (!owned.waitFor(10, TimeUnit.SECONDS)) { forcedStop = true; owned.destroyForcibly() }
        }, "rabi-video-stop").start()
    }
    private fun releaseResources() {
        delayedStart?.let { main.removeCallbacks(it) }; delayedStart = null
        videoController?.close(); videoController = null
        observer?.stopWatching(); observer = null
        wake?.let { if (it.isHeld) it.release() }; wake = null
    }
    override fun close() = onMain {
        if (closed) return@onMain
        closed = true
        listeners.clear()
        stopInternal("正在关闭并保存录像")
        releaseResources()
    }

    private fun configuration(directory: File): String = """
        logLevel: info
        logDestinations: [stdout]
        api: false
        metrics: false
        pprof: false
        playback: false
        rtsp: true
        rtspAddress: 127.0.0.1:${mediaSettings.previewPort}
        rtspTransports: [tcp]
        hls: false
        webrtc: false
        srt: false
        rtmp: true
        rtmpAddress: 0.0.0.0:${mediaSettings.rtmpPort}
        authInternalUsers:
          - user: any
            pass:
            ips: [127.0.0.1]
            permissions:
              - action: read
                path: rabi/$streamKey
          - user: any
            pass:
            ips: []
            permissions:
              - action: publish
                path: rabi/$streamKey
        paths:
          rabi/$streamKey:
            source: publisher
            overridePublisher: false
            record: true
            recordPath: ${directory.absolutePath}/%path/%Y-%m-%d_%H-%M-%S-%f
            recordFormat: fmp4
            recordPartDuration: 1s
            recordMaxPartSize: 16M
            recordSegmentDuration: 1m
            recordDeleteAfter: 0s
    """.trimIndent()

    companion object { private const val RESERVE = 256L * 1024 * 1024 }
}
