package com.rabi.link.test

import android.app.Activity
import android.app.Instrumentation
import android.content.Intent
import android.os.Bundle
import android.os.SystemClock
import android.view.View
import android.view.ViewGroup
import android.widget.ListView
import android.widget.Spinner
import android.widget.TextView
import com.rabi.link.recording.RabiRecordingHubActivity

/** Exercises review controls only; never toggles recording or logs event contents. */
class RecordingAsrNavigationInstrumentation : Instrumentation() {
    override fun onCreate(arguments: Bundle) { super.onCreate(arguments); start() }
    private fun views(view: View): List<View> = listOf(view) + if(view is ViewGroup) (0 until view.childCount).flatMap { views(view.getChildAt(it)) } else emptyList()
    private fun loaded(activity: Activity) {
        val deadline = SystemClock.uptimeMillis()+45000
        do {
            var busy = false
            runOnMainSync { busy = views(activity.window.decorView).filterIsInstance<TextView>().any { it.text.toString() in listOf("正在读取记录…","正在更新…") } }
            if(!busy) { waitForIdleSync(); return }
            SystemClock.sleep(100)
        } while(SystemClock.uptimeMillis() < deadline)
        error("Review loading timed out")
    }
    override fun onStart() {
        val result = Bundle(); var code = Activity.RESULT_OK
        val watchdog = Thread { try { Thread.sleep(90000); finish(Activity.RESULT_CANCELED,Bundle().apply { putString("error","UI acceptance timed out") }) } catch (_: InterruptedException) { } }.apply { isDaemon = true; start() }
        try {
            uiAutomation.executeShellCommand("am start -n com.rabi.link/.MainActivity").close()
            SystemClock.sleep(1000)
            val activity = startActivitySync(Intent(targetContext,RabiRecordingHubActivity::class.java).putExtra("page","records").addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
            waitForIdleSync(); loaded(activity)
            val tree = views(activity.window.decorView)
            val previous = tree.single { it.contentDescription == "上一个事件" }
            val next = tree.single { it.contentDescription == "下一个事件" }
            val type = tree.single { it.contentDescription == "筛选事件类型" } as Spinner
            val list = tree.filterIsInstance<ListView>().single()
            check(previous.isShown && next.isShown && previous.parent === next.parent)
            runOnMainSync { type.setSelection(1) }; waitForIdleSync(); loaded(activity)
            runOnMainSync { previous.performClick() }; loaded(activity)
            if(list.count > 1) {
                val original = list.getChildAt(0).tag
                runOnMainSync { previous.performClick() }; loaded(activity)
                check(list.getChildAt(0).tag != original) { "Previous event did not advance" }
                runOnMainSync { next.performClick() }; loaded(activity)
                check(list.getChildAt(0).tag == original) { "Next event did not restore the selected event" }
                result.putString("navigation","PASS: real ASR previous/next round trip")
            } else result.putString("navigation","NOT_COVERED: fewer than two ASR events")
            runOnMainSync { tree.filterIsInstance<TextView>().single { it.text.toString() == "回到实时" }.performClick() }
            waitForIdleSync()
            result.putString("result","PASS: toolbar controls, ASR type filter and return-to-live action")
        } catch(error: Throwable) { code = Activity.RESULT_CANCELED; result.putString("error",error.stackTraceToString()) }
        watchdog.interrupt()
        finish(code,result)
    }
}
