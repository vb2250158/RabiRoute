package com.rabi.link

import android.content.Context
import android.content.res.ColorStateList
import android.graphics.Color
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.view.Gravity
import android.view.View
import android.widget.Button
import android.widget.EditText
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.Spinner
import android.widget.Switch
import android.widget.TextView

enum class RabiGuidanceTone { INFO, SUCCESS, WARNING, ERROR }

data class RabiSetupGuidance(
    val title: String,
    val reason: String,
    val action: String,
    val tone: RabiGuidanceTone = RabiGuidanceTone.INFO,
) {
    fun displayText(): String = buildString {
        append(title)
        if (reason.isNotBlank()) append("\n").append(reason)
        if (action.isNotBlank()) append("\n下一步：").append(action)
    }
}

object RabiSetupGuide {
    fun missingConnection(urlMissing: Boolean, tokenMissing: Boolean, discoveredPcCount: Int): RabiSetupGuidance {
        if (urlMissing) {
            val scanResult = if (discoveredPcCount > 0) {
                "已在同一网络找到 Rabi PC，但手机仍不知道安全的 RabiLink 公网地址。"
            } else {
                "App 已尝试扫描同一 Wi-Fi，但没有发现可直接使用的 Rabi PC。PC 未启动、未开放局域网访问或不在同一网络时，Android 无法自动获得地址。"
            }
            return RabiSetupGuidance(
                "还缺 RabiLink 服务器地址",
                scanResult,
                "在 Rabi PC 的“RabiLink / 移动端”页面复制连接信息；以后安装包或配对二维码带有地址时，App 会自动填入。",
                RabiGuidanceTone.WARNING,
            )
        }
        if (tokenMissing) {
            return RabiSetupGuidance(
                "还缺一次安全登录",
                "应用 token 是账号凭证，Android 不能在没有确认的情况下从电脑偷读或自动生成。",
                "在 Rabi PC 的“RabiLink / 移动端”页面复制登录码，粘贴后点“连接 Rabi”。",
                RabiGuidanceTone.WARNING,
            )
        }
        return RabiSetupGuidance(
            "连接信息已填写",
            "App 将验证服务器、登录状态和可用 Rabi PC。",
            "点“连接 Rabi”，只有一个在线 PC 时会自动选择。",
        )
    }

    fun connectionError(error: Throwable): RabiSetupGuidance {
        val raw = error.message.orEmpty()
        val text = raw.lowercase()
        return when {
            "401" in text || "403" in text || "unauthorized" in text || "forbidden" in text -> RabiSetupGuidance(
                "登录没有通过",
                "服务器拒绝了当前登录码。它可能填错、已被撤销，或属于另一台 RabiLink 服务器。",
                "回到 Rabi PC 重新复制移动端登录码，再点“重新连接”。",
                RabiGuidanceTone.ERROR,
            )
            "unknownhost" in text || "unable to resolve host" in text || "name or service" in text -> RabiSetupGuidance(
                "找不到这台服务器",
                "服务器地址无法解析，通常是地址拼错、域名不可用或手机当前没有网络。",
                "检查网络和服务器地址；不要填写电脑上的 127.0.0.1。",
                RabiGuidanceTone.ERROR,
            )
            "timeout" in text || "timed out" in text -> RabiSetupGuidance(
                "服务器响应超时",
                "手机能够发起连接，但在等待时间内没有收到完整回应。服务器可能未启动、网络被拦截或链路太慢。",
                "确认 RabiLink 服务正在运行后重试；仍失败时打开诊断页查看具体环节。",
                RabiGuidanceTone.ERROR,
            )
            "cleartext" in text -> RabiSetupGuidance(
                "这个地址不够安全",
                "Android 阻止了公网 HTTP 明文连接，避免登录码在网络中裸传。",
                "改用 https:// 地址；局域网调试请在 Rabi PC 明确启用安全的移动端入口。",
                RabiGuidanceTone.ERROR,
            )
            "refused" in text || "failed to connect" in text || "unreachable" in text -> RabiSetupGuidance(
                "服务器没有接受连接",
                "地址存在，但对应服务未启动、端口未开放，或被防火墙拦截。",
                "启动 RabiLink 服务并检查防火墙后重试。",
                RabiGuidanceTone.ERROR,
            )
            else -> RabiSetupGuidance(
                "连接没有完成",
                raw.ifBlank { "App 收到了未分类的连接错误。" },
                "检查服务器与登录码后重试；若仍失败，打开诊断页复制错误详情。",
                RabiGuidanceTone.ERROR,
            )
        }
    }
}

