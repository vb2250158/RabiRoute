package com.rabi.link.test

import android.app.Activity
import android.app.Instrumentation
import android.content.Intent
import android.os.Bundle
import android.os.SystemClock
import android.view.View
import android.view.ViewGroup
import android.widget.TextView
import com.rabi.link.*
import com.rabi.link.modules.rokid.RabiGlassPcBackend
import com.rabi.link.recording.AllDayRecordingSettings
import com.rabi.link.recording.TargetWorkerIdentity
import org.json.JSONArray
import org.json.JSONObject
import java.net.InetAddress
import java.net.ServerSocket
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.Executors

/** Emulator-only service/UI acceptance. Fixture transcripts/replies are not PC ASR/Agent proof. */
class MobileCallInstrumentation : Instrumentation() {
    override fun onCreate(arguments: Bundle) { super.onCreate(arguments); start() }
    private fun tree(v: View): List<View> = listOf(v) + if (v is ViewGroup) (0 until v.childCount).flatMap { tree(v.getChildAt(it)) } else emptyList()
    private fun await(label: String, condition: () -> Boolean) {
        val end = SystemClock.uptimeMillis() + 20_000
        while (SystemClock.uptimeMillis() < end) { if (condition()) return; SystemClock.sleep(100) }
        error("Timed out: $label")
    }
    private fun field(owner: Any, name: String): Any? = owner.javaClass.getDeclaredField(name).apply { isAccessible = true }.get(owner)
    private fun service(): RabiConversationService? = RabiConversationService::class.java.getDeclaredField("currentInstance").apply { isAccessible = true }.get(null) as? RabiConversationService
    private fun screenshot(name: String) {
        uiAutomation.takeScreenshot()?.let { bitmap ->
            java.io.File(targetContext.cacheDir, name).outputStream().use { bitmap.compress(android.graphics.Bitmap.CompressFormat.PNG, 100, it) }
            bitmap.recycle()
        }
    }
    override fun onStart() {
        val result = Bundle(); var code = Activity.RESULT_OK
        var activity: Activity? = null
        var fixture: Fixture? = null
        try {
            check(android.os.Build.HARDWARE == "ranchu" || android.os.Build.MODEL.contains("sdk_gphone")) { "Fixture requires a separate Android emulator" }
            val saved = RabiLinkRelaySettings.load(targetContext)
            check(!saved.configured || (saved.token == "test-token" && saved.baseUrl.startsWith("http://127.0.0.1:"))) { "Refusing to replace existing login" }
            fixture = Fixture()
            val relay = RabiLinkRelayConfig(fixture.base, "test-token", true)
            RabiLinkRelaySettings.save(targetContext, relay.baseUrl, relay.token)
            TargetWorkerIdentity.save(targetContext, relay.baseUrl, relay.token, "fixture-pc")
            RabiConversationServiceState.setRestoreEnabled(targetContext, false)
            AllDayRecordingSettings(true, "audio", "mobile", "local_only", "original-record-route", false, false, false, 100).save(targetContext)
            activity = startActivitySync(Intent(targetContext, MainActivity::class.java).putExtra("open_messages", true).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
            await("two separate routes") {
                var count = 0
                runOnMainSync { count = tree(activity!!.window.decorView).count { it.contentDescription?.toString()?.startsWith("Test Persona，") == true } }
                count == 2
            }
            runOnMainSync {
                val rows = tree(activity!!.window.decorView).filter { it.contentDescription?.toString()?.startsWith("Test Persona，") == true }
                check(rows.size == 2)
                check(rows.all { tree(it).filterIsInstance<TextView>().size == 4 }) { "A row must contain only its four text fields plus avatar" }
                check(rows.map { it.contentDescription.toString() }.any { it.contains("Test Computer · Route A") })
            }
            screenshot("mobile-call-list.png")
            runOnMainSync { tree(activity!!.window.decorView).first { it.contentDescription?.toString()?.contains("Test Computer · Route A") == true }.performClick() }
            await("fresh route capability") { field(activity!!, "routesLoaded") == true }
            runOnMainSync { tree(activity!!.window.decorView).filterIsInstance<TextView>().single { it.text == "电话" }.performClick() }
            val runtime = targetContext.getSharedPreferences("rabi_conversation_runtime", 0)
            await("phone capture") { runtime.getBoolean("callActive", false) && runtime.getString("actualAudioSource", "") == "mobile" }
            val owner = service() ?: error("No service owner")
            val call = field(owner, "voiceCall") as RabiVoiceCallSession
            check(call.workerId == "fixture-pc" && call.routeId == "route-a")
            check(AllDayRecordingSettings.load(targetContext).processingPolicy == "local_only")
            screenshot("mobile-call-listening.png")
            val backend = field(owner, "backend") as RabiGlassPcBackend
            val listener = field(backend, "listener") as RabiGlassPcBackend.Listener
            RabiLinkRelaySettings.save(targetContext, "http://127.0.0.1:1", "other-test-connection")
            runOnMainSync { owner.javaClass.getDeclaredMethod("configureBackend").apply { isAccessible = true }.invoke(owner) }
            check(field(backend, "baseUrl") == fixture.base)
            val asr = field(backend, "eventAsr")!!
            @Suppress("UNCHECKED_CAST")
            val frozenAsr = field(asr, "relayConfiguration") as java.util.function.Supplier<RabiLinkRelayConfig>
            check(frozenAsr.get().baseUrl == fixture.base && frozenAsr.get().token == "test-token")
            RabiLinkRelaySettings.save(targetContext, fixture.base, "test-token")
            val now = System.currentTimeMillis()
            listener.onFinalRecordingTranscript("ordinary-capture", "ordinary", "ignored", now)
            listener.onFinalRecordingTranscript(call.captureId, "old", "ignored", now - 90_000)
            repeat(2) { listener.onFinalRecordingTranscript(call.captureId, "turn-one", "test turn one", now) }
            await("one admitted final input") { fixture.inputs.count { it.optString("clientMessageId").startsWith("rabi-call-v1.") } == 1 }
            check(fixture.inputs.single().optString("targetDeviceId") == "fixture-pc")
            check(fixture.inputs.single().optString("routeProfileId") == "route-a")
            runOnMainSync { RabiConversationService.muteVoiceCall(targetContext) }
            await("mute") { runtime.getBoolean("callMuted", false) }
            listener.onFinalRecordingTranscript(call.captureId, "muted", "ignored", System.currentTimeMillis())
            screenshot("mobile-call-muted.png")
            runOnMainSync { RabiConversationService.muteVoiceCall(targetContext) }
            await("unmute") { !runtime.getBoolean("callMuted", true) }
            listener.onFinalRecordingTranscript(call.captureId, "turn-two", "test turn two", System.currentTimeMillis())
            await("second input") { fixture.inputs.size == 2 }
            fixture.rejectInputs = true
            listener.onFinalRecordingTranscript(call.captureId, "offline-turn", "expired fixture turn", System.currentTimeMillis() - 88_000)
            await("temporary input failure") { fixture.inputAttempts.any { it.optString("text") == "expired fixture turn" } }
            SystemClock.sleep(2_100)
            val attempted = fixture.inputAttempts.size
            fixture.rejectInputs = false
            backend.retryFailedItems()
            await("expired queued input removed") { runtime.getString("delivery", "").orEmpty().startsWith("expired") }
            check(fixture.inputs.size == 2 && fixture.inputAttempts.size == attempted) { "Expired input must not replay after recovery" }
            check(!listener.phoneCallReply(JSONObject().put("taskId", fixture.inputs.first().getString("clientMessageId")).put("routeProfileId", "route-b")))
            targetContext.getSharedPreferences("rabi_glass_phone_backend", 0).edit().putString("replyCall:fixture-playback", call.id).commit()
            val playback = Executors.newSingleThreadExecutor()
            try {
                val reply = playback.submit<RabiGlassPcBackend.ReplyDeliveryResult> {
                    listener.onReply("fixture-playback", "route-a", "Fixture reply", ByteArray(320_000), JSONArray())
                }
                await("actual AudioTrack speaking") { runtime.getString("callState", "") == "speaking" && field(owner, "callPlaybackTrack") != null }
                runOnMainSync { RabiConversationService.muteVoiceCall(targetContext) }
                await("mute during playback") { runtime.getBoolean("callMuted", false) }
                check(runtime.getString("callState", "") == "speaking")
                screenshot("mobile-call-speaking.png")
                runOnMainSync { RabiConversationService.endVoiceCall(targetContext) }
                await("hangup") { !runtime.getBoolean("callActive", true) }
                check(!reply.get(5, java.util.concurrent.TimeUnit.SECONDS).played)
            } finally { playback.shutdownNow() }
            await("original recording restored") { runtime.getString("recordId", "").orEmpty().isNotEmpty() && !runtime.getString("recordId", "").orEmpty().startsWith("call_") }
            val restored = AllDayRecordingSettings.load(targetContext)
            check(restored.running && restored.routeProfileId == "original-record-route" && restored.processingPolicy == "local_only" && !restored.uploadEnabled)
            val late = JSONObject().put("taskId", fixture.inputs.first().getString("clientMessageId")).put("routeProfileId", "route-a")
            check(!listener.phoneCallReply(late) && !listener.synthesizeReply(late))
            runOnMainSync { RabiConversationService.startVoiceCall(targetContext, "fixture-pc", "route-a") }
            await("new call") { runtime.getBoolean("callActive", false) && runtime.getString("callId", "") != call.id }
            check(!listener.phoneCallReply(late))
            runOnMainSync { RabiConversationService.endVoiceCall(targetContext) }
            await("second hangup") { !runtime.getBoolean("callActive", true) }
            result.putString("result", "PASS: two same-persona routes, five-field list, actual microphone owner, final-input dedup/expiry/target, mute, two fixture turns, temporary failure then expired queue recovery without replay, actual AudioTrack interrupted by hangup, original recording restored, old reply fenced from new call")
            result.putString("limits", "Synthetic transcript and silent PCM reply fixtures; not real PC ASR, Agent response, audible speech, or physical phone acceptance")
        } catch (error: Throwable) {
            code = Activity.RESULT_CANCELED; result.putString("error", error.stackTraceToString())
            if (activity != null) runOnMainSync { result.putString("screen", tree(activity!!.window.decorView).filterIsInstance<TextView>().joinToString(" | ") { it.text.toString() }) }
            screenshot("mobile-call-failure.png")
        }
        finally {
            if (fixture != null) {
                runOnMainSync { RabiConversationService.pauseRecording(targetContext); activity?.finish() }
                fixture.close()
                check(targetContext.getSharedPreferences("rabi_link_relay_bridge", 0).edit().clear().commit())
            }
        }
        finish(code, result)
    }
    private class Fixture : AutoCloseable {
        private val server = ServerSocket(0, 16, InetAddress.getByName("127.0.0.1"))
        private val workers = Executors.newCachedThreadPool()
        val base = "http://127.0.0.1:${server.localPort}"
        val inputs = CopyOnWriteArrayList<JSONObject>()
        val inputAttempts = CopyOnWriteArrayList<JSONObject>()
        @Volatile var rejectInputs = false
        init {
            workers.execute {
                while (!server.isClosed) try { val client = server.accept(); workers.execute {
                    try { client.use {
                        val stream = it.getInputStream()
                        val header = java.io.ByteArrayOutputStream()
                        while (header.size() < 16_384) {
                            val byte = stream.read(); if (byte < 0) return@use
                            header.write(byte)
                            if (header.size() >= 4 && header.toString("US-ASCII").endsWith("\r\n\r\n")) break
                        }
                        val lines = header.toString("US-ASCII").split("\r\n")
                        val path = lines.first().split(" ")[1]
                        val size = lines.firstOrNull { it.startsWith("Content-Length:", true) }?.substringAfter(':')?.trim()?.toInt() ?: 0
                        val body = ByteArray(size); var read = 0
                        while (read < size) { val n = stream.read(body, read, size - read); if (n < 0) error("Short request"); read += n }
                        val output = it.getOutputStream()
                        if (path.startsWith("/api/rabilink/events")) {
                            output.write("HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\n\r\nevent: ready\ndata: {}\n\n".toByteArray()); output.flush()
                            while (!server.isClosed) { Thread.sleep(2_000); output.write(": keepalive\n\n".toByteArray()); output.flush() }
                        } else {
                            var status = "200 OK"
                            val response = if (path.startsWith("/api/rabilink/mobile/routes")) catalog()
                            else if (path.startsWith("/api/rabilink/devices/input")) {
                                val input = JSONObject(String(body, Charsets.UTF_8)); inputAttempts.add(input)
                                if (rejectInputs) { status = "503 Service Unavailable"; """{"code":-1,"message":"fixture temporarily unavailable"}""" }
                                else { inputs.add(input); """{"code":0,"eventId":"fixture-task-${inputs.size}"}""" }
                            }
                            else """{"code":0,"messages":[],"data":{},"nextCursor":""}"""
                            val bytes = response.toByteArray(Charsets.UTF_8)
                            output.write("HTTP/1.1 $status\r\nContent-Type: application/json\r\nContent-Length: ${bytes.size}\r\nConnection: close\r\n\r\n".toByteArray()); output.write(bytes); output.flush()
                        }
                    } } catch (ignored: InterruptedException) { Thread.currentThread().interrupt() }
                    catch (ignored: java.io.IOException) { /* SSE disconnect or fixture shutdown. */ }
                } } catch (ignored: java.net.SocketException) { }
            }
        }
        private fun catalog(): String = """{"code":0,"data":{"routes":[
            {"id":"route-a","name":"Route A","routeName":"Route A","enabled":true,"running":true,"agentRoleId":"test-persona","personaDisplayName":"Test Persona","messageAdapters":["rabilink"],"chatAvailable":true,"ownerWorkerId":"fixture-pc","ownerComputerName":"Test Computer","voiceCallProtocol":1},
            {"id":"route-b","name":"Route B","routeName":"Route B","enabled":true,"running":true,"agentRoleId":"test-persona","personaDisplayName":"Test Persona","messageAdapters":["rabilink"],"chatAvailable":true,"ownerWorkerId":"fixture-pc","ownerComputerName":"Test Computer","voiceCallProtocol":1},
            {"id":"profile","isPersonaOnly":true,"enabled":true,"messageAdapters":["rabilink"],"personaDisplayName":"Setup Row"}
        ]}}"""
        override fun close() { server.close(); workers.shutdownNow() }
    }
}
