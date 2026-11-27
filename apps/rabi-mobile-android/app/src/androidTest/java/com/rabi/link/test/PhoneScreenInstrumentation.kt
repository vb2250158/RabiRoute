package com.rabi.link.test

import android.app.Activity
import android.app.Instrumentation
import android.app.Notification
import android.app.NotificationManager
import android.app.UiAutomation
import android.content.Intent
import android.graphics.BitmapFactory
import android.graphics.Color
import android.os.Bundle
import android.os.ParcelFileDescriptor
import android.os.SystemClock
import android.util.Base64
import android.view.accessibility.AccessibilityNodeInfo
import android.widget.Button
import android.widget.LinearLayout
import com.rabi.link.RabiPhoneFiles
import com.rabi.link.modules.rokid.RabiGlassPcBackend
import com.rabi.link.phonecontrol.PhoneScreenAccess
import com.rabi.link.phonecontrol.PhoneScreenShareActivity
import com.rabi.link.phonecontrol.PhoneScreenShareService
import com.rabi.link.phonecontrol.PhoneInputAccess
import org.json.JSONObject
import org.json.JSONArray
import java.net.HttpURLConnection
import java.net.URL
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.UUID
import java.util.concurrent.atomic.AtomicInteger

class PhoneScreenInstrumentation : Instrumentation() {
    private var relayUrl: String? = null
    private var relayToken: String? = null
    private var touchFixture = false
    private var appsFixture = false
    private val phoneId = "rabi-phone-screenfixture"

    override fun onCreate(arguments: Bundle?) {
        super.onCreate(arguments)
        relayUrl = arguments?.getString("relay-url")
        relayToken = arguments?.getString("relay-token")
        touchFixture = arguments?.getString("touch-fixture") == "yes"
        appsFixture = arguments?.getString("apps-fixture") == "yes"
        start()
    }

