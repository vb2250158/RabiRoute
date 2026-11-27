package com.rabi.link.phonecontrol

import android.content.ComponentName
import android.content.Context
import android.content.pm.PackageManager
import android.os.SystemClock
import android.view.Choreographer
import com.rabi.link.RabiPhoneFiles
import org.json.JSONArray
import org.json.JSONObject
import java.security.MessageDigest

internal data class PhoneTouchAction(val kind: String, val x: Float = 0f, val y: Float = 0f,
                                     val endX: Float = 0f, val endY: Float = 0f, val durationMs: Long = 0, val appId: String? = null)

internal data class PhoneTouchFeedback(val requestId: String, val label: String, val action: PhoneTouchAction,
                                       val startedAt: Long = SystemClock.uptimeMillis()) {
    val endsAt = startedAt + action.durationMs + 450
    fun position(now: Long): Pair<Float, Float> {
        if (action.kind != "swipe") return action.x to action.y
        val progress = ((now - startedAt).toFloat() / action.durationMs).coerceIn(0f, 1f)
        return (action.x + (action.endX - action.x) * progress) to (action.y + (action.endY - action.y) * progress)
    }
}

internal data class PhoneLauncherApp(val id: String, val name: String, val packageName: String)

internal interface PhoneTouchDriver {
    enum class Result { COMPLETED, REJECTED, INTERRUPTED, UNCONFIRMED }
    fun dispatch(action: PhoneTouchAction, requestId: String, label: String, allowed: () -> Boolean): Result
    fun clearFeedback(requestId: String?)
    fun suspendFeedback(): AutoCloseable
    fun apps(): List<PhoneLauncherApp>
    fun canOpen(appId: String): Boolean
}

/** The device owns input admission, stop and the original durable receipt. */
class PhoneInputAccess(context: Context) {
    private val receipts = context.getSharedPreferences("rabi_phone_input_receipts", Context.MODE_PRIVATE)

