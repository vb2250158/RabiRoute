package com.rabi.link.test

import android.app.Activity
import android.app.Instrumentation
import android.content.*
import android.content.pm.PackageManager
import android.os.Bundle
import com.rabi.link.RabiConversationBootReceiver
import com.rabi.link.RabiConversationService
import com.rabi.link.recording.AllDayRecordingSettings

/** Real preferences and receiver; isolated fixture never changes the user's recording switch. */
class RecordingRestoreInstrumentation : Instrumentation() {
    override fun onCreate(arguments: Bundle) { super.onCreate(arguments); start() }
    override fun onStart() {
        val result = Bundle()
        val prefix = "restore-test-${System.nanoTime()}-"
        val preferences = mutableSetOf<String>()
        val actions = mutableListOf<String?>()
        val isolated = object : ContextWrapper(targetContext) {
            override fun getSharedPreferences(name: String, mode: Int): SharedPreferences {
                preferences.add(prefix + name)
                return super.getSharedPreferences(prefix + name, mode)
            }
            override fun getSystemService(name: String): Any? = null
            override fun checkPermission(permission: String, pid: Int, uid: Int) = PackageManager.PERMISSION_GRANTED
            override fun startForegroundService(intent: Intent): ComponentName? {
                actions.add(intent.action); return intent.component
            }
            override fun startService(intent: Intent): ComponentName? {
                actions.add(intent.action); return intent.component
            }
        }
        var code = Activity.RESULT_OK
        try {
            val receiver = RabiConversationBootReceiver()
            RabiConversationService.resumeRecordingFromForeground(isolated)
            check(actions.isEmpty())
            AllDayRecordingSettings.load(isolated).withEnabled(true, 100).save(isolated)
            receiver.onReceive(isolated, Intent(Intent.ACTION_BOOT_COMPLETED))
            val rebooted = AllDayRecordingSettings.load(isolated)
            check(rebooted.autoResume && !rebooted.running)
            check(actions == listOf(RabiConversationService.ACTION_RESTORE))
            RabiConversationService.resumeRecordingFromForeground(isolated)
            check(actions.last() == RabiConversationService.ACTION_RECORD)
            val count = actions.size
            RabiConversationService.resumeRecordingFromForeground(isolated)
            check(actions.size == count) // repeated Activity resume must not start a second capture
            AllDayRecordingSettings.load(isolated).withRunning(false, 200).save(isolated)
            check(AllDayRecordingSettings.load(isolated).autoResume) // transient interruption retains intent
            RabiConversationService.pauseRecording(isolated)
            check(!AllDayRecordingSettings.load(isolated).autoResume)
            com.rabi.link.RabiConversationServiceState.setRestoreEnabled(isolated, false)
            actions.clear()
            receiver.onReceive(isolated, Intent(Intent.ACTION_BOOT_COMPLETED))
            RabiConversationService.resumeRecordingFromForeground(isolated)
            check(actions.isEmpty())
            result.putString("result", "PASS: boot preserves enabled state; foreground resumes once; interruption retains state; explicit off stays off")
        } catch (error: Throwable) {
            code = Activity.RESULT_CANCELED; result.putString("error", error.stackTraceToString())
        } finally {
            preferences.forEach { targetContext.deleteSharedPreferences(it) }
        }
        finish(code, result)
    }
}
