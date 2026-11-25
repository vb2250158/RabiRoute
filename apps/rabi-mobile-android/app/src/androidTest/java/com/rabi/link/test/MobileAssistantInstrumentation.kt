package com.rabi.link.test

import android.app.Activity
import android.app.Instrumentation
import android.content.Intent
import android.os.Bundle
import android.os.SystemClock
import android.util.Base64
import android.view.View
import android.view.ViewGroup
import android.view.accessibility.AccessibilityNodeInfo
import android.webkit.JavascriptInterface
import android.webkit.PermissionRequest
import android.webkit.WebChromeClient
import android.webkit.WebView
import com.rabi.link.MainActivity
import com.rabi.link.RabiLinkRelaySettings
import com.rabi.link.assistant.MobileAssistantActivity
import org.json.JSONObject
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger

/** Verifies the real Android Activity/WebView/permission and SDK loop with generated test audio and a fake RabiLink endpoint. */
class MobileAssistantInstrumentation : Instrumentation() {
    override fun onCreate(arguments: Bundle) {
        super.onCreate(arguments)
        start()
    }

    private fun descendants(view: View): List<View> =
        listOf(view) + if (view is ViewGroup) (0 until view.childCount).flatMap { descendants(view.getChildAt(it)) } else emptyList()

    private fun await(label: String, predicate: () -> Boolean) {
        val end = SystemClock.uptimeMillis() + 22_000
        while (SystemClock.uptimeMillis() < end) {
            if (predicate()) return
            SystemClock.sleep(180)
        }
        error("Timed out: " + label)
    }

    private fun eval(view: WebView, code: String): String {
        val done = CountDownLatch(1)
        var result = ""
        runOnMainSync {
            view.evaluateJavascript(code) { result = it; done.countDown() }
        }
        check(done.await(5, TimeUnit.SECONDS))
        return result
    }

