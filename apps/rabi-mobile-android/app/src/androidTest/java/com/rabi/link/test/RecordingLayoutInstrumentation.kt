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
            val monitor=addMonitor(RabiRecordingHubActivity::class.java.name,null,false)
            targetContext.startActivity(Intent(targetContext,RabiRecordingHubActivity::class.java).putExtra("page","records").addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TASK))
            val activity=monitor.waitForActivityWithTimeout(30000) ?: error("Recording activity did not open")
            removeMonitor(monitor); waitForIdleSync()
            val all=views(activity.window.decorView)
            val ruler=all.filterIsInstance<RecordingTimeRuler>().single()
            val toggle=all.single { it.contentDescription?.toString()=="开始或暂停记录" }
            val stage=ruler.parent as View
            val rect=android.graphics.Rect(); runOnMainSync { stage.getGlobalVisibleRect(rect) }
            check(kotlin.math.abs(rect.height()-rect.width()*9/16)<=1)
            check(!ruler.isShown && !toggle.isShown)
            tap(rect.exactCenterX(),rect.exactCenterY())
            check(ruler.isShown && toggle.isShown)
            val after=android.graphics.Rect(); runOnMainSync { stage.getGlobalVisibleRect(after) }; check(rect==after)
            uiAutomation.takeScreenshot()?.let { bitmap -> java.io.File(targetContext.cacheDir,"record-layout-controls.png").outputStream().use { bitmap.compress(android.graphics.Bitmap.CompressFormat.PNG,100,it) }; bitmap.recycle() }
            tap(rect.exactCenterX(),rect.exactCenterY())
            check(!ruler.isShown && !toggle.isShown)
            uiAutomation.takeScreenshot()?.let { bitmap -> java.io.File(targetContext.cacheDir,"record-layout-clean.png").outputStream().use { bitmap.compress(android.graphics.Bitmap.CompressFormat.PNG,100,it) }; bitmap.recycle() }
            result.putString("result","PASS: 16:9 preview, tap reveals/hides recording and timeline, stable bounds")
            result.putString("previewBounds",rect.toShortString())
        } catch(error: Throwable) { result.putString("error",error.stackTraceToString()); code=Activity.RESULT_CANCELED }
        finish(code,result)
    }
}
