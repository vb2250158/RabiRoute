package com.rabi.link.modules.rokid

import android.content.Context
import android.os.Handler
import android.os.Looper
import android.util.AtomicFile
import com.rabi.link.RabiLinkRelaySettings
import com.rabi.link.recording.AllDayRecordingSettings
import com.rabiroute.sdk.RabiRouteSdk
import org.json.JSONObject
import java.io.File
import java.security.MessageDigest
import java.time.Instant
import java.util.concurrent.Executors

/** Consumes existing device-info events only. Owns no CXR connection, service or timer. */
class RabiGlassStatusPublisher(context: Context, private val onChanged: Runnable) : AutoCloseable {
    private val app = context.applicationContext
    private val worker = Executors.newSingleThreadExecutor()
    private val main = Handler(Looper.getMainLooper())
    // Latest-value outbox: status is a snapshot, not a history of every battery callback.
    // Token is never persisted; identity is a one-way digest binding endpoint + credential.
    private val outbox = AtomicFile(File(app.filesDir, "glass-status-pending.json"))
    private val sdk = RabiRouteSdk()
    @Volatile private var closed = false
    @Volatile var status = "尚未收到眼镜状态"; private set
    @Volatile var observedAt = ""; private set
    @Volatile var battery = -1; private set
    @Volatile var charging = false; private set

    fun accept(battery: Int, charging: Boolean) {
        if (closed || battery !in 0..100) return
        val settings = AllDayRecordingSettings.load(app)
        if (!settings.running) return
        val relay = RabiLinkRelaySettings.load(app)
        val timestamp = Instant.now().toString()
        val binding = if (relay.configured) identity(relay.baseUrl, relay.token) else ""
        this.battery = battery; this.charging = charging; observedAt = timestamp
        report("已收到眼镜状态")
        main.post { if (!closed) onChanged.run() } // Freshness changes even if the value is unchanged.
        if (binding.isEmpty() || !relay.statusSyncEnabled) return
        worker.execute {
            if (closed || !AllDayRecordingSettings.load(app).running) return@execute
            try {
                val current = RabiLinkRelaySettings.load(app)
                if (!current.configured || identity(current.baseUrl, current.token) != binding) return@execute
                val data = JSONObject().put("binding", binding).put("battery", battery)
                    .put("charging", charging).put("observedAt", timestamp)
                write(data)
                drain()
            } catch (_: Exception) { report("眼镜状态暂存失败") }
        }
    }

    /** Invoked by the owner on network restoration or settings changes, never by a timer. */
    fun onNetworkAvailable() {
        if (!closed) worker.execute { if (!closed) drain() }
    }

    private fun drain() {
        val settings = AllDayRecordingSettings.load(app)
        if (closed || !settings.running || !settings.uploadEnabled) return
        val relay = RabiLinkRelaySettings.load(app)
        if (!relay.configured || !relay.statusSyncEnabled) return
        try {
            if (!outbox.baseFile.exists()) return
            val data = JSONObject(outbox.openRead().bufferedReader().use { it.readText() })
            if (data.getString("binding") != identity(relay.baseUrl, relay.token)) {
                report("待发眼镜状态属于原连接，未向新账号发送")
                return
            }
            // Recheck consent immediately before the request. The request uses the frozen
            // relay snapshot, so a concurrent account switch cannot redirect old samples.
            val latest = AllDayRecordingSettings.load(app)
            if (closed || !latest.running || !latest.uploadEnabled) return
            val result = sdk.publishMobileDeviceStatus(relay.baseUrl, relay.token,
                data.getInt("battery"), data.getBoolean("charging"), data.getString("observedAt"))
            outbox.delete() // Single worker ensures this cannot delete a newer pending sample.
            report(if (result.stale) "眼镜状态已上报，但来源数据已过期" else "眼镜状态已上报")
        } catch (_: Exception) { report("眼镜状态等待联网重试") }
    }

    private fun write(data: JSONObject) {
        val output = outbox.startWrite()
        try { output.write(data.toString().toByteArray(Charsets.UTF_8)); outbox.finishWrite(output) }
        catch (error: Exception) { outbox.failWrite(output); throw error }
    }
    private fun report(value: String) {
        if (status == value) return
        status = value
        main.post { if (!closed) onChanged.run() }
    }
    override fun close() { closed = true; worker.shutdown() }

    companion object {
        @JvmStatic fun identity(baseUrl: String, token: String): String = MessageDigest.getInstance("SHA-256")
            .digest((baseUrl.trim().trimEnd('/') + "\u0000" + token).toByteArray(Charsets.UTF_8))
            .joinToString("") { "%02x".format(it) }
    }
}
