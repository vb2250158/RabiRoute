package com.rabi.link.modules.xiaomi

import android.app.Service
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import android.os.PowerManager
import android.util.Log
import java.util.concurrent.TimeUnit

class MiHealthCloudListProbeReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        val serviceIntent = Intent(context, MiHealthCloudProbeService::class.java).apply {
            putExtras(intent)
        }
        if (Build.VERSION.SDK_INT >= 26) {
            context.startForegroundService(serviceIntent)
        } else {
            context.startService(serviceIntent)
        }
    }
}

class MiHealthCloudProbeService : Service() {
    private var wakeLock: PowerManager.WakeLock? = null
    private val notificationPresenter by lazy { MiHealthCloudNotificationPresenter(this) }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        startAsForeground()
        acquireWakeLock()
        Thread {
            try {
                MiHealthCloudListProbe(applicationContext, intent ?: Intent()).run()
            } catch (error: Throwable) {
                Log.e(TAG, "小米健康云列表探针失败：${error.javaClass.simpleName}: ${error.message}", error)
            } finally {
                notificationPresenter.showFinishedNotification()
                releaseWakeLock()
                stopSelf(startId)
            }
        }.start()
        return START_NOT_STICKY
    }

    override fun onDestroy() {
        releaseWakeLock()
        super.onDestroy()
    }

    private fun startAsForeground() {
        val notification = notificationPresenter.buildRunningNotification()
        if (Build.VERSION.SDK_INT >= 29) {
            startForeground(MiHealthCloudNotificationPresenter.RUNNING_NOTIFICATION_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC)
        } else {
            startForeground(MiHealthCloudNotificationPresenter.RUNNING_NOTIFICATION_ID, notification)
        }
    }

    private fun acquireWakeLock() {
        if (wakeLock?.isHeld == true) {
            return
        }
        val manager = getSystemService(PowerManager::class.java) ?: return
        wakeLock = manager.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "RabiLinkProbe:MiHealthCloud").apply {
            setReferenceCounted(false)
            acquire(TimeUnit.MINUTES.toMillis(30))
        }
        Log.i(TAG, "已获取拉取期间 WakeLock，最长 30 分钟。")
    }

    private fun releaseWakeLock() {
        val lock = wakeLock ?: return
        if (lock.isHeld) {
            lock.release()
            Log.i(TAG, "已释放拉取期间 WakeLock。")
        }
        wakeLock = null
    }

    private companion object {
        const val TAG = "RabiMiHealthCloud"
    }
}

private class MiHealthCloudListProbe(
    private val context: Context,
    private val intent: Intent
) {
    private val logBuffer = StringBuilder()
    private val resultAccumulator = MiHealthCloudResultAccumulator()
    private val resultStore = MiHealthCloudResultStore(context)
    private val rawHttpRecorder = MiHealthCloudRawHttpRecorder(
        context,
        resultAccumulator.rawHttpBuffer,
        resultAccumulator::recordError,
        ::log
    )
    private var statusMessage = "未完成"
    private var reportSliceHours = 0L
    private var autoSaveZip = false

    fun run() {
        resultStore.clearLog()
        rawHttpRecorder.clearRawHttpDir()
        val request = MiHealthCloudProbeRequest.from(context, intent)
        reportSliceHours = request.sliceHours
        autoSaveZip = request.autoSaveZip

        log("开始小米健康云列表探针：dataTypes=${request.dataTypeNames.joinToString(",")} hours=${request.hours} sliceHours=${request.sliceHours} limit=${request.limit} maxPages=${request.maxPages} timeout=${request.requestTimeoutSeconds}s autoSaveZip=$autoSaveZip dataUrl=${request.dataUrl}")
        if (request.appId.isBlank() || request.accessToken.isBlank()) {
            statusMessage = "缺少 app_id 或 access_token"
            log("缺少 app_id 或 access_token。该路线需要小米健康云 OAuth 授权，不能复用小米健康私有登录态。")
            log("调用示例：adb shell am broadcast -n com.rabi.link/.modules.xiaomi.MiHealthCloudListProbeReceiver --es app_id '<appId>' --es access_token '<token>'")
            log("也可以打开 APK 内 OAuth 页面：adb shell am start -n com.rabi.link/.modules.xiaomi.MiHealthOAuthActivity --es app_id '<appId>'")
            persistResult(request.dataTypeNames, 0L, 0L, 0)
            return
        }

        val endNs = TimeUnit.MILLISECONDS.toNanos(System.currentTimeMillis())
        val startNs = endNs - TimeUnit.HOURS.toNanos(request.hours)
        val windows = buildWindows(startNs, endNs, request.sliceHours)
        val totalPoints = MiHealthCloudSdkPageRunner(
            context,
            request,
            rawHttpRecorder,
            resultAccumulator,
            ::log
        ).readAll(windows)
        statusMessage = if (totalPoints > 0) {
            "成功拉取样本"
        } else {
            "请求完成但样本数为 0"
        }
        log("小米健康云列表探针结束：总样本数=$totalPoints")
        persistResult(request.dataTypeNames, startNs, endNs, totalPoints)
    }

    private fun buildWindows(startNs: Long, endNs: Long, sliceHours: Long): List<Pair<Long, Long>> {
        if (sliceHours <= 0L) {
            return listOf(startNs to endNs)
        }
        val sliceNs = TimeUnit.HOURS.toNanos(sliceHours)
        if (sliceNs <= 0L || sliceNs >= endNs - startNs) {
            return listOf(startNs to endNs)
        }
        val windows = mutableListOf<Pair<Long, Long>>()
        var current = startNs
        while (current < endNs) {
            val next = minOf(current + sliceNs, endNs)
            windows += current to next
            current = next
        }
        return windows
    }

    private fun log(message: String) {
        Log.i(TAG, message)
        logBuffer.append(message).append('\n')
        resultStore.saveLog(logBuffer.toString())
    }

    private fun persistResult(dataTypeNames: List<String>, startNs: Long, endNs: Long, totalPoints: Int) {
        val snapshot = resultAccumulator.snapshot(dataTypeNames, statusMessage, startNs, endNs, reportSliceHours, totalPoints)
        resultStore.saveJson(snapshot)
        resultStore.saveMarkdown(snapshot)
        resultStore.saveLog(logBuffer.toString())
        resultStore.maybeAutoSaveZip(autoSaveZip, logBuffer.toString(), resultAccumulator::recordError, ::log)
        log("完整结果已保存：points=${resultAccumulator.pointCount} rawHttp=${resultAccumulator.rawHttpCount} errors=${resultAccumulator.errorCount}")
    }

    private fun formatNs(ns: Long): String {
        if (ns <= 0L) {
            return "unknown"
        }
        return MiHealthCloudTimeFormatter.formatNs(ns)
    }

    private companion object {
        const val TAG = "RabiMiHealthCloud"
    }
}
