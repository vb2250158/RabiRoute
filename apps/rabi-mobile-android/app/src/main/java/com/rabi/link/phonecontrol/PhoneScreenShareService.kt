package com.rabi.link.phonecontrol

import android.app.Activity
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Intent
import android.content.pm.ServiceInfo
import android.content.res.Configuration
import android.graphics.Bitmap
import android.graphics.Insets
import android.graphics.PixelFormat
import android.hardware.display.DisplayManager
import android.hardware.display.VirtualDisplay
import android.media.Image
import android.media.ImageReader
import android.media.projection.MediaProjection
import android.media.projection.MediaProjectionManager
import android.net.Uri
import android.os.Build
import android.os.Handler
import android.os.HandlerThread
import android.os.IBinder
import android.os.Looper
import android.os.SystemClock
import android.util.Log
import android.view.WindowManager
import android.view.WindowInsets
import java.nio.ByteBuffer
import java.time.Instant
import java.util.UUID
import org.json.JSONArray
import org.json.JSONObject
import kotlin.math.min
import kotlin.math.roundToInt
import kotlin.math.sqrt

/** Owns exactly one local, user-authorized projection. No grant or frame is persisted. */
class PhoneScreenShareService : Service() {
    internal data class Snapshot(val bitmap: Bitmap, val capturedAt: String, val nativeWidth: Int, val nativeHeight: Int, val epoch: String, val sequence: Long, val windowRevision: Long, val systemBars: Insets)
    internal data class ScreenReference(val epoch: String, val sequence: Long, val maxWidth: Int, val digest: ByteArray, val contentDigest: ByteArray, val issuedAt: Long,
                                        val nativeWidth: Int, val nativeHeight: Int, val width: Int, val height: Int, val windowRevision: Long, val systemBars: Insets)

    private val main = Handler(Looper.getMainLooper())
    private val frameLock = Object()
    private var frameThread: HandlerThread? = null
    private var projection: MediaProjection? = null
    private var display: VirtualDisplay? = null
    private var reader: ImageReader? = null
    private var latest: Image? = null
    private var copyBuffer: ByteBuffer? = null
    private var imageSequence = 0L
    private var imageWindowRevision = 0L
    private var capturedAt = ""
    private var epoch = ""
    private var size = 0 to 0
    private var systemBars = Insets.NONE
    private val references = LinkedHashMap<String, ScreenReference>()
    private val observations = LinkedHashMap<String, String>()
    private var inputNotice: Pair<String, String>? = null
    private data class NoticeSnapshot(val observations: List<Pair<String, String>>, val input: Pair<String, String>?)
    private data class PointerSnapshot(val epoch: String, val feedback: PhoneTouchFeedback)
    @Volatile private var noticeSnapshot = NoticeSnapshot(emptyList(), null)
    @Volatile private var pointerSnapshot: PointerSnapshot? = null

