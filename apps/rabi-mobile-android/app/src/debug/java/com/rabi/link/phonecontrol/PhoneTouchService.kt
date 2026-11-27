package com.rabi.link.phonecontrol

import android.accessibilityservice.AccessibilityService
import android.accessibilityservice.GestureDescription
import android.content.ActivityNotFoundException
import android.content.ComponentName
import android.content.Intent
import android.content.pm.ResolveInfo
import android.graphics.Path
import android.os.Handler
import android.os.Looper
import android.view.accessibility.AccessibilityEvent
import java.util.concurrent.CompletableFuture
import java.util.concurrent.TimeUnit

class PhoneTouchService : AccessibilityService() {
    private val main = Handler(Looper.getMainLooper())
    private lateinit var feedback: PhoneTouchOverlay
    private var window: Pair<String, Int>? = null
    private val driver = object : PhoneTouchDriver {
        override fun apps(): List<PhoneLauncherApp> = launchers().map { match ->
            val info = match.activityInfo
            val component = ComponentName(info.packageName, info.name)
            PhoneLauncherApp(component.flattenToShortString(), match.loadLabel(packageManager).toString().take(160), info.packageName)
        }.distinctBy { it.id }.sortedWith(compareBy({ it.name.lowercase() }, { it.id }))

        override fun canOpen(appId: String): Boolean = resolveLauncher(appId) != null

        override fun clearFeedback(requestId: String?) {
            main.post {
                PhoneScreenShareService.current()?.clearTouchFeedback(requestId)
                feedback.clear(requestId)
            }
        }

        override fun suspendFeedback(): AutoCloseable = feedback.suspendForCapture()

        override fun dispatch(action: PhoneTouchAction, requestId: String, label: String, allowed: () -> Boolean): PhoneTouchDriver.Result {
            val result = CompletableFuture<PhoneTouchDriver.Result>()
            main.post {
                if (result.isDone || !runCatching(allowed).getOrDefault(false)) {
                    result.complete(PhoneTouchDriver.Result.REJECTED)
                    return@post
                }
                try {
                    if (action.kind == "open-app") {
                        val component = action.appId?.let(::resolveLauncher)
                        if (component == null || !runCatching(allowed).getOrDefault(false)) {
                            result.complete(PhoneTouchDriver.Result.REJECTED)
                        } else {
                            startActivity(Intent.makeMainActivity(component).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_RESET_TASK_IF_NEEDED))
                            result.complete(PhoneTouchDriver.Result.COMPLETED)
                        }
                        return@post
                    }
                    if (action.kind == "back") {
                        result.complete(if (performGlobalAction(GLOBAL_ACTION_BACK)) PhoneTouchDriver.Result.COMPLETED else PhoneTouchDriver.Result.REJECTED)
                        return@post
                    }
                    val path = Path().apply {
                        moveTo(action.x, action.y)
                        if (action.kind == "swipe") lineTo(action.endX, action.endY)
                    }
                    val gesture = GestureDescription.Builder()
                        .addStroke(GestureDescription.StrokeDescription(path, 0, action.durationMs)).build()
                    val callback = object : GestureResultCallback() {
                        override fun onCompleted(gestureDescription: GestureDescription?) { result.complete(PhoneTouchDriver.Result.COMPLETED) }
                        override fun onCancelled(gestureDescription: GestureDescription?) { result.complete(PhoneTouchDriver.Result.INTERRUPTED) }
                    }
                    if (dispatchGesture(gesture, callback, main)) {
                        val marker = PhoneTouchFeedback(requestId, label, action)
                        PhoneScreenShareService.current()?.publishTouchFeedback(marker)
                        feedback.show(marker)
                    } else result.complete(PhoneTouchDriver.Result.REJECTED)
                } catch (_: ActivityNotFoundException) {
                    result.complete(PhoneTouchDriver.Result.REJECTED)
                } catch (_: SecurityException) {
                    result.complete(PhoneTouchDriver.Result.REJECTED)
                } catch (error: RuntimeException) {
                    android.util.Log.w("RabiPhoneTouch", "Android did not confirm ${action.kind}: ${error.javaClass.simpleName}")
                    result.complete(PhoneTouchDriver.Result.UNCONFIRMED)
                }
            }
            return try { result.get(action.durationMs + 1500, TimeUnit.MILLISECONDS) }
            catch (_: Exception) { result.complete(PhoneTouchDriver.Result.UNCONFIRMED); PhoneTouchDriver.Result.UNCONFIRMED }
        }
    }

    private fun launchers(packageName: String? = null): List<ResolveInfo> {
        val query = Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_LAUNCHER)
        if (packageName != null) query.setPackage(packageName)
        @Suppress("DEPRECATION")
        return packageManager.queryIntentActivities(query, 0).filter {
            val info = it.activityInfo
            info != null && info.exported && info.enabled && info.applicationInfo.enabled
        }
    }

    private fun resolveLauncher(appId: String): ComponentName? {
        val component = ComponentName.unflattenFromString(appId) ?: return null
        if (component.flattenToShortString() != appId) return null
        return component.takeIf { launchers(it.packageName).any { match -> match.activityInfo.name == it.className } }
    }

    override fun onServiceConnected() {
        super.onServiceConnected()
        if (!::feedback.isInitialized) feedback = PhoneTouchOverlay(this, main)
        PhoneInputAccess.attach(driver)
    }

    override fun onAccessibilityEvent(event: AccessibilityEvent) {
        if (event.eventType != AccessibilityEvent.TYPE_WINDOW_STATE_CHANGED) return
        val current = event.packageName?.toString().orEmpty() to event.windowId
        if (current == window) return
        window = current
        PhoneInputAccess.windowChanged()
    }

    override fun onInterrupt() { PhoneInputAccess.stopCurrent() }
    override fun onDestroy() {
        PhoneInputAccess.detach(driver)
        PhoneScreenShareService.current()?.clearTouchFeedback(null)
        if (::feedback.isInitialized) feedback.clear()
        super.onDestroy()
    }
}
