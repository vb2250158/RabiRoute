package com.rabi.link.modules.wearable

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.os.IBinder
import com.rabi.link.R
import com.rabi.link.RabiLinkRelaySettings
import com.rabiroute.sdk.RabiWearableHealthClient
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import java.time.Instant

class WearableHealthSyncService : Service() {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private val client = RabiWearableHealthClient()
    private val syncMutex = Mutex()
    private var loopJob: Job? = null

    override fun onCreate() {
        super.onCreate()
        ensureChannel()
        startForeground(NOTIFICATION_ID, notification("等待第一次健康同步"))
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == ACTION_STOP) {
            stopSelf()
            return START_NOT_STICKY
        }
        val syncNow = intent?.action == ACTION_SYNC_NOW
        if (loopJob?.isActive != true) {
            loopJob = scope.launch {
                while (isActive) {
                    val config = WearableHealthSettings.load(this@WearableHealthSyncService)
                    if (!config.enabled) {
                        stopSelf()
                        break
                    }
                    if (config.collectorMode == WearableHealthCollectorMode.XIAOMI_ADB_COMPANION) {
                        updateStatus("已启用小米 ADB Companion；等待已配对的 Rabi PC 自动采集。")
                        stopSelf()
                        break
                    }
                    syncOnce(config)
                    delay(config.pollIntervalMinutes.toLong() * 60_000L)
                }
            }
        } else if (syncNow) {
            scope.launch { syncOnce() }
        }
        return START_STICKY
    }

    override fun onDestroy() {
        scope.coroutineContext[Job]?.cancel()
        super.onDestroy()
    }

    override fun onBind(intent: Intent?): IBinder? = null

    private suspend fun syncOnce(config: WearableHealthConfig = WearableHealthSettings.load(this)) {
        syncMutex.withLock { syncOnceLocked(config) }
    }

    private suspend fun syncOnceLocked(config: WearableHealthConfig) {
        try {
            val relay = RabiLinkRelaySettings.load(this)
            check(relay.configured) { "请先在 RabiLink 首页配置 Relay 地址和应用 token。" }
            val samples = WearableHealthCollector.collect(this, config)
            if (samples.isEmpty()) {
                updateStatus("Health Connect 当前没有可上报的心率或睡眠记录。")
                return
            }
            val receipt = client.publish(
                relayBaseUrl = relay.baseUrl,
                token = relay.token,
                sourceDeviceId = config.sourceDeviceId.ifBlank { "unknown-wearable" },
                sourceDeviceKind = config.sourceDeviceKind.ifBlank { "wearable" },
                sourceDeviceName = config.sourceDeviceName,
                samples = samples,
                policy = config.policy,
                clientMessageId = "wearable-health-${System.currentTimeMillis()}",
                capturedAt = System.currentTimeMillis(),
                transport = "health-connect-phone"
            )
            updateStatus("已上报 ${samples.size} 条健康记录（${receipt.status.ifBlank { "accepted" }}）。")
        } catch (cancelled: CancellationException) {
            throw cancelled
        } catch (error: Throwable) {
            updateStatus("健康同步失败：${error.message ?: error.javaClass.simpleName}")
        }
    }

    private fun updateStatus(text: String) {
        WearableHealthSettings.saveLastStatus(this, text)
        (getSystemService(NOTIFICATION_SERVICE) as NotificationManager).notify(NOTIFICATION_ID, notification(text))
    }

    private fun ensureChannel() {
        val manager = getSystemService(NOTIFICATION_SERVICE) as NotificationManager
        manager.createNotificationChannel(
            NotificationChannel(CHANNEL_ID, "智能手表/手环健康同步", NotificationManager.IMPORTANCE_LOW)
        )
    }

    private fun notification(text: String): Notification {
        val open = PendingIntent.getActivity(
            this,
            0,
            Intent(this, WearableHealthSettingsActivity::class.java),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )
        return Notification.Builder(this, CHANNEL_ID)
            .setSmallIcon(R.drawable.rabiroute_icon)
            .setContentTitle("RabiLink 健康记录")
            .setContentText(text.take(120))
            .setContentIntent(open)
            .setOngoing(true)
            .build()
    }

    companion object {
        private const val CHANNEL_ID = "rabilink_wearable_health"
        private const val NOTIFICATION_ID = 4103
        private const val ACTION_SYNC_NOW = "com.rabi.link.wearable.SYNC_NOW"
        private const val ACTION_STOP = "com.rabi.link.wearable.STOP"

        @JvmStatic
        fun start(context: Context) {
            val config = WearableHealthSettings.load(context)
            if (config.collectorMode == WearableHealthCollectorMode.XIAOMI_ADB_COMPANION) {
                WearableHealthSettings.saveLastStatus(context, "已启用小米 ADB Companion；等待已配对的 Rabi PC 自动采集。")
                return
            }
            context.startForegroundService(Intent(context, WearableHealthSyncService::class.java))
        }

        @JvmStatic
        fun syncNow(context: Context) {
            val config = WearableHealthSettings.load(context)
            if (config.collectorMode == WearableHealthCollectorMode.XIAOMI_ADB_COMPANION) {
                WearableHealthSettings.saveLastStatus(context, "小米 ADB Companion 将由 Rabi PC 自动同步；请保持手机 USB 调试连接。")
                return
            }
            context.startForegroundService(
                Intent(context, WearableHealthSyncService::class.java).setAction(ACTION_SYNC_NOW)
            )
        }

        @JvmStatic
        fun stop(context: Context) {
            context.stopService(Intent(context, WearableHealthSyncService::class.java))
        }
    }
}

class WearableHealthBootReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent?) {
        val config = WearableHealthSettings.load(context)
        if (intent?.action == Intent.ACTION_BOOT_COMPLETED &&
            config.enabled &&
            config.collectorMode == WearableHealthCollectorMode.HEALTH_CONNECT
        ) {
            WearableHealthSyncService.start(context)
        }
    }
}
