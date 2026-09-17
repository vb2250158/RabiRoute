package com.rabi.link.recording

import android.app.Activity
import android.app.AlertDialog
import android.view.Gravity
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import com.rabi.link.RabiMobileUi
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

object RecordingStorageDialog {
    fun show(activity: Activity) {
        fun dp(value: Int) = (value * activity.resources.displayMetrics.density).toInt()
        fun label(value: String, size: Float, muted: Boolean = false) = TextView(activity).apply {
            text = value; textSize = size
            setTextColor(if(muted) RabiMobileUi.muted else RabiMobileUi.textColor())
        }
        val settings = LinearLayout(activity).apply { orientation = LinearLayout.VERTICAL; setPadding(dp(24),dp(8),dp(24),dp(12)) }
        val enabled = android.widget.Switch(activity).apply { text = "启用电脑缓存"; isChecked = RecordingResourceCache.enabled(activity); setTextColor(RabiMobileUi.primary) }
        var hours = RecordingResourceCache.hours(activity)
        fun retentionLabel() = if(hours == 0) "电脑保存后清理手机媒体" else "手机保留 $hours 小时"
        val heading = label(retentionLabel(),14f)
        val slider = android.widget.SeekBar(activity).apply { max = 168; progress = hours
            setOnSeekBarChangeListener(object: android.widget.SeekBar.OnSeekBarChangeListener {
                override fun onProgressChanged(bar: android.widget.SeekBar,p: Int,user: Boolean) { hours=p; heading.text=retentionLabel() }
                override fun onStartTrackingTouch(bar: android.widget.SeekBar) {}
                override fun onStopTrackingTouch(bar: android.widget.SeekBar) { RecordingResourceCache.save(activity,enabled.isChecked,hours) }
            })
        }
        enabled.setOnCheckedChangeListener { _,checked -> RecordingResourceCache.save(activity,checked,hours); slider.isEnabled=checked }
        slider.isEnabled=enabled.isChecked
        settings.addView(enabled); settings.addView(heading); settings.addView(slider)
        settings.addView(label(activity.getSharedPreferences("recording_resource_cache",0).getString("status","").orEmpty(),12f,true))
        settings.addView(label("到期只清理电脑已保存的媒体。时间线和转录保留，回看时自动加载。",12f,true))
        val rows = LinearLayout(activity).apply { orientation = LinearLayout.VERTICAL; setPadding(dp(24),dp(12),dp(24),dp(16)) }
        val dialog = AlertDialog.Builder(activity).setTitle("存储管理").setView(ScrollView(activity).apply { addView(LinearLayout(activity).apply { orientation=LinearLayout.VERTICAL; addView(settings); addView(rows) }) })
            .setNegativeButton("关闭",null).setPositiveButton("刷新",null).create()
        var worker: Thread? = null
        fun refresh() {
            dialog.getButton(AlertDialog.BUTTON_POSITIVE).isEnabled = false
            rows.removeAllViews(); rows.addView(label("正在统计记录占用…",14f,true))
            worker = Thread {
                val result = runCatching { RecordingStorage.scan(activity.filesDir,activity.cacheDir) }
                activity.runOnUiThread {
                    if(activity.isFinishing || activity.isDestroyed || !dialog.isShowing) return@runOnUiThread
                    dialog.getButton(AlertDialog.BUTTON_POSITIVE).isEnabled = true
                    rows.removeAllViews()
                    result.onSuccess { snapshot ->
                        rows.addView(label(if(snapshot.unavailable == 0) "记录总占用" else "已统计占用 · 部分文件未读取",13f,true))
                        rows.addView(label(RecordingStorage.formatBytes(snapshot.totalBytes),34f).apply { setTextColor(RabiMobileUi.primary); setPadding(0,dp(6),0,dp(20)) })
                        RecordingStorage.Kind.values().forEach { kind ->
                            rows.addView(LinearLayout(activity).apply {
                                gravity = Gravity.CENTER_VERTICAL; setPadding(0,dp(8),0,dp(8))
                                addView(label(kind.title,14f),LinearLayout.LayoutParams(0,-2,1f))
                                addView(label(RecordingStorage.formatBytes(snapshot.bytes.getValue(kind)),14f))
                            })
                        }
                        rows.addView(label("手机可用空间  ${RecordingStorage.formatBytes(snapshot.availableBytes)}",13f,true).apply { setPadding(0,dp(18),0,0) })
                        rows.addView(label("文件大小合计 · 1 GB = 1000 MB\n更新于 ${SimpleDateFormat("HH:mm:ss",Locale.getDefault()).format(Date())}，录音中可刷新",12f,true).apply { setPadding(0,dp(10),0,0) })
                    }.onFailure { rows.addView(label("统计失败，请点击刷新重试",14f,true)) }
                }
            }.also { it.start() }
        }
        dialog.setOnShowListener { dialog.getButton(AlertDialog.BUTTON_POSITIVE).setOnClickListener { refresh() }; refresh() }
        dialog.setOnDismissListener { worker?.interrupt() }
        dialog.show()
    }
}
