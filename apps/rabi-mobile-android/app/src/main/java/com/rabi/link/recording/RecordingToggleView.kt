package com.rabi.link.recording

import android.content.Context
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.widget.CompoundButton
import android.widget.Switch
import com.rabi.link.RabiMobileUi

/** Native checkable behavior with a track that does not depend on vendor thumb insets. */
internal class RecordingToggleView(context: Context) : CompoundButton(context) {
    private val paint = Paint(Paint.ANTI_ALIAS_FLAG)
    private val density = resources.displayMetrics.density
    init {
        text = ""; buttonDrawable = null; setPadding(0,0,0,0)
        minimumWidth = (52*density).toInt(); minimumHeight = (48*density).toInt()
        isClickable = true; isFocusable = true
        background = android.graphics.drawable.RippleDrawable(android.content.res.ColorStateList.valueOf(RabiMobileUi.accentBorder),null,
            RabiMobileUi.panel(context,Color.WHITE,Color.WHITE,24))
    }
    override fun getAccessibilityClassName(): CharSequence = Switch::class.java.name
    override fun onDraw(canvas: Canvas) {
        val left = (width-48*density)/2; val top = (height-28*density)/2
        paint.color = if(isChecked) RabiMobileUi.secondary else RabiMobileUi.borderStrong
        paint.alpha = if(isEnabled) 255 else 170
        canvas.drawRoundRect(left,top,left+48*density,top+28*density,14*density,14*density,paint)
        paint.color = Color.WHITE; paint.alpha = 255
        val thumb = left+(if(isChecked) 34 else 14)*density
        canvas.drawCircle(thumb,top+14*density,11*density,paint)
    }
}
