package com.rabi.link.recording

import android.app.Activity
import android.app.AlertDialog
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import com.rabi.link.RabiLinkRelaySettings
import com.rabi.link.RabiMobileDeviceIdentity
import com.rabi.link.RabiMobileUi
import com.rabiroute.sdk.RabiLinkPc
import com.rabiroute.sdk.RabiRouteSdk
import java.util.concurrent.Executors

/** Explicit new-capture destination selection; never migrates historical recordings. */
object RecordingArchiveSettingsPanel {
    fun show(activity: Activity) {
        val executor = Executors.newSingleThreadExecutor()
        var dismissed = false
        fun dp(n: Int) = (n * activity.resources.displayMetrics.density).toInt()
        val panel = LinearLayout(activity).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(20), dp(8), dp(20), dp(12))
        }
        fun label(value: String) = TextView(activity).apply {
            text = value; textSize = 14f; setTextColor(RabiMobileUi.primary)
            setPadding(0, dp(8), 0, dp(8))
        }.also { panel.addView(it) }
        label("录音上传、历史查询与播放依次使用：局域网直连 → P2P → 服务器中转。首次授权可能需要服务器信令。")
        label("模型、角色和长期保存目录只在电脑配置。此处仅启用新录音归档，不迁移全部历史，也不开放原件清理。")
        label("设备 owner：${RabiMobileDeviceIdentity.load(activity)}").setTextIsSelectable(true)
        val current = RecordingArchiveSession.load(activity)
        label(current?.let { "已配置电脑：${it.target.workerId}\n更换电脑需要独立迁移，不能在这里直接改绑。" } ?: "尚未启用电脑长期保存")
        val status = label("尚未读取电脑列表")
        val rows = LinearLayout(activity).apply { orientation = LinearLayout.VERTICAL }
        panel.addView(rows)
        val dialog = AlertDialog.Builder(activity).setTitle("电脑长期保存")
            .setView(ScrollView(activity).apply { addView(panel) })
            .setNegativeButton("关闭", null).create()
        dialog.setOnDismissListener { dismissed = true; executor.shutdown() }
        fun post(action: () -> Unit) = activity.runOnUiThread {
            if (!dismissed && !activity.isFinishing && !activity.isDestroyed) action()
        }
        fun failure(error: Throwable): String = when (error) {
            is RecordingArchiveTransport.HttpFailure -> when (error.status) {
                403 -> "电脑尚未授权此设备归档，请在电脑端绑定上方 owner 后重试。"
                404 -> "电脑尚不支持归档接口，请先更新电脑端。"
                503 -> "电脑归档存储暂不可用，请检查 NAS 和归档配置。"
                else -> "电脑请求失败（${error.status}），未改变本机归档设置。"
            }
            else -> "无法验证电脑身份或归档配置；请检查连接及电脑设置后重试。"
        }
        fun probe(worker: RabiLinkPc) {
            status.text = "正在验证所选电脑…"
            executor.execute {
                val relay = RabiLinkRelaySettings.load(activity)
                val result = runCatching {
                    check(relay.configured)
                    RecordingArchiveTransport(activity, relay, worker).probeCapabilities()
                }
                post {
                    result.onSuccess { cap ->
                        val namespace = cap.getString("storageNamespaceId")
                        val revision = cap.getLong("bindingRevision")
                        if (!cap.getBoolean("uploadAllowed") || revision <= 0) {
                            status.text = "电脑未启用此设备的归档绑定，请先在电脑配置。"
                            return@onSuccess
                        }
                        if (current != null && (current.target.workerId != worker.id || current.target.namespace != namespace)) {
                            status.text = "目标与已有配置不同，请先完成独立迁移；当前设置未改变。"
                            return@onSuccess
                        }
                        AlertDialog.Builder(activity).setTitle("启用新录音归档？")
                            .setMessage("电脑：${worker.name.ifBlank { worker.id }}\n只授权以后开始的新录音。已有历史不会因此上传，手机原件不会自动清理。")
                            .setNegativeButton("取消", null)
                            .setPositiveButton("启用") { _, _ ->
                                if (dismissed) return@setPositiveButton
                                status.text = "正在核验并保存…"
                                executor.execute {
                                    val saved = runCatching {
                                        RecordingArchiveSession.configure(activity, worker, namespace, revision, true).also {
                                            runCatching { com.rabi.link.RabiConversationService.kickArchive() }
                                        }
                                    }
                                    post { saved.onSuccess { status.text = "已启用新录音归档；从下次开始录音生效。重新打开记录页可查看远程历史。历史迁移和原件清理未启用。" }
                                        .onFailure { status.text = failure(it) } }
                                }
                            }.show()
                    }.onFailure { status.text = failure(it) }
                }
            }
        }
        val refresh = RabiMobileUi.secondary(activity, "刷新电脑列表") {
            val relay = RabiLinkRelaySettings.load(activity)
            if (!relay.configured) {
                status.text = "请先配置 RabiLink 连接。"
            } else {
                status.text = "正在发现电脑…"
                executor.execute {
                    val result = runCatching { RabiRouteSdk().getMobileState(relay.baseUrl, relay.token).workers }
                    post {
                        rows.removeAllViews()
                        result.onSuccess { workers ->
                            status.text = if (workers.isEmpty()) "暂无发现的电脑，请确认电脑在线。" else "选择电脑后会先验证归档授权，不会修改当前聊天目标。"
                            workers.forEach { worker ->
                                rows.addView(RabiMobileUi.secondary(activity, worker.name.ifBlank { worker.id } + (if (worker.online) "" else "（离线）")) { probe(worker) }.apply { isEnabled = worker.online })
                            }
                        }.onFailure { status.text = "电脑列表读取失败，请检查 RabiLink 连接。" }
                    }
                }
            }
        }
        panel.addView(refresh)
        dialog.show()
    }
}
