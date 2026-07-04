package com.rabiroute.bandprobe

import android.app.Activity
import android.content.ContentResolver
import android.net.Uri
import android.os.Bundle
import android.util.Log
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView

class MiHealthProviderProbeActivity : Activity() {
    private val tag = "RabiMiHealthProbe"
    private lateinit var logView: TextView

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val root = LinearLayout(this)
        root.orientation = LinearLayout.VERTICAL
        root.setPadding(24, 24, 24, 24)
        logView = TextView(this)
        logView.textSize = 13f
        val scroll = ScrollView(this)
        scroll.addView(logView)
        root.addView(scroll, LinearLayout.LayoutParams(-1, -1))
        setContentView(root)

        append("开始探测小米健康 Provider。只输出可访问性、列名和少量行数，不输出数据值。")
        probe()
    }

    private fun probe() {
        val candidates = listOf(
            "content://com.mi.health.provider.main",
            "content://com.mi.health.provider.main/",
            "content://com.mi.health.provider.main/heart",
            "content://com.mi.health.provider.main/heartrate",
            "content://com.mi.health.provider.main/heart_rate",
            "content://com.mi.health.provider.main/heartRate",
            "content://com.mi.health.provider.main/health",
            "content://com.mi.health.provider.main/data",
            "content://com.mi.health.provider.main/records",
            "content://com.mi.health.provider.main/sport",
            "content://com.mi.health.provider.main/sleep",
            "content://com.mi.health.provider.device"
        )

        for (candidate in candidates) {
            query(candidate)
        }
    }

    private fun query(candidate: String) {
        append("URI: $candidate")
        try {
            val uri = Uri.parse(candidate)
            val args = Bundle().apply {
                putInt(ContentResolver.QUERY_ARG_LIMIT, 5)
            }
            contentResolver.query(uri, null, args, null).use { cursor ->
                if (cursor == null) {
                    append("  结果：cursor=null")
                    return
                }
                append("  列名：${cursor.columnNames.joinToString()}")
                var rows = 0
                while (rows < 5 && cursor.moveToNext()) {
                    rows++
                }
                append("  前5行内行数：$rows")
            }
        } catch (error: Throwable) {
            append("  异常：${error.javaClass.simpleName}: ${error.message}")
        }
    }

    private fun append(message: String) {
        Log.i(tag, message)
        logView.append(message + "\n")
    }
}
