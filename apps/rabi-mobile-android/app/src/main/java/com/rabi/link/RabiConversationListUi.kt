package com.rabi.link

import android.app.Activity
import android.app.Dialog
import android.content.res.ColorStateList
import android.graphics.Color
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.graphics.drawable.RippleDrawable
import android.text.TextUtils
import android.view.Gravity
import android.view.View
import android.widget.*

/** Presentation only: every action is committed by the conversation owner. */
internal class RabiConversationListUi(private val activity: Activity) {
    private fun dp(value: Int) = RabiMobileUi.dp(activity, value)
    private fun text(value: String, size: Float, color: Int = RabiMobileUi.text) = TextView(activity).apply {
        text = value; textSize = size; setTextColor(color)
    }
    private fun touch(view: View, open: () -> Unit, actions: () -> Unit) {
        view.isFocusable = true
        view.background = RippleDrawable(ColorStateList.valueOf(RabiMobileUi.accentSurface), null, RabiMobileUi.panel(activity, Color.WHITE, Color.WHITE, 12))
        view.setOnClickListener { open() }
        view.setOnLongClickListener { actions(); true }
    }

    fun avatar(title: String, size: Int): ImageView = RabiMobileUi.avatar(activity, title).apply {
        setPadding(0, 0, 0, 0)
        background = GradientDrawable().apply { shape = GradientDrawable.OVAL; setColor(RabiMobileUi.accentSurface) }
        clipToOutline = true
        layoutParams = FrameLayout.LayoutParams(dp(size), dp(size), Gravity.CENTER)
    }

    private fun avatarWithUnread(image: ImageView, size: Int, unread: Int): View = FrameLayout(activity).apply {
        addView(image, FrameLayout.LayoutParams(dp(size), dp(size), Gravity.CENTER))
        if (unread > 0) addView(text(if (unread > 99) "99+" else unread.toString(), 11f, RabiMobileUi.onAccent).apply {
            gravity = Gravity.CENTER; minWidth = dp(20)
            setPadding(dp(5), 0, dp(5), 0)
            background = RabiMobileUi.panel(activity, RabiMobileUi.secondary, RabiMobileUi.surface, 12)
            contentDescription = "$unread 条未读消息"
        }, FrameLayout.LayoutParams(-2, dp(20), Gravity.TOP or Gravity.END))
    }

    private fun computerBadge(name: String) = text(name,10f,RabiMobileUi.muted).apply {
        maxLines = 1; ellipsize = TextUtils.TruncateAt.END; maxWidth = dp(96)
        setPadding(dp(6),dp(2),dp(6),dp(2))
        background = RabiMobileUi.panel(activity,RabiMobileUi.inputSurface,Color.TRANSPARENT,6)
        contentDescription = "人格来源电脑：$name"
    }
    private fun personaHeading(title: String, unread: Int, computer: String): View {
        val name = text(title,17f).apply {
            if(unread > 0) typeface = Typeface.DEFAULT_BOLD
            maxLines = 1; ellipsize = TextUtils.TruncateAt.END
        }
        val badge = computerBadge(computer)
        return object : LinearLayout(activity) {
            override fun onMeasure(widthSpec: Int, heightSpec: Int) {
                val available = View.MeasureSpec.getSize(widthSpec)
                badge.maxWidth = minOf(dp(96),available/2)
                badge.measure(View.MeasureSpec.makeMeasureSpec(badge.maxWidth,View.MeasureSpec.AT_MOST),View.MeasureSpec.makeMeasureSpec(0,View.MeasureSpec.UNSPECIFIED))
                name.maxWidth = (available-badge.measuredWidth-dp(8)).coerceAtLeast(0)
                super.onMeasure(widthSpec,heightSpec)
            }
        }.apply {
            gravity = Gravity.CENTER_VERTICAL
            addView(name,LinearLayout.LayoutParams(-2,-2))
            addView(badge,LinearLayout.LayoutParams(-2,-2).apply { marginStart = dp(8) })
        }
    }

    fun pinned(title: String, description: String, image: ImageView, unread: Int, open: () -> Unit, actions: () -> Unit, sourceComputer: String = ""): View = LinearLayout(activity).apply {
        orientation = LinearLayout.VERTICAL; gravity = Gravity.CENTER_HORIZONTAL
        setPadding(dp(6), dp(12), dp(6), dp(12))
        contentDescription = "$title，已置顶，$description"
        addView(avatarWithUnread(image, 72, unread), LinearLayout.LayoutParams(dp(84), dp(84)))
        addView(text(title, 15f).apply {
            gravity = Gravity.CENTER; maxLines = 2; ellipsize = TextUtils.TruncateAt.END
        }, LinearLayout.LayoutParams(-1, -2).apply { topMargin = dp(6) })
        if(sourceComputer.isNotBlank()) addView(computerBadge(sourceComputer),LinearLayout.LayoutParams(-2,-2).apply { topMargin = dp(4) })
        touch(this, open, actions)
    }

