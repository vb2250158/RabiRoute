package com.rabi.link.test

import android.app.Activity
import android.app.Instrumentation
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.Rect
import android.graphics.drawable.BitmapDrawable
import android.os.Bundle
import android.os.SystemClock
import android.view.View
import android.view.ViewGroup
import android.view.MotionEvent
import android.widget.Button
import android.widget.EditText
import android.widget.ImageView
import android.widget.TextView
import com.rabi.link.MainActivity
import com.rabi.link.RabiConversationTarget
import com.rabi.link.RabiChatStore
import com.rabi.link.RabiLinkRelaySettings
import com.rabi.link.RabiRouteMetadataCache
import com.rabi.link.recording.RabiRecordingHubActivity
import com.rabi.link.recording.TargetWorkerIdentity
import org.json.JSONArray
import org.json.JSONObject
import java.io.File

/** Exercises the installed Android UI against a disposable Relay account. */
class MobileLoginInstrumentation : Instrumentation() {
    private lateinit var arguments: Bundle

    override fun onCreate(arguments: Bundle) {
        super.onCreate(arguments)
        this.arguments = arguments
        start()
    }

    private fun views(view: View): List<View> = listOf(view) +
        if (view is ViewGroup) (0 until view.childCount).flatMap { views(view.getChildAt(it)) } else emptyList()