object RabiMobileUi {
    val background = Color.rgb(246, 248, 251)
    val surface = Color.WHITE
    val primary = Color.rgb(16, 42, 67)
    val secondary = Color.rgb(25, 191, 193)
    val accent = Color.rgb(255, 109, 157)
    val text = Color.rgb(17, 32, 51)
    val muted = Color.rgb(102, 117, 134)
    val border = Color.rgb(218, 226, 234)

    @JvmStatic
    fun dp(context: Context, value: Int): Int =
        (value * context.resources.displayMetrics.density + 0.5f).toInt()

    @JvmStatic
    fun panel(context: Context, color: Int, stroke: Int = border, radius: Int = 12): GradientDrawable =
        GradientDrawable().apply {
            setColor(color)
            setStroke(dp(context, 1), stroke)
            cornerRadius = dp(context, radius).toFloat()
        }

    @JvmStatic
    fun hero(context: Context, title: String, body: String): View = LinearLayout(context).apply {
        orientation = LinearLayout.HORIZONTAL
        gravity = Gravity.CENTER_VERTICAL
        setPadding(dp(context, 16), dp(context, 14), dp(context, 16), dp(context, 14))
        background = panel(context, Color.rgb(239, 253, 255), Color.rgb(183, 231, 232), 14)
        addView(ImageView(context).apply {
            setImageResource(R.drawable.rabiroute_icon)
            scaleType = ImageView.ScaleType.CENTER_CROP
            contentDescription = "RabiRoute"
        }, LinearLayout.LayoutParams(dp(context, 52), dp(context, 52)))
        addView(LinearLayout(context).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(context, 14), 0, 0, 0)
            addView(title(context, title, 22f))
            addView(note(context, body).apply { setPadding(0, dp(context, 4), 0, 0) })
        }, LinearLayout.LayoutParams(0, -2, 1f))
    }

    @JvmStatic
    fun card(context: Context): LinearLayout = LinearLayout(context).apply {
        orientation = LinearLayout.VERTICAL
        setPadding(dp(context, 16), dp(context, 15), dp(context, 16), dp(context, 15))
        background = panel(context, surface, border, 12)
        elevation = dp(context, 2).toFloat()
    }

    @JvmStatic
    fun title(context: Context, value: String, size: Float = 17f): TextView = TextView(context).apply {
        text = value
        textSize = size
        typeface = Typeface.DEFAULT_BOLD
        setTextColor(primary)
    }

    @JvmStatic
    fun note(context: Context, value: String): TextView = TextView(context).apply {
        text = value
        textSize = 13f
        setTextColor(muted)
        setLineSpacing(0f, 1.16f)
        setPadding(0, dp(context, 6), 0, dp(context, 10))
    }

    @JvmStatic
    fun label(context: Context, value: String): TextView = TextView(context).apply {
        text = value
        textSize = 12f
        typeface = Typeface.DEFAULT_BOLD
        setTextColor(primary)
        setPadding(0, dp(context, 7), 0, dp(context, 5))
    }

    @JvmStatic
    fun input(context: Context, hintText: String): EditText = EditText(context).apply {
        hint = hintText
        textSize = 15f
        setTextColor(RabiMobileUi.text)
        setHintTextColor(Color.rgb(139, 152, 168))
        setSingleLine(true)
        minHeight = dp(context, 52)
        gravity = Gravity.CENTER_VERTICAL
        setPadding(dp(context, 14), 0, dp(context, 14), 0)
        background = panel(context, surface, Color.rgb(193, 205, 216), 10)
    }

    @JvmStatic
    fun spinner(context: Context, value: Spinner): Spinner = value.apply {
        minimumHeight = dp(context, 52)
        setPadding(dp(context, 10), 0, dp(context, 10), 0)
        background = panel(context, surface, Color.rgb(193, 205, 216), 10)
    }

    @JvmStatic
    fun primary(context: Context, value: String, action: () -> Unit): Button = Button(context).apply {
        text = value
        isAllCaps = false
        textSize = 15f
        typeface = Typeface.DEFAULT_BOLD
        minHeight = dp(context, 52)
        setTextColor(Color.WHITE)
        background = panel(context, primary, primary, 10)
        setOnClickListener { action() }
    }

    @JvmStatic
    fun secondary(context: Context, value: String, action: () -> Unit): Button = Button(context).apply {
        text = value
        isAllCaps = false
        textSize = 15f
        minHeight = dp(context, 52)
        setTextColor(primary)
        background = panel(context, Color.rgb(239, 253, 255), Color.rgb(171, 224, 225), 10)
        setOnClickListener { action() }
    }

    /** App-bar action: compact visual treatment with an accessible 48dp touch target. */
    @JvmStatic
    fun compactAction(context: Context, value: String, action: () -> Unit): Button = Button(context).apply {
        text = value
        isAllCaps = false
        textSize = 14f
        minHeight = dp(context, 48)
        minimumHeight = dp(context, 48)
        setPadding(dp(context, 12), 0, dp(context, 12), 0)
        setTextColor(primary)
        background = panel(context, Color.rgb(239, 253, 255), Color.rgb(171, 224, 225), 10)
        setOnClickListener { action() }
    }

    @JvmStatic
    fun avatar(context: Context, label: String): ImageView = ImageView(context).apply {
        setImageResource(R.drawable.rabiroute_icon)
        scaleType = ImageView.ScaleType.CENTER_CROP
        contentDescription = "$label 头像"
        background = panel(context, Color.rgb(239, 253, 255), Color.rgb(183, 231, 232), 14)
        setPadding(dp(context, 3), dp(context, 3), dp(context, 3), dp(context, 3))
    }

    @JvmStatic
    fun unreadBadge(context: Context, count: Int): TextView = TextView(context).apply {
        text = if (count > 99) "99+" else count.coerceAtLeast(1).toString()
        textSize = 11f
        typeface = Typeface.DEFAULT_BOLD
        gravity = Gravity.CENTER
        minWidth = dp(context, 24)
        setPadding(dp(context, 6), 0, dp(context, 6), 0)
        setTextColor(Color.WHITE)
        background = panel(context, accent, accent, 12)
        contentDescription = "$count 条未读消息"
    }

    @JvmStatic
    fun styleSwitch(context: Context, value: Switch): Switch = value.apply {
        minHeight = dp(context, 48)
        setTextColor(RabiMobileUi.text)
        textSize = 14f
        thumbTintList = ColorStateList(
            arrayOf(intArrayOf(android.R.attr.state_checked), intArrayOf()),
            intArrayOf(surface, surface),
        )
        trackTintList = ColorStateList(
            arrayOf(intArrayOf(android.R.attr.state_checked), intArrayOf()),
            intArrayOf(secondary, Color.rgb(176, 188, 198)),
        )
    }

    @JvmStatic
    fun guidance(context: Context, value: RabiSetupGuidance): TextView = TextView(context).apply {
        text = value.displayText()
        textSize = 13f
        setLineSpacing(0f, 1.16f)
        setTextColor(
            when (value.tone) {
                RabiGuidanceTone.SUCCESS -> Color.rgb(22, 101, 52)
                RabiGuidanceTone.WARNING -> Color.rgb(146, 64, 14)
                RabiGuidanceTone.ERROR -> Color.rgb(153, 27, 27)
                RabiGuidanceTone.INFO -> primary
            }
        )
        val colors = when (value.tone) {
            RabiGuidanceTone.SUCCESS -> Color.rgb(240, 253, 244) to Color.rgb(134, 239, 172)
            RabiGuidanceTone.WARNING -> Color.rgb(255, 251, 235) to Color.rgb(253, 186, 116)
            RabiGuidanceTone.ERROR -> Color.rgb(254, 242, 242) to Color.rgb(252, 165, 165)
            RabiGuidanceTone.INFO -> Color.rgb(239, 253, 255) to Color.rgb(165, 227, 229)
        }
        setPadding(dp(context, 14), dp(context, 12), dp(context, 14), dp(context, 12))
        background = panel(context, colors.first, colors.second, 10)
    }

    /** Java-friendly styling hooks for legacy probe Activities. */
    @JvmStatic
    fun backgroundColor(): Int = background

    @JvmStatic
    fun primaryColor(): Int = primary

    @JvmStatic
    fun textColor(): Int = text

    @JvmStatic
    fun mutedColor(): Int = muted

    @JvmStatic
    fun borderColor(): Int = border

    @JvmStatic
    fun styleCard(context: Context, value: LinearLayout): LinearLayout = value.apply {
        orientation = LinearLayout.VERTICAL
        setPadding(dp(context, 16), dp(context, 15), dp(context, 16), dp(context, 15))
        background = panel(context, surface, border, 12)
        elevation = dp(context, 2).toFloat()
    }

    @JvmStatic
    @JvmOverloads
    fun styleInput(context: Context, value: EditText, multiline: Boolean = false): EditText = value.apply {
        textSize = 15f
        setTextColor(RabiMobileUi.text)
        setHintTextColor(Color.rgb(139, 152, 168))
        minHeight = dp(context, 52)
        gravity = if (multiline) Gravity.TOP else Gravity.CENTER_VERTICAL
        setPadding(dp(context, 14), if (multiline) dp(context, 12) else 0, dp(context, 14), if (multiline) dp(context, 12) else 0)
        background = panel(context, surface, Color.rgb(193, 205, 216), 10)
    }

    @JvmStatic
    @JvmOverloads
    fun fieldHelp(
        context: Context,
        value: String,
        tone: RabiGuidanceTone = RabiGuidanceTone.INFO,
    ): TextView = TextView(context).apply {
        text = value
        textSize = 12.5f
        setLineSpacing(0f, 1.12f)
        setPadding(dp(context, 2), dp(context, 5), dp(context, 2), dp(context, 7))
        setTextColor(fieldToneColor(tone))
    }

    @JvmStatic
    fun styleFieldHelp(
        context: Context,
        value: TextView,
        text: String,
        tone: RabiGuidanceTone,
    ): TextView = value.apply {
        this.text = text
        textSize = 12.5f
        setLineSpacing(0f, 1.12f)
        setPadding(dp(context, 2), dp(context, 5), dp(context, 2), dp(context, 7))
        setTextColor(fieldToneColor(tone))
    }

    @JvmStatic
    fun styleInputState(
        context: Context,
        value: EditText,
        tone: RabiGuidanceTone,
    ): EditText = value.apply {
        val stroke = when (tone) {
            RabiGuidanceTone.SUCCESS -> Color.rgb(74, 185, 116)
            RabiGuidanceTone.WARNING -> Color.rgb(245, 158, 66)
            RabiGuidanceTone.ERROR -> Color.rgb(239, 104, 104)
            RabiGuidanceTone.INFO -> Color.rgb(193, 205, 216)
        }
        background = panel(context, surface, stroke, 10)
    }

    private fun fieldToneColor(tone: RabiGuidanceTone): Int = when (tone) {
        RabiGuidanceTone.SUCCESS -> Color.rgb(22, 101, 52)
        RabiGuidanceTone.WARNING -> Color.rgb(146, 64, 14)
        RabiGuidanceTone.ERROR -> Color.rgb(153, 27, 27)
        RabiGuidanceTone.INFO -> muted
    }

    @JvmStatic
    fun stylePrimaryButton(context: Context, value: Button): Button = value.apply {
        isAllCaps = false
        textSize = 15f
        typeface = Typeface.DEFAULT_BOLD
        minHeight = dp(context, 52)
        setTextColor(Color.WHITE)
        background = panel(context, primary, primary, 10)
    }

    @JvmStatic
    fun styleSecondaryButton(context: Context, value: Button): Button = value.apply {
        isAllCaps = false
        textSize = 15f
        minHeight = dp(context, 52)
        setTextColor(primary)
        background = panel(context, Color.rgb(239, 253, 255), Color.rgb(171, 224, 225), 10)
    }

    @JvmStatic
    fun styleTitleText(context: Context, value: TextView, size: Float): TextView = value.apply {
        textSize = size
        typeface = Typeface.DEFAULT_BOLD
        setTextColor(primary)
    }

    @JvmStatic
    fun styleNoteText(context: Context, value: TextView): TextView = value.apply {
        textSize = 13f
        setTextColor(muted)
        setLineSpacing(0f, 1.16f)
    }

    @JvmStatic
    fun styleGuidance(
        context: Context,
        value: TextView,
        title: String,
        reason: String,
        action: String,
        tone: RabiGuidanceTone,
    ): TextView {
        val styled = guidance(context, RabiSetupGuidance(title, reason, action, tone))
        value.text = styled.text
        value.textSize = styled.textSize / context.resources.displayMetrics.scaledDensity
        value.setTextColor(styled.currentTextColor)
        value.setLineSpacing(0f, 1.16f)
        value.setPadding(dp(context, 14), dp(context, 12), dp(context, 14), dp(context, 12))
        value.background = styled.background
        return value
    }
}