    override fun onStart() {
        val report = Bundle()
        var result = Activity.RESULT_OK
        var host: Activity? = null
        var mobile: Activity? = null
        try {
            check(targetContext.packageName.endsWith(".assistantacceptance")) { "Isolated debug package required" }
            RabiLinkRelaySettings.saveAuthenticated(targetContext, "http://127.0.0.1:1", "assistant-fixture", "assistant-fixture-account")
            host = startActivitySync(Intent(targetContext, MainActivity::class.java)
                .putExtra("open_messages", true).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
            val monitor = addMonitor(MobileAssistantActivity::class.java.name, null, false)
            var opened = false
            runOnMainSync {
                val root = host!!.window.decorView
                descendants(root).firstOrNull { it.contentDescription?.toString() == "消息" }?.performClick()
                opened = descendants(root).firstOrNull { it.contentDescription?.toString() == "语音助手" }?.performClick() == true
            }
            check(opened) { "Missing assistant navigation button" }
            mobile = waitForMonitorWithTimeout(monitor, 10_000) ?: error("Assistant entry did not open")
            removeMonitor(monitor)
            lateinit var view: WebView
            runOnMainSync { view = descendants(mobile!!.window.decorView).filterIsInstance<WebView>().single() }
            await("unpaired connection hint") { eval(view, "document.getElementById('issue')?.textContent").contains("选择一台") }
            report.putString("entry", "passed")
            report.putString("unpaired", "passed")

            runOnMainSync {
                val permission = android.Manifest.permission.RECORD_AUDIO
                if (targetContext.checkSelfPermission(permission) != android.content.pm.PackageManager.PERMISSION_GRANTED) {
                    mobile!!.requestPermissions(arrayOf(permission), 20)
                }
                view.webChromeClient = object : WebChromeClient() {
                    override fun onPermissionRequest(request: PermissionRequest) {
                        if (request.resources.contentEquals(arrayOf(PermissionRequest.RESOURCE_AUDIO_CAPTURE))
                            && targetContext.checkSelfPermission(permission) == android.content.pm.PackageManager.PERMISSION_GRANTED) {
                            request.grant(request.resources)
                        } else request.deny()
                    }
                }
            }
            await("microphone permission dialog") {
                if (targetContext.checkSelfPermission(android.Manifest.permission.RECORD_AUDIO) == android.content.pm.PackageManager.PERMISSION_GRANTED) return@await true
                val root = uiAutomation.rootInActiveWindow ?: return@await false
                val identities = listOf("com.android.permissioncontroller", "com.google.android.permissioncontroller")
                identities.flatMap { root.findAccessibilityNodeInfosByViewId(it + ":id/permission_allow_foreground_only_button") }
                    .firstOrNull()?.performAction(AccessibilityNodeInfo.ACTION_CLICK) == true
            }

            val scripted = Fixture(view)
            runOnMainSync {
                view.removeJavascriptInterface("RabiMobile")
                view.addJavascriptInterface(scripted, "RabiMobile")
                view.reload()
            }
            await("RabiLink fixture ready") { eval(view, "document.querySelector('#start').disabled") == "false" }
            check(eval(view, "document.querySelector('#waveform').hidden") == "true")
            val inject = """
              (() => {
                const md = navigator.mediaDevices;
                const get = md.getUserMedia.bind(md);
                md.getUserMedia = async (...args) => {
                  const real = await get(...args);
                  const context = new AudioContext();
                  await context.resume();
                  const src = context.createOscillator();
                  const gain = context.createGain();
                  const destination = context.createMediaStreamDestination();
                  src.frequency.value=345;
                  gain.gain.value=0;
                  src.connect(gain);
                  gain.connect(destination);
                  src.start();
                  window.fixtureTone=() => {
                    gain.gain.value=0.25;
                    setTimeout(() => gain.gain.value=0,320);
                  };
                  window.fixtureRelease=() => {
                    real.getTracks().forEach(track=>track.stop());
                    destination.stream.getTracks().forEach(track=>track.stop());
                    void context.close();
                  };
                  return destination.stream;
                };
                document.querySelector('#start').click();
                return true;
              })()
            """.trimIndent()
            check(eval(view, inject) == "true")
            await("microphone listening") {
                eval(view, "Boolean(window.fixtureTone) && document.querySelector('#status').textContent==='正在聆听'") == "true"
            }
            report.putString("recordPermission", "android-dialog-granted")
            check(eval(view, "document.querySelector('#waveform').hidden") == "false")
            eval(view, "window.fixtureTone()")
            await("first waveform/transcript/auto submit and playback") {
                scripted.admissions.get() == 1 && scripted.synthesis.get() == 1 &&
                    eval(view, "!document.querySelector('#playing').hidden && Boolean(document.querySelector('mark'))") == "true"
            }
            eval(view, "window.fixtureTone()")
            await("second recognized turn interrupts previous playback") {
                scripted.admissions.get() == 2 && scripted.synthesis.get() == 2
            }
            await("second response rendered") { eval(view, "document.querySelector('#history').textContent").contains("测试回复二") }
            check(scripted.sentObservation)
            report.putString("fixtureFullDuplex", "2 admitted, 2 playback requests")
            eval(view, "window.fixtureRelease(); document.querySelector('#enabled').click()")
            await("disabled control and hidden waveform") {
                eval(view, "document.querySelector('#start').disabled && document.querySelector('#waveform').hidden") == "true"
            }
            eval(view, "document.querySelector('#back').click()")
            await("assistant exited") { mobile!!.isFinishing || mobile!!.isDestroyed }
            report.putString("exit", "passed")
        } catch (error: Throwable) {
            result = Activity.RESULT_CANCELED
            report.putString("error", error.stackTraceToString())
        } finally {
            runOnMainSync { mobile?.finish(); host?.finish() }
            finish(result, report)
        }
    }

    class Fixture(private val view: WebView) {
        val admissions = AtomicInteger()
        val synthesis = AtomicInteger()
        private val transcripts = AtomicInteger()
        private val accepted = linkedMapOf<String, Int>()
        @Volatile var sentObservation = false

        @Volatile private var voiceEnabled = true
        @JavascriptInterface fun voiceEnabled() = voiceEnabled
        @JavascriptInterface fun setVoiceEnabled(enabled: Boolean) { voiceEnabled = enabled }
        @JavascriptInterface fun microphoneAvailable() = true
        @JavascriptInterface fun close() = view.post { (view.context as Activity).finish() }

        @JavascriptInterface fun send(id: String, operation: String, body: String) {
            val input = JSONObject(body)
            val output = when(operation) {
                "state" -> """{"sessionId":"fixture-session","settings":{"voiceEnabled":true},"capabilities":{"mobileVoiceSubmit":true},"hostSettings":{"personaId":"voice","personaLabel":"测试人格","asrSource":"host","asrModel":"fixture","ttsSource":"host","ttsModel":"fixture","voiceReady":true}}"""
                "asr" -> {
                    check(input.getString("sessionId") == "fixture-session" && input.getString("source") == "active")
                    val data = Base64.decode(input.getString("audio"), Base64.NO_WRAP)
                    check(data.size in 45..100000 && String(data,0,4) == "RIFF")
                    """{"text":"测试语音${transcripts.incrementAndGet()}","additions":{"emotion":"happy","age":"31","confidence":"0.9"}}"""
                }
                "submit" -> {
                    val requestId = input.getString("requestId")
                    check(input.getString("action") == "mobile-voice-submit")
                    check(input.getString("sessionId") == "fixture-session")
                    val fields = input.getJSONObject("observation")
                    sentObservation = fields.getString("emotion") == "happy" && fields.getInt("age") == 31 &&
                        fields.getDouble("confidence") == 0.9
                    check(accepted.put(requestId, admissions.incrementAndGet()) == null)
                    JSONObject().put("accepted",true).put("sessionId","fixture-session").put("requestId",requestId).toString()
                }
                "messages" -> JSONObject().put("sessionId","fixture-session")
                    .put("messages",org.json.JSONArray(accepted.entries.flatMap { (request, index) ->
                        val answer = if(index == 1) "测试回复一。" else "测试回复二。"
                        listOf(JSONObject().put("id",request).put("role","user").put("text","测试语音${index}").put("status","completed"),
                            JSONObject().put("id","reply-${request}").put("role","assistant").put("text",answer).put("status","completed"))
                    })).toString()
                "tts" -> {
                    synthesis.incrementAndGet()
                    val bytes = ByteBuffer.allocate(44 + 8 * 16000 * 2).order(ByteOrder.LITTLE_ENDIAN)
                    val length = bytes.capacity() - 44
                    bytes.put("RIFF".toByteArray()).putInt(length + 36).put("WAVEfmt ".toByteArray()).putInt(16)
                    bytes.putShort(1).putShort(1).putInt(16000).putInt(32000).putShort(2).putShort(16)
                    bytes.put("data".toByteArray()).putInt(length)
                    repeat(length/2) { bytes.putShort((kotlin.math.sin(it*0.13)*1000).toInt().toShort()) }
                    Base64.encodeToString(bytes.array(), Base64.NO_WRAP)
                }
                else -> error("Unexpected test operation")
            }
            view.post { view.evaluateJavascript("window.mobileReply(" + JSONObject.quote(id) + ",true," + JSONObject.quote(output) + ")", null) }
        }
    }
}
