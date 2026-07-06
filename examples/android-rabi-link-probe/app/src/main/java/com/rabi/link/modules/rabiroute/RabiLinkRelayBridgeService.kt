package com.rabi.link.modules.rabiroute

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import android.os.PowerManager
import android.util.Log
import com.rabi.link.MainActivity
import com.rabi.link.R
import com.rabiroute.sdk.RabiInstance
import com.rabiroute.sdk.RabiRouteSdk
import java.net.URL
import java.util.concurrent.TimeUnit

class RabiLinkRelayBridgeService : Service() {
    private val sdk = RabiRouteSdk()
    private var bridgeThread: Thread? = null
    private var wakeLock: PowerManager.WakeLock? = null
    @Volatile private var running = false

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == ACTION_STOP) {
            stopBridge()
            stopSelf(startId)
            return START_NOT_STICKY
        }

        startAsForeground()
        acquireWakeLock()
        startBridge(intent ?: Intent())
        return START_STICKY
    }

    override fun onDestroy() {
        stopBridge()
        releaseWakeLock()
        super.onDestroy()
    }

    private fun startBridge(intent: Intent) {
        if (running) stopBridge()
        val relayBaseUrl = intent.getStringExtra(EXTRA_RELAY_BASE_URL).orEmpty().trim()
        val token = intent.getStringExtra(EXTRA_TOKEN).orEmpty().trim()
        val routeId = intent.getStringExtra(EXTRA_ROUTE_ID).orEmpty().trim()
        val callbackUrl = intent.getStringExtra(EXTRA_CALLBACK_URL).orEmpty().trim()
        val instance = instanceFromIntent(intent)
        if (relayBaseUrl.isBlank() || token.isBlank() || routeId.isBlank() || callbackUrl.isBlank() || instance == null) {
            Log.e(TAG, "缺少启动参数，无法启动 RabiLink Relay 桥。")
            stopSelf()
            return
        }

        running = true
        bridgeThread = Thread {
            Log.i(TAG, "RabiLink Relay 桥已启动：relay=$relayBaseUrl route=$routeId callback=$callbackUrl")
            while (running) {
                try {
                    val tasks = sdk.claimRabiLinkRelayTasks(
                        relayBaseUrl = relayBaseUrl,
                        token = token,
                        deviceId = deviceId(),
                        waitMs = 30000,
                        limit = 1
                    )
                    for (task in tasks) {
                        if (!running) break
                        handleRelayTask(relayBaseUrl, token, instance, routeId, callbackUrl, task.id, task.text)
                    }
                } catch (error: Throwable) {
                    Log.e(TAG, "RabiLink Relay 桥异常：${error.message ?: error}", error)
                    sleepQuietly(1200)
                }
            }
            Log.i(TAG, "RabiLink Relay 桥已停止。")
        }.apply {
            name = "RabiLinkRelayBridgeService"
            start()
        }
    }

    private fun stopBridge() {
        running = false
        bridgeThread?.interrupt()
        bridgeThread = null
    }

    private fun handleRelayTask(
        relayBaseUrl: String,
        token: String,
        _instance: RabiInstance,
        routeId: String,
        callbackUrl: String,
        taskId: String,
        text: String
    ) {
        try {
            handleRelayTaskUnchecked(relayBaseUrl, token, routeId, callbackUrl, taskId, text)
        } catch (error: Throwable) {
            Log.e(TAG, "公网任务处理异常：$taskId ${error.message ?: error}", error)
            runCatching {
                sdk.finishRabiLinkRelayTask(
                    relayBaseUrl,
                    token,
                    taskId,
                    "手机桥处理异常：${error.message ?: error}",
                    ok = false
                )
            }
        }
    }

    private fun handleRelayTaskUnchecked(
        relayBaseUrl: String,
        token: String,
        routeId: String,
        callbackUrl: String,
        taskId: String,
        text: String
    ) {
        Log.i(TAG, "取到公网任务：$taskId")
        val baselineReplies = sdk.getRabiLinkReplies(callbackUrl, routeId, 1)
        var afterReplyId = lastReplyId(baselineReplies)
        val inbound = sdk.deliverRabiLinkMessage(callbackUrl, text, routeId)
        Log.i(TAG, "已投递到 RabiRoute：messageId=${inbound.messageId} ok=${inbound.ok}")
        if (!inbound.ok || inbound.messageId.isBlank()) {
            sdk.finishRabiLinkRelayTask(relayBaseUrl, token, taskId, "手机桥投递到 RabiRoute 失败。", ok = false)
            return
        }

        var appendedCount = 0
        val startedAt = System.currentTimeMillis()
        var lastAppendAt = 0L
        while (running && System.currentTimeMillis() - startedAt < 60000) {
            val repliesJson = sdk.getRabiLinkReplies(callbackUrl, routeId, 50, afterReplyId)
            val replies = repliesJson.optJSONArray("replies")
            if (replies != null) {
                for (index in 0 until replies.length()) {
                    val reply = replies.optJSONObject(index) ?: continue
                    val replyId = reply.optString("id")
                    if (replyId.isNotBlank()) afterReplyId = replyId
                    if (reply.optString("messageId") != inbound.messageId) continue
                    val replyText = reply.optString("text")
                    if (replyText.isBlank()) continue
                    sdk.appendRabiLinkRelayMessage(relayBaseUrl, token, taskId, replyText, final = false)
                    appendedCount += 1
                    lastAppendAt = System.currentTimeMillis()
                    Log.i(TAG, "已写回公网 Relay：$replyId")
                }
            }
            if (appendedCount > 0 && System.currentTimeMillis() - lastAppendAt > 2500) {
                sdk.finishRabiLinkRelayTask(relayBaseUrl, token, taskId, ok = true)
                Log.i(TAG, "公网任务完成：$taskId replies=$appendedCount")
                return
            }
            sleepQuietly(250)
        }

        if (appendedCount > 0) {
            sdk.finishRabiLinkRelayTask(relayBaseUrl, token, taskId, ok = true)
            Log.i(TAG, "公网任务超时结束：$taskId replies=$appendedCount")
        } else {
            sdk.finishRabiLinkRelayTask(relayBaseUrl, token, taskId, "电脑端暂时没有返回回复。", ok = false)
            Log.w(TAG, "公网任务无回包：$taskId")
        }
    }

    private fun startAsForeground() {
        val notification = buildNotification()
        if (Build.VERSION.SDK_INT >= 29) {
            startForeground(NOTIFICATION_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC)
        } else {
            startForeground(NOTIFICATION_ID, notification)
        }
    }

    private fun buildNotification(): Notification {
        ensureChannel()
        val openIntent = PendingIntent.getActivity(
            this,
            0,
            Intent(this, MainActivity::class.java),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )
        val builder = if (Build.VERSION.SDK_INT >= 26) {
            Notification.Builder(this, CHANNEL_ID)
        } else {
            Notification.Builder(this)
        }
        return builder
            .setContentTitle("RabiLink 正在运行")
            .setContentText("正在连接 Rokid 眼镜、RabiRoute 和 Codex")
            .setSmallIcon(R.drawable.ic_rabi_link_notification)
            .setContentIntent(openIntent)
            .setOngoing(true)
            .build()
    }

    private fun ensureChannel() {
        if (Build.VERSION.SDK_INT < 26) return
        val channel = NotificationChannel(CHANNEL_ID, "RabiLink Relay 手机桥", NotificationManager.IMPORTANCE_LOW)
        getSystemService(NotificationManager::class.java)?.createNotificationChannel(channel)
    }

    private fun acquireWakeLock() {
        if (wakeLock?.isHeld == true) return
        val manager = getSystemService(PowerManager::class.java) ?: return
        wakeLock = manager.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "RabiLinkProbe:RelayBridge").apply {
            setReferenceCounted(false)
            acquire(TimeUnit.HOURS.toMillis(6))
        }
    }

    private fun releaseWakeLock() {
        val lock = wakeLock ?: return
        if (lock.isHeld) lock.release()
        wakeLock = null
    }

    private fun instanceFromIntent(intent: Intent): RabiInstance? {
        val guid = intent.getStringExtra(EXTRA_INSTANCE_GUID).orEmpty()
        val name = intent.getStringExtra(EXTRA_INSTANCE_NAME).orEmpty()
        val computerName = intent.getStringExtra(EXTRA_COMPUTER_NAME).orEmpty()
        val deviceType = intent.getStringExtra(EXTRA_DEVICE_TYPE).orEmpty()
        val baseUrl = intent.getStringExtra(EXTRA_MANAGER_BASE_URL).orEmpty().trimEnd('/')
        if (guid.isBlank() || baseUrl.isBlank()) return null
        val parsed = runCatching { URL(baseUrl) }.getOrNull()
        val host = parsed?.host.orEmpty()
        val port = if (parsed != null && parsed.port > 0) parsed.port else 8790
        return RabiInstance(
            guid = guid,
            name = name.ifBlank { "RabiRoute" },
            computerName = computerName,
            deviceType = deviceType,
            baseUrl = baseUrl,
            host = host,
            port = port,
            version = null
        )
    }

    private fun lastReplyId(json: org.json.JSONObject): String {
        val replies = json.optJSONArray("replies") ?: return ""
        return (replies.length() - 1 downTo 0)
            .asSequence()
            .mapNotNull { replies.optJSONObject(it)?.optString("id") }
            .firstOrNull { it.isNotBlank() }
            .orEmpty()
    }

    private fun sleepQuietly(ms: Long) {
        try {
            Thread.sleep(ms)
        } catch (_: InterruptedException) {
            Thread.currentThread().interrupt()
        }
    }

    private fun deviceId(): String = "${Build.MANUFACTURER}-${Build.MODEL}-${Build.ID}"

    companion object {
        private const val TAG = "RabiRelayBridge"
        private const val CHANNEL_ID = "rabi_link_relay_bridge"
        private const val NOTIFICATION_ID = 1301
        const val PREFS_NAME = "rabi_link_relay_bridge"
        const val PREF_ENABLED = "enabled"
        const val ACTION_STOP = "com.rabi.link.modules.rabiroute.STOP_RELAY_BRIDGE"
        const val EXTRA_RELAY_BASE_URL = "relayBaseUrl"
        const val EXTRA_TOKEN = "token"
        const val EXTRA_ROUTE_ID = "routeId"
        const val EXTRA_CALLBACK_URL = "callbackUrl"
        const val EXTRA_MANAGER_BASE_URL = "managerBaseUrl"
        const val EXTRA_INSTANCE_GUID = "instanceGuid"
        const val EXTRA_INSTANCE_NAME = "instanceName"
        const val EXTRA_COMPUTER_NAME = "computerName"
        const val EXTRA_DEVICE_TYPE = "deviceType"
    }
}
