package com.rabi.link.test

import android.app.Activity
import android.app.Instrumentation
import android.content.Intent
import android.os.Bundle
import android.view.View
import android.view.ViewGroup
import android.view.accessibility.AccessibilityNodeInfo
import android.widget.TextView
import com.rabi.link.recording.RabiRecordingHubActivity

class AsrUiInstrumentation : Instrumentation() {
    override fun onCreate(arguments: Bundle) { super.onCreate(arguments); start() }
    override fun onStart() {
        val result=Bundle(); var code=Activity.RESULT_OK
        try {
            val monitor=addMonitor(RabiRecordingHubActivity::class.java.name,null,false)
            targetContext.startActivity(Intent(targetContext,RabiRecordingHubActivity::class.java).putExtra("page","devices").addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TASK))
            val activity=monitor.waitForActivityWithTimeout(10000) ?: error("Phone did not open the recording page")
            removeMonitor(monitor)
            waitForIdleSync()
            fun views(v: View): List<View> = listOf(v)+(if(v is ViewGroup) (0 until v.childCount).flatMap { views(v.getChildAt(it)) } else emptyList())
            runOnMainSync { check(views(activity.window.decorView).filterIsInstance<TextView>().first { it.text.toString()=="ASR 设置" }.performClick()) }
            val deadline=System.currentTimeMillis()+20000
            var save: AccessibilityNodeInfo?=null
            while(System.currentTimeMillis()<deadline && save==null) {
                save=uiAutomation.rootInActiveWindow?.findAccessibilityNodeInfosByText("保存")?.firstOrNull { it.text?.toString() == "保存" }
                if(save==null) Thread.sleep(200)
            }
            check(save!=null) { "ASR dialog did not open" }
            var target = save
            while(target != null && !target.isClickable) target = target.parent
            check(target != null && target.performAction(AccessibilityNodeInfo.ACTION_CLICK))
            val savedBy = System.currentTimeMillis()+10000
            val enrollment = targetContext.getSharedPreferences("rabi_asr_enrollment",0)
            while(enrollment.getLong("requestedAt",0)==0L && System.currentTimeMillis()<savedBy) Thread.sleep(100)
            check(enrollment.getLong("requestedAt",0)>0L) { "ASR enrollment was not persisted" }
            result.putString("result","PASS: toolbar opens ASR list and Save is clickable")
        } catch(error: Throwable) { result.putString("error",error.stackTraceToString()); code=Activity.RESULT_CANCELED }
        finish(code,result)
    }
}
