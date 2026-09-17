package com.rabi.link.recording

import android.app.Activity
import android.app.AlertDialog
import android.content.ClipData
import android.view.DragEvent
import android.view.View
import android.widget.*
import com.rabi.link.RabiLinkRelaySettings
import com.rabi.link.RabiMobileUi
import com.rabiroute.sdk.RabiRouteSdk

/** Server-owned ordering; edits are committed only by Save. */
object AsrSettingsDialog {
    fun show(activity: Activity) {
        val relay = RabiLinkRelaySettings.load(activity)
        fun toast(text: String) = Toast.makeText(activity, text, Toast.LENGTH_SHORT).show()
        if(!relay.configured) { toast("请先配置 RabiLink"); return }
        val sdk = RabiRouteSdk()
        Thread {
            val loaded = runCatching { sdk.mobileAsrSettings(relay.baseUrl, relay.token) }
            activity.runOnUiThread {
                if(activity.isFinishing || activity.isDestroyed) return@runOnUiThread
                val settings = loaded.getOrElse { toast("ASR 列表读取失败，请确认服务器已更新并联网"); return@runOnUiThread }
                val workers = settings.workers.toMutableList()
                fun dp(value: Int) = (value * activity.resources.displayMetrics.density).toInt()
                val rows = LinearLayout(activity).apply { orientation = LinearLayout.VERTICAL; setPadding(dp(16),dp(8),dp(16),dp(8)) }
                val scroll = ScrollView(activity).apply { addView(rows) }
                fun render() {
                    rows.removeAllViews()
                    rows.addView(TextView(activity).apply { text = "拖动右侧手柄调整顺序，优先使用靠上的在线电脑。保存后自动转录新录音，并补转已有的本地录音。"; textSize = 13f; setTextColor(RabiMobileUi.muted); setPadding(0,0,0,dp(12)) })
                    if(workers.isEmpty()) rows.addView(TextView(activity).apply { text = "暂无提供 ASR 服务的电脑"; setTextColor(RabiMobileUi.muted) })
                    workers.forEachIndexed { index, worker ->
                        val row = LinearLayout(activity).apply { gravity = android.view.Gravity.CENTER_VERTICAL; minimumHeight = dp(64) }
                        row.addView(TextView(activity).apply {
                            text = "${index + 1}. ${worker.name}\n${if(worker.online) "在线" else "离线"}${if(worker.id == settings.selectedWorkerId) " · 当前优先" else ""}"
                            textSize = 14f; setTextColor(if(worker.online) RabiMobileUi.textColor() else RabiMobileUi.muted)
                        }, LinearLayout.LayoutParams(0,-2,1f))
                        row.addView(TextView(activity).apply {
                            text = "☰"; textSize = 22f; gravity = android.view.Gravity.CENTER; setTextColor(RabiMobileUi.muted)
                            contentDescription = "拖动调整 ${worker.name} 的 ASR 优先级"
                            setOnLongClickListener { view -> view.startDragAndDrop(ClipData.newPlainText("asr-worker", worker.id), View.DragShadowBuilder(row), worker.id, 0) }
                        }, LinearLayout.LayoutParams(dp(48),dp(48)))
                        row.setOnDragListener { _, event ->
                            when(event.action) {
                                DragEvent.ACTION_DRAG_STARTED -> event.localState is String
                                DragEvent.ACTION_DRAG_ENTERED -> { row.alpha = .5f; true }
                                DragEvent.ACTION_DRAG_EXITED, DragEvent.ACTION_DRAG_ENDED -> { row.alpha = 1f; true }
                                DragEvent.ACTION_DROP -> {
                                    val from = workers.indexOfFirst { it.id == event.localState }
                                    val to = workers.indexOfFirst { it.id == worker.id }
                                    if(from >= 0 && to >= 0 && from != to) { workers.add(to,workers.removeAt(from)); render() }
                                    true
                                }
                                else -> true
                            }
                        }
                        rows.addView(row)
                    }
                }
                render()
                val dialog = AlertDialog.Builder(activity).setTitle("ASR 设置").setView(scroll)
                    .setNegativeButton("取消",null).setPositiveButton("保存",null).create()
                dialog.setOnShowListener {
                    dialog.getButton(AlertDialog.BUTTON_POSITIVE).setOnClickListener {
                        val button = dialog.getButton(AlertDialog.BUTTON_POSITIVE); button.isEnabled = false
                        val priority = workers.map { it.id }
                        Thread {
                            val saved = runCatching {
                                val current = RabiLinkRelaySettings.load(activity)
                                check(current.baseUrl == relay.baseUrl && current.token == relay.token) { "RabiLink 已切换" }
                                sdk.mobileAsrSettings(relay.baseUrl,relay.token,priority).also { com.rabi.link.transport.AsrDirectory.update(relay,it) }
                            }
                            activity.runOnUiThread {
                                if(activity.isFinishing || activity.isDestroyed) return@runOnUiThread
                                button.isEnabled = true
                                if(saved.isSuccess) {
                                    val activated = runCatching { if(workers.isNotEmpty()) AllDayRecordingSettings.enableAsr(activity) }
                                    if(activated.isSuccess) { dialog.dismiss(); toast("ASR 优先级已保存") }
                                    else toast("优先级已保存，录音转录未启动，请重试保存")
                                }
                                else toast("未确认保存结果，请重新打开检查")
                            }
                        }.start()
                    }
                }
                dialog.show()
            }
        }.start()
    }
}
