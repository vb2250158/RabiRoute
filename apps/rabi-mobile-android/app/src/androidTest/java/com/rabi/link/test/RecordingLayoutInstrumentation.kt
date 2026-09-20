package com.rabi.link.test

import android.app.Activity
import android.app.Instrumentation
import android.content.Intent
import android.os.Bundle
import android.os.SystemClock
import android.view.View
import android.view.ViewGroup
import android.view.MotionEvent
import com.rabi.link.recording.RabiRecordingHubActivity
import com.rabi.link.recording.RecordingTimeRuler

/** Real touch checks: player proportions and overlays cannot shift the event list. */
class RecordingLayoutInstrumentation : Instrumentation() {
    private fun awaitLoaded(activity: Activity): android.widget.ListView {
        val deadline = SystemClock.uptimeMillis() + 45000
        while (SystemClock.uptimeMillis() < deadline) {
            var busy = true
            runOnMainSync {
                busy = views(activity.window.decorView).filterIsInstance<android.widget.TextView>()
                    .any { it.text.toString() in listOf("正在读取记录…", "正在更新…") }
            }
            if (!busy) break
            SystemClock.sleep(200)
        }
        waitForIdleSync()
        var list: android.widget.ListView? = null
        runOnMainSync {
            val tree = views(activity.window.decorView)
            check(tree.filterIsInstance<android.widget.TextView>().none {
                it.text.toString().startsWith("刷新失败") || it.text.toString() in listOf("正在读取记录…", "正在更新…")
            }) { "Record loading failed or exceeded 45 seconds" }
            list = tree.filterIsInstance<android.widget.ListView>().single()
        }
        return list!!
    }
    override fun onCreate(arguments: Bundle) { super.onCreate(arguments); start() }
    private fun views(v: View): List<View> = listOf(v) + if(v is ViewGroup) (0 until v.childCount).flatMap { views(v.getChildAt(it)) } else emptyList()
    private fun tap(x: Float,y: Float) {
        val t=SystemClock.uptimeMillis()
        sendPointerSync(MotionEvent.obtain(t,t,MotionEvent.ACTION_DOWN,x,y,0))
        sendPointerSync(MotionEvent.obtain(t,t+80,MotionEvent.ACTION_UP,x,y,0)); waitForIdleSync()
    }
    override fun onStart() {
        val result=Bundle(); var code=Activity.RESULT_OK
        try {
            val activity = startActivitySync(Intent(targetContext,RabiRecordingHubActivity::class.java)
                .putExtra("page","records").addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
            waitForIdleSync()
            val list = awaitLoaded(activity)
            result.putInt("eventCount",list.count)
            val all=views(activity.window.decorView)
            val ruler=all.filterIsInstance<RecordingTimeRuler>().single()
            val toggle=all.single { it.contentDescription?.toString()=="开始或暂停记录" }
            val stage=all.single { it.contentDescription?.toString()=="记录预览" }
            val rect=android.graphics.Rect(); runOnMainSync { stage.getGlobalVisibleRect(rect) }
            check(kotlin.math.abs(rect.height()-rect.width()*9/16)<=1)
            check(ruler.isShown && !toggle.isShown)
            tap(rect.exactCenterX(),rect.exactCenterY())
            check(ruler.isShown && toggle.isShown)
            val after=android.graphics.Rect(); runOnMainSync { stage.getGlobalVisibleRect(after) }; check(rect==after)
            uiAutomation.takeScreenshot()?.let { bitmap -> java.io.File(targetContext.cacheDir,"record-layout-controls.png").outputStream().use { bitmap.compress(android.graphics.Bitmap.CompressFormat.PNG,100,it) }; bitmap.recycle() }
            tap(rect.exactCenterX(),rect.exactCenterY())
            check(ruler.isShown && !toggle.isShown)
            uiAutomation.takeScreenshot()?.let { bitmap -> java.io.File(targetContext.cacheDir,"record-layout-clean.png").outputStream().use { bitmap.compress(android.graphics.Bitmap.CompressFormat.PNG,100,it) }; bitmap.recycle() }
            result.putString("result","PASS: 16:9 preview, persistent timeline, tap toggles recording controls, stable bounds")
            result.putString("previewBounds",rect.toShortString())
            if (list.count > 0) {
                runOnMainSync { list.getChildAt(0).performClick() }
                waitForIdleSync()
                val anchor = list.getChildAt(0).tag
                runOnMainSync { all.single { it.contentDescription == "刷新记录和转写" }.performClick() }
                awaitLoaded(activity)
                check(list.getChildAt(0).tag == anchor) { "Refresh moved the selected event" }
                result.putString("eventClickAndRefresh", "PASS")
            } else result.putString("eventClickAndRefresh", "NOT_COVERED: no saved events in current range")
            val monitor = addMonitor(RabiRecordingHubActivity::class.java.name,null,false)
            runOnMainSync { activity.requestedOrientation = android.content.pm.ActivityInfo.SCREEN_ORIENTATION_LANDSCAPE }
            val landscape = monitor.waitForActivityWithTimeout(10000) ?: error("Landscape recreation timed out")
            removeMonitor(monitor)
            val landscapeList = awaitLoaded(landscape)
            val tree = views(landscape.window.decorView)
            val landscapeStage = tree.single { it.contentDescription == "记录预览" }
            val landscapeRuler = tree.filterIsInstance<RecordingTimeRuler>().single()
            val previewRect = android.graphics.Rect(); val listRect = android.graphics.Rect(); val rulerRect = android.graphics.Rect()
            runOnMainSync {
                landscapeStage.getGlobalVisibleRect(previewRect)
                landscapeList.getGlobalVisibleRect(listRect)
                landscapeRuler.getGlobalVisibleRect(rulerRect)
            }
            check(listRect.left >= previewRect.right) { "Landscape list is not beside preview" }
            check(rulerRect.height() == landscapeRuler.height && rulerRect.height() > 0) { "Landscape timeline is clipped" }
            uiAutomation.takeScreenshot()?.let { bitmap -> java.io.File(targetContext.cacheDir,"record-layout-landscape.png").outputStream().use { bitmap.compress(android.graphics.Bitmap.CompressFormat.PNG,100,it) }; bitmap.recycle() }
            result.putString("landscape", "PASS: side-by-side layout and fully visible timeline")
            runOnMainSync { landscape.requestedOrientation = android.content.pm.ActivityInfo.SCREEN_ORIENTATION_UNSPECIFIED }
        } catch(error: Throwable) { result.putString("error",error.stackTraceToString()); code=Activity.RESULT_CANCELED }
        finish(code,result)
    }
}
