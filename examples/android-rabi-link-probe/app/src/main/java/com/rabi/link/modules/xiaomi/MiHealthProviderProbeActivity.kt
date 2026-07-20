package com.rabi.link.modules.xiaomi

import android.app.Activity
import android.content.ContentResolver
import android.net.Uri
import android.os.Bundle
import android.util.Log
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import com.rabi.link.RabiGuidanceTone
import com.rabi.link.RabiMobileUi
import com.rabi.link.RabiSetupGuidance

class MiHealthProviderProbeActivity : Activity() {
    private val tag = "RabiMiHealthProbe"
    private lateinit var logView: TextView
    private lateinit var statusView: TextView

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val content = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(16), dp(16), dp(16), dp(28))
            setBackgroundColor(RabiMobileUi.background)
            addView(RabiMobileUi.hero(
                this@MiHealthProviderProbeActivity,
                "小米本机数据边界检查",
                "这是高级诊断：只检查小米健康 Provider 是否允许普通 App 访问，不读取或展示健康数值。",
            ), full(0, 0, 0, 12))
        }
        statusView = RabiMobileUi.guidance(this, RabiSetupGuidance(
            "正在自动检查",
            "App 正在逐个测试公开候选入口，并且只统计可访问性和列名。",
            "请稍候，不需要操作。",
        ))
        content.addView(statusView, full(0, 0, 0, 12))
        val resultCard = RabiMobileUi.card(this).apply {
            addView(RabiMobileUi.title(this@MiHealthProviderProbeActivity, "诊断明细"))
            addView(RabiMobileUi.note(this@MiHealthProviderProbeActivity, "cursor=null 或 SecurityException 通常表示小米健康的私有权限墙，不是 Rabi 配置填错。"))
            logView = TextView(this@MiHealthProviderProbeActivity).apply {
                textSize = 13f
                setTextColor(RabiMobileUi.text)
                setPadding(dp(12), dp(10), dp(12), dp(10))
                background = RabiMobileUi.panel(this@MiHealthProviderProbeActivity, RabiMobileUi.surface, RabiMobileUi.border, 10)
            }
            addView(logView)
        }
        content.addView(resultCard)
        setContentView(ScrollView(this).apply { addView(content) })

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

        val accessible = candidates.count(::query)
        showGuidance(if (accessible > 0) RabiSetupGuidance(
            "发现 $accessible 个可访问入口",
            "系统允许普通 App 读取这些 Provider 元数据；具体可用字段见下方诊断。",
            "这仍属于实验能力，日常健康同步优先使用 Health Connect。",
            RabiGuidanceTone.SUCCESS,
        ) else RabiSetupGuidance(
            "小米本机 Provider 不允许普通 App 访问",
            "所有候选入口都返回空或权限错误，这是小米健康的系统权限限制，不是你漏填了设置。",
            "普通用户请改用 Health Connect；开发调试只能使用已授权的 PC ADB Companion。",
            RabiGuidanceTone.WARNING,
        ))
    }

    private fun query(candidate: String): Boolean {
        append("URI: $candidate")
        try {
            val uri = Uri.parse(candidate)
            val args = Bundle().apply {
                putInt(ContentResolver.QUERY_ARG_LIMIT, 5)
            }
            contentResolver.query(uri, null, args, null).use { cursor ->
                if (cursor == null) {
                    append("  结果：cursor=null")
                    return false
                }
                append("  列名：${cursor.columnNames.joinToString()}")
                var rows = 0
                while (rows < 5 && cursor.moveToNext()) {
                    rows++
                }
                append("  前5行内行数：$rows")
                return true
            }
        } catch (error: Throwable) {
            append("  异常：${error.javaClass.simpleName}: ${error.message}")
            return false
        }
    }

    private fun append(message: String) {
        Log.i(tag, message)
        logView.append(message + "\n")
    }

    private fun showGuidance(value: RabiSetupGuidance) {
        val styled = RabiMobileUi.guidance(this, value)
        statusView.text = styled.text
        statusView.setTextColor(styled.currentTextColor)
        statusView.background = styled.background
    }

    private fun full(left: Int, top: Int, right: Int, bottom: Int) =
        LinearLayout.LayoutParams(-1, -2).apply { setMargins(dp(left), dp(top), dp(right), dp(bottom)) }

    private fun dp(value: Int) = RabiMobileUi.dp(this, value)
}
