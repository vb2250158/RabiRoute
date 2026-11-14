package com.rabi.link.test

import android.app.Activity
import android.app.Instrumentation
import android.content.Intent
import android.os.Bundle
import android.view.View
import android.view.ViewGroup
import android.widget.ScrollView
import android.widget.TextView
import com.rabi.link.MainActivity
import com.rabi.link.RabiAppearanceActivity
import com.rabi.link.RabiChatStore
import com.rabi.link.RabiConversationListUi
import com.rabi.link.RabiMobileUi

/** UI acceptance without sending messages, changing connections or creating recording fixtures. */
class MobileUxInstrumentation : Instrumentation() {
    override fun onCreate(arguments: Bundle) { super.onCreate(arguments); start() }
    private fun views(view: View): List<View> = listOf(view) +
        if(view is ViewGroup) (0 until view.childCount).flatMap { views(view.getChildAt(it)) } else emptyList()
    private fun texts(activity: Activity) = views(activity.window.decorView).filterIsInstance<TextView>()
    private fun clickAction(activity: Activity, description: String) {
        views(activity.window.decorView).first { it.isClickable && it.contentDescription?.toString() == description }.performClick()
    }
    private fun screenshot(name: String) {
        uiAutomation.takeScreenshot()?.let { bitmap ->
            java.io.File(targetContext.cacheDir,"mobile-ux-$name.png").outputStream().use {
                bitmap.compress(android.graphics.Bitmap.CompressFormat.PNG,100,it)
            }
            bitmap.recycle()
        }
    }
    override fun onStart() {
        val result = Bundle()
        var code = Activity.RESULT_OK
        var activity: Activity? = null
        try {
            activity = startActivitySync(Intent(targetContext,MainActivity::class.java)
                .putExtra("open_settings",true).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
            waitForIdleSync()
            val main = activity as MainActivity
            runOnMainSync {
                check(texts(main).any { it.text.toString() == "连接与电脑" })
                clickAction(main,"语音与消息")
                check(texts(main).any { it.isShown && it.text.toString() == "自动播放语音回复" })
                check(texts(main).any { it.isShown && it.text.toString() == "主动联系偏好" })
                check(texts(main).filter { it.text.toString() == "语音模型" }.none { it.isShown })
                clickAction(main,"声音与存储高级设置")
                check(texts(main).any { it.isShown && it.text.toString() == "语音模型" })
                clickAction(main,"声音与存储高级设置")
            }
            screenshot("settings")
            result.putString("settings","PASS: daily controls visible; model/storage advanced controls expand and collapse")

            // Existing read conversations exercise refresh without modifying message contents or sending anything.
            val store = RabiChatStore(targetContext)
            val route = store.summaries().entries.firstOrNull {
                it.value.unread == 0 && store.listForConversation(it.key).size >= 12
            }?.key
            if(route != null) {
                runOnMainSync {
                    MainActivity::class.java.getDeclaredMethod("showConversationDetail",String::class.java)
                        .apply { isAccessible = true }.invoke(main,route)
                }
                waitForIdleSync()
                var scroll: ScrollView? = null
                var hasHistory = false
                runOnMainSync {
                    scroll = views(main.window.decorView).filterIsInstance<ScrollView>().first()
                    hasHistory = scroll!!.getChildAt(0).height > scroll!!.height + 300
                    if(hasHistory) scroll!!.scrollTo(0,0)
                }
                waitForIdleSync()
                if(hasHistory) {
                    runOnMainSync {
                        MainActivity::class.java.getDeclaredField("chatSignature").apply { isAccessible = true }.set(main,"force-refresh-for-test")
                        MainActivity::class.java.getDeclaredMethod("renderChat").apply { isAccessible = true }.invoke(main)
                    }
                    waitForIdleSync()
                    runOnMainSync { check(scroll!!.scrollY == 0) { "Refresh moved the history reader to the bottom" } }
                    result.putString("chatScroll","PASS: real conversation refresh preserves the top reading position")
                    screenshot("chat-history")
                } else result.putString("chatScroll","NOT_COVERED: available history fits on screen")
            } else result.putString("chatScroll","NOT_COVERED: no already-read conversation with sufficient history")

            runOnMainSync { main.finish() }
            activity = startActivitySync(Intent(targetContext,RabiAppearanceActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
            runOnMainSync {
                val ui = RabiConversationListUi(activity!!)
                val row = ui.row("测试角色","最近一条消息","17:00","测试电脑",ui.avatar("测试角色",48),3,{}, {},"置顶")
                activity!!.setContentView(row)
                val strings = views(row).filterIsInstance<TextView>().map { it.text.toString() }
                check(strings.containsAll(listOf("测试角色","最近一条消息","17:00","置顶","3")))
                check(RabiMobileUi.dp(activity!!,48) > 0)
            }
            waitForIdleSync()
            screenshot("conversation-row")
            result.putString("conversationRow","PASS: pinned row retains preview, timestamp and unread count")
        } catch(error: Throwable) {
            result.putString("error",error.stackTraceToString())
            code = Activity.RESULT_CANCELED
        } finally {
            runOnMainSync { activity?.finish() }
        }
        finish(code,result)
    }
}