    fun execute(action: String, input: JSONObject, guard: Runnable, instanceId: String): JSONObject {
        guard.run()
        if (action == "apps.list") return listApps(guard)
        val id = requireNotNull(input.opt("requestId") as? String)
        require(id.matches(Regex("[A-Za-z0-9_.:-]{1,160}")))
        val key = digest(id)
        if (action == "input.cancel") stop(id)
        val appId = if (action == "apps.open") requireNotNull(input.opt("appId") as? String).also { require(it.length in 3..350) } else null
        if (action != "input.perform" && appId == null) {
            require(action == "input.status" || action == "input.cancel")
            return synchronized(lock) { receipt(key, id)?.apply { remove("intent") } ?: result(id, "absent", 0) }
        }

        val source = input.optJSONObject("source")
        val steps = if (appId == null) requireNotNull(input.optJSONArray("actions")) else null
        if (appId == null || input.has("source")) requireNotNull(source)
        val captureAfter = captureOptions(input.opt("captureAfter"))
        if (captureAfter?.has("waitMs") == true) requireNotNull(source)
        val changes = if (appId == null) canonical(steps) else "apps.open\n" + canonical(appId)
        val intent = digest(canonical(source) + "\n" + changes + (captureAfter?.let { "\n" + canonical(it) } ?: ""))
        val prior = synchronized(lock) { receipt(key, id) }
        if (prior != null) return sameIntent(prior, intent)
        val projection = PhoneScreenShareService.current() ?: return result(id, "consent-required", 0)
        val driver = driverInstance ?: return result(id, "accessibility-required", 0)
        val reference = source?.let {
            val value = projection.reference(it.optString("frameId")) ?: return result(id, "target-changed", 0)
            if (it.optString("instanceId") != instanceId || it.optString("layoutRevision") != value.epoch ||
                value.windowRevision != windowRevision()) return result(id, "target-changed", 0)
            value
        }
        val epoch = reference?.epoch ?: projection.currentEpoch() ?: return result(id, "target-changed", 0)
        val actions = if (appId == null) readActions(checkNotNull(steps), source?.optJSONObject("imageView"), checkNotNull(reference)) else {
            if (!driver.canOpen(appId)) return result(id, "app-unavailable", 0, appId)
            listOf(PhoneTouchAction("open-app", appId = appId))
        }
        val work = Batch(id)
        synchronized(lock) {
            receipt(key, id)?.let { return sameIntent(it, intent) }
            if (active != null) return result(id, "busy", 0)
            guard.run()
            pruneReceipts()
            if (!save(key, result(id, "running", 0, appId).put("intent", intent))) {
                throw RabiPhoneFiles.Failure(503, "PHONE_INPUT_RECEIPT_UNAVAILABLE")
            }
            active = work
        }

        val label = input.optString("observerLabel").filterNot(Char::isISOControl).trim().take(120).ifEmpty { "Rabi" }
        var outcome = "completed"
        var readback = false
        var capture: JSONObject? = null
        val allowed = {
            guard.run()
            !work.cancelled && driverInstance === driver && projection.ownsEpoch(epoch) &&
                (reference == null || reference.windowRevision == windowRevision())
        }
        try {
            projection.showInput(id, label)
            for (step in actions) {
                if (!allowed()) { outcome = if (work.cancelled) "cancelled" else "target-changed"; break }
                when (driver.dispatch(step, id, label, allowed)) {
                    PhoneTouchDriver.Result.COMPLETED -> work.completed++
                    PhoneTouchDriver.Result.REJECTED -> {
                        outcome = if (work.cancelled) "cancelled" else if (appId != null && allowed()) "app-unavailable" else "target-changed"
                        break
                    }
                    PhoneTouchDriver.Result.INTERRUPTED -> { outcome = "cancelled"; break }
                    PhoneTouchDriver.Result.UNCONFIRMED -> { outcome = "uncertain"; break }
                }
            }
        } catch (_: java.util.concurrent.CancellationException) {
            outcome = "cancelled"
        } catch (_: Exception) {
            outcome = "uncertain"
        } finally {
            try {
                synchronized(lock) {
                    readback = captureAfter != null && outcome == "completed" && work.completed == actions.size && !work.cancelled
                    capture = captureAfter?.let {
                        if (readback) captureState("pending") else captureState("unavailable", "input-incomplete")
                    }
                    if (!save(key, result(id, outcome, work.completed, appId).put("intent", intent).put("capture", capture))) {
                        outcome = "uncertain"
                        readback = false
                        capture = captureAfter?.let { captureState("unavailable", "receipt-unconfirmed") }
                    }
                    if (!readback) active = null
                }
            } finally {
                if (outcome != "completed" || work.cancelled) driver.clearFeedback(id)
                projection.hideInput(id)
            }
        }
        if (readback && captureAfter != null) {
            try {
                val compareContent = reference != null && (appId != null || actions.all { insideAppArea(it, reference) })
                capture = readAfterInput(captureAfter, source, reference?.maxWidth ?: 960, label, instanceId, compareContent, Runnable {
                    guard.run()
                    if (work.cancelled) throw java.util.concurrent.CancellationException()
                    if (!projection.ownsEpoch(epoch)) throw RabiPhoneFiles.Failure(409, "PHONE_SCREEN_TARGET_CHANGED")
                })
            } finally {
                synchronized(lock) {
                    try {
                        val metadata = capture?.let(::captureMetadata) ?: captureState("unavailable", "readback-interrupted")
                        save(key, result(id, outcome, work.completed, appId).put("intent", intent).put("capture", metadata))
                    } finally { active = null }
                }
            }
        }
        return result(id, outcome, work.completed, appId).put("capture", capture)
    }

    private fun listApps(guard: Runnable): JSONObject {
        val projection = PhoneScreenShareService.current() ?: return JSONObject().put("state", "consent-required")
        val driver = driverInstance ?: return JSONObject().put("state", "accessibility-required")
        val apps = JSONArray()
        for (app in driver.apps()) apps.put(JSONObject().put("appId", app.id).put("name", app.name).put("packageName", app.packageName))
        guard.run()
        if (PhoneScreenShareService.current() !== projection || driverInstance !== driver) return JSONObject().put("state", "target-changed")
        return JSONObject().put("state", "ready").put("apps", apps)
    }

    private fun receipt(key: String, id: String): JSONObject? {
        val saved = receipts.getString(key, null) ?: return null
        val value = JSONObject(saved)
        value.remove("savedAt")
        if (value.optString("state") == "running") {
            val running = active?.takeIf { it.id == id }
            value.put("state", if (running == null) "uncertain" else if (running.cancelled) "cancel-requested" else "running")
            if (running != null) value.put("completedActions", running.completed)
        }
        if (value.optJSONObject("capture")?.optString("state") == "pending" && active?.id != id) {
            value.put("capture", captureState("unavailable", "readback-interrupted"))
        }
        return value
    }

