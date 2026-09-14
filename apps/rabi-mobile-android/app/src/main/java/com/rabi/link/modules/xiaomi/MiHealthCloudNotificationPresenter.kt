package com.rabi.link.modules.xiaomi

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.os.Build
import com.rabi.link.MainActivity
import org.json.JSONObject

internal class MiHealthCloudNotificationPresenter(
    private val context: Context
) {
    fun buildRunningNotification(): Notification {
        ensureChannel()
        val openIntent = PendingIntent.getActivity(
            context,
            0,
            Intent(context, MainActivity::class.java),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )
        return builder()
            .setContentTitle("Rabi Link 设备探针")
            .setContentText("正在拉取小米健康云数据")
            .setSmallIcon(android.R.drawable.stat_sys_download)
            .setContentIntent(openIntent)
            .setOngoing(true)
            .build()
    }

    fun showFinishedNotification() {
        ensureChannel()
        val result = MiHealthCloudArtifacts.readLastResult(context)
        val status = try {
            if (!result.hasJson()) {
                "拉取已结束，暂无 JSON 结果"
            } else {
                val root = JSONObject(result.json)
                val points = root.optJSONArray("points")?.length() ?: 0
                val sources = root.optJSONArray("dataSources")?.length() ?: 0
                val pages = root.optJSONArray("pages")?.length() ?: 0
                val raw = root.optJSONArray("rawHttp")?.length() ?: 0
                val errors = root.optJSONArray("errors")?.length() ?: 0
                "${root.optString("status", "拉取已结束")}，points=$points，sources=$sources，pages=$pages，raw=$raw，errors=$errors"
            }
        } catch (_: Throwable) {
            "拉取已结束"
        }
        val text = if (!result.hasZipUri()) {
            "$status。打开 App 查看结果。"
        } else {
            "$status。ZIP 已保存，可打开 App 分享。"
        }
        val openIntent = PendingIntent.getActivity(
            context,
            1,
            Intent(context, MainActivity::class.java),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )
        val notification = builder()
            .setContentTitle("小米健康云拉取完成")
            .setContentText(text)
            .setStyle(Notification.BigTextStyle().bigText(text))
            .setSmallIcon(android.R.drawable.stat_sys_download_done)
            .setContentIntent(openIntent)
            .setAutoCancel(true)
            .build()
        val manager = context.getSystemService(NotificationManager::class.java)
        manager?.notify(FINISHED_NOTIFICATION_ID, notification)
    }

    private fun ensureChannel() {
        if (Build.VERSION.SDK_INT < 26) {
            return
        }
        val channel = NotificationChannel(
            CHANNEL_ID,
            "小米健康云拉取",
            NotificationManager.IMPORTANCE_LOW
        )
        val manager = context.getSystemService(NotificationManager::class.java)
        manager?.createNotificationChannel(channel)
    }

    private fun builder(): Notification.Builder {
        return if (Build.VERSION.SDK_INT >= 26) {
            Notification.Builder(context, CHANNEL_ID)
        } else {
            Notification.Builder(context)
        }
    }

    companion object {
        const val CHANNEL_ID = MiHealthCloudContract.NOTIFICATION_CHANNEL_ID
        const val RUNNING_NOTIFICATION_ID = 1002
        const val FINISHED_NOTIFICATION_ID = 1003
    }
}