    fun row(title: String, preview: String, time: String, description: String, image: ImageView, unread: Int, open: () -> Unit, actions: () -> Unit, destinationHint: String = "", sourceComputer: String = ""): View = LinearLayout(activity).apply {
        orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER_VERTICAL
        minimumHeight = dp(88); setPadding(dp(18), dp(14), dp(18), dp(14))
        contentDescription = "$title，$description，$preview，$time，$unread 条未读消息"
        addView(image, LinearLayout.LayoutParams(dp(52), dp(52)).apply { marginEnd = dp(16) })
        addView(LinearLayout(activity).apply {
            orientation = LinearLayout.VERTICAL
            if(sourceComputer.isNotBlank()) addView(personaHeading(title,unread,sourceComputer),LinearLayout.LayoutParams(-1,-2))
            else addView(text(title,17f).apply {
                if(unread > 0) typeface = Typeface.DEFAULT_BOLD
                maxLines = 1; ellipsize = TextUtils.TruncateAt.END
            })
            if (destinationHint.isNotBlank()) addView(text(destinationHint, 11f, RabiMobileUi.muted).apply {
                maxLines = 1; ellipsize = TextUtils.TruncateAt.END
            }, LinearLayout.LayoutParams(-1, -2).apply { topMargin = dp(4) })
            addView(text(preview, 14f, RabiMobileUi.muted).apply {
                maxLines = 1; ellipsize = TextUtils.TruncateAt.END
            }, LinearLayout.LayoutParams(-1, -2).apply { topMargin = dp(7) })
        }, LinearLayout.LayoutParams(0, -2, 1f))
        if (time.isNotBlank() || unread > 0) addView(LinearLayout(activity).apply {
            orientation = LinearLayout.VERTICAL; gravity = Gravity.END
            if (time.isNotBlank()) addView(text(time, 12f, RabiMobileUi.muted).apply { maxLines = 1 }, LinearLayout.LayoutParams(-2, -2))
            if (unread > 0) addView(RabiMobileUi.unreadBadge(activity, unread), LinearLayout.LayoutParams(-2, dp(20)).apply { topMargin = dp(10) })
        }, LinearLayout.LayoutParams(-2, -2).apply { marginStart = dp(12); gravity = Gravity.TOP })
        touch(this, open, actions)
    }

    fun actions(title: String, destination: String, image: ImageView, pinned: Boolean, unread: Int,
                open: () -> Unit, pin: () -> Unit, read: () -> Unit, copy: () -> Unit) {
        val dialog = Dialog(activity)
        val body = LinearLayout(activity).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(12), dp(10), dp(12), dp(24))
            background = GradientDrawable().apply {
                setColor(RabiMobileUi.surface)
                cornerRadii = floatArrayOf(dp(28).toFloat(), dp(28).toFloat(), dp(28).toFloat(), dp(28).toFloat(), 0f, 0f, 0f, 0f)
            }
        }
        body.addView(View(activity).apply { background = RabiMobileUi.panel(activity, RabiMobileUi.borderStrong, RabiMobileUi.borderStrong, 4) },
            LinearLayout.LayoutParams(dp(32), dp(4)).apply { gravity = Gravity.CENTER_HORIZONTAL; bottomMargin = dp(14) })
        body.addView((row(title, destination, "", destination, image, 0, { dialog.dismiss(); open() }, {}) as LinearLayout).apply {
            addView(RabiMobileUi.icon(activity, R.drawable.ic_ui_chevron, RabiMobileUi.muted), LinearLayout.LayoutParams(dp(20), dp(20)))
        })
        data class Action(val label: String, val icon: Int, val run: () -> Unit)
        listOf(
            Action(if (unread > 0) "标记为已读" else "标记为未读", if (unread > 0) R.drawable.ic_ui_read else R.drawable.ic_ui_unread, read),
            Action(if (pinned) "取消置顶" else "置顶", R.drawable.ic_ui_pin, pin),
            Action("复制会话 ID", R.drawable.ic_ui_copy, copy),
        ).forEach { action ->
            body.addView(RabiMobileUi.actionRow(activity, action.icon, action.label, chevron = false) {
                dialog.dismiss(); action.run()
            }, LinearLayout.LayoutParams(-1, -2))
        }
        dialog.setContentView(ScrollView(activity).apply { addView(body) })
        dialog.window?.apply {
            setBackgroundDrawableResource(android.R.color.transparent)
            addFlags(android.view.WindowManager.LayoutParams.FLAG_DIM_BEHIND)
            setDimAmount(0.45f)
        }
        dialog.show()
        dialog.window?.apply {
            setGravity(Gravity.BOTTOM)
            setLayout(-1, -2)
        }
    }
}
