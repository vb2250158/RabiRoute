package com.rabi.link.test

import android.app.Activity
import android.app.Instrumentation
import android.content.Intent
import android.os.Bundle
import android.os.SystemClock
import android.view.MotionEvent
import com.rabi.link.recording.RabiRecordingHubActivity

/** Exercise actual touch dispatch and asynchronous storage scanning on a device. */
class StorageUiInstrumentation : Instrumentation() {
    override fun onCreate(arguments: Bundle) { super.onCreate(arguments); start() }
    override fun onStart() {
        val result = Bundle(); var code = Activity.RESULT_OK
        try {
            val monitor = addMonitor(RabiRecordingHubActivity::class.java.name,null,false)
            targetContext.startActivity(Intent(targetContext,RabiRecordingHubActivity::class.java).putExtra("page","records").addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TASK))
            check(monitor.waitForActivityWithTimeout(10000) != null)
            removeMonitor(monitor); waitForIdleSync()
            val preview=uiAutomation.rootInActiveWindow
            fun reveal(n: android.view.accessibility.AccessibilityNodeInfo): Boolean {
                if(n.contentDescription?.toString()=="显示或隐藏记录控制") return n.performAction(android.view.accessibility.AccessibilityNodeInfo.ACTION_CLICK)
                for(i in 0 until n.childCount) n.getChild(i)?.let { if(reveal(it)) return true }
                return false
            }
            if(preview.findAccessibilityNodeInfosByText("☰").isEmpty()) { check(reveal(preview)); waitForIdleSync() }
            uiAutomation.rootInActiveWindow.findAccessibilityNodeInfosByText("☰").first().performAction(android.view.accessibility.AccessibilityNodeInfo.ACTION_CLICK)
            waitForIdleSync()
            val button = uiAutomation.rootInActiveWindow.findAccessibilityNodeInfosByText("存储管理").first { it.text?.toString() == "存储管理" }
            val bounds = android.graphics.Rect(); button.getBoundsInScreen(bounds)
            val now = SystemClock.uptimeMillis()
            sendPointerSync(MotionEvent.obtain(now,now,MotionEvent.ACTION_DOWN,bounds.exactCenterX(),bounds.exactCenterY(),0))
            sendPointerSync(MotionEvent.obtain(now,now+100,MotionEvent.ACTION_UP,bounds.exactCenterX(),bounds.exactCenterY(),0))
            val deadline = SystemClock.uptimeMillis()+30000
            while(SystemClock.uptimeMillis()<deadline && uiAutomation.rootInActiveWindow.findAccessibilityNodeInfosByText("记录总占用").isEmpty()) Thread.sleep(200)
            check(uiAutomation.rootInActiveWindow.findAccessibilityNodeInfosByText("记录总占用").isNotEmpty()) { "Storage touch or scan did not complete" }
            val expected = com.rabi.link.recording.RecordingStorage.formatBytes(com.rabi.link.recording.RecordingStorage.scan(targetContext.filesDir,targetContext.cacheDir).totalBytes)
            check(uiAutomation.rootInActiveWindow.findAccessibilityNodeInfosByText(expected).isNotEmpty()) { "Displayed total does not match files" }
            uiAutomation.takeScreenshot().let { bitmap -> java.io.File(targetContext.cacheDir,"storage-acceptance.png").outputStream().use { bitmap.compress(android.graphics.Bitmap.CompressFormat.PNG,100,it) }; bitmap.recycle() }
            uiAutomation.rootInActiveWindow.findAccessibilityNodeInfosByText("刷新").first { it.text?.toString() == "刷新" }.performAction(android.view.accessibility.AccessibilityNodeInfo.ACTION_CLICK)
            Thread.sleep(1000)
            val refreshedBy = SystemClock.uptimeMillis()+30000
            while(SystemClock.uptimeMillis()<refreshedBy && uiAutomation.rootInActiveWindow.findAccessibilityNodeInfosByText("记录总占用").isEmpty()) Thread.sleep(200)
            check(uiAutomation.rootInActiveWindow.findAccessibilityNodeInfosByText(expected).isNotEmpty())
            result.putString("total",expected)
            result.putString("result","PASS: touch opens storage and scan completes")
        } catch(error: Throwable) { result.putString("error",error.stackTraceToString()); code=Activity.RESULT_CANCELED }
        finish(code,result)
    }
}
