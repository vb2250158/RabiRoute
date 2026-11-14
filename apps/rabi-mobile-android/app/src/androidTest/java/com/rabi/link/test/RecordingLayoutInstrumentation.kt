package com.rabi.link.test

import android.app.Activity
import android.app.Instrumentation
import android.content.Context
import android.content.ContextWrapper
import android.content.Intent
import android.content.SharedPreferences
import android.database.DatabaseErrorHandler
import android.database.sqlite.SQLiteDatabase
import android.graphics.Rect
import android.os.Bundle
import android.os.SystemClock
import android.view.MotionEvent
import android.view.View
import android.view.ViewGroup
import android.widget.LinearLayout
import android.widget.ListView
import android.widget.TextView
import com.rabi.link.RabiMobileUi
import com.rabi.link.recording.RabiRecordingHubActivity
import com.rabi.link.recording.RecordingReviewPanel
import java.io.File
import org.json.JSONObject

/** Measures real history space and checks the live-to-history transition and modal record playback. */
class RecordingLayoutInstrumentation : Instrumentation() {
    override fun onCreate(arguments: Bundle) { super.onCreate(arguments); start() }
    private fun views(v: View): List<View> = listOf(v) + if(v is ViewGroup) (0 until v.childCount).flatMap { views(v.getChildAt(it)) } else emptyList()
    /** Report failed assertions to the runner instead of crashing the target's main looper. */
    private fun onUi(action: () -> Unit) {
        var failure: Throwable? = null
        super.runOnMainSync { try { action() } catch(error: Throwable) { failure = error } }
        failure?.let { throw it }
    }
    private fun screenshot(name: String) {
        uiAutomation.takeScreenshot()?.let { bitmap ->
            File(targetContext.cacheDir,"record-browse-$name.png").outputStream().use { bitmap.compress(android.graphics.Bitmap.CompressFormat.PNG,100,it) }
            bitmap.recycle()
        }
    }
    private fun awaitList(activity: Activity, minimum: Int): ListView {
        var list: ListView? = null
        val deadline = SystemClock.uptimeMillis()+30000
        while(SystemClock.uptimeMillis() < deadline) {
            onUi { list = views(activity.window.decorView).filterIsInstance<ListView>().singleOrNull() }
            if(list != null) {
                var ready = false
                onUi { ready = list!!.count >= minimum && list!!.height > 0 }
                if(ready) { waitForIdleSync(); return list!! }
            }
            SystemClock.sleep(100)
        }
        error("Record list did not become usable within 30 seconds")
    }
    private fun drag(x: Float, from: Float, to: Float) {
        val started = SystemClock.uptimeMillis()
        sendPointerSync(MotionEvent.obtain(started,started,MotionEvent.ACTION_DOWN,x,from,0))
        for(step in 1..12) {
            SystemClock.sleep(25)
            sendPointerSync(MotionEvent.obtain(started,SystemClock.uptimeMillis(),MotionEvent.ACTION_MOVE,x,from+(to-from)*step/12,0))
        }
        sendPointerSync(MotionEvent.obtain(started,SystemClock.uptimeMillis(),MotionEvent.ACTION_UP,x,to,0))
        SystemClock.sleep(450); waitForIdleSync()
    }
    override fun onStart() {
        val output = Bundle(); var code = Activity.RESULT_OK
        var activity: Activity? = null; var fixture: RecordingReviewPanel? = null
        val name = "record-list-ui-${System.nanoTime()}"
        val root = File(targetContext.cacheDir,name).apply { mkdirs() }
        val prefs = mutableSetOf<String>()
        try {
            activity = startActivitySync(Intent(targetContext,RabiRecordingHubActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
            waitForIdleSync()
            var list: ListView? = null
            onUi { list = views(activity!!.window.decorView).filterIsInstance<ListView>().single() }
            val actualPanel = RabiRecordingHubActivity::class.java.getDeclaredField("reviewPanel").apply { isAccessible = true }.get(activity) as RecordingReviewPanel
            screenshot("phone-live")
            onUi {
                RecordingReviewPanel::class.java.getDeclaredMethod("enterHistory").apply { isAccessible = true }.invoke(actualPanel)
            }
            waitForIdleSync()
            onUi {
                val content = activity!!.findViewById<View>(android.R.id.content)
                val viewport = list!!.parent as View
                check(viewport.height >= content.height*0.65f) { "History occupies only ${viewport.height}/${content.height} of the screen" }
                check(views(activity!!.window.decorView).single { it.contentDescription == "开始或暂停记录" }.isShown) { "History hid the recording switch" }
                check(views(activity!!.window.decorView).single { it.contentDescription == "记录更多操作" }.isShown)
                check(!views(activity!!.window.decorView).single { it.contentDescription == "实时记录预览" }.isShown)
                val completeRows = (0 until list!!.childCount).count { list!!.getChildAt(it).bottom <= list!!.height }
                check(completeRows >= minOf(5,list!!.count)) { "Too few fully readable rows: $completeRows" }
                output.putInt("realListHeightPx",viewport.height); output.putInt("realContentHeightPx",content.height)
                output.putInt("realCompleteRows",completeRows)
            }
            screenshot("phone-history")
            onUi { actualPanel.close() }
            val isolated = object : ContextWrapper(activity!!) {
                override fun getApplicationContext(): Context = this
                override fun getFilesDir(): File = root
                override fun getCacheDir(): File = File(root,"cache").apply { mkdirs() }
                override fun getSharedPreferences(key: String,mode: Int): SharedPreferences {
                    synchronized(prefs) { prefs.add("$name-$key") }
                    return targetContext.getSharedPreferences("$name-$key",mode)
                }
                override fun getDatabasePath(key: String): File = File(root,"databases/$key").also { it.parentFile!!.mkdirs() }
                override fun openOrCreateDatabase(key: String,mode: Int,factory: SQLiteDatabase.CursorFactory?): SQLiteDatabase = SQLiteDatabase.openOrCreateDatabase(getDatabasePath(key),factory)
                override fun openOrCreateDatabase(key: String,mode: Int,factory: SQLiteDatabase.CursorFactory?,handler: DatabaseErrorHandler?): SQLiteDatabase = SQLiteDatabase.openOrCreateDatabase(getDatabasePath(key).path,factory,handler)
            }
            val segments = File(root,"rabi-conversation/audio-spool/segments").apply { mkdirs() }
            val now = java.util.Calendar.getInstance().apply { set(java.util.Calendar.HOUR_OF_DAY,12); set(java.util.Calendar.MINUTE,0); set(java.util.Calendar.SECOND,0); set(java.util.Calendar.MILLISECOND,0) }.timeInMillis
            val pcm = ByteArray(32000)
            val pcmHash = java.security.MessageDigest.getInstance("SHA-256").digest(pcm).joinToString("") { "%02x".format(it) }
            for(i in 0 until 205) {
                val id = "browse-audio-$i"
                File(segments,"$id.pcm").writeBytes(pcm)
                File(segments,"$id.json").writeText(JSONObject().put("eventId",id).put("captureId",id).put("sha256",pcmHash).put("pcmFileName","$id.pcm")
                    .put("sequence",i).put("bytes",32000).put("startedAt",now-i*10000L).put("endedAt",now-i*10000L+1000)
                    .put("source","mobile").put("processingPolicy","local_only").toString())
            }
            onUi {
                fixture = RecordingReviewPanel(isolated,{})
                val host = LinearLayout(activity).apply { orientation = LinearLayout.VERTICAL }
                host.addView(RabiMobileUi.title(activity!!,"记录",22f),LinearLayout.LayoutParams(-1,RabiMobileUi.dp(activity!!,56)))
                host.addView(fixture!!.view,LinearLayout.LayoutParams(-1,0,1f))
                host.addView(RabiMobileUi.bottomNavigation(activity!!,"records") {})
                activity!!.setContentView(host)
            }
            val records = awaitList(activity!!,100)
            onUi { check(records.count == 100) { "First page was not bounded" } }
            val tree = views(activity!!.window.decorView)
            val stage = tree.single { it.contentDescription == "实时记录预览" }
            onUi { check(stage.isShown) { "Initial page did not show live recording" } }
            val listBounds = Rect(); onUi { records.getGlobalVisibleRect(listBounds) }
            drag(listBounds.exactCenterX(),listBounds.bottom-40f,listBounds.top+40f)
            val historyBounds = Rect(); var first = 0; var offset = 0
            onUi {
                check(!stage.isShown) { "History scrolling left the live area on screen" }
                check(records.firstVisiblePosition > 0) { "The gesture did not continue into history scrolling" }
                check(records.childCount >= 5) { "History still shows fewer than five rows" }
                records.getGlobalVisibleRect(historyBounds); first = records.firstVisiblePosition; offset = records.getChildAt(0).top
                records.getChildAt(minOf(2,records.childCount-1)).performClick()
            }
            waitForIdleSync(); SystemClock.sleep(300)
            var openedDialog: android.app.AlertDialog? = null
            onUi {
                val dialog = RecordingReviewPanel::class.java.getDeclaredField("recordDialog").apply { isAccessible = true }.get(fixture) as android.app.AlertDialog
                openedDialog = dialog
                check(dialog.isShowing) { "Record selection did not open a dialog" }
                check(views(dialog.window!!.decorView).any { it.contentDescription == "历史记录弹窗预览" })
                check(!stage.isShown) { "Opening a record restored the live area" }
                val current = Rect(); records.getGlobalVisibleRect(current); check(current == historyBounds)
                check(records.firstVisiblePosition == first && records.getChildAt(0).top == offset) { "Dialog moved the history list" }
            }
            var playback: com.rabi.link.recording.RecordingPlaybackPanel? = null
            var seek: android.widget.SeekBar? = null
            val readyUntil = SystemClock.uptimeMillis()+15000
            while(SystemClock.uptimeMillis() < readyUntil) {
                var ready = false
                onUi {
                    playback = RecordingReviewPanel::class.java.getDeclaredField("player").apply { isAccessible = true }.get(fixture) as? com.rabi.link.recording.RecordingPlaybackPanel
                    seek = views(openedDialog!!.window!!.decorView).filterIsInstance<android.widget.SeekBar>().singleOrNull()
                    ready = playback != null && seek?.isEnabled == true
                }
                if(ready) break
                SystemClock.sleep(100)
            }
            check(playback != null && seek?.isEnabled == true) { "Paused/offline history could not load a valid local recording" }
            val seekBounds = Rect(); onUi { seek!!.getGlobalVisibleRect(seekBounds) }
            val touchTime = SystemClock.uptimeMillis()
            val seekX = seekBounds.left+seekBounds.width()*0.6f
            sendPointerSync(MotionEvent.obtain(touchTime,touchTime,MotionEvent.ACTION_DOWN,seekX,seekBounds.exactCenterY(),0))
            sendPointerSync(MotionEvent.obtain(touchTime,SystemClock.uptimeMillis(),MotionEvent.ACTION_UP,seekX,seekBounds.exactCenterY(),0))
            SystemClock.sleep(300)
            onUi {
                val engine = com.rabi.link.recording.RecordingPlaybackPanel::class.java.getDeclaredField("player").apply { isAccessible = true }.get(playback) as androidx.media3.exoplayer.ExoPlayer
                check(engine.currentPosition in 350..850) { "Seek did not reach the original media: ${engine.currentPosition}" }
                check(!playback!!.state().playing) { "Scrubbing resumed a paused recording" }
                views(openedDialog!!.window!!.decorView).single { it.contentDescription == "播放历史记录" }.performClick()
            }
            SystemClock.sleep(1500)
            onUi {
                check(!playback!!.state().playing) { "Completed playback still showed a pause action" }
                views(openedDialog!!.window!!.decorView).single { it.contentDescription == "播放历史记录" }.performClick()
                check(playback!!.state().playing) { "Replay required a second tap" }
                openedDialog!!.dismiss()
            }
            waitForIdleSync()
            screenshot("history-dialog-closed")
            for(expected in listOf(200,205)) {
                onUi { records.setSelectionFromTop(records.count-2,0) }
                awaitList(activity!!,expected)
            }
            onUi {
                check(!stage.isShown)
                records.setSelectionFromTop(190,0)
            }
            waitForIdleSync()
            onUi { check(records.firstVisiblePosition >= 185); check(records.count == 205) }
            screenshot("history-expanded")
            onUi { views(activity!!.window.decorView).single { it.contentDescription == "返回实时" }.performClick() }
            waitForIdleSync()
            onUi { check(stage.isShown) { "Return to live did not restore the live pane" } }
            output.putString("result","PASS: history scrolling removes the whole live pane; 205 isolated records remain scrollable; record dialogs preserve the underlying list; return-to-live restores the live pane")
            output.putInt("fixtureRecords",205)
            output.putString("playback","PASS: paused local playback loads without a recording owner; seek preserves pause; completed media replays in one tap")
        } catch(error: Throwable) { code=Activity.RESULT_CANCELED; output.putString("error",error.stackTraceToString()) }
        finally {
            onUi { fixture?.close(); activity?.finish() }
            synchronized(prefs) { prefs.forEach { targetContext.deleteSharedPreferences(it) } }
            check(root.canonicalFile.parentFile == targetContext.cacheDir.canonicalFile)
            root.deleteRecursively()
        }
        finish(code,output)
    }
}