    private fun captureOptions(raw: Any?): JSONObject? = when (raw) {
        null, false -> null
        true -> JSONObject()
        is JSONObject -> JSONObject().put("waitMs", integer(raw, "waitMs", 100..5000))
        else -> throw IllegalArgumentException("Invalid captureAfter")
    }

    private fun captureState(state: String, reason: String? = null) = JSONObject().put("state", state).put("reason", reason)

    private fun captureMetadata(capture: JSONObject): JSONObject = captureState(capture.getString("state"), capture.opt("reason") as? String)
        .put("frameId", capture.opt("frameId")).put("capturedAt", capture.opt("capturedAt"))

    private fun insideAppArea(action: PhoneTouchAction, frame: PhoneScreenShareService.ScreenReference): Boolean {
        if (action.kind == "back") return true
        val bars = frame.systemBars
        fun inside(x: Float, y: Float) = x >= bars.left && x < frame.nativeWidth - bars.right &&
            y >= bars.top && y < frame.nativeHeight - bars.bottom
        return inside(action.x, action.y) && (action.kind != "swipe" || inside(action.endX, action.endY))
    }

    private fun readAfterInput(options: JSONObject, source: JSONObject?, maxWidth: Int, label: String,
                               instanceId: String, compareContent: Boolean, guard: Runnable): JSONObject {
        val access = PhoneScreenAccess()
        val input = JSONObject().put("observerLabel", label)
        return try {
            if (!options.has("waitMs")) {
                access.execute("screen.capture", input.put("maxWidth", maxWidth), guard, instanceId, afterInput = true).put("state", "captured")
            } else {
                val result = access.execute("screen.wait", input.put("source", source).put("waitMs", options.getInt("waitMs")),
                    guard, instanceId, afterInput = true, compareContent = compareContent)
                result.optJSONObject("capture")?.put("state", "captured") ?: captureState(result.getString("state"))
            }
        } catch (_: java.util.concurrent.CancellationException) {
            captureState("cancelled")
        } catch (error: RabiPhoneFiles.Failure) {
            if (error.code == "PHONE_SCREEN_TARGET_CHANGED" || error.code == "PHONE_SCREEN_CONSENT_REQUIRED") captureState("target-changed")
            else captureState("unavailable", error.code)
        } catch (_: Exception) {
            captureState("unavailable", "PHONE_SCREEN_READ_FAILED")
        }
    }

    private fun sameIntent(record: JSONObject, intent: String): JSONObject {
        if (record.optString("intent") != intent) throw RabiPhoneFiles.Failure(409, "PHONE_INPUT_REQUEST_CONFLICT")
        record.remove("intent")
        return record
    }

    private fun save(key: String, receipt: JSONObject): Boolean = receipts.edit()
        .putString(key, receipt.put("savedAt", System.currentTimeMillis()).toString()).commit()

    private fun pruneReceipts() {
        val now = SystemClock.elapsedRealtime()
        if (now - lastPruned < 60 * 60_000) return
        lastPruned = now
        val cutoff = System.currentTimeMillis() - 24 * 60 * 60_000L
        val editor = receipts.edit()
        for ((key, value) in receipts.all) if (value is String && runCatching { JSONObject(value).getLong("savedAt") < cutoff }.getOrDefault(false)) editor.remove(key)
        editor.apply()
    }

    private fun readActions(items: JSONArray, view: JSONObject?, frame: PhoneScreenShareService.ScreenReference): List<PhoneTouchAction> {
        require(items.length() in 1..32)
        val width = view?.let { integer(it, "width", 1..3840) } ?: frame.width
        val height = view?.let { integer(it, "height", 1..3840) } ?: frame.height
        require(kotlin.math.abs(width.toDouble() * frame.height / frame.width - height) <= 2.0)
        val actions = List(items.length()) { index ->
            val action = requireNotNull(items.optJSONObject(index))
            val kind = action.optString("type")
            if (kind == "back") return@List PhoneTouchAction(kind)
            val x = coordinate(action, "x", width, frame.nativeWidth)
            val y = coordinate(action, "y", height, frame.nativeHeight)
            when (kind) {
                "click" -> PhoneTouchAction(kind, x, y, durationMs = 45)
                "longPress" -> PhoneTouchAction(kind, x, y, durationMs = integer(action, "durationMs", 500..1200).toLong())
                "swipe" -> PhoneTouchAction(kind, x, y, coordinate(action, "endX", width, frame.nativeWidth),
                    coordinate(action, "endY", height, frame.nativeHeight), integer(action, "durationMs", 100..1200).toLong())
                else -> throw IllegalArgumentException("Unsupported touch action")
            }
        }
        require(actions.sumOf { it.durationMs } <= 8000)
        return actions
    }

