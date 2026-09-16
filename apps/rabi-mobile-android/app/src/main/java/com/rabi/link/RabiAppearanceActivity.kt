package com.rabi.link

import android.app.Activity
import android.content.Intent
import android.os.Bundle
import android.view.Gravity
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import android.widget.Toast

class RabiAppearanceActivity : Activity() {
    override fun onCreate(state: Bundle?) {
        super.onCreate(state)
        val content = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(16), dp(12), dp(16), dp(16))
            setBackgroundColor(RabiMobileUi.background)
        }
        content.addView(LinearLayout(this).apply {
            gravity = Gravity.CENTER_VERTICAL
            addView(RabiMobileUi.title(this@RabiAppearanceActivity, "皮肤与外观", 22f), LinearLayout.LayoutParams(0, -2, 1f))
            addView(RabiMobileUi.compactAction(this@RabiAppearanceActivity, "返回") { finish() }, LinearLayout.LayoutParams(dp(72), dp(48)))
        })
        content.addView(RabiMobileUi.note(this, "选择后立即生效，自动保存在这台手机。"))
        val selected = RabiMobileTheme.preference(this)
        val ids = resources.getStringArray(R.array.mobile_theme_ids)
        val names = resources.getStringArray(R.array.mobile_theme_names)
        val descriptions = resources.getStringArray(R.array.mobile_theme_descriptions)
        ids.forEachIndexed { index, id ->
            val palette = when (id) {
                "light" -> RabiThemeTokens.light
                "dark" -> RabiThemeTokens.dark
                else -> if (RabiMobileTheme.systemDark()) RabiThemeTokens.dark else RabiThemeTokens.light
            }
            val card = RabiMobileUi.card(this)
            if (selected == id) card.background = RabiMobileUi.panel(this, RabiMobileUi.surface, RabiMobileUi.secondary)
            card.addView(RabiMobileUi.title(this, names[index]))
            card.addView(RabiMobileUi.note(this, descriptions[index]))
            val preview = LinearLayout(this).apply {
                gravity = Gravity.CENTER_VERTICAL
                setPadding(dp(12), dp(12), dp(12), dp(12))
                background = RabiMobileUi.panel(this@RabiAppearanceActivity, palette.getValue("canvas"), palette.getValue("border"))
            }
            listOf("surface", "accent-strong", "text").forEach { token ->
                preview.addView(TextView(this).apply {
                    background = RabiMobileUi.panel(this@RabiAppearanceActivity, palette.getValue(token), palette.getValue("border"), 8)
                    importantForAccessibility = android.view.View.IMPORTANT_FOR_ACCESSIBILITY_NO
                }, LinearLayout.LayoutParams(dp(28), dp(28)).apply { marginEnd = dp(8) })
            }
            preview.addView(TextView(this).apply {
                text = "消息与记录"; setTextColor(palette.getValue("text")); textSize = 14f
            }, LinearLayout.LayoutParams(0, -2, 1f))
            card.addView(preview, LinearLayout.LayoutParams(-1, -2).apply { topMargin = dp(4); bottomMargin = dp(12) })
            card.addView(RabiMobileUi.secondary(this, if (selected == id) "已选择" else "使用${names[index].substringBefore(" ·")}") {
                if (RabiMobileTheme.save(this, id)) recreate()
                else Toast.makeText(this, "皮肤未保存，请重试", Toast.LENGTH_SHORT).show()
            }.apply { isEnabled = selected != id })
            content.addView(card, LinearLayout.LayoutParams(-1, -2).apply { bottomMargin = dp(12) })
        }
        setContentView(ScrollView(this).apply { setBackgroundColor(RabiMobileUi.background); addView(content) })
    }

    private fun dp(value: Int) = RabiMobileUi.dp(this, value)

    companion object {
        fun open(activity: Activity) { activity.startActivity(Intent(activity, RabiAppearanceActivity::class.java)) }
    }
}