    override fun onStart() {
        val report = Bundle()
        var code = Activity.RESULT_OK
        var relayBackend: RabiGlassPcBackend? = null
        var restoreTouch: (() -> Unit)? = null
        try {
            val service = Intent(targetContext, PhoneScreenShareService::class.java)
            val access = PhoneScreenAccess()
            val manager = targetContext.getSystemService(NotificationManager::class.java)
            val guard = Runnable { }
            fun state() = access.execute("screen.status", JSONObject(), guard, "fixture-phone").getString("state")
            fun notice() = manager.activeNotifications.firstOrNull { it.id == 2027 }?.notification
            fun observes(name: String): Boolean {
                val extras = notice()?.extras ?: return false
                val line = "$name 正在看你的屏幕"
                return extras.getString(Notification.EXTRA_TITLE) == line ||
                    extras.getCharSequenceArray(Notification.EXTRA_TEXT_LINES)?.any { it.toString() == line } == true
            }
            targetContext.stopService(service)
            await { state() == "consent-required" }
            assertConsentRequired(access, guard)
            val base = relayUrl
            val automation = getUiAutomation(UiAutomation.FLAG_DONT_SUPPRESS_ACCESSIBILITY_SERVICES)
            if (touchFixture) restoreTouch = enableTestTouch(automation)
            if (base != null) {
                require(URL(base).host == "127.0.0.1")
                val token = requireNotNull(relayToken)
                relayBackend = RabiGlassPcBackend(targetContext, silentListener).apply { configure(base, token, phoneId); start() }
                var lastStatus = 0
                await(10_000, { "Relay did not expose the phone screen; last HTTP status $lastStatus" }) {
                    lastStatus = remote("screen.status").first
                    lastStatus == 200
                }
                check(remote("screen.capture").first == 409)
            }
            val activity = startActivitySync(Intent(targetContext, PhoneScreenShareActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
            runOnMainSync {
                val content = activity.findViewById<android.widget.FrameLayout>(android.R.id.content).getChildAt(0) as LinearLayout
                content.findViewWithTag<Button>("screen-sharing-toggle").performClick()
            }
            await(10_000) {
                val root = automation.rootInActiveWindow
                root?.packageName == "com.android.systemui" && approve(root)
            }
            await { state() == "sharing" }
            val label = "设备控制 · 测试会话"
            repeat(2) {
                val frame = access.execute("screen.capture", JSONObject().put("maxWidth", 32).put("observerLabel", label), guard, "fixture-phone")
                check(frame.getJSONObject("source").getString("instanceId") == "fixture-phone")
                val bytes = Base64.decode(frame.getString("data"), Base64.DEFAULT)
                val actual = checkNotNull(BitmapFactory.decodeByteArray(bytes, 0, bytes.size))
                check(actual.width == 32 && actual.height == frame.getInt("height"))
                actual.recycle()
            }
            if (base != null) {
                val (status, payload) = remote("screen.capture", label)
                check(status == 200) { "Relay capture returned $status" }
                val frame = payload.getJSONObject("data")
                check(frame.getJSONObject("source").getString("instanceId") == phoneId)
                val png = Base64.decode(frame.getString("data"), Base64.DEFAULT)
                val image = checkNotNull(BitmapFactory.decodeByteArray(png, 0, png.size))
                check(image.width == 32 && image.height == frame.getInt("height"))
                image.recycle()
            }
            await { notice()?.extras?.getString(Notification.EXTRA_TITLE) == "$label 正在看你的屏幕" }
            await { notice()?.extras?.getString(Notification.EXTRA_TITLE) == "手机屏幕共享已开启" }
            val fixture = startActivitySync(Intent(targetContext, PhoneScreenShareActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
            runOnMainSync {
                fixture.findViewById<android.widget.FrameLayout>(android.R.id.content).getChildAt(0).setBackgroundColor(Color.BLUE)
            }
            waitForIdleSync()
            SystemClock.sleep(400)
            fun call(action: String, name: String, parameters: JSONObject): JSONObject {
                if (base != null) {
                    val (status, payload) = remote(action, name, parameters)
                    check(status == 200) { "$action returned HTTP $status" }
                    return payload.getJSONObject("data")
                }
                if (action.startsWith("input.") || action.startsWith("apps.")) return PhoneInputAccess(targetContext)
                    .execute(action, parameters.put("observerLabel", name), guard, "fixture-phone")
                return access.execute(action, parameters.put("observerLabel", name), guard, "fixture-phone")
            }
            val baseline = call("screen.capture", label, JSONObject().put("maxWidth", 32)).getJSONObject("source")
            fun waitArgs(ms: Int) = JSONObject().put("source", baseline).put("waitMs", ms)
            val still = call("screen.wait", label, waitArgs(350))
            check(still.getString("state") == "unchanged" && !still.has("capture")) { "Unexpected static wait state: ${still.optString("state")}" }
            val changedWait = Executors.newSingleThreadExecutor()
            var changedSource: JSONObject? = null
            try {
                val changed = changedWait.submit<JSONObject> { call("screen.wait", "等待变化会话", waitArgs(4500)) }
                await { observes(label) && observes("等待变化会话") }
                val status = call("screen.status", label, JSONObject())
                check(status.getString("state") == "sharing" && !changed.isDone) {
                    "A status read should finish while the original screen wait is still active"
                }
                val viewers = status.getJSONObject("activity").getJSONArray("observations")
                check((0 until viewers.length()).map { viewers.getJSONObject(it).getString("label") }.containsAll(listOf(label, "等待变化会话")))
                check(!status.getJSONObject("activity").has("pointer"))
                runOnMainSync {
                    fixture.findViewById<android.widget.FrameLayout>(android.R.id.content).getChildAt(0).setBackgroundColor(Color.RED)
                }
                val update = changed.get(6, TimeUnit.SECONDS)
                check(update.getString("state") == "changed")
                val newFrame = update.getJSONObject("capture")
                check(newFrame.getInt("width") == 32 && newFrame.getString("frameId") != baseline.getString("frameId"))
                changedSource = newFrame.getJSONObject("source")
                val png = Base64.decode(newFrame.getString("data"), Base64.DEFAULT)
                checkNotNull(BitmapFactory.decodeByteArray(png, 0, png.size)).recycle()
            } finally { changedWait.shutdownNow() }
            if (touchFixture) {
                changedSource = verifyTouch(fixture, manager, automation, report, ::call)
            }
            if (appsFixture) {
                check(touchFixture)
                verifyApps(automation, checkNotNull(changedSource), report, ::call)
                checkNotNull(notice()).actions.single { it.title.toString() == "停止共享" }.actionIntent.send()
            } else {
                val stoppingWait = Executors.newSingleThreadExecutor()
                try {
                    val stopped = stoppingWait.submit<JSONObject> {
                        call("screen.wait", "停止共享验收会话", JSONObject().put("source", checkNotNull(changedSource)).put("waitMs", 5000))
                    }
                    await { observes("停止共享验收会话") }
                    val started = SystemClock.elapsedRealtime()
                    checkNotNull(notice()).actions.single().actionIntent.send()
                    val result = stopped.get(2, TimeUnit.SECONDS)
                    check(result.getString("state") == "target-changed" && !result.has("capture")) { "Expected stopped projection, received ${result.optString("state")}" }
                    report.putLong("stopToWaitResultMs", SystemClock.elapsedRealtime() - started)
                } finally { stoppingWait.shutdownNow() }
            }
            await { state() == "consent-required" && notice() == null }
            assertConsentRequired(access, guard)
            val invalidated = call("screen.wait", label, waitArgs(350))
            check(invalidated.getString("state") == "target-changed" && !invalidated.has("capture"))
            if (base != null) {
                val (status, payload) = remote("screen.capture")
                check(status == 409 && payload.getString("errorCode") == "PHONE_SCREEN_CONSENT_REQUIRED")
                report.putString("relay", "PASS: Android event worker delivered capture and change-aware wait through the isolated Relay. Status remained available during wait.")
            }
            report.putString("result", "PASS: original consent and notices; static wait, simultaneous observers, changed PNG, and old-frame invalidation on stop")
        } catch (error: Throwable) {
            code = Activity.RESULT_CANCELED
            report.putString("error", error.stackTraceToString())
        } finally {
            restoreTouch?.invoke()
            relayBackend?.stop()
            targetContext.stopService(Intent(targetContext, PhoneScreenShareService::class.java))
            finish(code, report)
        }
    }

    private fun verifyApps(automation: UiAutomation, source: JSONObject, report: Bundle,
                           call: (String, String, JSONObject) -> JSONObject) {
        val label = "应用启动验收"
        val directory = call("apps.list", label, JSONObject())
        check(directory.getString("state") == "ready")
        val apps = directory.getJSONArray("apps")
        val settings = (0 until apps.length()).map(apps::getJSONObject)
            .first { it.getString("packageName") == "com.android.settings" && it.getString("appId").endsWith("/.Settings") }
        val unknownId = UUID.randomUUID().toString()
        val unknown = call("apps.open", label, JSONObject().put("requestId", unknownId)
            .put("appId", "com.rabi.link/.phonecontrol.PhoneScreenShareService"))
        check(unknown.getString("state") == "app-unavailable")
        check(call("input.status", label, JSONObject().put("requestId", unknownId)).getString("state") == "absent")
        val id = UUID.randomUUID().toString()
        val body = JSONObject().put("requestId", id).put("appId", settings.getString("appId"))
            .put("source", source).put("captureAfter", JSONObject().put("waitMs", 2500))
        val launch = call("apps.open", label, body)
        check(launch.getString("state") == "completed" && launch.getString("launchState") == "requested") {
            "Android launch receipt: ${launch.optString("state")}"
        }
        await(8000, { "Android Settings never came to the foreground" }) {
            automation.rootInActiveWindow?.packageName == "com.android.settings"
        }
        val capture = launch.getJSONObject("capture")
        check(capture.getString("state") == "captured") { "Launch capture was ${capture.getString("state")}" }
        val bytes = Base64.decode(capture.getString("data"), Base64.DEFAULT)
        checkNotNull(BitmapFactory.decodeByteArray(bytes, 0, bytes.size)).recycle()
        val original = call("input.status", label, JSONObject().put("requestId", id))
        check(original.getString("appId") == settings.getString("appId") && original.getString("launchState") == "requested")
        val replay = call("apps.open", label, body)
        check(replay.getJSONObject("capture").getString("frameId") == capture.getString("frameId") && !replay.getJSONObject("capture").has("data"))
        report.putString("apps", "PASS: launcher catalog, unavailable component rejected, Android Settings visibly foregrounded, capture and original launch receipt")
    }

    private fun enableTestTouch(automation: UiAutomation): () -> Unit {
        fun shell(command: String) = ParcelFileDescriptor.AutoCloseInputStream(automation.executeShellCommand(command))
            .bufferedReader().use { it.readText().trim() }
        check(shell("getprop ro.kernel.qemu") == "1") { "Touch integration only updates the isolated emulator" }
        val key = "enabled_accessibility_services"
        val component = "com.rabi.link/com.rabi.link.phonecontrol.PhoneTouchService"
        val original = shell("settings get secure $key")
        val previousState = shell("settings get secure accessibility_enabled")
        require(original.matches(Regex("[a-zA-Z0-9_./:]*")) && previousState in setOf("0", "1", "null"))
        val services = (original.takeUnless { it == "null" }.orEmpty().split(':').filter { it.isNotEmpty() } + component).distinct()
        shell("settings put secure $key ${services.joinToString(":")}")
        shell("settings put secure accessibility_enabled 1")
        return {
            if (original == "null" || original.isEmpty()) shell("settings delete secure $key") else shell("settings put secure $key $original")
            if (previousState == "null") shell("settings delete secure accessibility_enabled") else shell("settings put secure accessibility_enabled $previousState")
        }
    }

    private fun verifyTouch(fixture: Activity, manager: NotificationManager, automation: UiAutomation, report: Bundle,
                            call: (String, String, JSONObject) -> JSONObject): JSONObject {
        await { PhoneInputAccess.ready() }
        val clicks = AtomicInteger()
        lateinit var button: Button
        runOnMainSync {
            val content = fixture.findViewById<android.widget.FrameLayout>(android.R.id.content).getChildAt(0) as LinearLayout
            button = Button(fixture).apply {
                text = "Touch fixture"
                backgroundTintList = null
                setBackgroundColor(Color.BLUE)
                setOnClickListener { clicks.incrementAndGet(); setBackgroundColor(Color.YELLOW) }
                setOnLongClickListener { true }
            }
            content.addView(button)
        }
        waitForIdleSync()
        SystemClock.sleep(350)
        val source = call("screen.capture", "触屏验收", JSONObject().put("maxWidth", 320)).getJSONObject("source")
        val bounds = source.getJSONObject("bounds")
        val location = IntArray(2)
        val sample = IntArray(2)
        runOnMainSync {
            button.getLocationOnScreen(location)
            sample[0] = location[0] + button.width / 4
            sample[1] = location[1] + button.height / 4
            location[0] += button.width / 2
            location[1] += button.height / 2
        }
        val x = location[0] * source.getDouble("width") / bounds.getDouble("width")
        val y = location[1] * source.getDouble("height") / bounds.getDouble("height")
        val click = JSONObject().put("type", "click").put("x", x).put("y", y)
        val id = UUID.randomUUID().toString()
        val body = JSONObject().put("requestId", id).put("source", source).put("actions", JSONArray().put(click))
            .put("captureAfter", JSONObject().put("waitMs", 1000))
        val first = call("input.perform", "触屏验收", body)
        check(first.getString("state") == "completed") { "Touch receipt: $first" }
        await { clicks.get() == 1 }
        val capture = first.getJSONObject("capture")
        check(capture.getString("state") == "captured") { "Readback state: ${capture.getString("state")}" }
        val png = Base64.decode(capture.getString("data"), Base64.DEFAULT)
        val image = checkNotNull(BitmapFactory.decodeByteArray(png, 0, png.size))
        val pixel = image.getPixel((sample[0] * image.width / bounds.getDouble("width")).toInt(), (sample[1] * image.height / bounds.getDouble("height")).toInt())
        image.recycle()
        check(Color.red(pixel) >= 230 && Color.green(pixel) >= 230 && Color.blue(pixel) <= 30) { "Readback did not show the changed control: ${pixel.toUInt().toString(16)}" }
        val duplicate = call("input.perform", "触屏验收", body)
        check(duplicate.getInt("completedActions") == 1 && !duplicate.getJSONObject("capture").has("data"))
        check(clicks.get() == 1) { "Duplicate input dispatched again" }
        val status = call("input.status", "触屏验收", JSONObject().put("requestId", id))
        check(status.getInt("completedActions") == 1 && !status.has("intent"))
        check(status.getJSONObject("capture").getString("frameId") == capture.getString("frameId"))

        // An Android button can repaint on press and focus even when its handler has no work.
        // Use an empty part of the fixture to check the case with genuinely unchanged pixels.
        waitForIdleSync()
        SystemClock.sleep(300)
        val idleFrame = call("screen.capture", "无变化验收", JSONObject().put("maxWidth", 320))
        val idleSource = idleFrame.getJSONObject("source")
        val emptyTap = JSONObject().put("type", "click").put("x", idleSource.getDouble("width") / 2)
            .put("y", idleSource.getDouble("height") * 0.9)
        val stillId = UUID.randomUUID().toString()
        val stillBody = JSONObject().put("requestId", stillId).put("source", idleSource)
            .put("actions", JSONArray().put(emptyTap)).put("captureAfter", JSONObject().put("waitMs", 650))
        val idleReadback = Executors.newSingleThreadExecutor()
        try {
            val still = idleReadback.submit<JSONObject> { call("input.perform", "无变化验收", stillBody) }
            await(5000, { "Input receipt was not available during readback" }) {
                val current = call("input.status", "无变化验收", JSONObject().put("requestId", stillId))
                current.optString("state") == "completed" && current.optJSONObject("capture")?.optString("state") == "pending"
            }
            val captureStatus = still.get(3, TimeUnit.SECONDS).getJSONObject("capture")
            check(captureStatus.getString("state") == "unchanged" && !captureStatus.has("data")) {
                "Static readback was ${captureStatus.getString("state")} ${frameDifference(idleFrame, captureStatus)}"
            }
            check(clicks.get() == 1)
        } finally { idleReadback.shutdownNow() }

        fun touchOverlayVisible(): Boolean = ParcelFileDescriptor.AutoCloseInputStream(
            automation.executeShellCommand("dumpsys window windows")
        ).bufferedReader().useLines { lines -> lines.any { "RabiLink touch feedback" in it } }
        val swipe = JSONObject(emptyTap.toString()).put("type", "swipe").put("durationMs", 1200)
            .put("endX", idleSource.getDouble("width") * 0.7).put("endY", idleSource.getDouble("height") * 0.75)
        val swipeBody = JSONObject().put("requestId", UUID.randomUUID().toString()).put("source", idleSource)
            .put("actions", JSONArray().put(swipe))
        val feedbackCheck = Executors.newSingleThreadExecutor()
        try {
            val activeSwipe = feedbackCheck.submit<JSONObject> { call("input.perform", "滑动会话", swipeBody) }
            await(4000, { "Android did not attach the touch feedback window" }) { touchOverlayVisible() }
            check(!activeSwipe.isDone) { "The overlay was observed only after the swipe" }
            check(manager.activeNotifications.firstOrNull { it.id == 2027 }?.notification?.extras
                ?.getString(Notification.EXTRA_TITLE) == "滑动会话 正在操作你的手机")
            val live = call("screen.status", "状态读取", JSONObject())
            check(live.getString("layoutRevision") == idleSource.getString("layoutRevision"))
            val activity = live.getJSONObject("activity")
            check(activity.getJSONObject("operation").getString("requestId") == swipeBody.getString("requestId"))
            val pointer = activity.getJSONObject("pointer")
            check(pointer.getString("label") == "滑动会话" && pointer.getString("kind") == "swipe")
            check(pointer.getDouble("startX") in 0.499..0.501 && pointer.getDouble("startY") in 0.899..0.901)
            check(pointer.getDouble("x") in 0.499..0.701 && pointer.getInt("remainingMs") > 0)
            sendStatus(2, Bundle().apply { putString("pointerFrame", "swipe") })
            SystemClock.sleep(230)
            val clean = call("screen.capture", "确认原图", JSONObject().put("maxWidth", 320))
            assertCleanProjection(idleFrame, clean)
            check(activeSwipe.get(3, TimeUnit.SECONDS).getString("state") == "completed")
            await(1800) { !touchOverlayVisible() }
            val finished = call("screen.status", "状态读取", JSONObject()).getJSONObject("activity")
            check(!finished.has("operation") && !finished.has("pointer"))
        } finally { feedbackCheck.shutdownNow() }

        val hold = JSONObject(click.toString()).put("type", "longPress").put("durationMs", 1050)
        val cancellable = JSONObject().put("requestId", UUID.randomUUID().toString()).put("source", source)
            .put("actions", JSONArray().put(hold).put(click))
        val executor = Executors.newSingleThreadExecutor()
        try {
            val pending = executor.submit<JSONObject> { call("input.perform", "触屏停止验收", cancellable) }
            var stop: Notification? = null
            await {
                stop = manager.activeNotifications.firstOrNull { it.id == 2027 }?.notification
                stop?.extras?.getString(Notification.EXTRA_TITLE) == "触屏停止验收 正在操作你的手机"
            }
            await { touchOverlayVisible() }
            val stopAction = checkNotNull(stop).actions.single { it.title.toString() == "停止操作" }
            if (relayUrl != null) {
                val wrong = call("input.cancel", "停止别的批次", JSONObject().put("requestId", UUID.randomUUID().toString()))
                check(wrong.getString("state") == "absent")
                val cancelledRequest = call("input.cancel", "停止原操作", JSONObject().put("requestId", cancellable.getString("requestId")))
                check(cancelledRequest.getString("state") in listOf("cancel-requested", "cancelled"))
            } else stopAction.actionIntent.send()
            val cancelled = pending.get(4, TimeUnit.SECONDS)
            check(cancelled.getString("state") == "cancelled" && cancelled.getInt("completedActions") <= 1) { "Stop receipt: $cancelled" }
            check(clicks.get() == 1)
            await { !touchOverlayVisible() }
            check(!call("screen.status", "状态读取", JSONObject()).getJSONObject("activity").has("pointer"))
            await { manager.activeNotifications.firstOrNull { it.id == 2027 }?.notification?.actions?.none { it.title.toString() == "停止操作" } == true }
        } finally { executor.shutdownNow() }
        report.putString("touch", "PASS: tap and changed control pixels in one response; unchanged after static input; original receipt during readback and on replay; named stop prevents the next tap")
        report.putString("pointer", "PASS: named swipe over an attached non-input window, clean projection during feedback, automatic clear and exact stop")
        report.putString("activity", "PASS: separate named observers, exact input batch, current geometry, and pointer removal")
        waitForIdleSync()
        SystemClock.sleep(400)
        return call("screen.capture", "触屏验收", JSONObject().put("maxWidth", 32)).getJSONObject("source")
    }

    private fun assertCleanProjection(before: JSONObject, after: JSONObject) {
        fun bitmap(frame: JSONObject) = Base64.decode(frame.getString("data"), Base64.DEFAULT).let {
            checkNotNull(BitmapFactory.decodeByteArray(it, 0, it.size))
        }
        val expected = bitmap(before)
        val actual = bitmap(after)
        try {
            check(expected.width == actual.width && expected.height == actual.height)
            for (y in expected.height * 7 / 10 until expected.height * 93 / 100) {
                for (x in expected.width / 4 until expected.width * 9 / 10) {
                    check(expected.getPixel(x, y) == actual.getPixel(x, y)) {
                        "Touch feedback covered projected content at ($x, $y): ${expected.getPixel(x, y).toUInt().toString(16)} -> ${actual.getPixel(x, y).toUInt().toString(16)}"
                    }
                }
            }
        } finally { expected.recycle(); actual.recycle() }
    }

    private fun frameDifference(before: JSONObject, after: JSONObject): String {
        if (!after.has("data")) return ""
        fun decode(value: JSONObject): android.graphics.Bitmap {
            val bytes = Base64.decode(value.getString("data"), Base64.DEFAULT)
            return checkNotNull(BitmapFactory.decodeByteArray(bytes, 0, bytes.size))
        }
        val first = decode(before)
        val second = decode(after)
        try {
            var left = first.width; var right = -1; var top = first.height; var bottom = -1; var count = 0
            for (y in 0 until minOf(first.height, second.height)) for (x in 0 until minOf(first.width, second.width)) {
                if (first.getPixel(x, y) == second.getPixel(x, y)) continue
                count++
                left = minOf(left, x); right = maxOf(right, x); top = minOf(top, y); bottom = maxOf(bottom, y)
            }
            return "pixels=$count bounds=$left,$top..$right,$bottom in ${first.width}x${first.height}"
        } finally { first.recycle(); second.recycle() }
    }

    private fun remote(action: String, label: String? = null, parameters: JSONObject = JSONObject()): Pair<Int, JSONObject> {
        val base = requireNotNull(relayUrl)
        val connection = URL("$base/api/rabilink/mobile/screen").openConnection() as HttpURLConnection
        try {
            connection.requestMethod = "POST"
            connection.setRequestProperty("content-type", "application/json")
            connection.setRequestProperty("x-rabilink-token", requireNotNull(relayToken))
            connection.connectTimeout = 3000
            connection.readTimeout = 5000
            connection.doOutput = true
            val body = JSONObject().put("targetId", phoneId).put("targetGuid", "").put("action", action)
            if (action == "screen.capture") body.put("maxWidth", 32)
            if (action != "screen.status") body.put("observerLabel", label)
            parameters.keys().forEach { body.put(it, parameters.get(it)) }
            connection.outputStream.use { it.write(body.toString().toByteArray(Charsets.UTF_8)) }
            val status = connection.responseCode
            val source = if (status < 400) connection.inputStream else connection.errorStream
            return status to JSONObject(source?.bufferedReader()?.use { it.readText() } ?: "{}")
        } finally { connection.disconnect() }
    }

    private val silentListener = object : RabiGlassPcBackend.Listener {
        override fun onStatus(status: String?) = Unit
        override fun onTranscript(text: String?, routeProfileId: String?) = Unit
        override fun onDeliveryState(clientMessageId: String?, routeProfileId: String?, state: String?, failure: String?) = Unit
        override fun onReply(messageId: String?, routeProfileId: String?, text: String?, pcm: ByteArray?, attachments: JSONArray?) = null
        override fun onPersonaAvatarChanged(roleId: String?, avatarVersion: String?, avatarUrl: String?) = Unit
        override fun onError(message: String?) = Unit
    }

    private fun approve(node: AccessibilityNodeInfo): Boolean {
        val label = node.text?.toString()
        if (node.isClickable && label in setOf("Start now", "立即开始", "开始")) return node.performAction(AccessibilityNodeInfo.ACTION_CLICK)
        for (index in 0 until node.childCount) if (node.getChild(index)?.let(::approve) == true) return true
        return false
    }

    private fun assertConsentRequired(access: PhoneScreenAccess, guard: Runnable) {
        val failure = runCatching { access.execute("screen.capture", JSONObject(), guard, "fixture-phone") }.exceptionOrNull() as? RabiPhoneFiles.Failure
        check(failure?.code == "PHONE_SCREEN_CONSENT_REQUIRED")
    }

    private fun await(timeout: Long = 5_000, failure: () -> String = { "Timed out waiting for the phone screen state" }, predicate: () -> Boolean) {
        val deadline = SystemClock.elapsedRealtime() + timeout
        while (!predicate()) {
            check(SystemClock.elapsedRealtime() < deadline, failure)
            SystemClock.sleep(50)
        }
    }
}