    private val callback = object : MediaProjection.Callback() {
        override fun onStop() { release(); stopSelf() }
        override fun onCapturedContentResize(width: Int, height: Int) { resizeOrStop(width, height) }
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == STOP) { release(); stopSelf(); return START_NOT_STICKY }
        if (intent?.action == STOP_INPUT) { PhoneInputAccess.stop(intent.getStringExtra("requestId")); return START_NOT_STICKY }
        if (projection != null) return START_NOT_STICKY
        val grant = if (Build.VERSION.SDK_INT >= 33) intent?.getParcelableExtra(GRANT, Intent::class.java)
            else @Suppress("DEPRECATION") intent?.getParcelableExtra<Intent>(GRANT)
        if (grant == null) { stopSelf(startId); return START_NOT_STICKY }
        try {
            getSystemService(NotificationManager::class.java).createNotificationChannel(
                NotificationChannel(CHANNEL, "屏幕共享", NotificationManager.IMPORTANCE_LOW)
            )
            startForeground(NOTICE, notification("手机屏幕共享已开启"), ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PROJECTION)
            val owner = getSystemService(MediaProjectionManager::class.java).getMediaProjection(Activity.RESULT_OK, grant)
                ?: error("Screen sharing grant is no longer available")
            projection = owner
            owner.registerCallback(callback, main)
            frameThread = HandlerThread("RabiPhoneScreenFrames").apply { start() }
            val bounds = getSystemService(WindowManager::class.java).maximumWindowMetrics.bounds
            applySize(bounds.width(), bounds.height())
            active = this
        } catch (error: RuntimeException) {
            Log.w("RabiPhoneScreen", "Unable to start the granted screen share", error)
            release(); stopSelf(startId)
        }
        return START_NOT_STICKY
    }

    override fun onConfigurationChanged(configuration: Configuration) {
        super.onConfigurationChanged(configuration)
        if (Build.VERSION.SDK_INT >= 34 || projection == null) return
        val bounds = getSystemService(WindowManager::class.java).maximumWindowMetrics.bounds
        resizeOrStop(bounds.width(), bounds.height())
    }

    private fun resizeOrStop(width: Int, height: Int) {
        try { applySize(width, height) }
        catch (error: RuntimeException) {
            Log.w("RabiPhoneScreen", "Screen share changed size and closed", error)
            release(); stopSelf()
        }
    }

    private fun applySize(width: Int, height: Int) {
        val owner = projection ?: return
        if (width < 1 || height < 1 || size == (width to height)) return
        PhoneInputAccess.stopCurrent()
        val scale = min(1.0, sqrt(720_000.0 / (width.toDouble() * height)))
        val outputWidth = (scale * width).roundToInt().coerceAtLeast(1)
        val outputHeight = (scale * height).roundToInt().coerceAtLeast(1)
        val next = ImageReader.newInstance(outputWidth, outputHeight, PixelFormat.RGBA_8888, 3)
        val density = (resources.configuration.densityDpi * scale).roundToInt().coerceAtLeast(1)
        val insets = getSystemService(WindowManager::class.java).maximumWindowMetrics.windowInsets
            .getInsetsIgnoringVisibility(WindowInsets.Type.systemBars())
        val previous = synchronized(frameLock) {
            val old = reader
            latest?.close(); latest = null
            copyBuffer = null
            references.clear()
            reader = next; size = width to height; epoch = UUID.randomUUID().toString()
            systemBars = insets
            frameLock.notifyAll()
            old
        }
        try {
            next.setOnImageAvailableListener(::onFrame, Handler(checkNotNull(frameThread).looper))
            val current = display
            if (current == null) {
                display = checkNotNull(owner.createVirtualDisplay("RabiLink screen", outputWidth, outputHeight, density,
                    DisplayManager.VIRTUAL_DISPLAY_FLAG_AUTO_MIRROR, next.surface, null, null))
            } else {
                current.resize(outputWidth, outputHeight, density)
                current.surface = next.surface
            }
        } finally { previous?.close() }
    }

    private fun onFrame(source: ImageReader) = synchronized(frameLock) {
        if (reader !== source) return@synchronized
        val image = source.acquireLatestImage() ?: return@synchronized
        latest?.close()
        latest = image
        imageSequence++
        imageWindowRevision = PhoneInputAccess.windowRevision()
        capturedAt = Instant.now().toString()
        frameLock.notifyAll()
    }

    internal fun snapshot(guard: Runnable, deadline: Long = SystemClock.elapsedRealtime() + 1500,
                          after: Long = -1, requiredEpoch: String? = null): Snapshot? {
        // Sample mirrored pixels only after any gesture feedback layer has left the display.
        val feedback = PhoneInputAccess.suspendFeedback()
        try {
            return synchronized(frameLock) {
                while (active === this && (requiredEpoch == null || epoch == requiredEpoch)) {
                    guard.run()
                    val remaining = deadline - SystemClock.elapsedRealtime()
                    if (remaining <= 0) break
                    val image = latest
                    if (image != null && imageSequence > after && PhoneInputAccess.frameClearsFeedback(image.timestamp)) {
                        return@synchronized Snapshot(copyImage(image), capturedAt, size.first, size.second, epoch, imageSequence, imageWindowRevision, systemBars)
                    }
                    frameLock.wait(min(remaining, 100L))
                }
                guard.run()
                null
            }
        } finally { feedback?.close() }
    }

    internal fun ownsEpoch(value: String) = synchronized(frameLock) { active === this && epoch == value }
    internal fun currentEpoch(): String? = synchronized(frameLock) { epoch.takeIf { active === this } }
    internal fun feedbackSettled() = synchronized(frameLock) { frameLock.notifyAll() }

    internal fun publishTouchFeedback(feedback: PhoneTouchFeedback) {
        if (active === this) pointerSnapshot = PointerSnapshot(epoch, feedback)
    }

    internal fun clearTouchFeedback(requestId: String?) {
        if (requestId == null || pointerSnapshot?.feedback?.requestId == requestId) pointerSnapshot = null
    }

    internal fun status(): JSONObject = synchronized(frameLock) {
        if (active !== this) return@synchronized JSONObject().put("state", "consent-required")
        val notices = noticeSnapshot
        val activity = JSONObject().put("observations", JSONArray().apply {
            notices.observations.forEach { (id, label) -> put(JSONObject().put("id", id).put("label", label)) }
        })
        notices.input?.let { (id, label) -> activity.put("operation", JSONObject().put("requestId", id).put("label", label)) }
        val now = SystemClock.uptimeMillis()
        pointerSnapshot?.takeIf { it.epoch == epoch && now < it.feedback.endsAt }?.let { marker ->
            val feedback = marker.feedback
            val (x, y) = feedback.position(now)
            val width = size.first.toDouble()
            val height = size.second.toDouble()
            activity.put("pointer", JSONObject().put("requestId", feedback.requestId).put("label", feedback.label)
                .put("kind", feedback.action.kind).put("remainingMs", feedback.endsAt - now)
                .put("startX", feedback.action.x / width).put("startY", feedback.action.y / height)
                .put("x", x / width).put("y", y / height))
        }
        JSONObject().put("state", "sharing").put("layoutRevision", epoch).put("activity", activity)
    }

    internal fun remember(frameId: String, frame: Snapshot, maxWidth: Int, digest: ByteArray, contentDigest: ByteArray, width: Int, height: Int): Boolean = synchronized(frameLock) {
        if (active !== this || epoch != frame.epoch) return@synchronized false
        references[frameId] = ScreenReference(frame.epoch, frame.sequence, maxWidth, digest, contentDigest, SystemClock.elapsedRealtime(),
            frame.nativeWidth, frame.nativeHeight, width, height, frame.windowRevision, frame.systemBars)
        if (references.size > 32) references.remove(references.keys.first())
        true
    }

    internal fun reference(frameId: String): ScreenReference? = synchronized(frameLock) {
        references[frameId]?.takeIf { active === this && it.epoch == epoch && SystemClock.elapsedRealtime() - it.issuedAt <= 120_000 }
    }

    private fun copyImage(image: Image): Bitmap {
        val plane = image.planes.single()
        check(plane.pixelStride == 4)
        val input = plane.buffer.duplicate()
        val start = input.position()
        val limit = input.limit()
        val rowBytes = image.width * 4
        val length = rowBytes * image.height
        val pixels = copyBuffer?.takeIf { it.capacity() == length }
            ?: ByteBuffer.allocateDirect(length).also { copyBuffer = it }
        pixels.clear()
        repeat(image.height) { row ->
            val offset = start + row * plane.rowStride
            input.limit(limit).position(offset).limit(offset + rowBytes)
            pixels.put(input)
        }
        pixels.flip()
        return Bitmap.createBitmap(image.width, image.height, Bitmap.Config.ARGB_8888).apply { copyPixelsFromBuffer(pixels) }
    }

    internal fun beginObservation(label: String): String {
        val id = UUID.randomUUID().toString()
        main.post {
            if (active !== this) return@post
            observations[id] = label
            refreshNotice()
        }
        return id
    }

    internal fun finishObservation(id: String) {
        main.postDelayed({ if (active === this && observations.remove(id) != null) refreshNotice() }, 2500)
    }

    internal fun showInput(id: String, label: String) {
        main.post {
            if (active !== this) return@post
            inputNotice = id to label
            refreshNotice()
        }
    }

    internal fun hideInput(id: String) {
        main.post {
            if (inputNotice?.first != id) return@post
            inputNotice = null
            refreshNotice()
        }
    }

    private fun refreshNotice() {
        noticeSnapshot = NoticeSnapshot(observations.toList(), inputNotice)
        val names = observations.values.distinct()
        val input = inputNotice
        val title = when {
            input != null -> "${input.second} 正在操作你的手机"
            names.isEmpty() -> "手机屏幕共享已开启"
            names.size == 1 -> "${names.first()} 正在看你的屏幕"
            else -> "${names.size} 个会话正在看你的屏幕"
        }
        getSystemService(NotificationManager::class.java).notify(NOTICE, notification(title, names, input?.first))
    }

    private fun notification(label: String, names: List<String> = emptyList(), inputId: String? = null): Notification {
        val stop = PendingIntent.getService(this, 0, Intent(this, PhoneScreenShareService::class.java).setAction(STOP), PendingIntent.FLAG_IMMUTABLE)
        val notification = Notification.Builder(this, CHANNEL).setContentTitle(label)
            .setSmallIcon(android.R.drawable.ic_menu_camera).setOngoing(true).setOnlyAlertOnce(true)
            .addAction(Notification.Action.Builder(null, "停止共享", stop).build())
        if (inputId != null) {
            val intent = Intent(this, PhoneScreenShareService::class.java).setAction(STOP_INPUT)
                .setData(Uri.fromParts("rabilink-phone-input", inputId, null)).putExtra("requestId", inputId)
            val stopInput = PendingIntent.getService(this, 1, intent, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
            notification.addAction(Notification.Action.Builder(null, "停止操作", stopInput).build())
        }
        if (names.size > 1 || inputId != null && names.isNotEmpty()) {
            notification.setStyle(Notification.InboxStyle().apply { names.forEach { addLine("$it 正在看你的屏幕") } })
        }
        return notification.build()
    }

    private fun release() {
        val released = synchronized(frameLock) {
            val owned = active === this
            if (owned) active = null
            display?.release(); display = null
            latest?.close(); latest = null
            copyBuffer = null
            references.clear()
            reader?.close(); reader = null
            frameLock.notifyAll()
            owned
        }
        if (released) PhoneInputAccess.stopCurrent()
        main.removeCallbacksAndMessages(null)
        observations.clear()
        inputNotice = null
        noticeSnapshot = NoticeSnapshot(emptyList(), null)
        pointerSnapshot = null
        projection?.unregisterCallback(callback)
        projection?.stop(); projection = null
        frameThread?.quitSafely(); frameThread = null
        stopForeground(STOP_FOREGROUND_REMOVE)
    }

    override fun onDestroy() { release(); super.onDestroy() }

    companion object {
        const val GRANT = "screenShareGrant"
        private const val CHANNEL = "rabi-phone-screen-share"
        private const val NOTICE = 2027
        private const val STOP = "com.rabi.link.stop_screen_share"
        private const val STOP_INPUT = "com.rabi.link.stop_phone_input"
        @Volatile private var active: PhoneScreenShareService? = null
        internal fun current() = active
    }
}