    private fun launch(key: String? = null, value: String? = null): Activity {
        val intent = Intent(targetContext, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        if (key != null) intent.putExtra(key, value)
        return startActivitySync(intent)
    }

    private fun await(label: String, predicate: () -> Boolean) {
        val deadline = SystemClock.uptimeMillis() + 15_000
        while (SystemClock.uptimeMillis() < deadline) {
            var finished = false
            runOnMainSync { finished = predicate() }
            if (finished) return
            SystemClock.sleep(70)
        }
        error("Timed out: $label")
    }

    private fun assertLogin(activity: Activity) {
        runOnMainSync {
            val nodes = views(activity.window.decorView)
            check(nodes.filterIsInstance<TextView>().any { it.isShown && it.text == "登录 RabiLink" })
            check(nodes.none { it.isShown && it.contentDescription?.toString() in setOf("记录", "消息", "设置") })
        }
    }

    private fun submit(activity: Activity, server: String, username: String, password: String) {
        runOnMainSync {
            val nodes = views(activity.window.decorView)
            val inputs = nodes.filterIsInstance<EditText>()
            check(inputs.size == 3)
            listOf(server, username, password).forEachIndexed { index, value -> inputs[index].setText(value) }
            check(nodes.filterIsInstance<Button>().single { it.text == "登录" }.performClick())
        }
    }

    private fun screenshot(name: String) {
        waitForIdleSync()
        val bitmap = checkNotNull(uiAutomation.takeScreenshot())
        File(targetContext.cacheDir, "$name.png").outputStream().use {
            check(bitmap.compress(Bitmap.CompressFormat.PNG, 100, it))
        }
        bitmap.recycle()
    }

    private fun verifyAccountStatus(activity: Activity) {
        fun statusView(label: String) = views(activity.window.decorView).find {
            it.isShown && it.contentDescription == "我的状态，$label，点按修改"
        }
        await("online account status") { statusView("在线") != null }
        runOnMainSync { check(statusView("在线")?.performClick() == true) }
        val deadline = SystemClock.uptimeMillis() + 5_000L
        var selected = false
        while (!selected && SystemClock.uptimeMillis() < deadline) {
            val choice = uiAutomation.rootInActiveWindow?.findAccessibilityNodeInfosByText("忙碌")
                ?.firstOrNull { it.text?.toString() == "忙碌" }
            if (choice != null) {
                val bounds = Rect()
                choice.getBoundsInScreen(bounds)
                if (!bounds.isEmpty) {
                    val now = SystemClock.uptimeMillis()
                    val down = MotionEvent.obtain(now, now, MotionEvent.ACTION_DOWN, bounds.exactCenterX(), bounds.exactCenterY(), 0)
                    val up = MotionEvent.obtain(now, now, MotionEvent.ACTION_UP, bounds.exactCenterX(), bounds.exactCenterY(), 0)
                    try { sendPointerSync(down); sendPointerSync(up) }
                    finally { down.recycle(); up.recycle() }
                    selected = true
                }
            }
            if (!selected) SystemClock.sleep(100)
        }
        check(selected) { "Could not choose Busy in the status picker" }
        await("server-confirmed busy account status") { statusView("忙碌")?.isEnabled == true }
        val relay = RabiLinkRelaySettings.load(targetContext)
        check(com.rabiroute.sdk.RabiRouteSdk().getMobileAccount(relay.baseUrl, relay.token).status ==
            com.rabiroute.sdk.RabiLinkMobileAccountStatus.BUSY)
    }

    private fun verifyChatScreens(nickname: String) {
        val examples = listOf(
            Triple("moon", "月见", "我把旅行清单整理好了，出发前再一起过一遍。"),
            Triple("river", "小川", "明天下午三点方便吗？"),
            Triple("cloud", "青云", "文件已收到，我晚点看看。"),
            Triple("star", "星遥", "今天的笔记已经同步。"),
            Triple("garden", "庭雪", "好呀，周末见。"),
        )
        val routes = JSONArray()
        val store = RabiChatStore(targetContext)
        for ((index, example) in examples.withIndex()) {
            val (id, name, preview) = example
            routes.put(JSONObject().put("id", id).put("name", name).put("agentRoleId", id)
                .put("personaDisplayName", name).put("enabled", true).put("running", true)
                .put("chatAvailable", true).put("messageAdapters", JSONArray(listOf("rabilink")))
                .put("ownerWorkerId", if (index % 2 == 0) "legacy-pc" else "other-pc")
                .put("ownerComputerName", if (index % 2 == 0) "测试电脑 A" else "测试电脑 B"))
            if (id == "moon") {
                store.append("$id-hello", "user", "text", "帮我看看出发前还要准备什么。", "", "", id)
                store.append("$id-note", "user", "text", "记得把相机也加进去。", "", "", id)
            }
            store.append("$id-reply", "assistant", "text", preview, "", "", id)
        }
        store.setPinned("moon", true)
        RabiRouteMetadataCache.save(targetContext, RabiLinkRelaySettings.load(targetContext),
            RabiRouteMetadataCache.decode(routes.toString()))
        val activity = startActivitySync(Intent(targetContext, MainActivity::class.java)
            .putExtra("open_messages", true).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
        fun currentViews() = views(activity.window.decorView).filter { it.isShown }
        fun hasAccountAvatar() = currentViews().filterIsInstance<ImageView>().any {
            it.contentDescription == "$nickname 的头像" && it.drawable is BitmapDrawable
        }
        await("nickname and account avatar in list") {
            currentViews().filterIsInstance<TextView>().any { it.text == nickname } && hasAccountAvatar()
        }
        verifyAccountStatus(activity)
        await("conversations from both computers") {
            listOf("月见", "小川").all { name -> currentViews().any { it.contentDescription?.startsWith("$name，") == true } }
        }
        screenshot("chat-list")
        runOnMainSync {
            currentViews().filterIsInstance<EditText>().single().setText("月见")
            check(currentViews().none { it.contentDescription?.startsWith("小川，") == true })
            currentViews().first { it.isClickable && it.contentDescription?.startsWith("月见，") == true }.performClick()
        }
        await("conversation header, bubbles and composer") {
            currentViews().filterIsInstance<TextView>().any { it.text == "月见" } &&
                currentViews().filterIsInstance<TextView>().any { it.text.toString() == examples[0].third } &&
                currentViews().any { it.contentDescription == "发送消息" } &&
                currentViews().any { it.contentDescription == "选择图片" } &&
                currentViews().any { it.contentDescription == "添加附件" } && hasAccountAvatar()
        }
        screenshot("chat-detail")
        check(store.unreadCount("moon") == 0 && store.unreadCount("river") > 0)
        runOnMainSync {
            val send = currentViews().first { it.contentDescription == "发送消息" }
            check(!send.isEnabled)
            val composer = currentViews().filterIsInstance<EditText>().single()
            composer.setText("测试草稿")
            check(send.isEnabled && store.draft("moon") == "测试草稿")
            currentViews().first { it.contentDescription == "返回" }.performClick()
        }
        await("list restored with account identity") {
            currentViews().filterIsInstance<TextView>().any { it.text == nickname } && hasAccountAvatar() &&
                currentViews().any { it.contentDescription == "我的状态，忙碌，点按修改" } &&
                currentViews().filterIsInstance<EditText>().singleOrNull()?.text?.toString() == "月见"
        }
        runOnMainSync {
            currentViews().filterIsInstance<EditText>().single().setText("小川")
            currentViews().first { it.isClickable && it.contentDescription?.startsWith("小川，") == true }.performClick()
        }
        val outbound = "模拟器跨电脑投递"
        runOnMainSync {
            currentViews().filterIsInstance<EditText>().single().setText(outbound)
            check(currentViews().first { it.contentDescription == "发送消息" }.performClick())
        }
        await("message accepted for the other PC") {
            store.listForConversation("river").any { it.text == outbound && it.deliveryState == "sent" }
        }
        runOnMainSync { activity.finish() }
    }

    override fun onStart() {
        val result = Bundle()
        try {
            check(targetContext.packageName.endsWith(".assistantacceptance")) { "Isolated debug package required" }
            val server = checkNotNull(arguments.getString("server"))
            val username = checkNotNull(arguments.getString("username"))
            val password = checkNotNull(arguments.getString("password"))
            val accountId = checkNotNull(arguments.getString("accountId"))
            val token = checkNotNull(arguments.getString("token"))
            check(!RabiLinkRelaySettings.load(targetContext).configured) { "The isolated test installation must start empty" }

            val fresh = launch()
            assertLogin(fresh)
            val notification = Intent(targetContext, MainActivity::class.java).putExtra("route_profile_id", "fixture-route")
            runOnMainSync { fresh.startActivity(notification) }
            waitForIdleSync()
            assertLogin(fresh)
            runOnMainSync { fresh.finish() }
            await("fresh login closed") { fresh.isDestroyed }
            val loginMonitor = addMonitor(MainActivity::class.java.name, null, false)
            targetContext.startActivity(Intent(targetContext, RabiRecordingHubActivity::class.java)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
            val redirected = checkNotNull(waitForMonitorWithTimeout(loginMonitor, 15_000))
            assertLogin(redirected)
            runOnMainSync { redirected.finish() }
            await("redirected login closed") { redirected.isDestroyed }
            result.putString("loginGate", "PASS: fresh launch, message link and recording shortcut")

            val login = launch("route_profile_id", "fixture-route")
            submit(login, server, username, "incorrect-fixture-password")
            await("wrong password rejected") {
                views(login.window.decorView).filterIsInstance<TextView>().any { it.text == "账号或密码不正确。" }
            }
            assertLogin(login)
            check(RabiLinkRelaySettings.accountId(targetContext).isBlank())
            submit(login, server, username, password)
            await("correct password opened original message link") {
                RabiConversationTarget.load(targetContext) == "fixture-route" &&
                    views(login.window.decorView).any { it.isShown && it.contentDescription == "返回" }
            }
            check(RabiLinkRelaySettings.accountId(targetContext) == accountId)
            check(RabiLinkRelaySettings.load(targetContext).token == token)
            result.putString("credentials", "PASS: wrong password remained gated and correct password restored the requested conversation")
            runOnMainSync { login.finish() }
            await("conversation closed") { login.isDestroyed }

            RabiLinkRelaySettings.save(targetContext, server, "expired-fixture-token")
            val expired = launch("route_profile_id", "fixture-route")
            await("invalid legacy token rejected") {
                views(expired.window.decorView).filterIsInstance<TextView>().any { it.text == "旧连接已失效，请用账号和密码登录。" }
            }
            assertLogin(expired)
            check(RabiLinkRelaySettings.accountId(targetContext).isBlank())
            runOnMainSync { expired.finish() }
            await("expired login closed") { expired.isDestroyed }

            RabiLinkRelaySettings.save(targetContext, server, token)
            TargetWorkerIdentity.save(targetContext, server, token, "legacy-pc")
            val saved = RabiLinkRelaySettings.load(targetContext)
            val monitor = addMonitor(RabiRecordingHubActivity::class.java.name, null, false)
            launch()
            val restored = waitForMonitorWithTimeout(monitor, 15_000)
            check(restored is RabiRecordingHubActivity) { "The legacy account did not open the recording home" }
            check(RabiLinkRelaySettings.accountId(targetContext) == accountId)
            check(RabiLinkRelaySettings.load(targetContext) == saved)
            check(TargetWorkerIdentity.load(targetContext, server, token) == "legacy-pc")
            runOnMainSync { restored.finish() }
            result.putString("legacy", "PASS: expired token remained gated and valid token opened recordings with the original account and connection")
            arguments.getString("expectedNickname")?.let { nickname ->
                await("recordings closed") { restored.isDestroyed }
                verifyChatScreens(nickname)
                result.putString("chatUi", "PASS: Relay nickname, avatar and saved status, conversations on two computers, chat and back to list")
            }
            finish(Activity.RESULT_OK, result)
        } catch (error: Throwable) {
            result.putString("error", error.message ?: error.javaClass.simpleName)
            finish(Activity.RESULT_CANCELED, result)
        }
    }
}