    private fun coordinate(body: JSONObject, field: String, view: Int, native: Int): Float {
        val value = (body.opt(field) as? Number)?.toDouble() ?: Double.NaN
        require(value.isFinite() && value >= 0 && value < view)
        return (value * native / view).toFloat()
    }

    private fun integer(body: JSONObject, field: String, allowed: IntRange): Int {
        val value = (body.opt(field) as? Number)?.toDouble() ?: Double.NaN
        require(value.isFinite() && value % 1 == 0.0 && value >= allowed.first && value <= allowed.last)
        return value.toInt()
    }

    private fun canonical(value: Any?): String = when (value) {
        is JSONObject -> value.keys().asSequence().sorted().joinToString(prefix = "{", postfix = "}") { JSONObject.quote(it) + ":" + canonical(value.get(it)) }
        is JSONArray -> (0 until value.length()).joinToString(prefix = "[", postfix = "]") { canonical(value.get(it)) }
        is String -> JSONObject.quote(value)
        else -> value.toString()
    }

    private fun digest(value: String) = MessageDigest.getInstance("SHA-256").digest(value.toByteArray(Charsets.UTF_8)).joinToString("") { "%02x".format(it) }
    private fun result(id: String, state: String, completed: Int, appId: String? = null) =
        JSONObject().put("requestId", id).put("state", state).put("completedActions", completed).put("appId", appId)
            .put("launchState", if (appId != null && state == "completed") "requested" else null)

    private class Batch(val id: String) {
        @Volatile var cancelled = false
        @Volatile var completed = 0
    }

    companion object {
        private val lock = Any()
        @Volatile private var driverInstance: PhoneTouchDriver? = null
        private data class FeedbackFence(val hiddenAt: Long, val settled: Boolean)
        @Volatile private var feedbackFence = FeedbackFence(0, true)
        private val visibleWindow = java.util.concurrent.atomic.AtomicLong()
        private var active: Batch? = null
        private var lastPruned = -60 * 60_000L

        @JvmStatic fun supported(context: Context): Boolean = try {
            @Suppress("DEPRECATION")
            context.packageManager.getServiceInfo(ComponentName(context, "com.rabi.link.phonecontrol.PhoneTouchService"), 0)
            true
        } catch (_: PackageManager.NameNotFoundException) { false }

        internal fun attach(driver: PhoneTouchDriver) = synchronized(lock) { driverInstance = driver; visibleWindow.incrementAndGet(); Unit }
        internal fun detach(driver: PhoneTouchDriver) = synchronized(lock) {
            if (driverInstance === driver) { driverInstance = null; active?.cancelled = true; visibleWindow.incrementAndGet() }
        }
        internal fun windowChanged() { visibleWindow.incrementAndGet() }
        internal fun windowRevision(): Long = visibleWindow.get()
        internal fun ready() = driverInstance != null
        internal fun suspendFeedback() = driverInstance?.suspendFeedback()
        internal fun feedbackVisible() { feedbackFence = FeedbackFence(Long.MAX_VALUE, false) }
        internal fun feedbackHidden() {
            val hidden = FeedbackFence(System.nanoTime(), false)
            feedbackFence = hidden
            // Removing the window can leave a frame queued for projection by the compositor.
            val frames = Choreographer.getInstance()
            frames.postFrameCallback {
                frames.postFrameCallback {
                    if (feedbackFence === hidden) {
                        feedbackFence = hidden.copy(settled = true)
                        PhoneScreenShareService.current()?.feedbackSettled()
                    }
                }
            }
        }
        internal fun frameClearsFeedback(timestamp: Long): Boolean = feedbackFence.let { it.settled && timestamp >= it.hiddenAt }
        internal fun stop(id: String?) {
            if (id == null) return
            synchronized(lock) { if (active?.id == id) active?.cancelled = true }
            driverInstance?.clearFeedback(id)
        }
        internal fun stopCurrent() {
            synchronized(lock) { active?.cancelled = true }
            driverInstance?.clearFeedback(null)
        }
    }
}
